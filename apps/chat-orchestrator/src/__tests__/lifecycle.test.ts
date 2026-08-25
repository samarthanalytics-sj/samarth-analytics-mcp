/**
 * The parts around the record: the settings poll, the supervisor's note, the health monitor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRecorder, DEFAULT_SLACK_SETTINGS } from '../events.js';
import {
  HealthMonitor, SettingsPoller, consumeSelfReported, markSelfReported,
  parseLastExit, readLastExit, LAST_EXIT_FILE, SELF_REPORTED_FILE,
} from '../lifecycle.js';

function fetchAnswering(rows: unknown, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return { ok: status < 300, status, json: async () => rows, text: async () => JSON.stringify(rows) } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Answers the settings read and the webhook RPC differently, the way the database does. */
function fetchRouting(settings: unknown, webhook: unknown, webhookStatus = 200) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/rpc/orchestrator_slack_webhook')) {
      return { ok: webhookStatus < 300, status: webhookStatus, json: async () => webhook, text: async () => '' } as Response;
    }
    return { ok: true, status: 200, json: async () => settings, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── Settings poll ───────────────────────────────────────────────────────────

test('the poll reads the one key and reports a change once', async () => {
  const changes: Array<{ enabled: boolean; first: boolean }> = [];
  const { impl, calls } = fetchAnswering([{ value: { enabled: true, events: { detailed: true } } }]);
  const p = new SettingsPoller('https://db.example.co', 'k', (s, first) => changes.push({ enabled: s.enabled, first }), impl);
  assert.deepEqual(p.current(), DEFAULT_SLACK_SETTINGS, 'defaults until the first read');
  const r1 = await p.refresh();
  assert.equal(r1.ok, true);
  assert.equal(r1.changed, true);
  assert.match(calls[0], /system_settings\?key=eq\.orchestrator\.slack/);
  assert.equal(p.current().enabled, true);
  assert.equal(p.current().groups.detailed, true);
  const r2 = await p.refresh();
  assert.equal(r2.changed, false, 'the same value is not a change');
  assert.deepEqual(changes, [{ enabled: true, first: true }]);
  assert.equal(p.reachable(), true);
});

test('a failed read keeps the last good settings and marks the database unreachable', async () => {
  const good = fetchAnswering([{ value: { enabled: true } }]);
  const p = new SettingsPoller('https://db.example.co', 'k', () => undefined, good.impl);
  await p.refresh();
  const bad = new SettingsPoller('https://db.example.co', 'k', () => undefined, fetchAnswering({}, 500).impl);
  await bad.refresh();
  assert.equal(bad.reachable(), false);
  assert.equal(p.current().enabled, true);
  // Same poller, now failing: settings survive.
  const flaky = fetchAnswering([{ value: { enabled: true } }]);
  const q = new SettingsPoller('https://db.example.co', 'k', () => undefined, flaky.impl);
  await q.refresh();
  (q as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchAnswering({}, 500).impl;
  assert.equal(q.current().enabled, true);
});

test('a missing row means defaults, not an error', async () => {
  const p = new SettingsPoller('https://db.example.co', 'k', () => undefined, fetchAnswering([]).impl);
  const r = await p.refresh();
  assert.equal(r.ok, true);
  assert.deepEqual(p.current(), DEFAULT_SLACK_SETTINGS);
});

test('no credentials means no poll and no claim of reachability', async () => {
  const p = new SettingsPoller('', '', () => undefined, fetchAnswering([]).impl);
  assert.equal(p.enabled, false);
  assert.equal((await p.refresh()).ok, false);
});

test('the poll reads the stored webhook alongside the switches', async () => {
  const seen: string[] = [];
  const { impl, calls } = fetchRouting([{ value: { enabled: true } }], 'https://hooks.slack.com/services/T1/B1/x');
  const p = new SettingsPoller('https://db.example.co', 'k', () => undefined, impl, (url) => seen.push(url));
  await p.refresh();
  assert.ok(calls.some(c => c.includes('/rpc/orchestrator_slack_webhook')), 'it asks for the webhook');
  assert.deepEqual(seen, ['https://hooks.slack.com/services/T1/B1/x']);
});

test('a webhook that cannot be read is not reported as one being removed', async () => {
  // The distinction that matters: '' means an admin cleared it, null means the database did not
  // answer. Treating the second as the first would silently switch off notifications on a blip.
  const seen: string[] = [];
  const { impl } = fetchRouting([{ value: {} }], null, 500);
  const p = new SettingsPoller('https://db.example.co', 'k', () => undefined, impl, (url) => seen.push(url));
  await p.refresh();
  assert.deepEqual(seen, [], 'nothing was reported');
  assert.equal(await p.fetchWebhook(), null);
});

test('a missing webhook function reads as "none stored", not as an error every minute', async () => {
  // 404 is the migration not being applied yet: a deployment state, not a fault.
  const { impl } = fetchRouting([{ value: {} }], null, 404);
  const p = new SettingsPoller('https://db.example.co', 'k', () => undefined, impl);
  assert.equal(await p.fetchWebhook(), '');
});

// ── The supervisor's note ───────────────────────────────────────────────────

test('the note is read once and then gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-exit-'));
  writeFileSync(join(dir, LAST_EXIT_FILE), JSON.stringify({ at: '2026-08-25T08:00:00.000Z', code: 4294967295, signal: null, planned: true, reason: 'deploying #900', ranForMs: 2_470_000 }));
  const first = readLastExit(dir);
  assert.ok(first);
  assert.equal(first.planned, true);
  assert.equal(first.reason, 'deploying #900');
  assert.equal(first.ranForMs, 2_470_000);
  assert.equal(existsSync(join(dir, LAST_EXIT_FILE)), false, 'deleted on read');
  assert.equal(readLastExit(dir), null, 'so it cannot be reported twice');
});

test('a crash the process already reported is not reported twice', () => {
  // One crash produced two critical rows before this: the dying process wrote one with the stack
  // trace, and the next run wrote another from the supervisor's note. Both true, and with Slack on
  // that is two pages for one stop.
  const dir = mkdtempSync(join(tmpdir(), 'orch-self-'));
  const at = new Date().toISOString();
  markSelfReported(dir, 'uncaughtException');
  assert.equal(existsSync(join(dir, SELF_REPORTED_FILE)), true);
  writeFileSync(join(dir, LAST_EXIT_FILE), JSON.stringify({ at, code: 1, planned: false, ranForMs: 3000 }));
  const exit = readLastExit(dir);
  assert.equal(exit?.selfReported, true);
  assert.equal(existsSync(join(dir, SELF_REPORTED_FILE)), false, 'the marker is cleared with the note');
});

test('a marker from an older crash never silences a newer one', () => {
  // The one failure mode worse than a duplicate: a stale marker suppressing a real crash report.
  const dir = mkdtempSync(join(tmpdir(), 'orch-stale-'));
  writeFileSync(join(dir, SELF_REPORTED_FILE), JSON.stringify({ at: '2026-08-01T00:00:00.000Z' }));
  assert.equal(consumeSelfReported(dir, new Date().toISOString()), false);
  assert.equal(existsSync(join(dir, SELF_REPORTED_FILE)), false, 'and it is cleared anyway');

  const dir2 = mkdtempSync(join(tmpdir(), 'orch-junk-'));
  writeFileSync(join(dir2, SELF_REPORTED_FILE), 'not json');
  assert.equal(consumeSelfReported(dir2, new Date().toISOString()), false);
});

test('a stop nobody reported is still reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plain-'));
  writeFileSync(join(dir, LAST_EXIT_FILE), JSON.stringify({ at: new Date().toISOString(), code: 4294967295, planned: false, ranForMs: 900_000 }));
  assert.equal(readLastExit(dir)?.selfReported, false);
});

test('a note without a usable time is ignored rather than reported at "now"', () => {
  assert.equal(parseLastExit('{"planned":true}'), null);
  assert.equal(parseLastExit('not json'), null);
  assert.equal(parseLastExit('{"at":"yesterday"}'), null);
  const ok = parseLastExit('{"at":"2026-08-25T08:00:00.000Z"}');
  assert.ok(ok);
  assert.equal(ok.planned, false, 'unplanned unless said');
  assert.equal(ok.fastExits, 0);
});

// ── Health monitor ──────────────────────────────────────────────────────────

test('a steady state is one check per tick; a change is an event; a return is a recovery', () => {
  const rec = new EventRecorder({ orchestrator: 'T', timezone: 'UTC', log: () => undefined });
  let reachable = true;
  let paused = false;
  const m = new HealthMonitor(
    { paused: () => paused, supabaseReachable: () => reachable, sinkFailures: () => 0, slackFailures: () => 0, mcpSessions: () => 1 },
    rec,
  );
  assert.equal(m.tick().state, 'healthy');
  assert.equal(m.tick().state, 'healthy');
  assert.deepEqual(rec.events.tail().map((e) => e.type), ['health.completed', 'health.completed']);

  reachable = false;
  assert.equal(m.tick().state, 'failed');
  assert.equal(rec.events.tail()[0].type, 'health.failed');
  assert.equal(rec.events.tail()[0].title, 'Health Status Changed');
  assert.equal(m.tick().state, 'failed');
  assert.equal(rec.events.tail()[0].type, 'health.failed', 'still failed, still a check');
  assert.equal(rec.events.tail()[0].title, 'Health Check', 'but not another "changed"');

  reachable = true;
  assert.equal(m.tick().state, 'healthy');
  assert.equal(rec.events.tail()[0].type, 'orchestrator.recovered');

  paused = true;
  assert.equal(m.tick().state, 'paused');
  assert.equal(rec.events.tail()[0].status, 'paused');
  paused = false;
  assert.equal(m.tick().state, 'healthy');
  assert.equal(rec.events.tail()[0].type, 'health.changed', 'unpausing is a change, not a recovery: nothing was broken');
});
