import assert from 'node:assert/strict';
import { buildGa4AuditReport, buildGa4ExecSummary, buildGa4Sections, type Ga4ReportInput } from '../ga4-report';
import type { Ga4CampaignReport } from '../ga4-campaigns';
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
  llmTraffic: [
    { source: 'claude.ai', sessions: 3000, keyEvents: 180, convRate: 0.06, revenue: 90000, engagementRate: 0.68 },
    { source: 'perplexity.ai', sessions: 1500, keyEvents: 60, convRate: 0.04, revenue: 30000, engagementRate: 0.55 },
    { source: 'chatgpt.com', sessions: 800, keyEvents: 24, convRate: 0.03, revenue: 0, engagementRate: 0.42 },
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
    campaigns: null,
    ...over,
  };
};

// A ranked campaign report with two tagged campaigns and an untagged share, shaped like rankGa4Campaigns'
// output so the report's campaignPerfView can format it without a live Data API call.
const campaignReport = (over: Partial<Ga4CampaignReport> = {}): Ga4CampaignReport => {
  const rows = over.taggedCampaigns ?? [
    { campaign: 'summer_sale', sessions: 5000, keyEvents: 400, revenue: 250000, engagementRate: 0.62 },
    { campaign: 'spring_promo', sessions: 3000, keyEvents: 150, revenue: 90000, engagementRate: 0.51 },
  ];
  return {
    windowDays: 28,
    dateRange: 'Jun 3 - Jun 30, 2026',
    totalSessions: 20000,
    primaryMetric: 'conversions',
    taggedCampaigns: rows,
    bestCampaign: rows[0] ?? null,
    untaggedSessions: 12000,
    untaggedSharePct: 60,
    currencyCode: 'INR',
    summary: 'Ranked 2 campaign(s) by conversions.',
    findings: [{ severity: 'info', category: 'attribution', message: 'Top campaign by conversions: "summer_sale".' }],
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

test('decision readiness: Customer lifetime value is graded by BigQuery export / Google Signals, not hardcoded', () => {
  const clvRow = (md: string): string => (md.split('\n').find((l) => l.includes('Customer lifetime value')) ?? '');

  // BigQuery event-level export on → Answerable.
  const bqMd = buildGa4AuditReport(input({ snapshot: snap({ bigQueryLinks: [{ project: 'proj', dailyExportEnabled: true, streamingExportEnabled: false }] }) }));
  assert.ok(/\| Customer lifetime value \| Answerable \|/.test(bqMd), `BigQuery export → Answerable, got: ${clvRow(bqMd)}`);

  // No export but Google Signals on → Partial (cross-device approximation).
  const sigMd = buildGa4AuditReport(input({ snapshot: snap({ bigQueryLinks: [], googleSignals: 'GOOGLE_SIGNALS_ENABLED' }) }));
  assert.ok(/\| Customer lifetime value \| Partial \|/.test(sigMd), `Signals only → Partial, got: ${clvRow(sigMd)}`);

  // Neither → Not answerable (original behaviour preserved).
  const noneMd = buildGa4AuditReport(input({ snapshot: snap({ bigQueryLinks: [], googleSignals: 'GOOGLE_SIGNALS_DISABLED' }) }));
  assert.ok(/\| Customer lifetime value \| Not answerable \|/.test(noneMd), `neither → Not answerable, got: ${clvRow(noneMd)}`);
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

test('decision readiness derives from config and is gated by the data trust matrix', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/Abandonment by product\/page\? \| Not answerable/.test(md), 'no ecommerce events → Not answerable');
  // Ads are linked, but revenue is unverified in this fixture, so the revenue decision is capped at
  // Partial rather than claimed Answerable on wiring alone.
  assert.ok(/Which campaigns generate revenue\? \| Partial/.test(md), 'revenue unverified → Partial despite Ads link');
});

test('decision readiness caps trust-dependent decisions at Partial when conversion/revenue are unverified', () => {
  // Default fixture: revenue is unverified (no ecommerce setup to gate on), so the revenue decision
  // is Partial even though conversion counts are trusted here. Google Signals alone is a cross-device
  // approximation, not robust identity, so repeat/churn is Partial even with Signals on (was
  // Answerable before this gating).
  const md = buildGa4AuditReport(input());
  assert.ok(/Which campaigns generate revenue\? \| Partial/.test(md), 'revenue-dependent decision gated to Partial');
  assert.ok(/Repeat\/churn within 90 days \| Partial/.test(md), 'Signals-only repeat/churn is Partial, not Answerable');

  // When the trust matrix marks conversions do-not-quote (a >=2x traffic spike that conversions did
  // not track), conversion-dependent decisions must also drop to Partial.
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const spikeMd = buildGa4AuditReport(input({ snapshot: snap({ keyEvents: [{ eventName: 'generate_lead' }, { eventName: 'refund' }] }), baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(/CAC by channel \| Partial/.test(spikeMd), 'conversions do-not-quote → CAC Partial');
  assert.ok(/Refund\/return rate \| Partial/.test(spikeMd), 'conversions do-not-quote → refund Partial despite refund events');
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
  // A deterministically-measured data-quality finding is Confirmed, not merely observed.
  assert.ok(/Unassigned.*\| Confirmed \|/.test(md), 'data-quality finding carries the Confirmed state');
});

test('section 4 carries a verification state per finding and a "Blocked by verification" group', () => {
  // A growth read is graded to its worst branch (carries an "if unconfirmed" branch), so it is
  // OBSERVED, not confirmed.
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(/\| Severity \| Area \| Issue \| Business risk \| Fix \| State \|/.test(md), 'findings table has a State column');
  assert.ok(/\| CRITICAL \| Growth \|.*\| Observed \|/.test(md), 'the growth read is Observed (unconfirmed)');
  // Verification blockers are promoted into Section 4 as a first-class Blocked group.
  assert.ok(/\*\*Blocked by verification\*\*/.test(md), 'blocked group heading');
  assert.ok(/- \*\*Consent:\*\*/.test(md), 'consent is a blocked item');
  assert.ok(/- \*\*Measurement:\*\*/.test(md), 'per-event parameter coverage is a blocked item');
  // The ecommerce blocker only appears once purchase/item key events exist.
  assert.ok(!/- \*\*Ecommerce:\*\*/.test(md), 'no ecommerce blocker without ecommerce events');
  const ecomMd = buildGa4AuditReport(input({ snapshot: snap({ keyEvents: [{ eventName: 'purchase' }, { eventName: 'add_to_cart' }] }) }));
  assert.ok(/- \*\*Ecommerce:\*\* Ecommerce item parameters and duplicate transactions/.test(ecomMd), 'ecommerce item-params/duplicate blocker surfaced');
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

test('section 6 renders the retention-cohort headline when provided, and omits it otherwise', () => {
  const withRet = buildGa4AuditReport(input({ retentionSummary: 'Week 1: 34% across 5 cohorts · Week 4: 11% across 3 cohorts (weighted, n>=100 each)' }));
  assert.ok(/- \*\*Retention \(cohorts\):\*\* Week 1: 34% across 5 cohorts/.test(withRet), 'retention line rendered from the summary');
  const without = buildGa4AuditReport(input());
  assert.ok(!/- \*\*Retention \(cohorts\):\*\*/.test(without), 'no retention line when the summary is null/absent');
});

test('engagement line keeps time + rate but drops the per-user figure when it is zero', () => {
  const b = baseline({ sessions: 100, avgEngagementSec: 60, engagementRate: 0.5, engagedSessionsPerUser: 0 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(/- \*\*Engagement:\*\*/.test(md) && /1m 0s avg engagement time\/session/.test(md), 'line still present with time');
  assert.ok(/50\.0% engaged-session rate/.test(md), 'rate still shown');
  assert.ok(!/engaged sessions\/user/.test(md), 'per-user figure dropped when 0 (no "0.0 engaged sessions/user")');
});

test('section 6 renders a Key insights block derived from the breakdown data', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*Key insights\*\*/.test(md), 'Key insights heading');
  assert.ok(/- Biggest funnel drop-off: View item to Add to cart, where 60% of users leave\./.test(md), 'funnel drop-off insight (10000 -> 4000)');
  assert.ok(/- AI assistants sent [\d,]+ sessions/.test(md), 'AI-channel materiality insight');
  assert.ok(/- \/ is your top entry page \([\d,]+ sessions\) but converts at only/.test(md), 'landing-page leak insight');
});

test('section 6 flags perf tables + insights as provisional when revenue/conversion are unverified', () => {
  // Default fixture: revenue is unverified, so the revenue columns get a provisional note and the
  // revenue-derived Key insight is tagged, rather than reading as verified fact.
  const md = buildGa4AuditReport(input());
  assert.ok(/Revenue columns below are provisional - revenue is unverified/.test(md), 'perf-table provisional note');
  assert.ok(/brings the most revenue.*\(provisional - revenue unverified\)/.test(md), 'revenue insight tagged provisional');
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

test('section 6 renders the AI-assistant traffic table with share + the undercount caveat', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(/\*\*AI assistant traffic\*\*/.test(md), 'AI traffic sub-heading');
  assert.ok(/\| AI source \| Sessions \| Conv\. rate \| Revenue \| Engagement \|/.test(md), 'table header');
  assert.ok(/\| claude\.ai \|/.test(md) && /\| perplexity\.ai \|/.test(md), 'AI-source rows');
  // AI sessions 3000+1500+800 = 5300 of 77506 total = 6.8%.
  assert.ok(/5,300 sessions, 6\.8% of all/.test(md), 'aggregate share of total sessions');
  assert.ok(/\| chatgpt\.com \|.*\| - \|/.test(md), 'zero-revenue AI source shows a dash');
  assert.ok(/systematic undercount/.test(md), 'undercount caveat present');
});

test('AI-assistant traffic table is omitted when there is no AI referral traffic', () => {
  const b = baseline({ llmTraffic: [] });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(!/\*\*AI assistant traffic\*\*/.test(md), 'no empty AI table');
});

test('AI-assistant table shows all matched sources and the share reconciles with the rows (no top-10 truncation)', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ source: `ai-src-${i}.com`, sessions: 100, keyEvents: 5, convRate: 0.05, revenue: 0, engagementRate: 0.5 }));
  const b = baseline({ llmTraffic: many });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(/\| ai-src-11\.com \|/.test(md), 'the 11th+ source is still shown (rows are not truncated at 10)');
  assert.ok(/1,200 sessions, 1\.5% of all/.test(md), 'the share sums exactly the rows shown (12 x 100 of 77,506)');
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
  assert.ok(/\*\*Setup completeness:\*\* \d+\/100 \(Grade [A-F]\)/.test(md), 'composite score + grade');
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

test('campaign performance: two tagged campaigns render rows, name the best, and format the untagged share', () => {
  const camp = campaignReport();
  const sections = buildGa4Sections(input({ campaigns: camp }));
  assert.ok(sections.campaignPerformance, 'campaignPerformance present when campaigns are tagged');
  assert.equal(sections.campaignPerformance!.rows.length, 2, 'both tagged campaigns become rows');
  assert.equal(sections.campaignPerformance!.rows[0].campaign, 'summer_sale', 'top campaign first');
  assert.equal(sections.campaignPerformance!.rows[0].conversions, '400', 'key-event count formatted from keyEvents');
  assert.equal(sections.campaignPerformance!.rows[0].purchases, '—', 'purchases show a dash (not 0) when never fetched');
  assert.equal(sections.campaignPerformance!.rows[0].revenue, 'INR 250,000', 'revenue prefixed with the property currency');
  assert.equal(sections.campaignPerformance!.rows[0].engagement, '62%', 'engagement as a whole percent');
  assert.ok(sections.campaignPerformance!.best?.startsWith('summer_sale'), 'best names the top campaign');
  assert.ok(/400 key events/.test(sections.campaignPerformance!.best!), 'best says key events, never conversions');
  assert.equal(sections.campaignPerformance!.untaggedShare, '60.0%', 'untagged share formatted to one decimal');
  assert.ok(/NOT sales/.test(sections.campaignPerformance!.caveat) && /channel table/.test(sections.campaignPerformance!.caveat), 'guardrail caveat travels with the view');
  // The markdown report prints the campaign table + the campaign finding lands in section 4.
  const md = buildGa4AuditReport(input({ campaigns: camp }));
  assert.ok(md.includes('**Campaign performance**'), 'markdown has the campaign table heading');
  assert.ok(md.includes('| Campaign | Sessions | Key events | Purchases | Revenue | Engagement |'), 'markdown header says Key events + Purchases, never Conversions');
  assert.ok(/\| summer_sale \| 5,000 \| 400 \| - \| INR 250,000 \|/.test(md), 'markdown renders the top campaign row (unfetched purchases = dash)');
  assert.ok(md.includes('NOT sales'), 'the guardrail caveat renders under the markdown table');
  assert.ok(md.includes('| Campaigns |'), 'the campaign finding lands in the All-findings table');
});

test('campaign performance: purchase counts render when fetched, and "best" carries them', () => {
  const camp = campaignReport({
    taggedCampaigns: [
      { campaign: 'summer_sale', sessions: 5000, keyEvents: 23933, revenue: 532085, engagementRate: 0.62, purchases: 214 },
      { campaign: 'spring_promo', sessions: 3000, keyEvents: 150, revenue: 90000, engagementRate: 0.51, purchases: 9 },
    ],
  });
  camp.bestCampaign = camp.taggedCampaigns[0];
  const sections = buildGa4Sections(input({ campaigns: camp }));
  assert.equal(sections.campaignPerformance!.rows[0].purchases, '214', 'real transaction count in its own column');
  assert.ok(/23,933 key events, 214 purchases/.test(sections.campaignPerformance!.best!), 'best separates key events from purchases');
});

test('anti-lie finding: paid-campaign revenue that no paid channel shows → attribution-mismatch HIGH', () => {
  // The demo-killer shape: two ad-platform campaigns claim ~760K, paid channels show ~43K, and the
  // biggest revenue "channel" is organic — the paid traffic is almost certainly mislabeled there.
  const b = baseline({
    channelPerformance: [
      { channel: 'Organic Shopping', sessions: 30000, keyEvents: 2000, convRate: 0.04, revenue: 845315, engagementRate: 0.6 },
      { channel: 'Paid Shopping', sessions: 900, keyEvents: 40, convRate: 0.03, revenue: 13200, engagementRate: 0.5 },
      { channel: 'Paid Social', sessions: 1200, keyEvents: 50, convRate: 0.03, revenue: 29380, engagementRate: 0.5 },
    ],
  });
  const camp = campaignReport({
    taggedCampaigns: [
      { campaign: 'Adv+ Shopping - All products', sessions: 8000, keyEvents: 23933, revenue: 532085, engagementRate: 0.6 },
      { campaign: '20574896341', sessions: 4000, keyEvents: 9000, revenue: 227350, engagementRate: 0.55 },
    ],
  });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b), campaigns: camp }));
  assert.ok(md.includes('Campaign and channel revenue do not reconcile'), 'reconciliation finding fires');
  assert.ok(md.includes('INR 759,435') && md.includes('INR 42,580'), 'both revenue pictures quantified');
  assert.ok(md.includes('Organic Shopping'), 'names the non-paid channel the revenue is likely landing in');
  assert.ok(/utm_medium=cpc/.test(md), 'fix names the paid-tagging remediation');

  // Reconciled paid revenue (paid channels cover the campaign claim) → no finding.
  const okB = baseline(); // default: Paid Search 180,000
  const okCamp = campaignReport({
    taggedCampaigns: [{ campaign: 'brand_search_always_on', sessions: 5000, keyEvents: 400, revenue: 200000, engagementRate: 0.6 }],
  });
  const okMd = buildGa4AuditReport(input({ baseline: okB, growth: growthOf(okB), campaigns: okCamp }));
  assert.ok(!okMd.includes('Campaign and channel revenue do not reconcile'), 'no finding when the pictures reconcile');

  // Non-paid campaign names (email/newsletter UTMs) never trip the check even with zero paid-channel revenue.
  const emailCamp = campaignReport({
    taggedCampaigns: [{ campaign: 'july_newsletter', sessions: 5000, keyEvents: 400, revenue: 300000, engagementRate: 0.6 }],
  });
  const noPaidB = baseline({
    channelPerformance: [
      { channel: 'Email', sessions: 9000, keyEvents: 700, convRate: 0.05, revenue: 310000, engagementRate: 0.65 },
      { channel: 'Organic Search', sessions: 40000, keyEvents: 1200, convRate: 0.03, revenue: 250000, engagementRate: 0.62 },
    ],
  });
  const emailMd = buildGa4AuditReport(input({ baseline: noPaidB, growth: growthOf(noPaidB), campaigns: emailCamp }));
  assert.ok(!emailMd.includes('Campaign and channel revenue do not reconcile'), 'email campaigns in non-paid channels are legitimate');
});

test('campaign performance: no tagged campaigns → campaignPerformance is null and markdown shows the advisory', () => {
  const empty = campaignReport({ taggedCampaigns: [], bestCampaign: null, untaggedSharePct: 100, findings: [{ severity: 'medium', category: 'attribution', message: 'No sessions are attributed to a marketing campaign.', recommendation: 'Add utm_campaign/utm_source/utm_medium to your marketing links.' }] });
  const sections = buildGa4Sections(input({ campaigns: empty }));
  assert.equal(sections.campaignPerformance, null, 'null when there are no tagged campaigns');
  const md = buildGa4AuditReport(input({ campaigns: empty }));
  assert.ok(/No utm_campaign-tagged traffic/.test(md), 'markdown prints the no-campaign advisory');
  assert.ok(!/\| Campaign \| Sessions \| Key events \|/.test(md), 'no empty campaign table when untagged');
  // A null campaigns input (query failed) leaves the section out entirely and adds no finding.
  const nullSections = buildGa4Sections(input({ campaigns: null }));
  assert.equal(nullSections.campaignPerformance, null, 'null campaigns → null view');
});


test('anti-lie findings: single-bucket channel concentration + payment-gateway referral leakage', () => {
  const b = baseline({
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
  });
  const counts = dqCounts({ sourceMediums: [
    { name: 'google / organic', sessions: 40000 },
    { name: 'razorpay.com / referral', sessions: 512 },
  ] });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b), dqCounts: counts, dataQuality: auditGa4DataQuality(counts) }));
  assert.ok(/arrived in a single day/.test(md), 'concentration finding fires on the one-day Direct burst');
  assert.ok(/an event .a bot burst, a scrape, or an untagged campaign., not a channel baseline/.test(md), 'concentration framing');
  assert.ok(/Payment-gateway referral leakage/.test(md), 'gateway leakage finding fires');
  assert.ok(/razorpay.com \/ referral/.test(md) && /List unwanted referrals/.test(md), 'names the gateway + the fix');
  // A clean fixture produces neither.
  const clean = buildGa4AuditReport(input());
  assert.ok(!/arrived in a single day/.test(clean) && !/Payment-gateway referral leakage/.test(clean), 'no anti-lie findings on clean data');
});

test('REGRESSION: the concentration spike and the revenue mismatch fire TOGETHER, cross-linked, with an auditable numerator', () => {
  // The reviewer-reported shape: the Direct single-bucket spike AND the paid-campaign revenue mismatch
  // exist in the same window. Both HIGHs must appear (a property can have two HIGH problems), the
  // reconciliation must name the spike as the same root cause, and the claimed total must count ONLY
  // revenue-bearing paid-format campaigns - the zero-revenue "PT | Traffic |..." campaign is excluded.
  const b = baseline({
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
      { channel: 'Paid Social', sessions: 1200, keyEvents: 50, convRate: 0.03, revenue: 29380, engagementRate: 0.5 },
    ],
  });
  const camp = campaignReport({
    taggedCampaigns: [
      { campaign: 'Adv+ Shopping - All products', sessions: 8000, keyEvents: 23933, revenue: 532085, engagementRate: 0.6 },
      { campaign: 'PT | Traffic | Website | March24', sessions: 27914, keyEvents: 500, revenue: 0, engagementRate: 0.4 },
      { campaign: '20574896341', sessions: 4000, keyEvents: 9000, revenue: 227350, engagementRate: 0.55 },
      { campaign: 'Adv+ Shopping - Bestsellers', sessions: 2000, keyEvents: 4000, revenue: 128460, engagementRate: 0.5 },
    ],
  });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b), campaigns: camp }));
  assert.ok(/arrived in a single day/.test(md), 'concentration HIGH still present alongside the mismatch');
  assert.ok(/Campaign and channel revenue do not reconcile/.test(md), 'reconciliation HIGH present in the same report');
  assert.ok(/same root cause as the Direct single-day concentration/.test(md), 'the two findings are cross-linked, not presented as unrelated');
  assert.ok(md.includes('INR 887,895'), 'numerator = 532,085 + 227,350 + 128,460 (revenue-bearing paid-format campaigns only)');
  assert.ok(/3 paid-format campaign\(s\) with recorded revenue/.test(md), 'the counted-campaign total is stated for auditability');
  const reconLine = md.split('\n').find((l) => l.includes('do not reconcile')) ?? '';
  assert.ok(!reconLine.includes('PT '), 'the zero-revenue traffic campaign is never counted or named in the mismatch');
});

test('ecommerce verification: a CLEAN transaction pass upgrades Ecommerce to PASS and un-caps revenue', () => {
  const sEcom = snap({ keyEvents: [{ eventName: 'purchase' }, { eventName: 'add_to_cart' }] });
  const inp = input({ snapshot: sEcom, config: auditGa4(sEcom), ecomVerification: { transactionsChecked: 180, duplicateIds: 0, notSetSharePct: 1.2 } });
  const md = buildGa4AuditReport(inp);
  assert.ok(/verified: 180 transaction_id\(s\) checked - no duplicates/.test(md), 'Ecommerce evidence shows the verified pass');
  const exec = buildGa4ExecSummary(inp);
  const rev = exec.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!;
  // Collection is still Partial (Admin API ceiling), so revenue lands on CAUTION - quotable and
  // credit-earning, no longer unverified/do-not-quote.
  assert.ok(!/unverified|do not quote/i.test(rev.reason), 'revenue is no longer unverified: ' + rev.reason);
  assert.ok(!exec.reliabilityCappedBy.some((c) => /Revenue/.test(c)), 'revenue no longer caps the reliability headline');
  // The verified pass also clears the Section-8 blocked item + not-verified line.
  const sections = buildGa4Sections(inp);
  assert.ok(!(sections.blocked ?? []).some((b) => b.area === 'Ecommerce'), 'no Ecommerce blocked-by-verification item');
  assert.ok(!sections.notVerified.items.some((i) => /Ecommerce item parameters/.test(i.item)), 'not-verified list drops the ecommerce line');
});

test('ecommerce verification: DUPLICATE transaction_ids fail the area and keep revenue do-not-quote', () => {
  const sEcom = snap({ keyEvents: [{ eventName: 'purchase' }] });
  const inp = input({ snapshot: sEcom, config: auditGa4(sEcom), ecomVerification: { transactionsChecked: 150, duplicateIds: 3, notSetSharePct: 0.4 } });
  const md = buildGa4AuditReport(inp);
  assert.ok(/verified: 3 duplicate transaction_id\(s\) among 150 checked/.test(md), 'duplicates named in the evidence');
  const exec = buildGa4ExecSummary(inp);
  const rev = exec.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!;
  assert.equal(rev.safe, false, 'revenue not quotable with duplicated transactions');
  assert.ok(exec.reliabilityCappedBy.some((c) => /Revenue/.test(c)), 'revenue caps the headline');
});

test('ecommerce verification: a high missing-id share stays PARTIAL (deduplication impossible)', () => {
  const sEcom = snap({ keyEvents: [{ eventName: 'purchase' }] });
  const md = buildGa4AuditReport(input({ snapshot: sEcom, config: auditGa4(sEcom), ecomVerification: { transactionsChecked: 90, duplicateIds: 0, notSetSharePct: 22.5 } }));
  assert.ok(/22.5% of purchases have no id/.test(md), 'missing-id share named');
  // An UNRUN pass keeps the original Partial wording (verification, not vibes).
  const md2 = buildGa4AuditReport(input({ snapshot: sEcom, config: auditGa4(sEcom) }));
  assert.ok(/item params & duplicate transactions not verified/.test(md2), 'unrun pass stays Partial with the old wording');
});

test('data-collection continuity: sessions on EVERY day of the window upgrade Data collection to PASS', () => {
  // 5-day window, all 5 days have traffic -> continuity verified via the Data API.
  const counts = dqCounts({ windowDays: 5, startDate: '2026-06-25', endDate: '2026-06-29' });
  const b = baseline({ dailySessions: [
    { date: '20260625', sessions: 900 }, { date: '20260626', sessions: 950 }, { date: '20260627', sessions: 870 },
    { date: '20260628', sessions: 910 }, { date: '20260629', sessions: 925 },
  ] });
  const inp = input({ baseline: b, growth: growthOf(b), dqCounts: counts, dataQuality: auditGa4DataQuality(counts) });
  const md = buildGa4AuditReport(inp);
  assert.ok(/verified: sessions arrived on every day of the 5-day window/.test(md), 'evidence names the verified continuity');
  const exec = buildGa4ExecSummary(inp);
  const sess = exec.trust.find((t) => t.metric === 'Sessions, users, engagement rate')!;
  assert.equal(sess.safe, true, 'sessions become SAFE once collection is verified: ' + sess.reason);

  // A gap day (or thin coverage) keeps the Admin-only Partial - unproven is not verified.
  const gappy = baseline({ dailySessions: [
    { date: '20260625', sessions: 900 }, { date: '20260626', sessions: 0 }, { date: '20260627', sessions: 870 },
    { date: '20260628', sessions: 910 }, { date: '20260629', sessions: 925 },
  ] });
  const md2 = buildGa4AuditReport(input({ baseline: gappy, growth: growthOf(gappy), dqCounts: counts, dataQuality: auditGa4DataQuality(counts) }));
  assert.ok(!/verified: sessions arrived on every day/.test(md2), 'a zero-session day fails the continuity bar');
});

test('data-collection continuity raises the reliability headline (the verification, not a relaxed gate)', () => {
  const counts = dqCounts({ windowDays: 5, startDate: '2026-06-25', endDate: '2026-06-29' });
  const full = baseline({ dailySessions: [
    { date: '20260625', sessions: 900 }, { date: '20260626', sessions: 950 }, { date: '20260627', sessions: 870 },
    { date: '20260628', sessions: 910 }, { date: '20260629', sessions: 925 },
  ] });
  const verified = buildGa4ExecSummary(input({ baseline: full, growth: growthOf(full), dqCounts: counts, dataQuality: auditGa4DataQuality(counts) }));
  const unverified = buildGa4ExecSummary(input()); // default fixture: 90-day window, ~8 daily entries -> no continuity
  assert.ok(verified.reliabilityPct > unverified.reliabilityPct, `verified ${verified.reliabilityPct}% > unverified ${unverified.reliabilityPct}%`);
});

test('anti-lie finding: engagement bimodality across markets -> invalid-traffic finding (same detector as the chart)', () => {
  const b = baseline({
    geoPerformance: [
      { country: 'India', sessions: 50000, keyEvents: 1500, convRate: 0.03, revenue: 400000, engagementRate: 0.9 },
      { country: 'United States', sessions: 12000, keyEvents: 900, convRate: 0.075, revenue: 250000, engagementRate: 0.92 },
      { country: 'United Kingdom', sessions: 6000, keyEvents: 300, convRate: 0.05, revenue: 90000, engagementRate: 0.88 },
      { country: 'Vietnam', sessions: 9000, keyEvents: 2, convRate: 0.0002, revenue: 0, engagementRate: 0.12 },
    ],
  });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b) }));
  assert.ok(/Suspected invalid traffic/.test(md), 'finding fires');
  assert.ok(/Vietnam \(12% engagement\)/.test(md), 'names the low-cluster market with its engagement');
  assert.ok(/9,000 sessions \(11.7% of the listed markets' total\)/.test(md), 'quantifies the affected share');
  assert.ok(/\| HIGH \| Data quality \| Suspected invalid traffic/.test(md), 'HIGH at >=10% share');

  // A smooth engagement spread produces nothing.
  const smooth = baseline({
    geoPerformance: [
      { country: 'India', sessions: 50000, keyEvents: 1500, convRate: 0.03, revenue: 400000, engagementRate: 0.62 },
      { country: 'United States', sessions: 12000, keyEvents: 900, convRate: 0.075, revenue: 250000, engagementRate: 0.7 },
      { country: 'United Kingdom', sessions: 6000, keyEvents: 300, convRate: 0.05, revenue: 90000, engagementRate: 0.55 },
      { country: 'Germany', sessions: 4000, keyEvents: 150, convRate: 0.04, revenue: 60000, engagementRate: 0.48 },
    ],
  });
  assert.ok(!/Suspected invalid traffic/.test(buildGa4AuditReport(input({ baseline: smooth, growth: growthOf(smooth) }))), 'no finding on a smooth spread');

  // A tiny low cluster (<3% of listed sessions) is noise, not a bot wave.
  const tiny = baseline({
    geoPerformance: [
      { country: 'India', sessions: 50000, keyEvents: 1500, convRate: 0.03, revenue: 400000, engagementRate: 0.9 },
      { country: 'United States', sessions: 12000, keyEvents: 900, convRate: 0.075, revenue: 250000, engagementRate: 0.92 },
      { country: 'United Kingdom', sessions: 6000, keyEvents: 300, convRate: 0.05, revenue: 90000, engagementRate: 0.88 },
      { country: 'Vietnam', sessions: 900, keyEvents: 2, convRate: 0.002, revenue: 0, engagementRate: 0.12 },
    ],
  });
  assert.ok(!/Suspected invalid traffic/.test(buildGa4AuditReport(input({ baseline: tiny, growth: growthOf(tiny) }))), 'sub-3% low cluster stays a breakdown note');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
