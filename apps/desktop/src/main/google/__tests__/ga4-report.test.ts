import assert from 'node:assert/strict';
import { buildGa4AuditReport, type Ga4ReportInput } from '../ga4-report';
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

test('report has all the templated sections', () => {
  const md = buildGa4AuditReport(input());
  for (const h of ['# GA4 Property Audit', '## Executive summary', '## Area status', '## Property baseline', '## Decision readiness', '## Findings', '## Not verified', '## Summary']) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  assert.ok(md.includes('353451709'), 'property id');
  assert.ok(md.includes('14 months'), 'retention label');
});

test('area-status table grades on evidence: Data collection + zero-config Custom definitions are Partial, not a blind Pass', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(md.includes('| Data collection | Partial | Likely |'), 'collection Partial (deep health unverifiable)');
  assert.ok(/\| Custom definitions \| Partial \| Likely \|/.test(md), 'zero custom defs → Partial');
  // Ecommerce is never a clean Pass while item params are unverified.
  const ecomMd = buildGa4AuditReport(input({ snapshot: snap({ keyEvents: [{ eventName: 'purchase' }, { eventName: 'add_to_cart' }] }) }));
  assert.ok(/\| Ecommerce \| Partial \| Likely \|/.test(ecomMd), 'ecommerce present → Partial, not Pass');
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

test('a data-quality finding lands in the Findings table; counts in Summary', () => {
  const counts = dqCounts({
    totalSessions: 100,
    channelGroups: [{ name: 'Unassigned', sessions: 40 }, { name: 'Direct', sessions: 60 }],
  });
  const md = buildGa4AuditReport(input({ dqCounts: counts, dataQuality: auditGa4DataQuality(counts) }));
  assert.ok(/\| Findings \(by severity\)|Recommended fix/.test(md));
  assert.ok(/Unassigned/.test(md));
});

test('a traffic spike conversions did not track → HIGH growth finding, exec flags it, no false all-clear', () => {
  const b = baseline({ sessions: 32165, priorSessions: 8819, keyEvents: 210, priorKeyEvents: 200, revenue: 1000, priorRevenue: 950 });
  const md = buildGa4AuditReport(input({ baseline: b, growth: growthOf(b, 'Organic Social') }));
  assert.ok(/\| HIGH \| Growth \|/.test(md), 'high growth finding in the table');
  assert.ok(/high-impact issue/.test(md), 'exec flags the high finding');
  assert.ok(!/Well-configured/.test(md), 'never a false all-clear');
  assert.ok(/Growth signals \(vs prior\)/.test(md), 'growth signals shown in baseline');
});

test('healthy growth (sessions, key events and revenue move together) → no growth finding', () => {
  const md = buildGa4AuditReport(input()); // baseline trends are all ~+11%
  assert.ok(!/\| (HIGH|MEDIUM) \| Growth \|/.test(md), 'no spike/drop finding when outcomes track sessions');
});

test('exec summary never claims "Well-configured" while areas are unverified/partial', () => {
  const md = buildGa4AuditReport(input());
  assert.ok(!/Well-configured/.test(md));
  assert.ok(/area\(s\) unverified/.test(md), 'exec discloses unverified coverage');
});

test('missing baseline → Not Verified, no crash', () => {
  const md = buildGa4AuditReport(input({ baseline: null }));
  assert.ok(md.includes('## Property baseline'));
  assert.ok(/Not Verified/.test(md));
});

test('table cells escape pipes (no broken Markdown rows)', () => {
  const s = snap({ customDimensions: [{ parameterName: 'user_email', displayName: 'a | b', scope: 'EVENT' }] });
  const md = buildGa4AuditReport(input({ snapshot: s, config: auditGa4(s) }));
  assert.ok(md.includes('\\|'), 'pipe escaped in a cell');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
