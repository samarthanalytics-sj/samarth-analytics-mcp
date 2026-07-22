import assert from 'node:assert/strict';
import { TagWatchService, buildTagWatchSlack } from '../tag-watch-service';
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
  assert.equal(svc.removeTarget('G-SVC').targets.length, 0);
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
