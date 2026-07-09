import assert from 'node:assert/strict';
import { ga4DataLagDays, monitorGa4, firstMetric, type Ga4MonitorInput } from '../ga4-monitor';
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

test('SOME missing inputs degrade to skipped checks, never false alarms', () => {
  // Realtime + baseline present (checks run), the rest missing → skips, no alerts, still healthy.
  const r = monitorGa4(input({ eventDeltas: null, transactions: null, dqCounts: null, priorNoSourceShare: null }));
  assert.equal(r.health, 'healthy', r.summary);
  assert.ok(r.checks.some((c) => c.status === 'skip'), 'unfetchable checks skipped');
  assert.ok(r.checks.some((c) => c.status !== 'skip'), 'fetched checks still ran');
});

test('ALL inputs missing is NOT healthy: the run surfaces the real fetch error as a failed access check', () => {
  // The false-assurance bug: every query failed (expired token / lost access / quota) used to render
  // "HEALTHY - Everything looks healthy" with six silent skips. It must say what actually happened.
  const r = monitorGa4({ property: 'properties/1', realtimeActiveUsers: null, baseline: null, dqCounts: null, eventDeltas: null, transactions: null, keyEventNames: [], hasEcommerce: false, priorNoSourceShare: null, fetchError: 'invalid_grant: Token has been expired or revoked.' });
  assert.equal(r.health, 'critical', r.summary);
  assert.equal(r.checks[0].id, 'access', 'access check leads the table');
  assert.equal(r.checks[0].status, 'fail');
  assert.ok(/invalid_grant/.test(r.checks[0].detail), 'the underlying error is shown');
  const a = r.alerts.find((x) => x.id === 'no_access');
  assert.ok(a, 'no_access alert raised');
  assert.equal(a!.severity, 'high');
  assert.ok(/invalid_grant/.test(a!.detail), 'alert carries the real cause');
  assert.ok(/Re-connect the Google account/.test(a!.recommendation ?? ''), 'actionable fix');
  // Without a captured error message the guard still refuses to say "healthy".
  const noMsg = monitorGa4({ property: 'properties/1', realtimeActiveUsers: null, baseline: null, dqCounts: null, eventDeltas: null, transactions: null, keyEventNames: [], hasEcommerce: false, priorNoSourceShare: null });
  assert.equal(noMsg.health, 'critical');
  assert.ok(noMsg.alerts.some((x) => x.id === 'no_access'));
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

test('AGREEMENT: the monitor fires the SAME verdicts as the audit on the broken-property fixture', () => {
  // The advisor's exact scenario: the audit graded this shape broken (revenue mismatch HIGH,
  // Direct burst HIGH, 36% untagged, bot-market bimodality) while the monitor read 7/7 Pass.
  // Same shared detectors now: the monitor must fire on every one of them.
  const brokenBaseline = baseline({
    channelDaily: [
      { channel: 'Direct', series: [
        { date: '20260610', sessions: 300 }, { date: '20260611', sessions: 22362 }, { date: '20260612', sessions: 310 },
        { date: '20260613', sessions: 305 }, { date: '20260614', sessions: 300 },
      ] },
      { channel: 'Organic Search', series: [
        { date: '20260610', sessions: 700 }, { date: '20260611', sessions: 750 }, { date: '20260612', sessions: 720 },
        { date: '20260613', sessions: 730 }, { date: '20260614', sessions: 705 },
      ] },
    ],
    channelPerformance: [
      { channel: 'Organic Shopping', sessions: 30000, keyEvents: 2000, convRate: 0.04, revenue: 845315, engagementRate: 0.6 },
      { channel: 'Paid Shopping', sessions: 900, keyEvents: 40, convRate: 0.03, revenue: 13200, engagementRate: 0.5 },
    ],
    geoPerformance: [
      { country: 'India', sessions: 50000, keyEvents: 1500, convRate: 0.03, revenue: 400000, engagementRate: 0.9 },
      { country: 'United States', sessions: 12000, keyEvents: 900, convRate: 0.075, revenue: 250000, engagementRate: 0.92 },
      { country: 'United Kingdom', sessions: 6000, keyEvents: 300, convRate: 0.05, revenue: 90000, engagementRate: 0.88 },
      { country: 'Vietnam', sessions: 9000, keyEvents: 2, convRate: 0.0002, revenue: 0, engagementRate: 0.12 },
    ],
  });
  const campaigns = {
    windowDays: 28, dateRange: 'Jun 3 - Jun 30, 2026', totalSessions: 50000, primaryMetric: 'conversions' as const,
    taggedCampaigns: [
      { campaign: 'Adv+ Shopping - All products', sessions: 8000, keyEvents: 23933, revenue: 532085, engagementRate: 0.6 },
      { campaign: '20574896341', sessions: 4000, keyEvents: 9000, revenue: 227350, engagementRate: 0.55 },
    ],
    bestCampaign: null, untaggedSessions: 18000, untaggedSharePct: 36, summary: '', findings: [],
  };
  const r = monitorGa4(input({ baseline: brokenBaseline, campaigns }));

  const kinds = new Set(r.alerts.map((a) => a.kind));
  assert.ok(kinds.has('attribution_mismatch'), 'revenue reconciliation fires: ' + [...kinds].join(','));
  assert.ok(kinds.has('concentration'), 'the Direct burst fires');
  assert.ok(kinds.has('invalid_traffic'), 'the bot-market bimodality fires');
  assert.ok(r.health === 'critical', 'a property the audit grades broken is NOT healthy: ' + r.health);
  const byId = (id: string) => r.checks.find((c) => c.id === id)!;
  assert.equal(byId('reconciliation').status, 'fail', 'reconciliation check fails');
  assert.equal(byId('concentration').status, 'fail', 'concentration check fails');
  assert.equal(byId('invalid_traffic').status, 'fail', 'invalid-traffic check fails');
  // Untagged at 36% is below the 40% alert bar -> pass with the share stated (not silent).
  assert.equal(byId('untagged').status, 'pass');
  assert.ok(/36.0% of sessions are untagged/.test(byId('untagged').detail), byId('untagged').detail);
});

test('correctness checks: untagged share alerts at >=40%, channel-mix shift alerts on a 15-point jump', () => {
  const campaigns = {
    windowDays: 28, dateRange: null, totalSessions: 50000, primaryMetric: 'sessions' as const,
    taggedCampaigns: [], bestCampaign: null, untaggedSessions: 24000, untaggedSharePct: 48, summary: '', findings: [],
  };
  const r = monitorGa4(input({ campaigns }));
  const untagged = r.alerts.find((a) => a.kind === 'untagged_share');
  assert.ok(untagged, 'untagged alert fires at 48%');
  assert.equal(untagged!.severity, 'medium');
  assert.ok(/48.0% of sessions carry no utm_campaign/.test(untagged!.detail), untagged!.detail);

  // Channel shift: Direct 10% -> 44% of sessions vs the prior window (the biggest mover among 3).
  const shifted = monitorGa4(input({
    dqCounts: dq({ totalSessions: 45000, channelGroups: [{ name: 'Organic Search', sessions: 20000 }, { name: 'Direct', sessions: 20000 }, { name: 'Referral', sessions: 5000 }] }),
    priorChannelGroups: [{ name: 'Organic Search', sessions: 6000 }, { name: 'Direct', sessions: 1000 }, { name: 'Referral', sessions: 3000 }],
  }));
  const shift = shifted.alerts.find((a) => a.kind === 'channel_shift');
  assert.ok(shift, 'channel-shift alert fires');
  assert.ok(/Direct moved from 10.0% to 44.4%/.test(shift!.detail), shift!.detail);
  // Stable mix -> pass.
  const stable = monitorGa4(input({ priorChannelGroups: [{ name: 'Organic Search', sessions: 6100 }, { name: 'Direct', sessions: 3900 }] }));
  assert.equal(stable.checks.find((c) => c.id === 'channel_shift')!.status, 'pass');
});

test('correctness checks SKIP (never false-pass) when their inputs were not fetched', () => {
  const r = monitorGa4(input({ campaigns: null }));
  const byId = (id: string) => r.checks.find((c) => c.id === id)!;
  assert.equal(byId('reconciliation').status, 'skip', 'no campaigns -> reconciliation skips');
  assert.equal(byId('untagged').status, 'skip', 'no campaigns -> untagged skips');
  assert.equal(byId('concentration').status, 'skip', 'no channelDaily -> concentration skips');
  assert.equal(byId('invalid_traffic').status, 'skip', 'thin geo data -> invalid-traffic skips');
  assert.equal(byId('channel_shift').status, 'skip', 'no prior mix -> shift check skips');
  assert.equal(r.health, 'healthy', 'skipped correctness checks alone never alarm');
});

test('consent-signal check: pass with gcs, warn+LOW without, MEDIUM on regression, honest SKIP otherwise', () => {
  const withSignal = monitorGa4(input({ consentProbe: { observedHit: true, gcsPresent: true, gcs: 'G111' } }));
  const row = (r: ReturnType<typeof monitorGa4>) => r.checks.find((c) => c.id === 'consent_signal')!;
  assert.equal(row(withSignal).status, 'pass');
  assert.ok(/gcs=G111/.test(row(withSignal).detail), 'raw gcs shown');

  // minSeverity 'info' = what the desktop tab uses; the default 'medium' would filter the LOW alert.
  const missing = monitorGa4(input({ consentProbe: { observedHit: true, gcsPresent: false, gcs: null } }), { minSeverity: 'info' });
  assert.equal(row(missing).status, 'warn');
  const a1 = missing.alerts.find((x) => x.kind === 'consent_signal');
  assert.ok(a1 && a1.severity === 'low', 'never-present is LOW (no over-alarm)');

  const regressed = monitorGa4(input({ consentProbe: { observedHit: true, gcsPresent: false, gcs: null }, priorConsentGcsPresent: true }));
  const a2 = regressed.alerts.find((x) => x.kind === 'consent_signal');
  assert.ok(a2 && a2.severity === 'medium', 'present->absent is the silent-deploy regression, MEDIUM');
  assert.ok(/LOST/.test(a2!.title), 'regression title says lost');

  const gated = monitorGa4(input({ consentProbe: { observedHit: false, gcsPresent: false, gcs: null } }));
  assert.equal(row(gated).status, 'skip', 'no hit observed -> SKIP, never a guess');
  assert.ok(/consent banner may be gating/.test(row(gated).detail));
  assert.ok(!gated.alerts.some((x) => x.kind === 'consent_signal'), 'no alert when nothing can be judged');

  const noProbe = monitorGa4(input());
  assert.ok(!noProbe.checks.some((c) => c.id === 'consent_signal'), 'no probe attempted -> no check row at all');
});

test('data freshness: pass when current, MEDIUM alert at 3+ days, HIGH at 7+, honest skip when unknown', () => {
  const row = (r: ReturnType<typeof monitorGa4>) => r.checks.find((c) => c.id === 'freshness')!;
  assert.equal(row(monitorGa4(input({ dataLagDays: 1 }))).status, 'pass');
  assert.equal(row(monitorGa4(input({ dataLagDays: 2 }))).status, 'pass', '48h is inside GA4 processing window');

  const lagged = monitorGa4(input({ dataLagDays: 4 }));
  assert.equal(row(lagged).status, 'warn');
  const a = lagged.alerts.find((x) => x.kind === 'data_freshness');
  assert.ok(a && a.severity === 'medium', '3-6 day lag is MEDIUM');
  assert.ok(/4 days behind/.test(a!.title), a!.title);

  const broken = monitorGa4(input({ dataLagDays: 9 }));
  assert.equal(row(broken).status, 'fail');
  assert.equal(broken.alerts.find((x) => x.kind === 'data_freshness')!.severity, 'high', 'a week+ is HIGH');

  assert.equal(row(monitorGa4(input())).status, 'skip', 'unknown lag -> skip, never a guess');
});

test('ga4DataLagDays: computed from the last date the Data API returned a row for', () => {
  assert.equal(ga4DataLagDays(baseline(), '2026-06-18'), 1, 'last row 06-17, today 06-18 -> 1 day');
  assert.equal(ga4DataLagDays(baseline(), '2026-07-01'), 14, 'stale series -> the real lag');
  assert.equal(ga4DataLagDays(null, '2026-07-01'), null);
  assert.equal(ga4DataLagDays(baseline({ dailySessions: [] }), '2026-07-01'), null);
  assert.equal(ga4DataLagDays(baseline(), undefined), null);
});

test('BigQuery export: pass when live, LOW when all exports disabled, MEDIUM when the link disappears, no row when never linked', () => {
  const snap = (links: Array<{ project: string; dailyExportEnabled: boolean; streamingExportEnabled: boolean }>) =>
    ({ displayName: 'Acme', keyEvents: [], dataStreams: [], bigQueryLinks: links }) as unknown as NonNullable<Ga4MonitorInput['snapshot']>;
  const row = (r: ReturnType<typeof monitorGa4>) => r.checks.find((c) => c.id === 'bigquery');

  const live = monitorGa4(input({ snapshot: snap([{ project: 'proj-a', dailyExportEnabled: true, streamingExportEnabled: false }]) }));
  assert.equal(row(live)!.status, 'pass');
  assert.ok(/daily/.test(row(live)!.detail), row(live)!.detail);

  const dead = monitorGa4(input({ snapshot: snap([{ project: 'proj-a', dailyExportEnabled: false, streamingExportEnabled: false }]) }), { minSeverity: 'info' });
  assert.equal(row(dead)!.status, 'warn');
  assert.equal(dead.alerts.find((a) => a.kind === 'bigquery_export')!.severity, 'low', 'a dead link is LOW (nothing broke, nothing ships)');

  const removed = monitorGa4(input({ snapshot: snap([]), priorBqLinked: true }));
  assert.equal(row(removed)!.status, 'fail');
  const a = removed.alerts.find((x) => x.kind === 'bigquery_export');
  assert.ok(a && a.severity === 'medium', 'a disappearing link is MEDIUM');
  assert.ok(/does not backfill/.test(a!.detail), a!.detail);

  assert.ok(!row(monitorGa4(input({ snapshot: snap([]) }))), 'never linked -> no row (optional infra, not a health failure)');
  assert.ok(!row(monitorGa4(input())), 'links unread -> no row');
});

test('PII detector scans campaign names and traffic sources too, always masked', () => {
  const campaigns = {
    windowDays: 28, dateRange: null, totalSessions: 10000, primaryMetric: 'sessions' as const,
    taggedCampaigns: [{ campaign: 'newsletter-june-jane.doe@example.com', sessions: 420, keyEvents: 3, revenue: 0, engagementRate: 0.5 }],
    bestCampaign: null, untaggedSessions: 1000, untaggedSharePct: 10, summary: '', findings: [],
  };
  const r = monitorGa4(input({ campaigns }));
  assert.equal(r.checks.find((c) => c.id === 'pii')!.status, 'fail');
  const alert = r.alerts.find((a) => a.kind === 'pii')!;
  assert.ok(/campaign name/.test(alert.detail), alert.detail);
  const everything = JSON.stringify(r);
  assert.ok(!everything.includes('jane.doe@example.com'), 'the raw address never appears anywhere in the run');
  assert.ok(everything.includes('***@***'), 'the masked form is shown');

  const srcOnly = monitorGa4(input({ dqCounts: dq({ sourceMediums: [{ name: 'bob@corp.com / email', sessions: 60 }] }) }));
  const srcAlert = srcOnly.alerts.find((a) => a.kind === 'pii')!;
  assert.ok(/traffic source/.test(srcAlert.detail), srcAlert.detail);
  assert.ok(!JSON.stringify(srcOnly).includes('bob@corp.com'), 'source addresses masked too');
});

test('data-collection copy labels the daily figure (yesterday / last complete day) so it never reads stale', () => {
  // Fresh property: last complete row is yesterday -> the copy SAYS yesterday.
  const fresh = baseline({ dailySessions: [
    { date: '20260628', sessions: 340 }, { date: '20260629', sessions: 345 }, { date: '20260630', sessions: 338 },
  ] });
  const r1 = monitorGa4(input({ baseline: fresh, dqCounts: dq({ todayYmd: '2026-07-01' }) }));
  const d1 = r1.checks.find((c) => c.id === 'data_flow')!.detail;
  assert.ok(/338 sessions yesterday \(Jun 30, 2026\)/.test(d1), d1);

  // Trailing partial "today" is excluded, so the labeled day is still yesterday.
  const partial = baseline({ dailySessions: [
    { date: '20260629', sessions: 345 }, { date: '20260630', sessions: 338 }, { date: '20260701', sessions: 5 },
  ] });
  const r2 = monitorGa4(input({ baseline: partial, dqCounts: dq({ todayYmd: '2026-07-01' }) }));
  assert.ok(/yesterday \(Jun 30, 2026\)/.test(r2.checks.find((c) => c.id === 'data_flow')!.detail));

  // Series ending far in the past: the copy admits it is the last complete day GA4 has.
  const d3 = monitorGa4(input()).checks.find((c) => c.id === 'data_flow')!.detail;
  assert.ok(/on Jun 17, 2026 - the last complete day GA4 has/.test(d3), d3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
