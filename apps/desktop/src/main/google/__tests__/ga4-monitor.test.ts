import assert from 'node:assert/strict';
import { monitorGa4, firstMetric, type Ga4MonitorInput } from '../ga4-monitor';
import type { Ga4Baseline } from '../data-service';
import type { DataQualityCounts } from '../ga4-data-quality';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// A healthy baseline: steady daily sessions, outcomes moving with traffic. Tests override the fields
// they exercise.
const baseline = (over: Partial<Ga4Baseline> = {}): Ga4Baseline => ({
  startDate: '2026-06-01', endDate: '2026-06-30', priorStartDate: '2026-05-01', priorEndDate: '2026-05-31',
  sessions: 10000, priorSessions: 9500, keyEvents: 500, priorKeyEvents: 480, revenue: 200000, priorRevenue: 190000,
  avgEngagementSec: 60, engagementRate: 0.5, engagedSessionsPerUser: 1.2, trendPct: 5,
  peakDay: { date: '20260615', sessions: 360 },
  dailySessions: [
    { date: '20260610', sessions: 330 }, { date: '20260611', sessions: 340 }, { date: '20260612', sessions: 335 },
    { date: '20260613', sessions: 345 }, { date: '20260614', sessions: 338 }, { date: '20260615', sessions: 360 },
    { date: '20260616', sessions: 342 }, { date: '20260617', sessions: 336 },
  ],
  peakDayChannels: null, channelDaily: [], devices: [], newVsReturning: [], topCountries: [],
  channelPerformance: [{ channel: 'Organic Search', sessions: 6000, keyEvents: 300, convRate: 0.05, revenue: 120000, engagementRate: 0.6 }],
  landingPages: [], devicePerformance: [], geoPerformance: [], llmTraffic: [], funnelSteps: [],
  ...over,
});

const dq = (over: Partial<DataQualityCounts> = {}): DataQualityCounts => ({
  totalSessions: 10000,
  channelGroups: [{ name: 'Organic Search', sessions: 6000 }, { name: 'Direct', sessions: 4000 }],
  sourceMediums: [{ name: 'google / organic', sessions: 6000 }],
  windowDays: 30, startDate: '2026-06-01', endDate: '2026-06-30', todayYmd: '2026-07-01',
  ...over,
});

const input = (over: Partial<Ga4MonitorInput> = {}): Ga4MonitorInput => ({
  property: 'properties/123',
  realtimeActiveUsers: 12,
  baseline: baseline(),
  dqCounts: dq(),
  eventDeltas: { events: [{ name: 'purchase', count: 500, priorCount: 480 }], keyEventNames: ['purchase'] },
  transactions: null,
  keyEventNames: ['purchase'],
  hasEcommerce: false,
  priorNoSourceShare: null,
  ...over,
});

console.log('\nGA4 monitor:');

test('a healthy property produces no alerts and reports healthy', () => {
  const r = monitorGa4(input());
  assert.equal(r.health, 'healthy', r.summary);
  assert.equal(r.alerts.length, 0, JSON.stringify(r.alerts));
  assert.ok(r.checks.find((c) => c.id === 'data_flow')?.status === 'pass', 'data flow passes');
});

test('copy reads cleanly: dates are formatted and there are no em dashes', () => {
  // Force a no-data alert (dates appear in the message) + a conversion break (shared-engine copy).
  const b = baseline({ dailySessions: [
    { date: '20260613', sessions: 345 }, { date: '20260614', sessions: 338 }, { date: '20260615', sessions: 360 },
    { date: '20260616', sessions: 342 }, { date: '20260617', sessions: 0 },
  ] });
  const r = monitorGa4(input({ realtimeActiveUsers: 0, baseline: b }));
  const all = JSON.stringify(r);
  assert.ok(/Jun 17, 2026/.test(all), 'YYYYMMDD dates are rendered as "Jun 17, 2026", not raw: ' + all.slice(0, 200));
  assert.ok(!/\b20260617\b/.test(all), 'no raw YYYYMMDD date leaks into the copy');
  assert.ok(!/[—–]/.test(all), 'no em/en dashes in any alert or check text');
  // Healthy-path plural: "1 active user" not "1 active user(s)".
  const one = JSON.stringify(monitorGa4(input({ realtimeActiveUsers: 1 })));
  assert.ok(!/user\(s\)|session\(s\)|issue\(s\)/.test(one), 'no clunky "(s)" pluralisation');
});

test('no realtime + empty last complete day on a normally-trafficked property = critical no-data alert', () => {
  // Last complete day (20260617, since todayYmd 2026-07-01 is not in the series) has 0 sessions.
  const b = baseline({ dailySessions: [
    { date: '20260613', sessions: 345 }, { date: '20260614', sessions: 338 }, { date: '20260615', sessions: 360 },
    { date: '20260616', sessions: 342 }, { date: '20260617', sessions: 0 },
  ] });
  const r = monitorGa4(input({ realtimeActiveUsers: 0, baseline: b }));
  const a = r.alerts.find((x) => x.kind === 'no_data');
  assert.ok(a, 'no_data alert present: ' + JSON.stringify(r.alerts));
  assert.equal(a.id, 'no_data');
  assert.equal(a.severity, 'critical');
  assert.equal(r.health, 'critical');
});

test('a partial trailing day (today) is not misread as a data outage', () => {
  // The last series day IS today → excluded; the prior complete day has real traffic → no alert.
  const b = baseline({ dailySessions: [
    { date: '20260628', sessions: 340 }, { date: '20260629', sessions: 345 }, { date: '20260630', sessions: 338 },
    { date: '20260701', sessions: 5 }, // partial "today"
  ] });
  const r = monitorGa4(input({ realtimeActiveUsers: 0, baseline: b, dqCounts: dq({ todayYmd: '2026-07-01' }) }));
  assert.ok(!r.alerts.some((a) => a.kind === 'no_data'), 'no false no-data on a partial today: ' + JSON.stringify(r.alerts));
});

test('a key event that stopped firing is a critical event_stopped alert with a stable id', () => {
  const r = monitorGa4(input({
    eventDeltas: { events: [{ name: 'purchase', count: 0, priorCount: 480 }], keyEventNames: ['purchase'] },
    keyEventNames: ['purchase'],
  }));
  const a = r.alerts.find((x) => x.kind === 'event_stopped');
  assert.ok(a, 'event_stopped alert present: ' + JSON.stringify(r.alerts));
  assert.equal(a.id, 'event_stopped:purchase', 'stable dedup id keyed on the event name');
  assert.equal(a.severity, 'high');
  assert.equal(r.health, 'critical');
});

test('a sudden one-day spike raises a medium spike alert', () => {
  const b = baseline({ dailySessions: [
    { date: '20260610', sessions: 300 }, { date: '20260611', sessions: 310 }, { date: '20260612', sessions: 305 },
    { date: '20260613', sessions: 315 }, { date: '20260614', sessions: 1600 }, { date: '20260615', sessions: 320 },
    { date: '20260616', sessions: 308 },
  ] });
  const r = monitorGa4(input({ baseline: b }));
  const a = r.alerts.find((x) => x.kind === 'spike');
  assert.ok(a, 'spike alert present: ' + JSON.stringify(r.alerts.map((z) => z.kind)));
  assert.equal(a.severity, 'medium');
});

test('a rise in unattributed sessions vs the prior window flags consent-mode drift', () => {
  const driftDq = dq({ totalSessions: 10000, channelGroups: [{ name: 'Organic Search', sessions: 6500 }, { name: 'Unassigned', sessions: 3500 }] });
  const r = monitorGa4(input({ dqCounts: driftDq, priorNoSourceShare: 8 })); // 35% now vs 8% prior → +27 pts
  const a = r.alerts.find((x) => x.kind === 'consent_drift');
  assert.ok(a, 'consent_drift alert present: ' + JSON.stringify(r.alerts.map((z) => z.kind)));
  assert.equal(a.id, 'consent_drift');
  assert.equal(a.severity, 'high', 'a large drift (>= 2x threshold) is high');
  // A stable share (no rise) does not flag drift.
  const stable = monitorGa4(input({ dqCounts: dq({ totalSessions: 10000, channelGroups: [{ name: 'Organic Search', sessions: 9700 }, { name: 'Unassigned', sessions: 300 }] }), priorNoSourceShare: 3 }));
  assert.ok(!stable.alerts.some((x) => x.kind === 'consent_drift'), 'no drift when the share is stable');
});

test('minSeverity filters which findings become alerts', () => {
  const spikeBaseline = baseline({ dailySessions: [
    { date: '20260610', sessions: 300 }, { date: '20260611', sessions: 310 }, { date: '20260612', sessions: 305 },
    { date: '20260613', sessions: 315 }, { date: '20260614', sessions: 1600 }, { date: '20260615', sessions: 320 },
    { date: '20260616', sessions: 308 },
  ] });
  const withDefault = monitorGa4(input({ baseline: spikeBaseline }));
  assert.ok(withDefault.alerts.some((a) => a.kind === 'spike'), 'medium spike surfaces at the default threshold');
  const highOnly = monitorGa4(input({ baseline: spikeBaseline }), { minSeverity: 'high' });
  assert.ok(!highOnly.alerts.some((a) => a.kind === 'spike'), 'a medium spike is filtered out when minSeverity is high');
});

test('duplicate transactions raise a revenue-integrity alert only when ecommerce is on', () => {
  const withDup = monitorGa4(input({ hasEcommerce: true, transactions: { transactions: [{ id: 'T-1', purchases: 3 }], notSetShare: 0 } }));
  assert.ok(withDup.alerts.some((a) => a.kind === 'duplicate_tx'), 'dup alert when ecommerce on');
  // Same data but ecommerce off → no transaction check runs.
  const off = monitorGa4(input({ hasEcommerce: false, transactions: { transactions: [{ id: 'T-1', purchases: 3 }], notSetShare: 0 } }));
  assert.ok(!off.alerts.some((a) => a.kind === 'duplicate_tx'), 'no dup alert when ecommerce off');
});

test('missing inputs degrade to skipped checks, never false alarms', () => {
  const r = monitorGa4({ property: 'properties/1', realtimeActiveUsers: null, baseline: null, dqCounts: null, eventDeltas: null, transactions: null, keyEventNames: [], hasEcommerce: false, priorNoSourceShare: null });
  assert.equal(r.alerts.length, 0, 'no alerts with no data');
  assert.equal(r.health, 'healthy');
  assert.ok(r.checks.every((c) => c.status === 'skip'), 'every check skipped');
});

test('alerts are ordered worst-severity first', () => {
  const r = monitorGa4(input({
    realtimeActiveUsers: 0,
    baseline: baseline({ dailySessions: [
      { date: '20260613', sessions: 345 }, { date: '20260614', sessions: 338 }, { date: '20260615', sessions: 360 },
      { date: '20260616', sessions: 342 }, { date: '20260617', sessions: 0 },
    ] }),
    eventDeltas: { events: [{ name: 'view_item', count: 0, priorCount: 900 }], keyEventNames: ['purchase'] },
  }));
  assert.ok(r.alerts.length >= 2, 'multiple alerts: ' + JSON.stringify(r.alerts.map((a) => a.severity)));
  const ranks = r.alerts.map((a) => (a.severity === 'critical' ? 0 : a.severity === 'high' ? 1 : a.severity === 'medium' ? 2 : 3));
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), 'sorted worst-first');
});

test('internal-traffic data_quality alert id is STABLE across runs as the non-prod share drifts (dedup)', () => {
  // Non-production hostnames fire the internal-traffic finding through monitorGa4 → a data_quality alert.
  // The alert id is derived from the finding's message.slice(0,24); the message now leads with a fixed
  // prefix ("Non-production or preview…") so the id must NOT churn when only the flagged share changes.
  const run = (nonProdSessions: number) =>
    monitorGa4(
      input({
        dqCounts: dq({
          totalSessions: 10000,
          hostnames: [
            { name: 'www.example.com', sessions: 10000 - nonProdSessions },
            { name: 'staging.example.com', sessions: nonProdSessions },
          ],
        }),
      })
    );
  const a1 = run(3000).alerts.find((x) => x.kind === 'data_quality' && /Non-production or preview/.test(x.detail));
  const a2 = run(2600).alerts.find((x) => x.kind === 'data_quality' && /Non-production or preview/.test(x.detail));
  assert.ok(a1, 'internal-traffic alert fires at 30% non-prod: ' + JSON.stringify(run(3000).alerts.map((z) => z.kind)));
  assert.ok(a2, 'internal-traffic alert fires at 26% non-prod');
  assert.notEqual(a1.detail, a2.detail, 'the detail text DID change (share drifted) — proving the id stability is non-trivial');
  assert.equal(a1.id, a2.id, 'the dedup id is identical across runs despite the drifting share');
});

test('firstMetric reads a scalar realtime metric, null when absent', () => {
  assert.equal(firstMetric({ dimensionHeaders: [], metricHeaders: ['activeUsers'], rows: [{ dimensions: [], metrics: ['42'] }] }), 42);
  assert.equal(firstMetric({ dimensionHeaders: [], metricHeaders: ['activeUsers'], rows: [] }), null);
  assert.equal(firstMetric(null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
