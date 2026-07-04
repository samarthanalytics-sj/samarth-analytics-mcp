import assert from 'node:assert/strict';
import { Ga4MonitoringService } from '../ga4-monitoring-service';
import type { GoogleDataService } from '../../google/data-service';
import type { AccountView, Ga4MonitorRun } from '../../shared/ipc';

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
  svc.configure({ propertyId: 'properties/1', propertyLabel: 'Acme', slackEnabled: true, enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x');

  const run1 = await svc.runOnce();
  assert.ok(run1, 'run produced');
  assert.equal(run1.health, 'critical');
  assert.ok(run1.alerts.some((a) => a.kind === 'no_data'), 'no_data alert: ' + JSON.stringify(run1.alerts.map((a) => a.kind)));
  assert.ok(run1.newAlertIds.includes('no_data'), 'the no_data alert is new on run 1');
  assert.equal(run1.newAlertIds.length, run1.alerts.length, 'every alert is new on the first run');
  assert.equal(run1.slackSent, 1, 'Slacked once');
  assert.equal(posts.length, 1, 'a single Slack POST carries all the new alerts');

  const run2 = await svc.runOnce();
  assert.ok(run2 && run2.alerts.some((a) => a.kind === 'no_data'), 'still failing');
  assert.deepEqual(run2.newAlertIds, [], 'no NEW alerts on run 2');
  assert.equal(run2.slackSent, 0, 'no repeat Slack for the ongoing issue');
  assert.equal(posts.length, 1, 'still just one POST total');
  assert.equal(emitted.length, 2, 'both runs broadcast to the renderer');
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
  svc.configure({ propertyId: 'properties/1', slackEnabled: true, enabled: false });
  const run = await svc.runOnce();
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

test('runOnce is a no-op without an active signed-in account or a chosen property', async () => {
  const secrets = makeSecrets();
  const noProp = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data: fakeData(), secrets, emit: () => {} });
  assert.equal(await noProp.runOnce(), null, 'no property set → null');
  const noAcct = new Ga4MonitoringService({ registry: { getActiveView: () => null }, data: fakeData(), secrets, emit: () => {} });
  noAcct.configure({ propertyId: 'properties/1', enabled: false });
  assert.equal(await noAcct.runOnce(), null, 'no active account → null');
});
