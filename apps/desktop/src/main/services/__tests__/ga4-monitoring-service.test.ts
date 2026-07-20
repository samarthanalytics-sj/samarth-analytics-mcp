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

test('per-property notify: legacy global toggles SEED targets once; alerts can be muted per property', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  // Old-shape config: targets WITHOUT notify + the old global toggles -> seeded per target.
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, digestEnabled: true, auditEnabled: false });
  const seeded = svc.status().targets[0].notify!;
  assert.deepEqual(seeded, { alerts: true, digest: true, audit: false }, 'seeded from the legacy globals');

  // Mute alerts on THIS property only: the sweep still runs, nothing posts.
  svc.setWebhook('https://hooks.slack.com/services/T/B/acme', 'properties/1');
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true, notify: { alerts: false, digest: false, audit: false } }] });
  const [run] = await svc.runOnce();
  assert.ok(run && run.alerts.length > 0, 'the health check still finds the issue');
  assert.equal(run.slackSent, 0, 'muted property posts nothing');
  assert.equal(posts.length, 0, 'no Slack POST at all');
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

  // Enable the digest on the TARGET (notification choices live per property now).
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true, notify: { alerts: true, digest: true, audit: false } }] });
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

test('weekly scheduled audit: runs once per property per 7 days, posts the exec summary, survives failures', async () => {
  const secrets = makeSecrets();
  const posts: string[] = [];
  const auditCalls: string[] = [];
  let auditShouldFail = false;
  let nowMs = Date.parse('2026-07-02T09:00:00Z');
  const fakeExec = {
    propertyName: 'Acme', propertyId: '1', auditId: 'GA4-1-20260701', dateRange: 'Jun 4 - Jul 1, 2026 (28 days)',
    composite: 76, grade: 'B', reliabilityPct: 58, reliabilityConfidence: 'High confidence', reliabilityCappedBy: [],
    verdict: 'Trustworthy within the verified scope.', biggestRisk: 'None material.', highestImpactFix: 'Enable BigQuery export.',
    coverage: { checked: 12, partial: 2, notVerified: 2 }, categories: [], trust: [],
  };
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => nowMs,
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
    runAudit: async (property) => {
      auditCalls.push(property);
      if (auditShouldFail) throw new Error('quota exhausted');
      return fakeExec as never;
    },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/acme', 'properties/1');

  // OFF by default: sweeps never run the audit.
  await svc.runOnce();
  assert.equal(auditCalls.length, 0, 'no audit when disabled');

  // Enabled on the TARGET: the next sweep runs it once and posts the exec summary.
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true, notify: { alerts: true, digest: false, audit: true } }] });
  await svc.runOnce();
  assert.deepEqual(auditCalls, ['properties/1'], 'audit ran for the property');
  const auditPosts = posts.filter((b) => b.includes('Weekly GA4 audit'));
  assert.equal(auditPosts.length, 1, 'exec summary posted');
  assert.ok(auditPosts[0].includes('58%'), 'summary carries the reliability number');
  assert.ok(auditPosts[0].includes('Biggest risk'), 'summary carries the risk line');
  assert.equal(svc.status().targetStatuses[0].lastAuditAt, nowMs, 'lastAuditAt persisted');

  // Not due tomorrow; due again after 7 days.
  nowMs += 24 * 60 * 60 * 1000;
  await svc.runOnce();
  assert.equal(auditCalls.length, 1, 'not due after 1 day');
  nowMs += 6 * 24 * 60 * 60 * 1000;
  auditShouldFail = true;
  await svc.runOnce();
  assert.equal(auditCalls.length, 2, 'due again after 7 days');
  // A failing audit records the error on the target but never breaks the health sweep.
  const st = svc.status().targetStatuses[0];
  assert.ok(/weekly audit: quota exhausted/.test(st.lastError ?? ''), 'audit failure surfaced as lastError');
  assert.ok(st.lastRun, 'the health check itself still completed');
});

test('consent probe: runs at most once per target per 24h, caches between sweeps, remembers the prior verdict', async () => {
  const secrets = makeSecrets();
  let nowMs = Date.parse('2026-07-02T09:00:00Z');
  let probeCalls = 0;
  let probeResult: { observedHit: boolean; gcsPresent: boolean; gcs: string | null } | null = { observedHit: true, gcsPresent: true, gcs: 'G111' };
  const data = fakeData();
  (data as { getGa4PropertySnapshot: unknown }).getGa4PropertySnapshot = async () => ({
    displayName: 'Acme', keyEvents: [{ eventName: 'purchase' }],
    dataStreams: [{ name: 'p/1/ds/9', displayName: 'Web', type: 'WEB_DATA_STREAM', defaultUri: 'https://acme.example', enhancedMeasurementEnabled: true }],
  });
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data, secrets, emit: () => {},
    now: () => nowMs,
    probeConsent: async () => { probeCalls++; return probeResult; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });

  const [run1] = await svc.runOnce();
  assert.equal(probeCalls, 1, 'probe ran on the first sweep');
  assert.equal(run1.checks.find((c) => c.id === 'consent_signal')!.status, 'pass', 'signal present');

  // Same day: cached verdict feeds the check, no second page load.
  nowMs += 60 * 60 * 1000;
  const [run2] = await svc.runOnce();
  assert.equal(probeCalls, 1, 'throttled within 24h');
  assert.equal(run2.checks.find((c) => c.id === 'consent_signal')!.status, 'pass', 'cached verdict still feeds the check');

  // Next day the signal is GONE: the service passes the prior verdict so the engine grades MEDIUM.
  nowMs += 24 * 60 * 60 * 1000;
  probeResult = { observedHit: true, gcsPresent: false, gcs: null };
  const [run3] = await svc.runOnce();
  assert.equal(probeCalls, 2, 'probe re-ran after 24h');
  const alert = run3.alerts.find((a) => a.kind === 'consent_signal');
  assert.ok(alert && alert.severity === 'medium', 'regression graded MEDIUM: ' + JSON.stringify(alert));
  assert.ok(/LOST/.test(alert!.title));
});

test('bigquery-link memory: a link seen on one sweep and gone on the next raises the removal alert', async () => {
  const secrets = makeSecrets();
  let nowMs = Date.parse('2026-07-02T09:00:00Z');
  let links: Array<{ project: string; dailyExportEnabled: boolean; streamingExportEnabled: boolean }> = [
    { project: 'proj-a', dailyExportEnabled: true, streamingExportEnabled: false },
  ];
  const data = fakeData();
  (data as { getGa4PropertySnapshot: unknown }).getGa4PropertySnapshot = async () => ({
    displayName: 'Acme', keyEvents: [{ eventName: 'purchase' }], dataStreams: [], bigQueryLinks: links,
  });
  const svc = new Ga4MonitoringService({ registry: { getActiveView: () => account }, data, secrets, emit: () => {}, now: () => nowMs });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });

  const [run1] = await svc.runOnce();
  assert.equal(run1.checks.find((c) => c.id === 'bigquery')!.status, 'pass', 'link live on the first sweep');
  assert.ok(!run1.alerts.some((a) => a.kind === 'bigquery_export'), 'no alert while the link is healthy');

  nowMs += 60 * 60 * 1000;
  links = [];
  const [run2] = await svc.runOnce();
  const alert = run2.alerts.find((a) => a.kind === 'bigquery_export');
  assert.ok(alert && alert.severity === 'medium', 'removal alert fires: ' + JSON.stringify(run2.alerts.map((a) => a.id)));
  assert.equal(run2.checks.find((c) => c.id === 'bigquery')!.status, 'fail');
});

test('monitor window is LIVE and property-timezone anchored: ends on the dq todayYmd, not a UTC date', async () => {
  const secrets = makeSecrets();
  const data = fakeData();
  const captured: Array<{ s: string; e: string }> = [];
  const orig = data.getGa4Baseline.bind(data);
  (data as { getGa4Baseline: typeof data.getGa4Baseline }).getGa4Baseline = async (p: string, s: string, e: string) => { captured.push({ s, e }); return orig(p, s, e); };
  (data as { getGa4PropertySnapshot: unknown }).getGa4PropertySnapshot = async () => ({
    displayName: 'Acme', keyEvents: [{ eventName: 'purchase' }], timeZone: 'Asia/Kolkata',
  });
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account }, data, secrets, emit: () => {},
    // The machine's UTC clock still reads Jul 1 evening; the property's day (per dq todayYmd) is Jul 2.
    now: () => Date.parse('2026-07-01T20:30:00Z'),
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });

  const [run] = await svc.runOnce();
  assert.equal(captured[0].e, '2026-07-02', "baseline ends TODAY in the property's timezone (live, unlike the audit's today-1)");
  assert.equal(captured[0].s, '2026-06-04', 'same day-span, anchored to the property day');
  assert.equal(run.timeZone, 'Asia/Kolkata', "the run carries the property's reporting timezone for the UI");
});

test('monthly report: first sweep only starts the clock; it posts after 30 days and records the issue history', async () => {
  const secrets = makeSecrets();
  let nowMs = Date.parse('2026-07-02T09:00:00Z');
  const posts: string[] = [];
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets,
    emit: () => {},
    now: () => nowMs,
    slackFetch: async (_url, init) => { posts.push(init.body); return { ok: true, status: 200, text: async () => 'ok' }; },
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], slackEnabled: true, enabled: false });
  svc.setWebhook('https://hooks.slack.com/services/T/B/x', 'properties/1');

  await svc.runOnce();
  assert.ok(!posts.some((b) => b.includes('Monthly tracking report')), 'first sweep starts the clock, does not send');
  const t1 = svc.status().targets.find((t) => t.propertyId === 'properties/1')!;
  assert.ok(t1.lastMonthlyAt, 'clock seeded');
  assert.ok((t1.issueLog ?? []).some((e) => e.id === 'no_data' && !e.closedAt), 'issue history records the open no-data alert');

  nowMs += 31 * 24 * 60 * 60 * 1000;
  await svc.runOnce();
  const monthly = posts.find((b) => b.includes('Monthly tracking report'));
  assert.ok(monthly, 'monthly posted once due: ' + posts.length);
  assert.ok(/still open/.test(monthly!), 'verdict counts the open issue');
  assert.ok(monthly!.includes('One recommendation for next month'), 'exactly one recommendation');

  // Not again on the next sweep.
  const before = posts.filter((b) => b.includes('Monthly tracking report')).length;
  await svc.runOnce();
  assert.equal(posts.filter((b) => b.includes('Monthly tracking report')).length, before, 'no repeat inside 30 days');
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

test('run history: each sweep appends one entry (score/counts/duration/trigger); manual vs scheduled recorded', async () => {
  let now = Date.parse('2026-07-02T09:00:00Z');
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets: makeSecrets(),
    emit: () => {},
    now: () => now,
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });

  const [r1] = await svc.runOnce(); // default: a timer/boot sweep → scheduled
  assert.equal(r1.trigger, 'scheduled', 'default trigger is scheduled');
  assert.ok(typeof r1.score === 'number' && r1.score >= 0 && r1.score <= 100, `score in range: ${r1.score}`);
  assert.ok(typeof r1.durationMs === 'number' && r1.durationMs >= 0, 'duration stamped');

  now += 60_000;
  await svc.runOnce('properties/1', 'manual'); // the Run-now click path

  const t = svc.status().targetStatuses[0];
  const hist = t.history ?? [];
  assert.equal(hist.length, 2, 'one entry per completed run');
  assert.equal(hist[0].trigger, 'scheduled');
  assert.equal(hist[1].trigger, 'manual');
  assert.equal(hist[1].at, now, 'entry timestamped with the run time');
  assert.equal(hist[1].score, t.lastRun?.score, 'history score matches the run');
  assert.equal(hist[1].health, t.lastRun?.health, 'history health matches the run');
  assert.equal(
    hist[1].critical,
    (t.lastRun?.alerts ?? []).filter((a) => a.severity === 'critical' || a.severity === 'high').length,
    'critical column counts critical + high alerts',
  );
  assert.equal(
    hist[1].warnings,
    (t.lastRun?.alerts ?? []).filter((a) => a.severity === 'medium' || a.severity === 'low').length,
    'warnings column counts medium + low alerts',
  );
});

test('configure() echo of a STALE targets copy never rolls back server-owned fields (history survives)', async () => {
  const svc = new Ga4MonitoringService({
    registry: { getActiveView: () => account },
    data: fakeData(),
    secrets: makeSecrets(),
    emit: () => {},
    now: () => Date.parse('2026-07-02T09:00:00Z'),
  });
  svc.configure({ targets: [{ propertyId: 'properties/1', propertyLabel: 'Acme', enabled: true }], enabled: false });
  // The renderer snapshots targets (e.g. for a later Pause click) BEFORE the run records history.
  const stale = JSON.parse(JSON.stringify(svc.status().targets)) as typeof svc.status.prototype;
  await svc.runOnce();
  const before = svc.status().targetStatuses[0].history?.length ?? 0;
  assert.ok(before >= 1, 'run recorded history');
  // The stale echo (with a legitimate renderer-owned change: pause) must not erase the history.
  svc.configure({ targets: (stale as unknown as Array<Record<string, unknown>>).map((x) => ({ ...x, enabled: false })) as never });
  const t = svc.status().targetStatuses[0];
  assert.equal(t.enabled, false, 'renderer-owned field (pause) applied');
  assert.equal(t.history?.length ?? 0, before, 'server-owned history preserved despite the stale echo');
});
