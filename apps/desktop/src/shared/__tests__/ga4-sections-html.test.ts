import assert from 'node:assert/strict';
import { ga4SectionsHtml, engagementClusters } from '../ga4-sections-html';
import type { Ga4SectionsView } from '../ipc';

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

const view = (over: Partial<Ga4SectionsView> = {}): Ga4SectionsView => ({
  topFinding: {
    severity: 'critical',
    area: 'Growth',
    message: 'Sessions grew +276% but conversions <did> not keep pace.',
    evidence: 'Sessions +276%; key events +112%; revenue +69%.',
    whyItMatters: 'Revenue may be under-reported.',
    ifUnconfirmed: 'Graded to the worse branch.',
    recommendation: 'Verify in DebugView.',
    related: 'Unassigned 3% of sessions.',
  },
  noIssueNote: null,
  outcomes: {
    assessed: true,
    sessionsPct: 276,
    keyEventsPct: 112,
    revenuePct: 69,
    restated: null,
    drivers: [],
    sessionsFrom: '8,904', sessionsTo: '33,453',
    keyEventsFrom: '500', keyEventsTo: '1,060',
    revenueFrom: 'INR 100,000', revenueTo: 'INR 169,000',
    keSafe: false,
    revSafe: false,
    sesSafe: true,
    quoteNote: '* Not safe to quote until conversion tracking is confirmed; sessions are safe to quote.',
    read: 'Outcomes did NOT keep pace with traffic.',
    trendPattern: 'Upward trend. A sustained upward trend.',
  },
  findings: [
    { severity: 'critical', area: 'Growth', message: 'Spike unconfirmed.', businessRisk: 'Revenue unreliable.', recommendation: 'Verify in DebugView.', state: 'unconfirmed' },
    { severity: 'low', area: 'Config', message: 'No custom dimensions.', businessRisk: 'Limited segmentation.', recommendation: 'Register dimensions.', state: 'confirmed' },
    { severity: 'info', area: 'Data quality', message: 'No major issues.', businessRisk: '—', recommendation: '—', state: 'confirmed' },
  ],
  blocked: [
    { area: 'Consent', message: 'Consent Mode v2 not assessed.', recommendation: 'Verify in DebugView.' },
    { area: 'Measurement', message: 'Per-event parameter coverage not computed.', recommendation: 'Run a per-event pass.' },
  ],
  actionableCount: 2,
  areas: [
    { area: 'Data collection', statusKey: 'partial', confidence: 'Likely', evidence: '1 data stream(s)' },
    { area: 'Key events', statusKey: 'pass', confidence: 'Certain', evidence: '5 key event(s)' },
    { area: 'Consent', statusKey: 'not_verified', confidence: 'Guessing', evidence: 'consent mode not retrievable' },
  ],
  baseline: {
    sessions: '33,453',
    priorSessions: '8,904',
    trend: ' (+276% vs prior period)',
    growth: { sessionsPct: 276, keyEventsPct: 112, revenuePct: 69, keSafe: false, revSafe: false },
    peakDay: 'Jun 28 — 2,236 sessions',
    newVsReturning: 'new 78%, returning 21%',
    topMarkets: 'India 96%, United States 1%',
    engagement: '1m 23s avg engagement time/session · 61.2% engaged-session rate · 1.4 engaged sessions/user',
    retention: 'Week 1: 34% across 5 cohorts · Week 4: 11% across 3 cohorts (weighted, n>=100 each)',
  },
  channelPerformance: [
    { channel: 'Organic Search', sessions: '20,000', convRate: '3.0%', revenue: 'INR 250,000', engagement: '62%' },
    { channel: 'Paid Search', sessions: '8,000', convRate: '4.5%', revenue: 'INR 180,000', engagement: '55%' },
  ],
  landingPages: [
    { page: '/pricing', sessions: '12,000', convRate: '6.0%', revenue: 'INR 300,000', engagement: '71%' },
    { page: '/blog/post', sessions: '8,000', convRate: '0.5%', revenue: '-', engagement: '34%' },
  ],
  devicePerformance: [
    { device: 'mobile', sessions: '50,000', convRate: '3.0%', revenue: 'INR 200,000', engagement: '52%' },
    { device: 'desktop', sessions: '25,000', convRate: '4.0%', revenue: 'INR 320,000', engagement: '68%' },
  ],
  geoPerformance: [
    { country: 'India', sessions: '70,000', convRate: '3.0%', revenue: 'INR 400,000', engagement: '55%' },
    { country: 'United States', sessions: '4,000', convRate: '8.0%', revenue: 'INR 250,000', engagement: '72%' },
  ],
  campaignPerformance: {
    rows: [
      { campaign: 'summer_sale', sessions: '5,000', conversions: '400', purchases: '12', revenue: 'INR 250,000', engagement: '62%', spend: 'INR 100,000', roas: '2.5x', cac: 'INR 8,333' },
      { campaign: 'spring_promo', sessions: '3,000', conversions: '150', purchases: '4', revenue: 'INR 90,000', engagement: '51%', spend: '—', roas: '—', cac: '—' },
    ],
    best: 'summer_sale (400 key events, 12 purchases, INR 250,000)',
    untaggedShare: '60.0%',
    hasCost: true,
    caveat: '"Key events" counts every configured key event (product views, add-to-carts, sign-ups, ...), NOT sales - Purchases is the real transaction count. Revenue here is campaign-attributed and will not match the channel table 1:1.',
  },
  productPerformance: null,
  llmTraffic: {
    rows: [
      { source: 'claude.ai', sessions: '3,000', convRate: '6.0%', revenue: 'INR 90,000', engagement: '68%' },
      { source: 'perplexity.ai', sessions: '1,500', convRate: '4.0%', revenue: 'INR 30,000', engagement: '55%' },
    ],
    share: '4,500 sessions, 5.8% of all',
  },
  insights: [
    'Traffic peaked on Jun 15 at 1,800 sessions - 40% above the daily average.',
    'Conversion rates are near 100% on the channels that carry most of your traffic - mark only true conversions.',
  ],
  funnel: {
    steps: [
      { label: 'View item', users: '10,000', pctEntry: '100%', stepConv: '—' },
      { label: 'Add to cart', users: '4,000', pctEntry: '40%', stepConv: '40%' },
      { label: 'Begin checkout', users: '2,000', pctEntry: '20%', stepConv: '50%' },
      { label: 'Purchase', users: '1,000', pctEntry: '10%', stepConv: '50%' },
    ],
    overall: '10.0%',
  },
  decisions: [
    { q: 'Which campaigns generate revenue?', status: 'Answerable', note: 'Google Ads linked' },
    { q: 'Lead quality', status: 'Not answerable', note: 'no lead key events' },
  ],
  notVerified: { gate: 'whether conversion tracking fires for the new traffic', items: [{ item: 'Per-event parameter coverage', blocks: 'whether events carry params' }, { item: 'Consent Mode v2 signals', blocks: 'consent loss' }] },
  scope: { auditId: 'GA4-123-20260629', composite: 65, grade: 'D', reliabilityPct: 45, window: 'Jun 3 – Jun 30, 2026 (28 days)', retention: '14 months', timezone: 'Asia/Calcutta', currency: 'INR', generated: '2026-06-30T12:00:00Z', property: 'Acme (123)', limitations: 'per-event parameter coverage not computed.', findings: { critical: 1, high: 0, medium: 0, low: 1, info: 1 }, footer: 'Read-only - GA4 has no auto-fixes; apply each change in the GA4 Admin UI.' },
  ...over,
});

console.log('\nGA4 sections HTML:');

test('section 2 renders the top finding as a severity-coloured card with its fields', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('What is wrong'));
  assert.ok(h.includes('CRITICAL') && h.includes('Growth'), 'severity badge + area');
  assert.ok(h.includes('Evidence:') && h.includes('Why it matters:') && h.includes('Fix:'), 'expanded fields');
});

test('section 2 drops the Evidence row when it merely repeats the message', () => {
  const dup = 'Sessions fell -49% vs the prior period.';
  const h = ga4SectionsHtml(view({ topFinding: { ...view().topFinding!, message: dup, evidence: dup } }));
  assert.ok(!/Evidence:/.test(h), 'no duplicate Evidence row when evidence === message');
  assert.ok(h.includes(dup), 'the message itself is still shown');
});

test('section 3 growth bars show the real from→to data points alongside the percentages', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Outcomes vs traffic'));
  assert.ok(h.includes('Sessions') && h.includes('Key events') && h.includes('Revenue'), 'the three growth bars');
  assert.ok(/\+276%/.test(h) && /\+112%/.test(h), 'growth percentages shown');
  assert.ok(h.includes('8,904 → 33,453') && h.includes('INR 100,000 → INR 169,000'), 'from→to data points on the bars');
  assert.ok(/Read:/.test(h) && /Not safe to quote/i.test(h), 'read line + caveat (key events/revenue unsafe)');
  assert.ok(h.includes('Trend pattern:'), 'trend pattern line');
});

test('section 4 renders one colour-coded card per finding, highest severity first', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('All findings'));
  assert.ok(h.includes('3 item(s) - 2 to act on, 1 advisory'), 'counts');
  assert.ok(h.includes('No custom dimensions') && h.includes('Spike unconfirmed'), 'finding messages');
});

test('section 4 shows the "Observed - unconfirmed" chip and the "Blocked by verification" group', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Observed - unconfirmed'), 'unconfirmed finding carries the state chip');
  assert.ok(h.includes('Blocked by verification'), 'blocked group heading');
  assert.ok(h.includes('Consent Mode v2 not assessed') && h.includes('Per-event parameter coverage not computed'), 'blocked items rendered');
  // A confirmed finding gets no chip.
  const clean = ga4SectionsHtml(view({ findings: [{ severity: 'low', area: 'Config', message: 'X.', businessRisk: '—', recommendation: '—', state: 'confirmed' }], blocked: [] }));
  assert.ok(!clean.includes('Observed - unconfirmed') && !clean.includes('Blocked by verification'), 'no chip/group when nothing is unconfirmed or blocked');
});

test('no top finding → a green "no high-severity issue" card', () => {
  const h = ga4SectionsHtml(view({ topFinding: null, noIssueNote: 'No high-severity issue. 2 area(s) are unverified.' }));
  assert.ok(/No high-severity issue/.test(h));
});

test('all dynamic text is HTML-escaped (no injection)', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('&lt;did&gt;') && !h.includes('<did>'), 'finding message escaped');
});

test('section 5 renders area coverage with status chips + confidence + evidence', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Area status'));
  assert.ok(h.includes('Data collection') && h.includes('Key events') && h.includes('Consent'));
  assert.ok(h.includes('Not Verified') && h.includes('1 data stream(s)'), 'status label + evidence');
});

test('section 6 baseline shows sessions, growth (with trust-matrix flag), peak day, markets', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Property baseline'));
  assert.ok(h.includes('33,453') && h.includes('India 96%'));
  assert.ok(/flagged in the data trust matrix/.test(h), 'flagged growth figures point at the trust matrix (verdict-aware, not a blanket "not safe")');
});

test('section 6 baseline renders the engagement line, and omits it when null', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Engagement/.test(h) && h.includes('1m 23s avg engagement time/session'), 'engagement metaRow shown');
  const h2 = ga4SectionsHtml(view({ baseline: { ...view().baseline!, engagement: null } }));
  assert.ok(!/Engagement:/.test(h2), 'no engagement row when the figure is null');
});

test('section 6 baseline renders the retention-cohort line, and omits it when null', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Retention \(cohorts\)/.test(h) && h.includes('Week 1: 34% across 5 cohorts'), 'retention metaRow shown');
  const h2 = ga4SectionsHtml(view({ baseline: { ...view().baseline!, retention: null } }));
  assert.ok(!/Retention \(cohorts\)/.test(h2), 'no retention row when there is not enough data');
});

test('section 6 renders the channel-performance table (conversion rate + revenue per channel)', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Channel performance/.test(h), 'table heading');
  assert.ok(h.includes('Conv. rate') && h.includes('Engagement'), 'column headers');
  assert.ok(h.includes('Organic Search') && h.includes('4.5%') && h.includes('INR 250,000'), 'a channel row with conv rate + revenue');
});

test('section 6 omits the channel table when no channel data', () => {
  const h = ga4SectionsHtml(view({ channelPerformance: [] }));
  assert.ok(!/Channel performance/.test(h), 'no empty table');
});

test('section 6 renders the landing-page table (entry-page conversion rate + revenue)', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Landing pages/.test(h), 'table heading');
  assert.ok(h.includes('/pricing') && h.includes('6.0%') && h.includes('INR 300,000'), 'a landing-page row with conv rate + revenue');
});

test('section 6 omits the landing-page table when no landing-page data', () => {
  const h = ga4SectionsHtml(view({ landingPages: [] }));
  assert.ok(!/Landing pages/.test(h), 'no empty table');
});

test('section 6 landing-page paths are HTML-escaped (no injection — paths come from the audited site)', () => {
  const h = ga4SectionsHtml(view({ landingPages: [{ page: '/x"><script>alert(1)</script>&q=1', sessions: '10', convRate: '1.0%', revenue: '-', engagement: '20%' }] }));
  assert.ok(!h.includes('<script>alert(1)'), 'raw script tag must never reach the output');
  assert.ok(h.includes('&lt;script&gt;'), 'angle brackets escaped');
  assert.ok(h.includes('&amp;q=1'), 'ampersand escaped');
});

test('section 6 renders the device + market performance tables', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Device performance/.test(h) && /Market performance/.test(h), 'both table headings');
  assert.ok(h.includes('mobile') && h.includes('4.0%'), 'a device row with conv rate');
  assert.ok(h.includes('United States') && h.includes('INR 400,000'), 'a market row with revenue');
});

test('section 6 omits the device + market tables when no such data', () => {
  const h = ga4SectionsHtml(view({ devicePerformance: [], geoPerformance: [] }));
  assert.ok(!/Device performance/.test(h) && !/Market performance/.test(h), 'no empty tables');
});

test('section 6 renders the Key insights card, escaped, and omits it when empty', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Key insights/.test(h), 'insights heading');
  assert.ok(h.includes('Traffic peaked on Jun 15') && h.includes('near 100% on the channels that carry most of your traffic'), 'insight bullets rendered');
  const h2 = ga4SectionsHtml(view({ insights: [] }));
  assert.ok(!/Key insights/.test(h2), 'no insights card when there are none');
});

test('section 6 renders the AI-assistant traffic table with its share + undercount caveat', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/AI assistant traffic/.test(h), 'table heading');
  assert.ok(h.includes('4,500 sessions, 5.8% of all'), 'aggregate share in the caption');
  assert.ok(h.includes('claude.ai') && h.includes('6.0%') && h.includes('INR 90,000'), 'an AI-source row');
  assert.ok(/systematic undercount/.test(h), 'undercount caveat');
});

test('section 6 omits the AI-assistant table when there is no AI traffic (null)', () => {
  const h = ga4SectionsHtml(view({ llmTraffic: null }));
  assert.ok(!/AI assistant traffic/.test(h), 'no AI table');
});

test('section 6 renders the campaign-performance table with the campaign name, best campaign, and untagged share', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Campaign performance/.test(h), 'campaign table heading');
  assert.ok(h.includes('summer_sale') && h.includes('400') && h.includes('INR 250,000'), 'a tagged-campaign row');
  assert.ok(/top: summer_sale/.test(h), 'best campaign in the caption');
  assert.ok(/Key events<\/th>/.test(h) && !/>Conversions<\/th>/.test(h), 'column header says Key events, never Conversions');
  assert.ok(/>Purchases<\/th>/.test(h) && h.includes('>12<'), 'real purchase count rendered in its own column');
  assert.ok(h.includes('NOT sales') && h.includes('will not match the channel table 1:1'), 'guardrail caveat under the campaign table');
  assert.ok(/untagged traffic 60\.0%/.test(h), 'untagged share in the caption');
});

test('section 6 omits the campaign table when there are no tagged campaigns (null)', () => {
  const h = ga4SectionsHtml(view({ campaignPerformance: null }));
  assert.ok(!/Campaign performance/.test(h), 'no campaign table when null');
});

test('section 6 renders ONE funnel (the bar chart), with step conversion folded in and no duplicate table', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(/Purchase funnel: users per step/.test(h), 'funnel chart heading');
  assert.ok(/view-to-purchase is 10\.0%/.test(h), 'overall rate in the explainer');
  assert.ok(h.includes('Begin checkout') && /step conv 50%/.test(h), 'step conversion carried on the bar value');
  assert.ok(!/Ecommerce funnel<\/[a-z]+>|>Ecommerce funnel</.test(h) && !/Step conversion<\/th>/.test(h), 'the duplicate table is gone');
  assert.ok(/not a strict sequential path/.test(h), 'honesty caveat present');
});

test('section 6 omits the funnel when it is null (non-ecommerce property)', () => {
  const h = ga4SectionsHtml(view({ funnel: null }));
  assert.ok(!/Ecommerce funnel/.test(h), 'no funnel block');
});

test('section 6 device/market performance: zero-revenue rows render a dash placeholder', () => {
  // Empty the other two tables so the ONLY zero-revenue dash cells come from device + market. Pass the
  // em-dash the formatter actually emits, to also prove ga4SectionsHtml strips it to a hyphen on output.
  const h = ga4SectionsHtml(view({
    channelPerformance: [], landingPages: [],
    devicePerformance: [{ device: 'tablet', sessions: '2,506', convRate: '1.2%', revenue: '—', engagement: '40%' }],
    geoPerformance: [{ country: '(not set)', sessions: '1,200', convRate: '0.0%', revenue: '—', engagement: '20%' }],
  }));
  assert.ok(!/—/.test(h), 'em-dash is stripped to a hyphen on output');
  const dashCells = (h.match(/<td[^>]*>-<\/td>/g) || []).length;
  assert.ok(dashCells >= 2, 'each zero-revenue device/market row renders a dash cell');
});

test('section 7 decision readiness pills answerable vs not answerable', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Decision readiness'));
  assert.ok(h.includes('Which campaigns generate revenue?') && h.includes('Answerable') && h.includes('Not answerable'));
});

test('section 8 not verified shows the gate + the unverified items', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Not verified') && h.includes('Gates sign-off:'));
  assert.ok(h.includes('Per-event parameter coverage'));
});

test('section 9 scope shows the metadata + findings-count badges + footer', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('GA4-123-20260629') && h.includes('14 months'));
  assert.ok(h.includes('Critical 1') && h.includes('Low 1'), 'findings-count badges');
  assert.ok(h.includes('Read-only'), 'footer note');
});

test('output uses no em dashes (house style)', () => {
  const h = ga4SectionsHtml(view({ topFinding: { severity: 'high', area: 'Growth', message: 'A — B problem.', recommendation: 'Fix — now.' }, noIssueNote: null }));
  assert.ok(!h.includes('—'), 'em dashes stripped');
});


test('engagementClusters splits two populations at a wide gap, null on a smooth spread', () => {
  const split = engagementClusters([
    { name: 'Vietnam', pct: 4 }, { name: 'Turkiye', pct: 23 }, { name: 'Brazil', pct: 32 },
    { name: 'Indonesia', pct: 78 }, { name: 'US', pct: 88 }, { name: 'India', pct: 96 },
  ]);
  assert.ok(split, 'clear 46-point gap detected');
  assert.deepEqual(split.low.map((r) => r.name), ['Vietnam', 'Turkiye', 'Brazil']);
  assert.equal(split.high[0].name, 'Indonesia');
  assert.equal(engagementClusters([{ name: 'a', pct: 60 }, { name: 'b', pct: 70 }, { name: 'c', pct: 80 }, { name: 'd', pct: 90 }]), null, 'smooth spread has no break');
  assert.equal(engagementClusters([{ name: 'a', pct: 65 }, { name: 'b', pct: 66 }, { name: 'c', pct: 95 }, { name: 'd', pct: 96 }]), null, 'a not-actually-low cluster does not split');
});

test('evidence charts render: device share-vs-revenue, market bimodality, funnel bars, flagged rows', () => {
  const h = ga4SectionsHtml(view({
    devicePerformance: [
      { device: 'mobile', sessions: '64,015', convRate: '56%', revenue: 'INR 1,145,819', engagement: '97%' },
      { device: 'desktop', sessions: '24,384', convRate: '30%', revenue: 'INR 37,010', engagement: '39%' },
    ],
    geoPerformance: [
      { country: 'India', sessions: '63,992', convRate: '56.7%', revenue: 'INR 1,149,789', engagement: '96%' },
      { country: 'Vietnam', sessions: '7,772', convRate: '2.7%', revenue: '-', engagement: '4%' },
      { country: 'Singapore', sessions: '3,123', convRate: '88.2%', revenue: '-', engagement: '91%' },
      { country: 'Brazil', sessions: '1,020', convRate: '29.6%', revenue: '-', engagement: '32%' },
      { country: 'Germany', sessions: '584', convRate: '89.4%', revenue: '-', engagement: '95%' },
    ],
    funnel: { steps: [
      { label: 'View item', users: '34,722', pctEntry: '100%', stepConv: '-' },
      { label: 'Add to cart', users: '1,610', pctEntry: '5%', stepConv: '5%' },
      { label: 'Begin checkout', users: '701', pctEntry: '2%', stepConv: '44%' },
      { label: 'Purchase', users: '369', pctEntry: '1%', stepConv: '53%' },
    ], overall: '1.1%' },
  }));
  assert.ok(h.includes('Share of visits vs share of revenue, by device'), 'device viz card');
  assert.ok(h.includes('% of visits but only') && h.includes('desktop'), 'device mismatch callout computed');
  assert.ok(h.includes('Engagement rate by market: two separate populations'), 'bimodality card renders');
  assert.ok(h.includes('two populations, no overlap'), 'divider note');
  assert.ok(h.includes('Purchase funnel: users per step'), 'funnel viz card');
  assert.ok(h.includes('95 of every 100') && h.includes('leave before Add to cart'), 'biggest-drop callout computed');
  assert.ok(h.includes('traffic is suspect'), 'market flag note present');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
