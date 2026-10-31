import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagWatchService, buildTagWatchSlack, TAG_WATCH_WEBHOOK_REF, type TagWatchState } from '../tag-watch-service';
import { MAX_TIMER_MS, MAX_INTERVAL_HOURS } from '../timer-limits';
import { SecretStore, type Cryptor } from '../../storage/secret-store';
import type { TagWatchTarget } from '../../google/tag-watch-core';
import { log } from '../../logger';

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

// Reversible, NON-secure stand-in for safeStorage, so a REAL SecretStore runs in plain Node and the
// on-disk secrets file can be checked for plaintext.
class FakeCryptor implements Cryptor {
  constructor(public available = true) {}
  isAvailable(): boolean { return this.available; }
  encrypt(plaintext: string): Buffer { return Buffer.from(`enc::${plaintext}`, 'utf8'); }
  decrypt(ciphertext: Buffer): string {
    const s = ciphertext.toString('utf8');
    if (!s.startsWith('enc::')) throw new Error('bad ciphertext');
    return s.slice(5);
  }
}
/** An in-memory secret store for tests that never look at the disk. */
const memSecrets = () => {
  const map = new Map<string, string>();
  return { get: (r: string) => map.get(r) ?? null, has: (r: string) => map.has(r), set: (r: string, v: string) => { map.set(r, v); }, delete: (r: string) => { map.delete(r); }, available: () => true };
};

console.log('\ntag-watch-service:');

test('add captures a baseline immediately and validates the id shape', async () => {
  const svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => gtagJs(['purchase']), now: () => 1 });
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
    secrets: memSecrets(),
    fetchGtagJs: async () => js,
    now: () => Date.now(),
    sendSlack: async (webhook, payload) => { sent.push({ webhook, text: payload.text }); return { ok: true }; },
  });
  await svc.addTarget('G-SVC');
  svc.setSlackWebhook('https://hooks.slack.com/services/T/B/xyz');
  js = gtagJs(['purchase', 'form_start']); // a real change
  await svc.runOnce();
  assert.equal(sent.length, 1, 'one alert for one change');
  assert.equal(sent[0].webhook, 'https://hooks.slack.com/services/T/B/xyz', 'sent to the stored webhook');
  assert.ok(sent[0].text.includes('1 change'), sent[0].text);
  // No further change -> no further alert.
  await svc.runOnce();
  assert.equal(sent.length, 1, 'clean scans do not re-alert');
});

test('no Slack webhook -> no send, but the change is still recorded on the timeline', async () => {
  let js = gtagJs(['purchase']);
  const svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => js, now: () => Date.now() });
  await svc.addTarget('G-SVC');
  js = gtagJs([]);
  const cfg = await svc.runOnce();
  const t = cfg.targets[0];
  assert.ok(t.timeline.some((e) => e.kind === 'changed' && e.changes.some((c) => c.field === 'key events')));
});

test('a fetch failure records a scan_error and never crashes the sweep', async () => {
  const svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => { throw new Error('ENOTFOUND'); }, now: () => 1 });
  // add cannot capture a baseline (fetch throws) but must not reject
  const cfg = await svc.addTarget('G-SVC');
  const t = cfg.targets[0];
  assert.equal(t.lastSnapshot, null);
  assert.equal(t.timeline[0].kind, 'scan_error');
  assert.ok(t.timeline[0].summary.includes('ENOTFOUND'));
});

test('remove + enable/interval mutate config; dedupe by id', async () => {
  const svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => gtagJs(['purchase']), now: () => 1 });
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
    svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => gtagJs(['purchase']), configPath: file, now: () => 1 });
    assert.equal(svc.getConfig().intervalHours, MAX_INTERVAL_HOURS, 'loaded interval clamped to the ceiling');
    assert.equal(delays.length, 1, 'enabled + a target arms the timer on load');
    assert.ok(delays[0] >= 1 && delays[0] <= MAX_TIMER_MS, `armed delay ${delays[0]} must fit in a 32-bit timer`);
  } finally {
    svc?.stop();
    globalThis.setInterval = realSetInterval;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: only the constructor and setEnabled armed the timer, so enabling scheduled scans with no
// target yet (or removing every target, which stops the timer) and THEN adding one left the UI saying
// "Scheduled scans on" while nothing ran until the next app launch.
test('enabling with no targets, then adding one, arms the schedule (and re-arms after remove-all)', async () => {
  const DAY_MS = 24 * 3_600_000; // the default 24 h cadence: only this service's timers use it here
  const armed: number[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => { if (Number(ms) === DAY_MS) armed.push(Number(ms)); return realSetInterval(fn, ms); }) as typeof setInterval;
  const svc = new TagWatchService({ secrets: memSecrets(), fetchGtagJs: async () => gtagJs(['purchase']), now: () => 1 });
  try {
    svc.setEnabled(true);
    assert.equal(armed.length, 0, 'nothing to scan yet, so nothing armed');
    await svc.addTarget('G-SVC');
    assert.equal(armed.length, 1, 'the first target arms the scheduled scans');
    await svc.addTarget('G-TWO');
    assert.equal(armed.length, 1, 'a second target does not re-arm a running schedule');
    svc.removeTarget('G-SVC');
    svc.removeTarget('G-TWO');
    await svc.addTarget('G-SVC');
    assert.equal(armed.length, 2, 're-armed after the list was emptied and refilled');
    svc.setEnabled(false);
    await svc.addTarget('G-OFF');
    assert.equal(armed.length, 2, 'adding while scheduled scans are off arms nothing');
  } finally {
    svc.stop();
    globalThis.setInterval = realSetInterval;
  }
});

// Regression: the scheduled sweep ran as runOnce().catch(() => undefined), so a sweep that failed (a
// disk write, a broadcast) left no trace and a schedule that stopped working could not be diagnosed.
test('a failed scheduled sweep is logged with its message only (no webhook), not swallowed', async () => {
  const CADENCE_MS = 7 * 3_600_000; // a cadence no other test here arms
  let failBroadcast = false;
  const svc = new TagWatchService({
    secrets: memSecrets(),
    fetchGtagJs: async () => gtagJs(['purchase']),
    now: () => 1,
    emit: () => { if (failBroadcast) throw new Error('state write failed while posting to https://hooks.slack.com/services/T0/B0/not-a-real-secret'); },
  });
  await svc.addTarget('G-SVC');
  svc.setInterval(7);
  // Capture the scheduled callback. The stub is installed and removed synchronously (no await between),
  // so it can never interleave with another test's setInterval stub.
  let tick: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => { if (Number(ms) === CADENCE_MS) tick = fn; return realSetInterval(fn, ms); }) as typeof setInterval;
  try {
    svc.setEnabled(true);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  const warned: string[] = [];
  const realWarn = log.warn;
  log.warn = (message: string, ...details: string[]): void => {
    if (message.startsWith('Tag watch: a scheduled scan failed')) warned.push([message, ...details].join(' | '));
    else realWarn.call(log, message, ...details);
  };
  try {
    assert.ok(tick, 'the scheduled scan was armed');
    failBroadcast = true;
    (tick as unknown as () => void)();
    for (let i = 0; i < 50 && warned.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(warned.length, 1, 'the failed sweep was logged');
    assert.match(warned[0], /state write failed/, warned[0]);
    assert.ok(!warned[0].includes('not-a-real-secret'), `the webhook path never reaches the log: ${warned[0]}`);
  } finally {
    log.warn = realWarn;
    svc.stop();
  }
});

// Regression: scanTarget took the target's array INDEX before awaiting the fetch and wrote back by it.
// A remove during the fetch shifted the list, so one tag's snapshot was folded into ANOTHER target
// (false change alerts to Slack + bogus timeline rows), or the slot was gone and the sweep threw.
test('a target removed while a sweep fetches is never folded into another, and the sweep still resolves', async () => {
  const keyEvents: Record<string, string[]> = { 'G-XXX': ['x_evt'], 'G-AAA': ['a_evt'], 'G-BBB': ['b_evt'] };
  let gate: { id: string; reached: () => void; release: Promise<void> } | null = null;
  const holdFetch = (id: string): { reached: Promise<void>; release: () => void } => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { gate = { id, reached: r, release: released }; });
    return { reached, release };
  };
  const sent: string[] = [];
  const svc = new TagWatchService({
    secrets: memSecrets(),
    fetchGtagJs: async (id) => {
      const g = gate;
      if (g && g.id === id) { gate = null; g.reached(); await g.release; }
      return gtagJs(keyEvents[id]);
    },
    now: () => 1,
    sendSlack: async (_w, p) => { sent.push(p.text); return { ok: true }; },
  });
  for (const id of Object.keys(keyEvents)) await svc.addTarget(id);
  svc.setSlackWebhook('https://hooks.slack.com/services/T/B/xyz');
  const bBefore = svc.getConfig().targets.find((t) => t.measurementId === 'G-BBB')!;

  // [X, A, B]: X is removed while A's fetch is in flight, shifting A and B down one slot.
  const a = holdFetch('G-AAA');
  const sweep = svc.runOnce();
  await a.reached;
  svc.removeTarget('G-XXX');
  a.release();
  await sweep;
  assert.equal(sent.length, 0, `no false change alert: ${sent.join(' | ')}`);
  const bAfter = svc.getConfig().targets.find((t) => t.measurementId === 'G-BBB')!;
  assert.deepEqual(bAfter.timeline, bBefore.timeline, "B's timeline is untouched");
  assert.deepEqual(bAfter.lastSnapshot?.keyEvents, ['b_evt'], "B's baseline is still B's own");
  assert.deepEqual(svc.getConfig().targets.find((t) => t.measurementId === 'G-AAA')!.lastSnapshot?.keyEvents, ['a_evt'], "A's scan landed on A");

  // [A, B]: the LAST target is removed while its fetch is in flight - the sweep resolves cleanly.
  const b = holdFetch('G-BBB');
  const sweep2 = svc.runOnce();
  await b.reached;
  svc.removeTarget('G-BBB');
  b.release();
  const cfg = await sweep2;
  assert.deepEqual(cfg.targets.map((t) => t.measurementId), ['G-AAA'], 'the removed target stays removed');
  assert.equal(sent.length, 0, 'still no alert');
});

// Regression: the Slack webhook (a bearer secret) was written in plaintext to tag-watch-config.json and
// sent in full to the renderer on every get + tagwatch:changed broadcast. It now lives encrypted in the
// secret store; the file, getConfig() and every broadcast only carry hasSlackWebhook.
test('the Slack webhook is stored encrypted: never in the config file, getConfig() or a broadcast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'samarth-tagwatch-'));
  const file = join(dir, 'tag-watch.json');
  const secretsFile = join(dir, 'secrets.json');
  const url = 'https://hooks.slack.com/services/T0/B0/secretpart';
  const emitted: TagWatchState[] = [];
  const sentTo: string[] = [];
  let js = gtagJs(['purchase']);
  try {
    const svc = new TagWatchService({
      secrets: new SecretStore(secretsFile, new FakeCryptor()),
      fetchGtagJs: async () => js,
      configPath: file,
      emit: (s) => emitted.push(s),
      now: () => 1,
      sendSlack: async (w) => { sentTo.push(w); return { ok: true }; },
    });
    await svc.addTarget('G-SVC');
    const st = svc.setSlackWebhook(url);
    assert.equal(st.hasSlackWebhook, true, 'the renderer only learns a webhook is connected');
    js = gtagJs(['purchase', 'form_start']);
    await svc.runOnce();
    assert.deepEqual(sentTo, [url], 'the alert still goes to the stored webhook');
    assert.ok(!readFileSync(file, 'utf8').includes('hooks.slack.com'), 'no webhook in the config file');
    assert.ok(!readFileSync(secretsFile, 'utf8').includes('hooks.slack.com'), 'secret store holds ciphertext only');
    assert.ok(!JSON.stringify(svc.getConfig()).includes('hooks.slack.com'), 'getConfig() never carries the URL');
    assert.ok(emitted.length > 0 && !JSON.stringify(emitted).includes('hooks.slack.com'), 'no broadcast carries the URL');
    // Clearing removes the secret.
    assert.equal(svc.setSlackWebhook('').hasSlackWebhook, false, 'an empty value removes the webhook');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy plaintext webhook in the config file migrates into the secret store and leaves the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'samarth-tagwatch-'));
  const file = join(dir, 'tag-watch.json');
  const url = 'https://hooks.slack.com/services/T0/B0/legacy';
  const target = { measurementId: 'G-SVC', lastSnapshot: null, timeline: [], lastScanAt: null, lastParsed: false };
  try {
    writeFileSync(file, JSON.stringify({ enabled: false, intervalHours: 24, slackWebhook: url, targets: [target] }));
    const secrets = new SecretStore(join(dir, 'secrets.json'), new FakeCryptor());
    const svc = new TagWatchService({ secrets, fetchGtagJs: async () => gtagJs(['purchase']), configPath: file, now: () => 1 });
    assert.equal(secrets.get(TAG_WATCH_WEBHOOK_REF), url, 'moved into the encrypted store');
    assert.ok(!readFileSync(file, 'utf8').includes('hooks.slack.com'), 'and removed from the config file at once');
    assert.equal(svc.getConfig().hasSlackWebhook, true);
    assert.equal(svc.getConfig().targets.length, 1, 'the rest of the config is kept');

    // Without OS encryption it cannot be kept securely: dropped from the file, never used or exposed.
    writeFileSync(file, JSON.stringify({ enabled: false, intervalHours: 24, slackWebhook: url, targets: [target] }));
    const locked = new SecretStore(join(dir, 'secrets-locked.json'), new FakeCryptor(false));
    const svc2 = new TagWatchService({ secrets: locked, fetchGtagJs: async () => gtagJs(['purchase']), configPath: file, now: () => 1 });
    assert.ok(!readFileSync(file, 'utf8').includes('hooks.slack.com'), 'plaintext removed even when it cannot be migrated');
    assert.equal(svc2.getConfig().hasSlackWebhook, false);
    assert.throws(() => svc2.setSlackWebhook(url), /cannot be stored securely/, 'and a new one is refused rather than kept in plaintext');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTagWatchSlack escapes Slack mrkdwn in third-party values and clips long ones', async () => {
  const target = { measurementId: 'G-SVC', label: 'A & <B>' } as TagWatchTarget;
  const p = buildTagWatchSlack(target, { at: 1, kind: 'changed', changes: [{ field: 'site search params', before: 'q', after: '<!channel> <https://evil.example|reset password>' }, { field: 'sGTM URL', before: '(not set)', after: 'x'.repeat(1000) }], summary: '' });
  const wire = JSON.stringify(p);
  assert.ok(!wire.includes('<!channel>') && !wire.includes('<https://evil'), 'no live mention or link reaches Slack');
  assert.ok(wire.includes('&lt;!channel&gt;'), 'the value is shown, escaped');
  assert.ok(wire.includes('A &amp; &lt;B&gt; (G-SVC)'), 'the label is escaped too');
  assert.ok(!wire.includes('x'.repeat(301)), 'long values are clipped');
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
