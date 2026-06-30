import assert from 'node:assert/strict';
import { execSummaryHtml } from '../ga4-exec-html';
import type { Ga4ExecSummaryView } from '../ipc';

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

const view = (over: Partial<Ga4ExecSummaryView> = {}): Ga4ExecSummaryView => ({
  propertyName: 'Acme <Co>',
  propertyId: '123',
  auditId: 'GA4-123-20260629',
  composite: 65,
  grade: 'D',
  reliabilityPct: 45,
  reliabilityConfidence: 'Medium confidence',
  verdict: 'Action required — fix things.',
  biggestRisk: 'Revenue may be wrong.',
  highestImpactFix: 'Check DebugView.',
  coverage: { checked: 11, partial: 3, notVerified: 1 },
  categories: [
    { name: 'Configuration', subscore: 83, weight: 18, contribution: 14.9, status: 'pass' },
    { name: 'Consent & Compliance', subscore: null, weight: 10, contribution: 0, status: 'not_verified' },
  ],
  trust: [
    { metric: 'Sessions, users, engagement rate', safe: true, reason: 'Fine.' },
    { metric: 'Revenue / AOV / ROAS', safe: false, reason: 'A <bad> spike.' },
  ],
  ...over,
});

console.log('\nGA4 exec-summary HTML:');

test('renders the verdict, reliability % and confidence', () => {
  const h = execSummaryHtml(view());
  assert.ok(h.includes('Executive Summary'));
  assert.ok(h.includes('45%') && h.includes('Medium confidence'));
  assert.ok(h.includes('Action required'));
  assert.ok(h.includes('Revenue may be wrong.') && h.includes('Check DebugView.'));
});

test('scorecard shows categories, composite, and Not-Verified handling', () => {
  const h = execSummaryHtml(view());
  assert.ok(h.includes('Configuration') && h.includes('83/100'));
  assert.ok(h.includes('COMPOSITE') && h.includes('65/100'));
  assert.ok(h.includes('Not Verified'), 'null subscore → Not Verified');
});

test('data trust matrix renders SAFE/DO-NOT badges', () => {
  const h = execSummaryHtml(view());
  assert.ok(h.includes('SAFE TO QUOTE') && h.includes('DO NOT QUOTE'));
});

test('all dynamic text is HTML-escaped (no injection)', () => {
  const h = execSummaryHtml(view());
  assert.ok(h.includes('Acme &lt;Co&gt;') && !h.includes('Acme <Co>'), 'property name escaped');
  assert.ok(h.includes('A &lt;bad&gt; spike.') && !h.includes('<bad>'), 'trust reason escaped');
});

test('cards use a table layout (not CSS grid) so Word renders the 2×2, not a single column', () => {
  const h = execSummaryHtml(view());
  assert.ok(!/display:\s*grid/.test(h), 'no CSS grid (Word ignores it → cards would stack)');
  assert.ok(h.includes('<table'), 'uses table-based layout');
});

test('reliability colour bands by score (low=red, mid=amber, high=green) via CSS var fallbacks', () => {
  assert.ok(execSummaryHtml(view({ reliabilityPct: 20 })).includes('--c-red'));
  assert.ok(execSummaryHtml(view({ reliabilityPct: 50 })).includes('--c-amber'));
  assert.ok(execSummaryHtml(view({ reliabilityPct: 90 })).includes('--c-green'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
