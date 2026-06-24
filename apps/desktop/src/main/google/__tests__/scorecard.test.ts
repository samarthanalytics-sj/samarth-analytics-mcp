import assert from 'node:assert/strict';
import { buildScorecard, gradeOf } from '../scorecard';
import type { ScorecardFinding } from '../scorecard';

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

const f = (severity: ScorecardFinding['severity'], category = 'x', message = 'm'): ScorecardFinding => ({
  severity,
  category,
  message,
  recommendation: 'fix it',
});

console.log('\nScorecard:');

test('a clean setup scores 100 / grade A', () => {
  const r = buildScorecard([{ key: 'gtm', label: 'GTM', findings: [] }]);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.topIssues.length, 0);
});

test('gradeOf thresholds', () => {
  assert.equal(gradeOf(100), 'A');
  assert.equal(gradeOf(90), 'A');
  assert.equal(gradeOf(89), 'B');
  assert.equal(gradeOf(80), 'B');
  assert.equal(gradeOf(70), 'C');
  assert.equal(gradeOf(60), 'D');
  assert.equal(gradeOf(59), 'F');
  assert.equal(gradeOf(0), 'F');
});

test('severity weighting (critical 30 / high 12 / med 4 / low 1 / info 0) and floor at 0', () => {
  // 1 high + 1 medium + 1 low = 100 - (12+4+1) = 83
  assert.equal(buildScorecard([{ key: 'g', label: 'G', findings: [f('high'), f('medium'), f('low')] }]).score, 83);
  // critical is the heaviest
  assert.equal(buildScorecard([{ key: 'g', label: 'G', findings: [f('critical')] }]).score, 70);
  // info never deducts
  assert.equal(buildScorecard([{ key: 'g', label: 'G', findings: [f('info'), f('info')] }]).score, 100);
  // never goes below 0
  assert.equal(buildScorecard([{ key: 'g', label: 'G', findings: Array(20).fill(f('high')) }]).score, 0);
});

test('runtime-required findings are never scored (Audit Brain §7)', () => {
  const rt = { severity: 'high' as const, category: 'ga4', message: 'variable id', confidence: 'runtime-required' as const };
  assert.equal(buildScorecard([{ key: 'g', label: 'G', findings: [rt, rt, rt] }]).score, 100, 'runtime-required high findings deduct nothing');
});

test('overall score pools all sections; per-section scores are independent', () => {
  const r = buildScorecard([
    { key: 'gtm', label: 'GTM container', findings: [] }, // clean
    { key: 'ga4', label: 'GA4 property', findings: [f('high'), f('high')] }, // -30
  ]);
  const gtm = r.sections.find((s) => s.key === 'gtm')!;
  const ga4 = r.sections.find((s) => s.key === 'ga4')!;
  assert.equal(gtm.score, 100);
  assert.equal(gtm.grade, 'A');
  assert.equal(ga4.score, 76); // 100 - (2 × 12)
  assert.equal(ga4.grade, 'C');
  assert.equal(r.score, 76, 'overall = combined pool (100 - 24)');
  assert.equal(r.summary.high, 2);
});

test('top issues are ranked by severity and capped at 10, carrying the section + recommendation', () => {
  const sections = [
    { key: 'gtm', label: 'GTM container', findings: [f('low', 'a'), f('high', 'b')] },
    { key: 'ga4', label: 'GA4 property', findings: [f('medium', 'c'), ...Array(12).fill(f('info', 'd'))] },
  ];
  const r = buildScorecard(sections);
  assert.equal(r.topIssues.length, 10, 'capped at 10');
  assert.equal(r.topIssues[0].severity, 'high', 'highest severity first');
  assert.equal(r.topIssues[0].section, 'GTM container');
  assert.equal(r.topIssues[0].recommendation, 'fix it');
  // ordering: high, medium, then lows/infos
  assert.equal(r.topIssues[1].severity, 'medium');
});

test('per-section counts tally correctly', () => {
  const r = buildScorecard([{ key: 'g', label: 'G', findings: [f('high'), f('high'), f('low'), f('info')] }]);
  const s = r.sections[0];
  assert.deepEqual(s.counts, { critical: 0, high: 2, medium: 0, low: 1, info: 1 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
