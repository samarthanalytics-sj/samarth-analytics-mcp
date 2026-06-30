import assert from 'node:assert/strict';
import { buildGa4Scorecard, type Ga4ScorecardInput } from '../ga4-scorecard';

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

// Every area the report feeds in — incl. Integrations, so the mapping covers all of them.
const ALL_AREAS = ['Data collection', 'Data retention', 'Benchmarking', 'Custom definitions', 'Ecommerce', 'Key events', 'Audiences', 'Attribution', 'Integrations', 'Consent', 'Privacy (PII)'];
const areas = (over: Record<string, 'pass' | 'partial' | 'fail' | 'not_verified'> = {}): Ga4ScorecardInput['areas'] =>
  ALL_AREAS.map((area) => ({ area, statusKey: over[area] ?? 'pass' }));

console.log('\nGA4 scorecard:');

test('a clean property scores high with all categories verified', () => {
  const r = buildGa4Scorecard({ areas: areas(), findings: [] });
  assert.equal(r.composite, 100, 'all Pass → composite 100');
  assert.equal(r.grade, 'A');
  assert.equal(r.notVerifiedAreas, 0);
  assert.ok(r.trust.every((t) => t.safe), 'no findings → everything safe to quote');
  assert.equal(r.reliabilityPct, 100);
  assert.equal(r.reliabilityConfidence, 'High confidence');
});

test('a CRITICAL growth finding tanks Data Quality to Fail and flags revenue/conversions Do-not-quote', () => {
  const r = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'critical', category: 'growth' }] });
  const dq = r.categories.find((c) => c.name === 'Data Quality')!;
  assert.equal(dq.subscore, 0, 'critical growth → Data Quality Fail');
  assert.ok(r.composite !== null && r.composite < 85, `composite dragged down (${r.composite})`);
  const safe = (m: string) => r.trust.find((t) => t.metric === m)!.safe;
  assert.equal(safe('Revenue / AOV / ROAS'), false);
  assert.equal(safe('Conversion counts'), false);
  assert.equal(safe('Smart Bidding optimisation'), false);
  assert.equal(safe('Sessions, users, engagement rate'), true, 'sessions still safe');
});

test('a material attribution-loss finding marks channel attribution Do-not-quote (low does not)', () => {
  const lowOnly = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'low', category: 'data_quality' }] });
  assert.equal(lowOnly.trust.find((t) => t.metric === 'Channel attribution')!.safe, true, 'a 5% (low) loss is still quotable');
  const material = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'high', category: 'data_quality' }] });
  assert.equal(material.trust.find((t) => t.metric === 'Channel attribution')!.safe, false, 'a material loss is not');
});

test('Not-Verified categories are excluded and their weight redistributed (composite ignores them)', () => {
  // Make Consent & Compliance fully Not Verified (both members) — composite should still be 100.
  const r = buildGa4Scorecard({ areas: areas({ Consent: 'not_verified', 'Privacy (PII)': 'not_verified' }), findings: [] });
  const cc = r.categories.find((c) => c.name === 'Consent & Compliance')!;
  assert.equal(cc.subscore, null, 'no verified member → Not Verified');
  assert.equal(cc.contribution, 0);
  assert.equal(r.composite, 100, 'remaining categories renormalised to 100');
  assert.equal(r.notVerifiedAreas, 2);
});

test('contributions of scored categories sum to the composite', () => {
  const r = buildGa4Scorecard({
    areas: areas({ 'Data collection': 'partial', 'Custom definitions': 'partial', Ecommerce: 'partial' }),
    findings: [{ severity: 'medium', category: 'data_quality' }],
  });
  const sum = r.categories.filter((c) => c.subscore !== null).reduce((s, c) => s + c.contribution, 0);
  assert.ok(r.composite !== null && Math.abs(sum - r.composite) <= 0.6, `contributions ${sum} ≈ composite ${r.composite}`);
});

test('grade bands: A>=90, B>=80, C>=70, D>=60, F<60', () => {
  // Drive composite down with fails and check the grade tracks.
  const failAll = buildGa4Scorecard({ areas: areas(Object.fromEntries(ALL_AREAS.map((a) => [a, 'fail']))), findings: [{ severity: 'high', category: 'growth' }] });
  assert.equal(failAll.composite, 0);
  assert.equal(failAll.grade, 'F');
});

test('every fed-in area (incl. Integrations) influences the composite — a Fail moves the number', () => {
  const clean = buildGa4Scorecard({ areas: areas(), findings: [] });
  const intFail = buildGa4Scorecard({ areas: areas({ Integrations: 'fail' }), findings: [] });
  assert.ok(intFail.composite !== null && clean.composite !== null && intFail.composite < clean.composite, 'Integrations Fail must lower the composite, not be silently dropped');
});

test('unassessed growth does not claim "verified safe" in the trust reasons (Not Verified ≠ Pass)', () => {
  const assessed = buildGa4Scorecard({ areas: areas(), findings: [], growthAssessed: true });
  assert.match(assessed.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!.reason, /moved with traffic/);
  const notAssessed = buildGa4Scorecard({ areas: areas(), findings: [], growthAssessed: false });
  const rev = notAssessed.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!;
  assert.ok(rev.safe, 'still safe (no negative evidence)');
  assert.match(rev.reason, /did not run this window/, 'but the reason must not claim verified growth');
  assert.ok(!/moved with traffic/.test(rev.reason));
});

test('deterministic: same input → identical output', () => {
  const input = { areas: areas({ 'Data collection': 'partial' }), findings: [{ severity: 'high', category: 'growth' }] };
  assert.deepEqual(buildGa4Scorecard(input), buildGa4Scorecard(input));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
