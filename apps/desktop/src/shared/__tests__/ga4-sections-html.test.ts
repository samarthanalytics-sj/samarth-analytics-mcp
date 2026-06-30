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

test('output uses no em dashes (house style)', () => {
  const h = ga4SectionsHtml(view({ topFinding: { severity: 'high', area: 'Growth', message: 'A — B problem.', recommendation: 'Fix — now.' }, noIssueNote: null }));
  assert.ok(!h.includes('—'), 'em dashes stripped');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
