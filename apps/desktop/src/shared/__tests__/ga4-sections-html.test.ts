import assert from 'node:assert/strict';
import { ga4SectionsHtml } from '../ga4-sections-html';
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
    keSafe: false,
    revSafe: false,
    sesSafe: true,
    read: 'Outcomes did NOT keep pace with traffic.',
    trendPattern: 'Upward trend. A sustained upward trend.',
  },
  findings: [
    { severity: 'critical', area: 'Growth', message: 'Spike unconfirmed.', businessRisk: 'Revenue unreliable.', recommendation: 'Verify in DebugView.' },
    { severity: 'low', area: 'Config', message: 'No custom dimensions.', businessRisk: 'Limited segmentation.', recommendation: 'Register dimensions.' },
    { severity: 'info', area: 'Data quality', message: 'No major issues.', businessRisk: '—', recommendation: '—' },
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

test('section 3 renders growth bars, the Read line, and the not-safe-to-quote caveat', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Outcomes vs traffic'));
  assert.ok(h.includes('Sessions') && h.includes('Key events') && h.includes('Revenue'), 'the three growth bars');
  assert.ok(/\+276%/.test(h) && /\+112%/.test(h), 'growth values shown');
  assert.ok(/Read:/.test(h) && /Not safe to quote/i.test(h), 'read line + caveat (key events/revenue unsafe)');
  assert.ok(h.includes('Trend pattern:'), 'trend pattern line');
});

test('section 4 renders one colour-coded card per finding, highest severity first', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('All findings'));
  assert.ok(h.includes('3 item(s) - 2 to act on, 1 advisory'), 'counts');
  assert.ok(h.includes('No custom dimensions') && h.includes('Spike unconfirmed'), 'finding messages');
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

test('section 6 baseline shows sessions, growth (with unsafe tag), peak day, markets', () => {
  const h = ga4SectionsHtml(view());
  assert.ok(h.includes('Property baseline'));
  assert.ok(h.includes('33,453') && h.includes('India 96%'));
  assert.ok(/not safe to quote/.test(h), 'growth unsafe note shown when key events/revenue unsafe');
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
