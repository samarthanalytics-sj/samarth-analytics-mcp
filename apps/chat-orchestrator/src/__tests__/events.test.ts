/**
 * The lifecycle record: what an event says, who gets told, and what never leaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SLACK_SETTINGS,
  EventRecorder,
  EventStore,
  SlackNotifier,
  SupabaseEventSink,
  SLACK_BURST_LIMIT,
  deriveHealth,
  eventLine,
  formatDuration,
  formatWhen,
  notifyGroupOf,
  parseSlackSettings,
  shouldNotify,
  simpleText,
  slackPayload,
  toRow,
  type EventType,
  type OrchestratorEvent,
} from '../events.js';

const AT = '2026-08-25T08:00:00.000Z';

function ev(over: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: 'e1',
    at: AT,
    timezone: 'Asia/Kolkata',
    type: 'orchestrator.started',
    status: 'started',
    severity: 'success',
    title: 'Orchestrator Started',
    orchestrator: 'GA4 Monitoring',
    ...over,
  };
}

/** Records Slack posts and row writes without a network. */
function fakeFetch(status = 200, body = 'ok') {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── The message people read ─────────────────────────────────────────────────

test('the time is written in the named zone, with the zone named', () => {
  const s = formatWhen(AT, 'Asia/Kolkata');
  assert.match(s, /25 Aug 2026/);
  assert.match(s, /01:30 PM/, s);
  assert.match(s, /IST/, 'the zone is in the string, so a wrong zone is visible rather than silent');
});

test('an unknown zone falls back to UTC and says so, never to the host zone', () => {
  assert.match(formatWhen(AT, 'Mars/Olympus'), /UTC$/);
});

test('durations read like a person wrote them', () => {
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(12_000), '12s');
  assert.equal(formatDuration(45 * 60_000), '45 minutes');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(2 * 3_600_000 + 5 * 60_000), '2h 05m');
});

test('the simple message is the spec shape: heading, then Time / Status / Reason / Details', () => {
  const text = simpleText(
    ev({
      type: 'orchestrator.stopped',
      status: 'stopped',
      title: 'Orchestrator Stopped',
      reason: 'Manual stop',
      details: 'Stopped by user',
      durationMs: 45 * 60_000,
      trigger: 'Operator',
    }),
  );
  assert.equal(
    text,
    [
      'Orchestrator Stopped',
      'Orchestrator: GA4 Monitoring',
      'Time: 25 Aug 2026, 01:30 PM IST',
      'Status: Stopped',
      'Trigger: Operator',
      'Reason: Manual stop',
      'Details: Stopped by user',
      'Duration: 45 minutes',
    ].join('\n'),
  );
});

test('lines with nothing to say are absent rather than printed as a dash', () => {
  const text = simpleText(ev());
  assert.doesNotMatch(text, /Reason:/);
  assert.doesNotMatch(text, /Details:/);
  assert.doesNotMatch(text, /Duration:/);
});

test('technical detail never reaches the message or Slack', () => {
  const e = ev({ type: 'task.failed', status: 'failed', severity: 'error', title: 'Task Failed', error: 'TypeError: x is undefined\n    at loop.ts:12' });
  assert.doesNotMatch(simpleText(e), /TypeError/);
  assert.doesNotMatch(JSON.stringify(slackPayload(e)), /TypeError/);
  assert.match(eventLine(e), /TypeError/, 'the log line is where the detail goes');
  assert.equal(toRow(e).error, 'TypeError: x is undefined at loop.ts:12', 'and the row keeps it, flattened');
});

test('the Slack payload carries plain text and one mrkdwn block with bold labels', () => {
  const p = slackPayload(ev({ type: 'task.failed', status: 'failed', severity: 'error', title: 'Orchestrator Failed', taskId: 'Traffic Monitoring', reason: 'API request failed', action: 'Retry scheduled' }));
  assert.match(String(p.text), /^Orchestrator Failed\n/);
  const block = (p.blocks as Array<{ text: { text: string } }>)[0].text.text;
  assert.match(block, /:x: \*Orchestrator Failed\*/);
  assert.match(block, /\*Task:\* Traffic Monitoring/);
  assert.match(block, /\*Reason:\* API request failed/);
  assert.match(block, /\*Action:\* Retry scheduled/);
});

test('the log line wears the [event] tag so the log viewer files it', () => {
  assert.match(eventLine(ev()), /^\[event\] orchestrator\.started started: Orchestrator Started/);
});

// ── Who gets told ───────────────────────────────────────────────────────────

test('every event type belongs to a notification group', () => {
  const types: EventType[] = [
    'orchestrator.started', 'orchestrator.stopped', 'orchestrator.paused', 'orchestrator.resumed',
    'orchestrator.unexpected_shutdown', 'orchestrator.recovered', 'orchestrator.startup_failed',
    'task.started', 'task.completed', 'task.failed', 'task.skipped', 'task.retried',
    'api.request.started', 'api.request.completed', 'api.request.failed', 'database.operation',
    'service.connection', 'slack.sent', 'slack.failed', 'health.started', 'health.completed',
    'health.failed', 'health.changed', 'config.changed', 'schedule.triggered', 'auth.failed',
    'timeout', 'error', 'critical',
  ];
  for (const t of types) assert.ok(notifyGroupOf(t), t);
});

test('nothing posts while notifications are off, critical included', () => {
  assert.equal(shouldNotify('orchestrator.unexpected_shutdown', DEFAULT_SLACK_SETTINGS), false);
});

test('the defaults post starts, stops, failures, recoveries and health, and not every tool call', () => {
  const on = { ...DEFAULT_SLACK_SETTINGS, enabled: true };
  assert.equal(shouldNotify('orchestrator.started', on), true);
  assert.equal(shouldNotify('task.failed', on), true);
  assert.equal(shouldNotify('orchestrator.recovered', on), true);
  assert.equal(shouldNotify('health.changed', on), true);
  assert.equal(shouldNotify('task.completed', on), false, 'task completion is opt-in');
  assert.equal(shouldNotify('api.request.completed', on), false, 'a tool call is not a notification');
  assert.equal(shouldNotify('task.started', on), false);
});

test('critical posts whenever notifications are on, even with its switch off', () => {
  const s = { ...DEFAULT_SLACK_SETTINGS, enabled: true, groups: { ...DEFAULT_SLACK_SETTINGS.groups, critical: false } };
  assert.equal(shouldNotify('orchestrator.unexpected_shutdown', s), true);
});

test('"detailed" is the everything switch', () => {
  const s = { ...DEFAULT_SLACK_SETTINGS, enabled: true, groups: { ...DEFAULT_SLACK_SETTINGS.groups, detailed: true, failure: false } };
  assert.equal(shouldNotify('api.request.completed', s), true);
  assert.equal(shouldNotify('task.failed', s), true, 'detailed does not care that failure is off');
});

test('settings from the table are read tolerantly, and a missing switch is never "on"', () => {
  const s = parseSlackSettings({ enabled: true, channel_label: '#ops', events: { task_completion: true, nonsense: true } });
  assert.equal(s.enabled, true);
  assert.equal(s.channelLabel, '#ops');
  assert.equal(s.groups.task_completion, true);
  assert.equal(s.groups.detailed, false);
  assert.deepEqual(parseSlackSettings(null), DEFAULT_SLACK_SETTINGS);
  assert.deepEqual(parseSlackSettings('garbage'), DEFAULT_SLACK_SETTINGS);
  assert.equal(parseSlackSettings({ enabled: 'true' }).enabled, false, 'a string is not a boolean');
});

// ── The store ───────────────────────────────────────────────────────────────

test('the store is a ring: newest first, filtered, capped', () => {
  const store = new EventStore(5);
  for (let i = 0; i < 8; i++) {
    store.push(ev({ id: `e${i}`, at: new Date(Date.parse(AT) + i * 1000).toISOString(), type: i % 2 ? 'task.failed' : 'task.completed', status: i % 2 ? 'failed' : 'success', taskId: `t${i % 3}` }));
  }
  assert.equal(store.size(), 5, 'the oldest three fell off');
  assert.equal(store.tail()[0].id, 'e7', 'newest first');
  assert.deepEqual(store.tail({ type: 'task.failed' }).map((e) => e.id), ['e7', 'e5', 'e3']);
  assert.deepEqual(store.tail({ type: 'task' }).length, 5, 'a prefix matches the family');
  assert.deepEqual(store.tail({ taskId: 't1' }).map((e) => e.id), ['e7', 'e4']);
  assert.deepEqual(store.tail({ limit: 2 }).length, 2);
  assert.deepEqual(store.tail({ since: new Date(Date.parse(AT) + 6000).toISOString() }).map((e) => e.id), ['e7', 'e6']);
});

// ── The recorder ────────────────────────────────────────────────────────────

test('one record() is a log line, a stored event, a row, and a Slack post when enabled', async () => {
  const lines: string[] = [];
  const rows = fakeFetch();
  const slackCalls = fakeFetch();
  const slack = new SlackNotifier('https://hooks.slack.com/services/T1/B1/x', slackCalls.impl);
  const rec = new EventRecorder({
    orchestrator: 'Test',
    timezone: 'Asia/Kolkata',
    sink: new SupabaseEventSink('https://db.example.co', 'service-key', rows.impl),
    slack,
    slackSettings: () => ({ ...DEFAULT_SLACK_SETTINGS, enabled: true, channelLabel: '#ops' }),
    log: (l) => lines.push(l),
  });
  rec.record({ type: 'task.failed', status: 'failed', title: 'Task Failed', reason: 'boom' });
  await rec.flush();

  assert.equal(lines.filter((l) => l.startsWith('[event] task.failed')).length, 1);
  assert.match(rows.calls[0].url, /\/rest\/v1\/orchestrator_events$/);
  assert.equal((rows.calls[0].body as { event_type: string }).event_type, 'task.failed');
  assert.equal(slackCalls.calls.length, 1, 'posted once');
  const all = rec.events.tail();
  assert.deepEqual(all.map((e) => e.type), ['slack.sent', 'task.failed'], 'the send is itself recorded, once');
  assert.equal(all[0].details, 'Task Failed to #ops');
  assert.equal(rows.calls.length, 2, 'and the slack.sent record is a row too');
  assert.equal(slackCalls.calls.length, 1, 'but the slack.sent record is not itself posted to Slack');
});

test('a Slack failure is recorded and counted, and never throws', async () => {
  const slackCalls = fakeFetch(404, 'no_service');
  const slack = new SlackNotifier('https://hooks.slack.com/services/T1/B1/x', slackCalls.impl);
  const rec = new EventRecorder({
    orchestrator: 'Test', timezone: 'UTC', slack,
    slackSettings: () => ({ ...DEFAULT_SLACK_SETTINGS, enabled: true }),
    log: () => undefined,
  });
  rec.record({ type: 'task.failed', status: 'failed', title: 'Task Failed' });
  await rec.flush();
  const sent = rec.events.tail({ type: 'slack.failed' });
  assert.equal(sent.length, 1);
  // The reason is what the token MEANS; "no_service" is a Slack code, not an explanation. The raw
  // text is kept beside it for whoever needs it.
  assert.match(sent[0].reason ?? '', /no longer recognises this webhook/);
  assert.match(sent[0].error ?? '', /404 no_service/);
  assert.equal(slack.stats().failures, 1);
});

test('a webhook anywhere but hooks.slack.com is not configured', async () => {
  const calls = fakeFetch();
  const s = new SlackNotifier('https://evil.example.com/hook', calls.impl);
  assert.equal(s.configured, false);
  assert.equal((await s.post(ev())).ok, false);
  assert.equal(calls.calls.length, 0, 'nothing was sent anywhere');
});

test('a webhook stored later takes effect without a restart, and a bad one is refused not stored', async () => {
  // The whole point of keeping it in Vault: an admin saves it on the website and delivery starts on
  // the next poll, on a machine they have no shell on.
  const calls = fakeFetch();
  const s = new SlackNotifier('', calls.impl);
  assert.equal(s.configured, false);
  assert.equal(s.stats().source, 'none');

  assert.deepEqual(s.setWebhook('https://evil.example.com/hook', 'vault'), { changed: false, valid: false });
  assert.equal(s.configured, false, 'a refused URL is not stored, so posts do not start failing instead');

  assert.deepEqual(s.setWebhook('https://hooks.slack.com/services/T1/B1/x', 'vault'), { changed: true, valid: true });
  assert.equal(s.configured, true);
  assert.equal(s.stats().source, 'vault');
  assert.equal((await s.post(ev())).ok, true);

  assert.equal(s.setWebhook('https://hooks.slack.com/services/T1/B1/x', 'vault').changed, false, 'the same URL is not a change');
  assert.deepEqual(s.setWebhook('', 'vault'), { changed: true, valid: true }, 'clearing it is allowed');
  assert.equal(s.configured, false);
  assert.equal(s.stats().source, 'none');
});

test('a new destination starts with a clean rate-limit slate', async () => {
  // What was held back was held back for the people watching the OLD channel. A new one has heard
  // none of it.
  const calls = fakeFetch();
  let now = 0;
  const s = new SlackNotifier('https://hooks.slack.com/services/T1/B1/old', calls.impl, () => now);
  const crash = () => ev({ type: 'orchestrator.unexpected_shutdown', severity: 'critical', title: 'Crash', reason: 'same' });
  for (let i = 0; i < 3; i++) await s.post(crash());
  assert.equal((await s.post(crash())).throttled, true);

  s.setWebhook('https://hooks.slack.com/services/T2/B2/new', 'vault');
  assert.equal((await s.post(crash())).ok, true, 'the new channel has not been told yet');
});

test('a flood of DIFFERENT events is held after the burst limit, with one line saying so; critical still goes', async () => {
  // Distinct reasons throughout, so this exercises the overall budget rather than the per-event
  // repeat cap above. Twenty different things going wrong is still twenty messages too many.
  const calls = fakeFetch();
  let now = 0;
  const s = new SlackNotifier('https://hooks.slack.com/services/T1/B1/x', calls.impl, () => now);
  const distinct = (i: number) => ev({ type: 'task.failed', severity: 'error', title: 'Task Failed', reason: `failure ${i}` });

  for (let i = 0; i < SLACK_BURST_LIMIT; i++) assert.equal((await s.post(distinct(i))).ok, true);
  const held = await s.post(distinct(100));
  assert.equal(held.throttled, true);
  assert.equal(calls.calls.length, SLACK_BURST_LIMIT + 1, 'one "being held" notice');
  await s.post(distinct(101));
  assert.equal(calls.calls.length, SLACK_BURST_LIMIT + 1, 'and only one');
  assert.equal(
    (await s.post(ev({ type: 'critical', severity: 'critical', title: 'Critical', reason: 'the roof is off' }))).ok,
    true,
    'critical is never held by the volume budget',
  );
  now = 11 * 60_000;
  assert.equal((await s.post(distinct(102))).ok, true, 'the window moved on');
});

test('a crash loop does not become a pager storm, but a new critical event still gets through', async () => {
  // Measured against a real incident on 2026-08-25: a port clash produced eight critical events in
  // five minutes, one per supervisor restart. Critical is exempt from the burst budget, so without
  // a repeat cap that is eight identical pages.
  const calls = fakeFetch();
  let now = 0;
  const s = new SlackNotifier('https://hooks.slack.com/services/T1/B1/x', calls.impl, () => now);
  const crash = () => ev({ type: 'orchestrator.unexpected_shutdown', severity: 'critical', title: 'Orchestrator Unexpected Shutdown', reason: 'Unhandled error in the process' });

  for (let i = 0; i < 3; i++) {
    now += 60_000;
    assert.equal((await s.post(crash())).ok, true, `crash ${i + 1} is news`);
  }
  now += 60_000;
  assert.equal((await s.post(crash())).throttled, true, 'the fourth is the same news');
  assert.equal(calls.calls.length, 4, 'and it says so, once');
  assert.match(String((calls.calls[3].body as { text: string }).text), /has now happened 4 times/);
  now += 60_000;
  assert.equal((await s.post(crash())).throttled, true);
  assert.equal(calls.calls.length, 4, 'and then stays quiet about it');

  // A DIFFERENT critical event is not what was throttled.
  const other = ev({ type: 'orchestrator.startup_failed', severity: 'critical', title: 'Orchestrator Failed To Start', reason: 'The MCP server could not be reached' });
  assert.equal((await s.post(other)).ok, true);

  now += 11 * 60_000;
  assert.equal((await s.post(crash())).ok, true, 'the window moved on');
});

test('secrets in a reason or detail are redacted before anything sees them', async () => {
  const rec = new EventRecorder({ orchestrator: 'T', timezone: 'UTC', log: () => undefined });
  const e = rec.record({ type: 'error', status: 'failed', title: 'x', reason: 'token ya29.abcdefghijklmnop failed', details: 'Bearer abcdefghijklmnopqrstuvwxyz', error: 'sk-abcdefghijklmnopqrstuvwxyz0123' });
  assert.doesNotMatch(e.reason ?? '', /ya29\./);
  assert.doesNotMatch(e.details ?? '', /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(e.error ?? '', /sk-abc/);
});

test('a row write failure is counted on the sink and does not throw', async () => {
  const sink = new SupabaseEventSink('https://db.example.co', 'k', fakeFetch(500, 'boom').impl);
  await sink.write(ev());
  assert.equal(sink.stats().failures, 1);
  const off = new SupabaseEventSink('', '', fakeFetch().impl);
  assert.equal(off.isEnabled(), false);
});

// ── Health ──────────────────────────────────────────────────────────────────

test('health names the state and the reason', () => {
  const base = { paused: false, supabaseReachable: true, sinkFailures: 0, sinkFailuresBefore: 0, slackFailures: 0, slackFailuresBefore: 0, mcpSessions: 2 };
  assert.deepEqual(deriveHealth(base), { state: 'healthy', reason: 'All services available' });
  assert.equal(deriveHealth({ ...base, paused: true }).state, 'paused');
  assert.equal(deriveHealth({ ...base, supabaseReachable: false }).state, 'failed');
  assert.equal(deriveHealth({ ...base, sinkFailures: 3 }).state, 'warning');
  assert.equal(deriveHealth({ ...base, sinkFailures: 3, sinkFailuresBefore: 3 }).state, 'healthy', 'old failures are not a current warning');
  assert.equal(deriveHealth({ ...base, slackFailures: 1 }).state, 'warning');
});
