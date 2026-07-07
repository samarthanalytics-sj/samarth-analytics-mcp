import assert from 'node:assert/strict';
import { Ga4MonitoringService } from '../ga4-monitoring-service';
import type { GoogleDataService } from '../../google/data-service';
import type { AccountView, Ga4MonitorRun } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
let pending = 0;
function done(): void { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); }
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) done(); });
}

// A fake data-service that returns a property with NO data on the last complete day (a no-data alert)
// but steady events otherwise → exactly one alert (no_data), so dedup is easy to assert.
const fakeData = (): GoogleDataService => ({
  getGa4PropertySnapshot: async () => ({ displayName: 'Acme', keyEvents: [{ eventName: 'purchase' }] }),
  getGa4DataQuality: async () => ({ totalSessions: 9000, channelGroups: [{ name: 'Organic Search', sessions: 9000 }], sourceMediums: [], windowDays: 28, startDate: '2026-06-04', endDate: '2026-07-01', todayYmd: '2026-07-02' }),
  runGa4RealtimeReport: async () => ({ dimensionHeaders: [], metricHeaders: ['activeUsers'], rows: [{ dimensions: [], metrics: ['0'] }] }),
  getGa4Baseline: async () => ({
    sessions: 9000, priorSessions: 9500, keyEvents: 400, priorKeyEvents: 410, revenue: 100000, priorRevenue: 105000,
    dailySessions: [
      { date: '20260627', sessions: 330 }, { date: '20260628', sessions: 340 }, { date: '20260629', sessions: 335 },
      { date: '20260630', sessions: 345 }, { date: '20260701', sessions: 0 },
    ],
    peakDayChannels: null, channelPerformance: [{ channel: 'Organic Search', sessions: 9000, keyEvents: 400, convRate: 0.04, revenue: 100000, engagementRate: 0.6 }],
    newVsReturning: [],
  }),
  getGa4EventDeltas: async () => ({ events: [{ name: 'purchase', count: 400, priorCount: 410 }] }),
  getGa4Transactions: async () => ({ transactions: [], notSetShare: 0 }),
} as unknown as GoogleDataService);

const account: AccountView = { id: 'acct1', email: 'a@b.com', createdAt: 0, isActive: true, hasGoogleToken: true };
const makeSecrets = () => {
  const map = new Map<string, string>();
  return { store: map, get: (r: string) => map.get(r) ?? null, has: (r: string) => map.has(r), set: (r: string, v: string) => { map.set(r, v); }, delete: (r: string) => { map.delete(r); }, available: () => true };
};

console.log('\nGA4 monitoring service:');

test('per-account scoping: a property added under one mail is invisible (and never swept) under another', async () => {
  const accountB: AccountView = { id: 'acct2', email: 'b@c.com', createdAt: 0, isActive: true, hasGoogleToken: true };
  let current: AccountView = account; // acct1 active first
  const swept: string[] = [];
  const data = fakeData();
  const orig = data.getGa4Baseline.bind(data);
  (data as { getGa4Baseline: typeof data.getGa4Baseline }).getGa4Baseline = async (p: string, s: string, e: string) => { swept.push(p); return orig(p, s, e); };
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => current },
    data, secrets: makeSecrets(), emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
  });

  // acct1 adds P1.
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme (acct1)', enabled: true }], enabled: false });
  assert.equal(svc.status().targetStatuses.length, 1, 'acct1 sees its property');

  // Switch to acct2: NOTHING of acct1's is visible or sweepable.
  current = accountB;
  assert.equal(svc.status().targetStatuses.length, 0, 'acct2 sees no acct1 properties');
  assert.deepEqual(await svc.runOnce(), [], 'a sweep under acct2 never queries acct1 properties');
  assert.ok(!swept.includes('properties/1') || swept.length === 1, 'no cross-account query yet');

  // acct2 adds its own property; the lists stay independent.
  svc.configure({ targets: [{ propertyId: 'properties/2', propertyLabel: 'Beta (acct2)', enabled: true }], enabled: false });
  assert.deepEqual(svc.status().targetStatuses.map((t) => t.propertyId), ['properties/2'], 'acct2 sees only its own');
  const runsB = await svc.runOnce();
  assert.deepEqual(runsB.map((r) => r.property), ['properties/2'], 'acct2 sweep covers only its own');

  // Back to acct1: its property (and only its property) is still there, untouched by acct2's configure.
  current = account;
  assert.deepEqual(svc.status().targetStatuses.map((t) => t.propertyId), ['properties/1'], 'acct1 list preserved across the switch');
  const runsA = await svc.runOnce();
  assert.deepEqual(runsA.map((r) => r.property), ['properties/1'], 'acct1 sweep covers only its own');
});

test('weekly digest: posts once per property per 7 days to its own channel, persists lastDigestAt, off by default', async () => {
  const secrets = makeSecrets();
  const posts: Array<{ url: string; body: string }> = [];
  let nowMs = Date.parse('2026-07-02T09:00:00Z');
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => nowMs,
    slackFetch: async (url, init) => { posts.push({ url: String(url), body: init.body }); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/acme', 'properties/1');

  // Digest OFF by default: only the alert posts.
  await svc.runOnce();
  assert.equal(posts.filter((x) => x.body.includes('Weekly health digest')).length, 0, 'no digest when disabled');

  // Enable the digest: the next sweep posts one (first-ever digest is immediately due).
  svc.configure({ digestEnabled: true });
  await svc.runOnce();
  const digests = posts.filter((x) => x.body.includes('Weekly health digest'));
  assert.equal(digests.length, 1, 'one digest after enabling');
  assert.ok(digests[0].url.endsWith('/acme'), 'digest posts to the property own channel');
  assert.ok(digests[0].body.includes('Acme'), 'digest names the property');
  assert.ok(digests[0].body.includes('Checks:'), 'digest carries the check counts');
  const st = svc.status().targetStatuses[0];
  assert.equal(st.lastDigestAt, nowMs, 'lastDigestAt persisted on the target');

  // 1 day later: not due -> no second digest. 7 days later: due again.
  nowMs += 24 * 60 * 60 * 1000;
  await svc.runOnce();
  assert.equal(posts.filter((x) => x.body.includes('Weekly health digest')).length, 1, 'not due after 1 day');
  nowMs += 6 * 24 * 60 * 60 * 1000;
  await svc.runOnce();
  assert.equal(posts.filter((x) => x.body.includes('Weekly health digest')).length, 2, 'due again after 7 days');
});

test('a new issue Slacks once; the same ongoing issue does not re-Slack on the next run', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const emitted: Ga4MonitorRun[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: (r) => emitted.push(r),
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', 'properties/1');

  const [run1] = await svc.runOnce();
  assert.ok(run1, 'run produced');
  assert.equal(run1.health, 'critical');
  assert.ok(run1.alerts.some((a) => a.kind === 'no_data'), 'no_data alert: ' + JSON.stringify(run1.alerts.map((a) => a.kind)));
  assert.ok(run1.newAlertIds.includes('no_data'), 'the no_data alert is new on run 1');
  assert.equal(run1.newAlertIds.length, run1.alerts.length, 'every alert is new on the first run');
  assert.equal(run1.slackSent, 1, 'Slacked once');
  assert.equal(posts.length, 1, 'a single Slack POST carries all the new alerts');

  const [run2] = await svc.runOnce();
  assert.ok(run2 && run2.alerts.some((a) => a.kind === 'no_data'), 'still failing');
  assert.deepEqual(run2.newAlertIds, [], 'no NEW alerts on run 2');
  assert.equal(run2.slackSent, 0, 'no repeat Slack for the ongoing issue');
  assert.equal(posts.length, 1, 'still just one POST total');
  assert.equal(emitted.length, 2, 'both runs broadcast to the renderer');
  // lastSlackAt records WHEN the alert actually posted, and does not move on no-send runs.
  const ts = svc.status().targetStatuses[0];
  assert.equal(ts.lastSlackAt, Date.parse('2026-07-02T09:00:00Z'), 'lastSlackAt set by the send');
  assert.equal(svc.status().lastSlackAt, ts.lastSlackAt, 'status rolls up the most recent Slack send');
});

test('multi-property: a sweep runs every enabled target with INDEPENDENT alert dedup + one Slack per property', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const emitted: Ga4MonitorRun[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: (r) => emitted.push(r),
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({
    targets: [
      { propertyId: 'properties/1', propertyLabel: 'Acme Store', enabled: true },
      { propertyId: 'properties/2', propertyLabel: 'Beta Store', enabled: true },
    ],
    slackEnabled: true, enabled: false,
  });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', 'properties/1');
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', 'properties/2');

  const sweep1 = await svc.runOnce();
  assert.equal(sweep1.length, 2, 'both targets checked');
  assert.deepEqual(sweep1.map((r) => r.property), ['properties/1', 'properties/2'], 'sequential, in config order');
  assert.ok(sweep1.every((r) => r.newAlertIds.length > 0), 'each property gets its OWN first-run new alerts');
  assert.equal(posts.length, 2, 'one Slack POST per property');
  assert.ok(posts[0].includes('Acme Store') && posts[1].includes('Beta Store'), 'each POST names its property');

  const sweep2 = await svc.runOnce();
  assert.ok(sweep2.every((r) => r.newAlertIds.length === 0), 'ongoing issues are not NEW on either property');
  assert.equal(posts.length, 2, 'no repeat Slack for ongoing issues');
  assert.equal(emitted.length, 4, 'every run of every sweep is broadcast');

  const st = svc.status();
  assert.equal(st.targetStatuses.length, 2, 'status carries per-target statuses');
  assert.ok(st.targetStatuses.every((t) => t.lastRun !== null && t.lastRunAt !== null), 'each target keeps its own lastRun');
});

test('multi-property: runOnce(propertyId) runs ONLY that target; a paused target is skipped by sweeps but runnable on demand', async () => {
  const secrets = makeSecrets();
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
  });
  svc.configure({
    targets: [
      { propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true },
      { propertyId: 'properties/2', propertyLabel: 'Beta', enabled: false }, // paused
    ],
    enabled: false,
  });
  const sweep = await svc.runOnce();
  assert.deepEqual(sweep.map((r) => r.property), ['properties/1'], 'a sweep skips the paused target');
  const manual = await svc.runOnce('properties/2');
  assert.deepEqual(manual.map((r) => r.property), ['properties/2'], 'a manual run still checks the paused target');
  const one = await svc.runOnce('properties/1');
  assert.equal(one.length, 1, 'single-target run checks exactly one');
});

test('one property, one channel: own webhooks route per property; a legacy DEFAULT webhook migrates onto channel-less properties and is deleted', async () => {
  const secrets = makeSecrets();
  const sentTo: string[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async (url) => { sentTo.push(String(url)); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({
    targets: [
      { propertyId: 'properties/1', propertyLabel: 'Acme Store', enabled: true },
      { propertyId: 'properties/2', propertyLabel: 'Beta Store', enabled: true },
    ],
    slackEnabled: true, slackLabel: '#old-default', enabled: false,
  });
  // Legacy layout: an account-level default + one property with its own channel.
  svc.setWebhook('https://hooks.slack.com/services/T/B/default'); // legacy account-level
  svc.setWebhook('https://hooks.slack.com/services/T/B/acme-own', 'properties/1'); // Acme's own

  // status() triggers the migration: the default URL becomes Beta's OWN channel (with the old global
  // label), Acme keeps its own, and the legacy account-level secret is deleted.
  const st = svc.status();
  assert.equal(secrets.get('ga4-slack-webhook:acct1:properties/1'), 'https://hooks.slack.com/services/T/B/acme-own', 'own channel untouched');
  assert.equal(secrets.get('ga4-slack-webhook:acct1:properties/2'), 'https://hooks.slack.com/services/T/B/default', 'default migrated to the channel-less property');
  assert.ok(!secrets.has('ga4-slack-webhook:acct1'), 'legacy account-level secret deleted');
  assert.ok(st.targetStatuses.every((t) => t.hasWebhook), 'both properties now show their own channel');
  assert.equal(st.targets.find((t) => t.propertyId === 'properties/2')!.slackLabel, '#old-default', 'migrated channel inherits the old global label');
  assert.equal(st.hasWebhook, false, 'no account-level webhook remains');

  // A sweep posts each property to ITS channel.
  await svc.runOnce();
  assert.deepEqual(sentTo, ['https://hooks.slack.com/services/T/B/acme-own', 'https://hooks.slack.com/services/T/B/default'], 'each property posts to its own channel');

  // Removing a property's channel means NO alerts for it (there is no fallback any more).
  svc.clearWebhook('properties/1');
  assert.equal(svc.status().targetStatuses[0].hasWebhook, false, 'own channel removed');
  sentTo.length = 0;
  const t1 = await svc.sendTest('properties/1');
  assert.ok(!t1.ok && /No Slack channel is connected for this property/.test(t1.error ?? ''), JSON.stringify(t1));
  assert.deepEqual(sentTo, [], 'nothing posted without an own channel');
  // A propertyId-less test is no longer meaningful.
  const t0 = await svc.sendTest();
  assert.ok(!t0.ok && /Pick a property/.test(t0.error ?? ''), JSON.stringify(t0));
});

test('removing a monitored property also deletes its per-property webhook secret', async () => {
  const secrets = makeSecrets();
  const svc = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {} });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/own', 'properties/1');
  assert.ok(secrets.has('ga4-slack-webhook:acct1:properties/1'), 'secret stored');
  svc.configure({ targets: [] });
  assert.ok(!secrets.has('ga4-slack-webhook:acct1:properties/1'), 'secret deleted with the target');
});

test('no channels at all: a property-level sendTest fails cleanly and a sweep sends nothing', async () => {
  const secrets = makeSecrets();
  let posted = false;
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async () => { posted = true; return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, enabled: false });
  const t = await svc.sendTest('properties/1');
  assert.ok(!t.ok && /No Slack channel is connected for this property/.test(t.error ?? ''), JSON.stringify(t));
  await svc.runOnce();
  assert.equal(posted, false, 'nothing posted with no channels');
});

test('legacy single-property config ({propertyId}) migrates to a one-entry targets list', async () => {
  const svc = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets: makeSecrets(), emit: () => {} });
  // Old persisted shape arrives as a patch over an empty-targets config (same merge path as load).
  const st = svc.configure({ propertyId: 'properties/9', propertyLabel: 'Legacy Store' } as never);
  assert.equal(st.targets.length, 1, 'migrated to one target');
  assert.equal(st.targets[0].propertyId, 'properties/9');
  assert.equal(st.targets[0].propertyLabel, 'Legacy Store');
  assert.equal(st.targets[0].enabled, true, 'migrated target is enabled');
});

test('with no webhook stored, runs still complete and broadcast but send no Slack', async () => {
  const secrets = makeSecrets();
  let posted = false;
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async () => { posted = true; return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: '', enabled: true }], slackEnabled: true, enabled: false });
  const [run] = await svc.runOnce();
  assert.ok(run && run.alerts.length, 'issue found');
  assert.equal(run.slackSent, 0, 'nothing sent without a webhook');
  assert.equal(posted, false, 'fetch never called');
  assert.equal(svc.status().hasWebhook, false, 'status reflects no webhook');
});

test('setWebhook rejects a non-Slack URL and stores a valid one', async () => {
  const secrets = makeSecrets();
  const svc = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {} });
  assert.throws(() => svc.setWebhook('https://example.com/x'), /valid Slack Incoming Webhook/);
  const st = svc.setWebhook('https://hooks.slack.com/services/T/B/x');
  assert.equal(st.hasWebhook, true);
  assert.equal(secrets.get('ga4-slack-webhook:acct1'), 'https://hooks.slack.com/services/T/B/x');
  svc.clearWebhook();
  assert.equal(svc.status().hasWebhook, false, 'clearWebhook removes it');
});

test('sendTest posts a confirmation to the property channel, and fails cleanly when none is stored', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {},
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });
  // No channel yet -> clean failure, no POST.
  const noHook = await svc.sendTest('properties/1');
  assert.ok(!noHook.ok && /No Slack channel is connected/.test(noHook.error ?? ''), JSON.stringify(noHook));
  assert.equal(posts.length, 0, 'no POST without a channel');
  // With the property's own channel -> posts a test message naming the property.
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', 'properties/1');
  const ok = await svc.sendTest('properties/1');
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(posts.length, 1, 'one test POST');
  assert.ok(posts[0].includes('Acme'), 'the test message names the property');
});

test('slackLabel round-trips through configure and status', async () => {
  const svc = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets: makeSecrets(), emit: () => {} });
  const st = svc.configure({ slackLabel: '#ga4-alerts · Acme' });
  assert.equal(st.slackLabel, '#ga4-alerts · Acme', 'label persists in status');
});

test('runOnce is a no-op without an active signed-in account or any monitored property', async () => {
  const secrets = makeSecrets();
  const noProp = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {} });
  assert.deepEqual(await noProp.runOnce(), [], 'no properties → empty sweep');
  const noAcct = new Ga4MonitoringService({ registry: { getActiveView: () => null }, data: fakeData(), secrets, emit: () => {} });
  noAcct.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: '', enabled: true }], enabled: false });
  assert.deepEqual(await noAcct.runOnce(), [], 'no active account → empty sweep');
});
