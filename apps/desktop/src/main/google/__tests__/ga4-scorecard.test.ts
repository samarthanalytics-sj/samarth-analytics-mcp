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
  // growthAssessed: SAFE requires every gating check to have actually PASSED — including the
  // traffic-vs-conversion comparison having RUN. No findings alone is not enough.
  const r = buildGa4Scorecard({ areas: areas(), findings: [], growthAssessed: true });
  assert.equal(r.composite, 100, 'all Pass → composite 100');
  assert.equal(r.grade, 'A');
  assert.equal(r.notVerifiedAreas, 0);
  assert.ok(r.trust.every((t) => t.safe && t.verdict === 'safe'), 'all gates passed → everything safe to quote');
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

test('attribution-loss findings gate channel attribution: low → caution, material → do-not-quote', () => {
  const lowOnly = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'low', category: 'data_quality' }] });
  const lowRow = lowOnly.trust.find((t) => t.metric === 'Channel attribution')!;
  assert.equal(lowRow.verdict, 'caution', 'a 5% (low) loss → quote with caution (partial gate, not safe)');
  assert.equal(lowRow.safe, false, 'caution is not "safe" — safe means every gate PASSED');
  const material = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'high', category: 'data_quality' }] });
  assert.equal(material.trust.find((t) => t.metric === 'Channel attribution')!.verdict, 'do_not_quote', 'a material loss is a failed gate');
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

test('PASS-GATED: an unrun gating check → UNVERIFIED, never safe ("revenue safe while unverified" fix)', () => {
  const assessed = buildGa4Scorecard({ areas: areas(), findings: [], growthAssessed: true });
  assert.equal(assessed.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!.verdict, 'safe', 'all gates passed → safe');
  const notAssessed = buildGa4Scorecard({ areas: areas(), findings: [], growthAssessed: false });
  const rev = notAssessed.trust.find((t) => t.metric === 'Revenue / AOV / ROAS')!;
  assert.equal(rev.verdict, 'unverified', 'a gating check that did not run downgrades to UNVERIFIED');
  assert.equal(rev.safe, false, 'not-failed is NOT the same as passed — never safe');
  assert.match(rev.reason, /not verified/i);
  assert.ok(rev.requires.includes('traffic-vs-conversion tracking'), 'requires lists the gating checks');
  // Reliability cannot be raised by unverified metrics.
  assert.ok(notAssessed.reliabilityPct < assessed.reliabilityPct, 'unverified gates lower the reliability number');
});

test('a failed gate outranks unverified: DO NOT QUOTE even when other gates did not run', () => {
  const r = buildGa4Scorecard({ areas: areas({ Consent: 'not_verified' }), findings: [{ severity: 'critical', category: 'growth' }] });
  const sb = r.trust.find((t) => t.metric === 'Smart Bidding optimisation')!;
  assert.equal(sb.verdict, 'do_not_quote', 'failed traffic-vs-conversion gate wins over the unverified consent gate');
  assert.match(sb.reason, /failed/i);
});

test('effective weights of scored categories sum to 1.0 (the redistribution is exposed and testable)', () => {
  const r = buildGa4Scorecard({ areas: areas({ Consent: 'not_verified', 'Privacy (PII)': 'not_verified' }), findings: [] });
  const scored = r.categories.filter((c) => c.subscore !== null);
  const sum = scored.reduce((s, c) => s + c.effectiveWeight, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `effective weights sum to 1.0 (got ${sum})`);
  const nv = r.categories.find((c) => c.subscore === null)!;
  assert.equal(nv.effectiveWeight, 0, 'a Not-Verified category carries no effective weight');
});

test('category status = WORST verified member — status and subscore cannot contradict', () => {
  // Event Tracking members: Custom definitions Pass + Ecommerce Fail → subscore 50 (mean) but the
  // status must read Fail (the category holds a failed area), not "partial".
  const r = buildGa4Scorecard({ areas: areas({ Ecommerce: 'fail' }), findings: [] });
  const et = r.categories.find((c) => c.name === 'Event Tracking')!;
  assert.equal(et.subscore, 50);
  assert.equal(et.status, 'fail', 'worst verified member drives the status');
});

test('a MEDIUM growth finding (ran but could not conclude) gates conversions/revenue as NOT safe', () => {
  // ga4-growth emits MEDIUM for exactly the inconclusive cases (a spike with too little conversion
  // signal to judge; a sharp drop that may be broken tagging) — the gate must not read PASS.
  const r = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'medium', category: 'growth' }], growthAssessed: true });
  const conv = r.trust.find((t) => t.metric === 'Conversion counts')!;
  assert.notEqual(conv.verdict, 'safe', 'an inconclusive comparison cannot make conversions safe');
  assert.match(conv.reason, /traffic-vs-conversion/i, 'the reason names the unconfirmed gate');
  // LOW (channel-mix dilution) is a concluded, non-blocking read — still passes (no over-alarm).
  const low = buildGa4Scorecard({ areas: areas(), findings: [{ severity: 'low', category: 'growth' }], growthAssessed: true });
  assert.equal(low.trust.find((t) => t.metric === 'Conversion counts')!.verdict, 'safe');
});

test('channel attribution is gated on data collection (no safe channel split of unquotable sessions)', () => {
  const r = buildGa4Scorecard({ areas: areas({ 'Data collection': 'fail' }), findings: [], growthAssessed: true });
  const chan = r.trust.find((t) => t.metric === 'Channel attribution')!;
  assert.equal(chan.verdict, 'do_not_quote', 'failing collection fails the channel row too');
});

test('production ceiling: best statuses the desktop audit can emit land in the High band', () => {
  // The Admin API caps Data collection at Partial, Ecommerce at Partial, and Consent is never
  // readable — pin the reachable top of the scale so threshold edits cannot strand the UI bands.
  const r = buildGa4Scorecard({
    areas: areas({ 'Data collection': 'partial', Ecommerce: 'partial', Consent: 'not_verified' }),
    findings: [],
    growthAssessed: true,
  });
  assert.ok(r.reliabilityPct >= 45 && r.reliabilityPct <= 55, `reachable ceiling ~45 (got ${r.reliabilityPct})`);
  assert.equal(r.reliabilityConfidence, 'High confidence', 'the top band is reachable by a clean production property');
});

test('deterministic: same input → identical output', () => {
  const input = { areas: areas({ 'Data collection': 'partial' }), findings: [{ severity: 'high', category: 'growth' }] };
  assert.deepEqual(buildGa4Scorecard(input), buildGa4Scorecard(input));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
