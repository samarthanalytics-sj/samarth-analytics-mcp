import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagWatchService, buildTagWatchSlack } from '../tag-watch-service';
import { MAX_TIMER_MS, MAX_INTERVAL_HOURS } from '../timer-limits';
import type { TagWatchTarget } from '../../google/tag-watch-core';

let passed = 0;
let failed = 0;
let pending = 0;
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); } });
}

// A minimal real gtag.js the parser accepts; `key` varies the key-events between scans.
function gtagJs(keyEvents: string[]): string {
  const rules = keyEvents.map((e) => ['map', 'matchingRules', JSON.stringify({ type: 5, args: [{ stringValue: e }] })]);
  const data = { resource: { tags: [{ function: '__ccd_conversion_marking', vtp_conversionRules: ['list', ...rules] }, { function: '__gct', vtp_trackingId: 'G-SVC', vtp_sessionDuration: 0 }] }, blob: { '1': 'G-SVC' } };
  return `//\n(function(){\nvar data = ${JSON.stringify(data)};\n})()`;
}

console.log('\ntag-watch-service:');

test('add captures a baseline immediately and validates the id shape', async () => {
  const svc = new TagWatchService({ fetchGtagJs: async () => gtagJs(['purchase']), now: () => 1 });
  await assert.rejects(() => svc.addTarget('not-an-id'), /not a measurement/);
  const cfg = await svc.addTarget('g-svc', 'My site');
  assert.equal(cfg.targets.length, 1);
  const t = cfg.targets[0];
  assert.equal(t.measurementId, 'G-SVC', 'normalized upper');
  assert.equal(t.label, 'My site');
  assert.deepEqual(t.lastSnapshot?.keyEvents, ['purchase'], 'baseline captured on add');
  assert.equal(t.timeline[0].kind, 'first_scan');
});

test('a scheduled sweep detects a change and posts Slack exactly once with before/after', async () => {
  let js = gtagJs(['purchase']);
  const sent: Array<{ webhook: string; text: string }> = [];
  const svc = new TagWatchService({
    fetchGtagJs: async () => js,
    now: () => Date.now(),
    sendSlack: async (webhook, payload) => { sent.push({ webhook, text: payload.text }); return { ok: true }; },
  });
  await svc.addTarget('G-SVC');
  svc.setSlackWebhook('https://hooks.slack.com/services/T/B/xyz');
  js = gtagJs(['purchase', 'form_start']); // a real change
  await svc.runOnce();
  assert.equal(sent.length, 1, 'one alert for one change');
  assert.ok(sent[0].text.includes('1 change'), sent[0].text);
  // No further change -> no further alert.
  await svc.runOnce();
  assert.equal(sent.length, 1, 'clean scans do not re-alert');
});

test('no Slack webhook -> no send, but the change is still recorded on the timeline', async () => {
  let js = gtagJs(['purchase']);
  const svc = new TagWatchService({ fetchGtagJs: async () => js, now: () => Date.now() });
  await svc.addTarget('G-SVC');
  js = gtagJs([]);
  const cfg = await svc.runOnce();
  const t = cfg.targets[0];
  assert.ok(t.timeline.some((e) => e.kind === 'changed' && e.changes.some((c) => c.field === 'key events')));
});

test('a fetch failure records a scan_error and never crashes the sweep', async () => {
  const svc = new TagWatchService({ fetchGtagJs: async () => { throw new Error('ENOTFOUND'); }, now: () => 1 });
  // add cannot capture a baseline (fetch throws) but must not reject
  const cfg = await svc.addTarget('G-SVC');
  const t = cfg.targets[0];
  assert.equal(t.lastSnapshot, null);
  assert.equal(t.timeline[0].kind, 'scan_error');
  assert.ok(t.timeline[0].summary.includes('ENOTFOUND'));
});

test('remove + enable/interval mutate config; dedupe by id', async () => {
  const svc = new TagWatchService({ fetchGtagJs: async () => gtagJs(['purchase']), now: () => 1 });
  await svc.addTarget('G-SVC');
  await svc.addTarget('g-svc'); // dup
  assert.equal(svc.getConfig().targets.length, 1, 'deduped by id');
  assert.equal(svc.setInterval(6).intervalHours, 6);
  assert.equal(svc.setInterval(0).intervalHours, 1, 'floored at 1h');
  // Ceiling: past setInterval's 2^31-1 ms limit (596 h) Node fires every 1 ms.
  assert.equal(svc.setInterval(24 * 365).intervalHours, MAX_INTERVAL_HOURS, 'capped at the timer ceiling');
  assert.equal(svc.removeTarget('G-SVC').targets.length, 0);
});

// Regression: normalize (the load path) only floor-clamped, so a persisted interval past the timer limit
// armed a setInterval that Node replaces with 1 ms, scanning gtag.js and posting Slack nonstop.
test('a persisted interval past the timer limit loads clamped, and the armed delay fits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'samarth-tagwatch-'));
  const file = join(dir, 'tag-watch.json');
  const target = { measurementId: 'G-SVC', lastSnapshot: null, timeline: [], lastScanAt: null, lastParsed: false };
  writeFileSync(file, JSON.stringify({ enabled: true, intervalHours: 1e9, targets: [target] }));
  const delays: number[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => { delays.push(Number(ms)); return realSetInterval(fn, 3_600_000); }) as typeof setInterval;
  let svc: TagWatchService | null = null;
  try {
    svc = new TagWatchService({ fetchGtagJs: async () => gtagJs(['purchase']), configPath: file, now: () => 1 });
    assert.equal(svc.getConfig().intervalHours, MAX_INTERVAL_HOURS, 'loaded interval clamped to the ceiling');
    assert.equal(delays.length, 1, 'enabled + a target arms the timer on load');
    assert.ok(delays[0] >= 1 && delays[0] <= MAX_TIMER_MS, `armed delay ${delays[0]} must fit in a 32-bit timer`);
  } finally {
    svc?.stop();
    globalThis.setInterval = realSetInterval;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTagWatchSlack: change list with field arrows; unparsed is a warning', async () => {
  const target = { measurementId: 'G-SVC', label: 'Store' } as TagWatchTarget;
  const p = buildTagWatchSlack(target, { at: 1, kind: 'changed', changes: [{ field: 'key events', before: 'a', after: 'b' }], summary: '' });
  assert.ok(p.text.includes('Store (G-SVC)'));
  assert.ok(JSON.stringify(p.blocks).includes('key events'));
  const w = buildTagWatchSlack(target, { at: 1, kind: 'unparsed_now', changes: [], summary: '' });
  assert.ok(w.text.includes('stopped parsing'));
  assert.ok(Array.isArray(w.blocks) && w.blocks.length > 0, 'unparsed payload still has blocks');
});
