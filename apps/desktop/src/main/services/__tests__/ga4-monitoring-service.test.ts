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
  svc.setWebhook('https://hooks.slack.com/services/T/B/x');

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
  svc.setWebhook('https://hooks.slack.com/services/T/B/x');

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

test('one property, one channel: a property with its OWN webhook posts there; others fall back to the default', async () => {
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
    slackEnabled: true, enabled: false,
  });
  svc.setWebhook('https://hooks.slack.com/services/T/B/default'); // account default
  svc.setWebhook('https://hooks.slack.com/services/T/B/acme-own', 'properties/1'); // Acme's own channel

  const st = svc.status();
  assert.equal(secrets.get('ga4-slack-webhook:acct1:properties/1'), 'https://hooks.slack.com/services/T/B/acme-own', 'own channel stored per account+property');
  assert.equal(st.targetStatuses.find((t) => t.propertyId === 'properties/1')!.hasWebhook, true, 'Acme shows its own channel');
  assert.equal(st.targetStatuses.find((t) => t.propertyId === 'properties/2')!.hasWebhook, false, 'Beta shows fallback');

  await svc.runOnce();
  assert.deepEqual(sentTo, ['https://hooks.slack.com/services/T/B/acme-own', 'https://hooks.slack.com/services/T/B/default'], 'Acme posts to its own channel, Beta to the default');

  // sendTest(propertyId) exercises the same routing.
  sentTo.length = 0;
  await svc.sendTest('properties/1');
  await svc.sendTest('properties/2');
  assert.deepEqual(sentTo, ['https://hooks.slack.com/services/T/B/acme-own', 'https://hooks.slack.com/services/T/B/default'], 'per-property test posts to the effective channel');

  // Removing the property's channel falls back to the default (and a re-test proves it).
  svc.clearWebhook('properties/1');
  assert.equal(svc.status().targetStatuses[0].hasWebhook, false, 'own channel removed');
  sentTo.length = 0;
  await svc.sendTest('properties/1');
  assert.deepEqual(sentTo, ['https://hooks.slack.com/services/T/B/default'], 'falls back to the default channel');
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

test('sendTest posts a confirmation to the webhook, and fails cleanly when none is stored', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {},
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });
  // No webhook yet → clean failure, no POST.
  const noHook = await svc.sendTest();
  assert.ok(!noHook.ok && /No Slack webhook/.test(noHook.error ?? ''), JSON.stringify(noHook));
  assert.equal(posts.length, 0, 'no POST without a webhook');
  // With a webhook → posts a test message naming the property.
  svc.setWebhook('https://hooks.slack.com/services/T/B/x');
  const ok = await svc.sendTest();
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
