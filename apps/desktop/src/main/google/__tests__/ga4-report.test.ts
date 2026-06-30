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
  assert.equal(exec.coverage.checked, 11);
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
