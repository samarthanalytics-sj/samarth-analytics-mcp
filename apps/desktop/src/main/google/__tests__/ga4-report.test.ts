import assert from 'node:assert/strict';
import { buildGa4AuditReport, buildGa4ExecSummary, type Ga4ReportInput } from '../ga4-report';
import { auditGa4, type Ga4PropertySnapshot } from '../ga4-audit';
import { auditGa4DataQuality } from '../ga4-data-quality';
import { auditGa4Growth } from '../ga4-growth';
import type { DataQualityCounts } from '../ga4-data-quality';
import type { Ga4Baseline } from '../data-service';

const growthOf = (b: Ga4Baseline | null, topChannel = 'Organic Search') =>
  b
    ? auditGa4Growth({
        sessions: b.sessions,
        priorSessions: b.priorSessions,
        keyEvents: b.keyEvents,
        priorKeyEvents: b.priorKeyEvents,
        revenue: b.revenue,
        priorRevenue: b.priorRevenue,
        topChannel,
      })
    : null;

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

const snap = (over: Partial<Ga4PropertySnapshot> = {}): Ga4PropertySnapshot => ({
  property: 'properties/353451709',
  displayName: 'Purple Tresor Property - GA4',
  timeZone: 'Asia/Calcutta',
  currencyCode: 'INR',
  industryCategory: 'SHOPPING',
  dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true },
  keyEvents: [{ eventName: 'generate_lead' }, { eventName: 'sign_up' }],
  customDimensions: [],
  customMetrics: [],
  dataStreams: [{ name: 'properties/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true }],
  googleAdsLinks: 1,
  googleSignals: 'GOOGLE_SIGNALS_ENABLED',
  ...over,
});

const dqCounts = (over: Partial<DataQualityCounts> = {}): DataQualityCounts => ({
  totalSessions: 77506,
  channelGroups: [
    { name: 'Organic Search', sessions: 40000 },
    { name: 'Direct', sessions: 20000 },
    { name: 'Unassigned', sessions: 2200 },
  ],
  sourceMediums: [{ name: 'google / organic', sessions: 40000 }],
  windowDays: 90,
  startDate: '2026-04-01',
  endDate: '2026-06-29',
  ...over,
});

const baseline = (over: Partial<Ga4Baseline> = {}): Ga4Baseline => ({
  startDate: '2026-04-01',
  endDate: '2026-06-29',
  priorStartDate: '2026-01-01',
  priorEndDate: '2026-03-31',
  sessions: 77506,
  priorSessions: 70000,
  keyEvents: 4000,
  priorKeyEvents: 3600,
  revenue: 555000,
  priorRevenue: 500000,
  trendPct: 11,
  peakDay: { date: '20260615', sessions: 1800 },
  dailySessions: [
    { date: '20260610', sessions: 1200 },
    { date: '20260611', sessions: 1300 },
    { date: '20260612', sessions: 1250 },
    { date: '20260613', sessions: 1400 },
    { date: '20260614', sessions: 1350 },
    { date: '20260615', sessions: 1800 },
    { date: '20260616', sessions: 1300 },
    { date: '20260617', sessions: 1250 },
  ],
  peakDayChannels: [
    { name: 'Organic Search', sessions: 900 },
    { name: 'Direct', sessions: 500 },
    { name: 'Organic Social', sessions: 400 },
  ],
  channelDaily: [
    { channel: 'Organic Search', series: [{ date: '20260610', sessions: 700 }, { date: '20260611', sessions: 750 }] },
    { channel: 'Direct', series: [{ date: '20260610', sessions: 300 }, { date: '20260611', sessions: 320 }] },
  ],
  devices: [
    { name: 'mobile', sessions: 50000 },
    { name: 'desktop', sessions: 25000 },
    { name: 'tablet', sessions: 2506 },
  ],
  newVsReturning: [
    { name: 'new', sessions: 46000 },
    { name: 'returning', sessions: 31506 },
  ],
  topCountries: [{ name: 'India', sessions: 70000 }, { name: 'United States', sessions: 4000 }],
  avgEngagementSec: 83,
  engagementRate: 0.612,
  engagedSessionsPerUser: 1.4,
  channelPerformance: [
    { channel: 'Organic Search', sessions: 40000, keyEvents: 1200, convRate: 0.03, revenue: 250000, engagementRate: 0.62 },
    { channel: 'Paid Search', sessions: 20000, keyEvents: 900, convRate: 0.045, revenue: 180000, engagementRate: 0.55 },
    { channel: 'Direct', sessions: 15000, keyEvents: 300, convRate: 0.02, revenue: 0, engagementRate: 0.48 },
  ],
  landingPages: [
    { page: '/', sessions: 30000, keyEvents: 800, convRate: 0.026, revenue: 120000, engagementRate: 0.6 },
    { page: '/pricing', sessions: 12000, keyEvents: 720, convRate: 0.06, revenue: 300000, engagementRate: 0.71 },
    { page: '/blog/post', sessions: 8000, keyEvents: 40, convRate: 0.005, revenue: 0, engagementRate: 0.34 },
  ],
  devicePerformance: [
    { device: 'mobile', sessions: 50000, keyEvents: 1500, convRate: 0.03, revenue: 200000, engagementRate: 0.52 },
    { device: 'desktop', sessions: 25000, keyEvents: 1000, convRate: 0.04, revenue: 320000, engagementRate: 0.68 },
    { device: 'tablet', sessions: 2506, keyEvents: 30, convRate: 0.012, revenue: 0, engagementRate: 0.4 },
  ],
  geoPerformance: [
    { country: 'India', sessions: 70000, keyEvents: 2100, convRate: 0.03, revenue: 400000, engagementRate: 0.55 },
    { country: 'United States', sessions: 4000, keyEvents: 320, convRate: 0.08, revenue: 250000, engagementRate: 0.72 },
    { country: '(not set)', sessions: 1200, keyEvents: 0, convRate: 0, revenue: 0, engagementRate: 0.2 },
  ],
  funnelSteps: [
    { event: 'view_item', users: 10000 },
    { event: 'add_to_cart', users: 4000 },
    { event: 'begin_checkout', users: 2000 },
    { event: 'purchase', users: 1000 },
  ],
  ...over,
});

const input = (over: Partial<Ga4ReportInput> = {}): Ga4ReportInput => {
  const s = over.snapshot ?? snap();
  const counts = over.dqCounts ?? dqCounts();
  const b = over.baseline !== undefined ? over.baseline : baseline();
  const g = over.growth !== undefined ? over.growth : growthOf(b);
  return {
    property: s.property,
    displayName: s.displayName,
    generatedAt: '2026-06-29T00:00:00.000Z',
    snapshot: s,
    config: auditGa4(s),
    dataQuality: auditGa4DataQuality(counts),
    dqCounts: counts,
    baseline: b,
    growth: g,
    attribution: { reportingAttributionModel: 'CROSS_CHANNEL_DATA_DRIVEN', acquisitionConversionEventLookbackWindow: 'ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS', otherConversionEventLookbackWindow: 'CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS' },
    audienceCount: 4,
    ...over,
  };
};

console.log('\nGA4 report:');

test('report has all 9 verdict-first sections', () => {
  const md = buildGa4AuditReport(input());
  for (const h of [
    '# GA4 Property Audit',
    '## 1 · Executive summary',
    '## 2 · What is wrong',
    '## 3 · Outcomes vs traffic',
    '## 4 · All findings',
    '## 5 · Area status',
    '## 6 · Property baseline',
    '## 7 · Decision readiness',
    '## 8 · Not verified',
    '## 9 · Scope & metadata',
  ]) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  assert.ok(md.includes('353451709'), 'property id (in title + scope)');
  assert.ok(md.includes('14 months'), 'retention label');
  // Verdict is read-first: it precedes the metadata appendix.
  assert.ok(md.indexOf('## 1 · Executive summary') < md.indexOf('## 9 · Scope'), 'exec summary before metadata');
});

test('area-status grades on evidence with coloured dots: Data collection + zero-config Custom definitions are Partial', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\| Data collection \| 🟡 Partial \| Likely \|/.test(md), 'collection Partial (deep health unverifiable)');
  assert.ok(/\| Custom definitions \| 🟡 Partial \| Likely \|/.test(md), 'zero custom defs → Partial');
  assert.ok(/🟢 Pass/.test(md), 'pass rows carry the green dot');
  // Ecommerce is never a clean Pass while item params are unverified.
  const ecomMd = buildGa4AuditReport(input({ snapshot: snap({ keyEvents: [{ eventName: 'purchase' }, { eventName: 'add_to_cart' }] }) }));
  assert.ok(/\| Ecommerce \| 🟡 Partial \| Likely \|/.test(ecomMd), 'ecommerce present → Partial, not Pass');
});

test('property baseline renders Unicode bars + channel mix', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(md.includes('█'), 'has a filled bar block');
  assert.ok(md.includes('Channel mix'), 'channel mix section');
  assert.ok(/\+11% vs prior period/.test(md), 'trend label');
  assert.ok(md.includes('Jun 15, 2026'), 'peak day formatted');
});

test('bar percentages are clamped to 0..100 (never print an out-of-range share)', () => {
  // A device report whose total diverges from baseline.sessions must not yield >100% bars.
  const md = buildGa4AuditReport(input());
  for (const m of md.matchAll(/(\d+)%/g)) assert.ok(Number(m[1]) <= 100, `bar over 100%: ${m[0]}`);
});

test('decision readiness derives from config (ecommerce absent → abandonment Not answerable)', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/Abandonment by product\/page\? \| Not answerable/.test(md));
  assert.ok(/Which campaigns generate revenue\? \| Answerable/.test(md)); // Ads linked
});

test('a data-quality finding lands in the All-findings table with a business-risk column', () => {
  const counts = dqCounts({
    totalSessions: 100,
    channelGroups: [{ name: 'Unassigned', sessions: 40 }, { name: 'Direct', sessions: 60 }],
  });
  const md = buildGa4AuditReport(input({ dqCounts: counts, dataQuality: auditGa4DataQuality(counts) }));
  assert.ok(/## 4 · All findings/.test(md));
  assert.ok(/Business risk/.test(md), 'findings table has a business-risk column');
  assert.ok(/Unassigned/.test(md));
});

test('a doubled-traffic spike conversions did not track → CRITICAL (worst unverified branch), "Do not trust yet"', () => {
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(/\| CRITICAL \| Growth \|/.test(md), 'a >=2x spike not tracked by conversions is CRITICAL, not HIGH');
  assert.ok(/\*\*Overall verdict:\*\* Action required/.test(md), 'exec verdict reflects the critical finding');
  assert.ok(/\*\*Reporting reliability:\*\*/.test(md) && /Do not quote/.test(md), 'reliability + trust matrix flag the risk');
  assert.ok(/revenue\/ROAS may be wrong/.test(md), 'leads with the live-reporting stake');
  assert.ok(!/Well-configured/.test(md), 'never a false all-clear');
  assert.ok(/## 2 · What is wrong/.test(md) && /If unconfirmed:/.test(md), 'top finding is expanded with the worse branch');
  assert.ok(/Growth signals \(vs prior\)/.test(md), 'growth signals shown in baseline');
});

test('section 6 baseline includes an engagement line (avg time/session formatted mm ss, engaged rate, per user)', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/- \*\*Engagement:\*\*/.test(md), 'engagement metaRow present');
  assert.ok(/1m 23s avg engagement time\/session/.test(md), '83s formats as 1m 23s');
  assert.ok(/61\.2% engaged-session rate/.test(md), 'engagementRate 0.612 → 61.2%');
  assert.ok(/1\.4 engaged sessions\/user/.test(md), 'engaged sessions per user shown');
});

test('engagement line is omitted when the baseline has no sessions', () => {
  const b = baseline({ sessions: 0, avgEngagementSec: 0, engagementRate: 0, engagedSessionsPerUser: 0 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/- \*\*Engagement:\*\*/.test(md), 'no engagement line without sessions to derive it from');
});

test('engagement line keeps time + rate but drops the per-user figure when it is zero', () => {
  const b = baseline({ sessions: 100, avgEngagementSec: 60, engagementRate: 0.5, engagedSessionsPerUser: 0 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(/- \*\*Engagement:\*\*/.test(md) && /1m 0s avg engagement time\/session/.test(md), 'line still present with time');
  assert.ok(/50\.0% engaged-session rate/.test(md), 'rate still shown');
  assert.ok(!/engaged sessions\/user/.test(md), 'per-user figure dropped when 0 (no "0.0 engaged sessions/user")');
});

test('section 6 renders a channel-performance table with conversion rate + revenue per channel', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Channel performance\*\*/.test(md), 'channel-performance sub-heading');
  assert.ok(/\| Channel \| Sessions \| Conv\. rate \| Revenue \| Engagement \|/.test(md), 'table header row');
  assert.ok(/\| Organic Search \|/.test(md), 'top channel row');
  assert.ok(/4\.5%/.test(md), 'paid-search conversion rate formatted as a percentage');
  assert.ok(/\| Direct \|.*\| - \|.*%/.test(md), 'a zero-revenue channel shows a dash placeholder, not 0 (em-dash stripped to hyphen on output)');
});

test('channel-performance table is omitted when the baseline has no channel data', () => {
  const b = baseline({ channelPerformance: [] });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/\*\*Channel performance\*\*/.test(md), 'no empty channel table');
});

test('section 6 renders a landing-page table with entry-page conversion rate + revenue', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Landing pages\*\*/.test(md), 'landing-page sub-heading');
  assert.ok(/\| Landing page \| Sessions \| Conv\. rate \| Revenue \| Engagement \|/.test(md), 'table header row');
  assert.ok(/\| \/pricing \|/.test(md), 'a top entry-page row');
  assert.ok(/6\.0%/.test(md), 'pricing-page conversion rate formatted as a percentage');
  assert.ok(/\| \/blog\/post \|.*\| - \|.*%/.test(md), 'a zero-revenue entry page shows a dash placeholder, not 0');
});

test('landing-page table is omitted when the baseline has no landing-page data', () => {
  const b = baseline({ landingPages: [] });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/\*\*Landing pages\*\*/.test(md), 'no empty landing-page table');
});

test('section 6 renders device + market performance tables with conversion rate + revenue', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Device performance\*\*/.test(md), 'device-performance sub-heading');
  assert.ok(/\| Device \| Sessions \| Conv\. rate \| Revenue \| Engagement \|/.test(md), 'device table header');
  assert.ok(/\| desktop \|.*4\.0%/.test(md), 'a device row with its conversion rate');
  assert.ok(/\*\*Market performance\*\*/.test(md), 'market-performance sub-heading');
  assert.ok(/\| Market \| Sessions \| Conv\. rate \| Revenue \| Engagement \|/.test(md), 'market table header');
  assert.ok(/\| United States \|.*8\.0%/.test(md), 'a market row with its conversion rate');
  assert.ok(/\| tablet \|.*\| - \|.*%/.test(md), 'a zero-revenue device shows a dash placeholder');
});

test('device + market tables are omitted when the baseline has no such data', () => {
  const b = baseline({ devicePerformance: [], geoPerformance: [] });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/\*\*Device performance\*\*/.test(md), 'no empty device table');
  assert.ok(!/\*\*Market performance\*\*/.test(md), 'no empty market table');
});

test('section 6 renders the ecommerce funnel with step conversion + depth + the approximation caveat', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Ecommerce funnel\*\*/.test(md), 'funnel sub-heading');
  assert.ok(/overall view-to-purchase 10\.0%/.test(md), 'overall view→purchase rate (1000/10000)');
  assert.ok(/\| Step \| Users \| % of entry \| Step conversion \|/.test(md), 'funnel table header');
  // begin_checkout: % of entry = 2000/10000 = 20%; step conversion (from add_to_cart) = 2000/4000 = 50% — distinct columns
  assert.ok(/\| Begin checkout \| 2,000 \| 20% \| 50% \|/.test(md), 'depth vs step-conversion are different columns');
  assert.ok(/\| View item \| 10,000 \| 100% \| - \|/.test(md), 'entry step has no step-conversion (em-dash stripped to hyphen on output)');
  assert.ok(/not a strict sequential path/.test(md), 'honesty caveat present');
});

test('ecommerce funnel is omitted when there is no view_item reach (non-ecommerce property)', () => {
  const noView = baseline({ funnelSteps: [{ event: 'view_item', users: 0 }, { event: 'add_to_cart', users: 0 }, { event: 'begin_checkout', users: 0 }, { event: 'purchase', users: 0 }] });
  assert.ok(!/\*\*Ecommerce funnel\*\*/.test(buildGa4AuditReport(input({ baseline: noView, growth: growthOf(noView) }))), 'no funnel without an entry step');
  const noData = baseline({ funnelSteps: [] });
  assert.ok(!/\*\*Ecommerce funnel\*\*/.test(buildGa4AuditReport(input({ baseline: noData, growth: growthOf(noData) }))), 'no funnel when the query returned nothing');
});

test('ecommerce funnel guards divide-by-zero and never clamps a step above 100%', () => {
  // begin_checkout not tracked (0 users) but purchase fires — a real tracking-gap shape.
  const gap = baseline({ funnelSteps: [{ event: 'view_item', users: 5000 }, { event: 'add_to_cart', users: 2000 }, { event: 'begin_checkout', users: 0 }, { event: 'purchase', users: 300 }] });
  const md = buildGa4AuditReport(input({ baseline: gap, growth: growthOf(gap) }));
  assert.ok(/\| Purchase \| 300 \| 6% \| - \|/.test(md), 'purchase step-conversion is a dash when the prior step is 0 (no divide-by-zero)');
  // A later step exceeding an earlier one shows the true ratio, not a clamp.
  const anomaly = baseline({ funnelSteps: [{ event: 'view_item', users: 1000 }, { event: 'add_to_cart', users: 1200 }, { event: 'begin_checkout', users: 600 }, { event: 'purchase', users: 300 }] });
  assert.ok(/\| Add to cart \| 1,200 \| 120% \| 120% \|/.test(buildGa4AuditReport(input({ baseline: anomaly, growth: growthOf(anomaly) }))), 'a >100% step is shown, not clamped');
});

test('untrusted outcome metrics are flagged "not safe to quote" in the report; sessions are not', () => {
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(/key events [+\-]\d+% \(not safe to quote\)/.test(md), 'key events tagged');
  assert.ok(/revenue [+\-]\d+% \(not safe to quote\)/.test(md), 'revenue tagged');
  assert.ok(!/sessions [+\-]\d+% \(not safe to quote\)/.test(md), 'sessions stay quotable');
  // healthy growth (default fixture, ~+11%) → no tags
  assert.ok(!/\(not safe to quote\)/.test(buildGa4AuditReport(input())));
});

test('a 50–99% spike not tracked is HIGH (not escalated to CRITICAL)', () => {
  const b = baseline({ sessions: 14000, priorSessions: 9000, keyEvents: 460, priorKeyEvents: 450, revenue: 1000, priorRevenue: 980 }); // +56%
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(/\| HIGH \| Growth \|/.test(md));
  assert.ok(!/\| CRITICAL \| Growth \|/.test(md));
});

test('a diluted-but-growing spike is graded LOW, not "Action required", and revenue stays quotable', () => {
  // sessions +276%, key events +112%, revenue +69% — conversions grew with the traffic (just slower).
  const b = baseline({ sessions: 33453, priorSessions: 8904, keyEvents: 1060, priorKeyEvents: 500, revenue: 169000, priorRevenue: 100000 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/Action required/.test(md), 'no false CRITICAL verdict when conversions grew with the traffic');
  assert.ok(/\| LOW \| Growth \|/.test(md), 'growth graded LOW (channel-mix dilution)');
  assert.ok(!/\| (CRITICAL|HIGH) \| Growth \|/.test(md), 'not escalated to critical/high');
  assert.ok(!/revenue\/ROAS may be wrong/.test(md), 'drops the "revenue may be wrong" alarm');
  // Growth no longer "serious" → the traffic-vs-conversion gate is not FAILED, so revenue is not
  // do-not-quote. It stays UNVERIFIED (pass-gated: the ecommerce setup gate cannot be verified via
  // the Admin API in this fixture) — never silently promoted to "safe".
  assert.ok(!/Revenue \/ AOV \/ ROAS \| ⛔ Do not quote/.test(md), 'diluted growth is not a failed gate');
  assert.ok(/Revenue \/ AOV \/ ROAS \| ⚪ Unverified/.test(md), 'revenue reads UNVERIFIED (ecommerce gate unverified), not do-not-quote');
});

test('healthy growth (sessions, key events and revenue move together) → no actionable growth finding', () => {
  const md = buildGa4AuditReport(input()); // baseline trends are all ~+11%
  assert.ok(!/\| (CRITICAL|HIGH|MEDIUM) \| Growth \|/.test(md), 'no spike/drop finding when outcomes track sessions');
});

test('exec summary leads with the score + reliability and never claims "Well-configured"', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(!/Well-configured/.test(md));
  assert.ok(/## 1 · Executive summary/.test(md), 'read-first exec summary present');
  assert.ok(/\*\*Reliability score:\*\* \d+\/100 \(Grade [A-F]\)/.test(md), 'composite score + grade');
  assert.ok(/\*\*Reporting reliability:\*\* \d+% - (High|Medium|Low) confidence/.test(md), 'reliability %');
  assert.ok(/Per-category scorecard/.test(md) && /\| \*\*Composite\*\* \|/.test(md), 'scorecard with composite row');
  assert.ok(/Data trust matrix/.test(md), 'data trust matrix');
  assert.ok(/not verified/.test(md), 'coverage discloses unverified areas');
});

test('executive summary shows the selected audit window (date range + day count)', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Audit window:\*\* .*Jun 29, 2026 \(90 days\)/.test(md), 'markdown section 1 names the window');
  const exec = buildGa4ExecSummary(input());
  assert.ok(exec.dateRange.includes('Jun 29, 2026') && exec.dateRange.includes('90 days'), 'exec view carries the window');
});

test('a clean property with unverifiable consent/ecommerce reads honest — usable, never blanket-"safe to quote"', () => {
  const s = snap({
    customDimensions: [{ parameterName: 'tier', displayName: 'Tier', scope: 'USER' }],
    customMetrics: [{ parameterName: 'pts', displayName: 'Pts' }],
  });
  const md = buildGa4AuditReport(input({ snapshot: s, config: auditGa4(s) }));
  // PASS-GATED trust: with consent + ecommerce unverified, the report must NOT claim the data is
  // blanket-safe to quote (an unrun check cannot make a metric safe) — but it also must not alarm.
  assert.ok(!/Action required/.test(md), 'clean property → no false alarm');
  assert.ok(!/Trustworthy - the data is safe to quote/.test(md), 'must not claim safe-to-quote while revenue/consent gates are unverified');
  assert.ok(/unverified/i.test(md), 'the verdict acknowledges the unverified areas');
});

test('a genuinely clean property (only an info advisory) does not manufacture a risk', () => {
  // Fully instrumented + clean config + clean data quality + healthy growth → no actionable finding.
  const s = snap({
    customDimensions: [{ parameterName: 'tier', displayName: 'Tier', scope: 'USER' }],
    customMetrics: [{ parameterName: 'pts', displayName: 'Pts' }],
  });
  const md = buildGa4AuditReport(input({ snapshot: s, config: auditGa4(s) }));
  assert.ok(/No high-severity issue/.test(md), 'section 2 takes the clean-property branch');
  assert.ok(!/\*\*At stake:\*\* Channel\/source attribution is unreliable/.test(md), 'no fabricated risk in the verdict');
  assert.ok(!/\| INFO \| Data quality \| No major data-quality issues[^|]*\| Channel\/source/.test(md), 'info row carries no business risk');
});

test('buildGa4ExecSummary returns the structured exec used by the panel + styled export', () => {
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const exec = buildGa4ExecSummary(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(exec.composite !== null && exec.composite < 80, 'a critical spike drags the composite down');
  assert.ok(/^[A-F]$/.test(exec.grade));
  assert.match(exec.verdict, /Action required/);
  assert.equal(exec.categories.length, 6);
  assert.equal(exec.trust.length, 5);
  assert.equal(exec.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!.safe, false, 'revenue do-not-quote under a spike');
  assert.equal(exec.coverage.checked, 12); // config areas 9 (+Enhanced measurement +Attribution, graded) + Audiences/Ecommerce/Consent
  // The markdown section 1 and the structured exec agree on the headline number.
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(md.includes(`${exec.composite}/100`), 'markdown + structured exec share the composite');
});

test('report output uses no em dashes (house style)', () => {
  assert.ok(!buildGa4AuditReport(input()).includes('—'), 'clean path');
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  assert.ok(!buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') })).includes('—'), 'critical-spike path');
});

test('missing baseline → Not Verified, no crash', () => {
  const md = buildGa4AuditReport(input({ baseline: null }));
  assert.ok(md.includes('## 6 · Property baseline'));
  assert.ok(/Not Verified/.test(md));
});

test('table cells escape pipes (no broken Markdown rows)', () => {
  const s = snap({ customDimensions: [{ parameterName: 'user_email', displayName: 'a | b', scope: 'EVENT' }] });
  const md = buildGa4AuditReport(input({ snapshot: s, config: auditGa4(s) }));
  assert.ok(md.includes('\\|'), 'pipe escaped in a cell');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
