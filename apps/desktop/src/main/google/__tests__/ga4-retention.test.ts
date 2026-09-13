import assert from 'node:assert/strict';
import { planRetentionCohorts, parseRetentionRows, summarizeGa4Retention } from '../ga4-retention';
import type { RetentionCohort, RetentionCohortPlan } from '../ga4-retention';

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

const dow = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string): number =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

console.log('\nGA4 retention:');

test('planRetentionCohorts: N newest-first Sun-Sat weeks, with deterministic maturity min(i, fwd)', () => {
  const plan = planRetentionCohorts('2026-07-01', 8, 4, 2); // any Wed; result shape is date-independent
  assert.equal(plan.cohorts.length, 8);
  assert.equal(plan.forwardWeeks, 4);
  plan.cohorts.forEach((c, i) => {
    assert.equal(dow(c.startDate), 0, `cohort ${i} starts on Sunday`);
    assert.equal(dow(c.endDate), 6, `cohort ${i} ends on Saturday`);
    assert.equal(daysBetween(c.startDate, c.endDate), 6, `cohort ${i} spans 7 days`);
    assert.equal(c.weeksMature, Math.min(i, 4), `cohort ${i} maturity`);
    if (i > 0) assert.equal(daysBetween(plan.cohorts[i].endDate, plan.cohorts[i - 1].endDate), 7, 'newest-first, 7 days apart');
  });
  // The newest cohort's Saturday must already be complete (on/before today minus the 2-day buffer).
  assert.ok(daysBetween(plan.cohorts[0].endDate, '2026-07-01') >= 2, 'newest week is complete past the buffer');
});

test('planRetentionCohorts: bad date → empty plan (never throws)', () => {
  assert.deepEqual(planRetentionCohorts('not-a-date', 8, 4, 2).cohorts, []);
});

test('parseRetentionRows: pivots cohort x nthWeek rows; missing cells → 0', () => {
  const plan: RetentionCohortPlan = { forwardWeeks: 4, cohorts: [
    { name: 'w0', startDate: '2026-06-21', endDate: '2026-06-27', weeksMature: 0 },
    { name: 'w1', startDate: '2026-06-14', endDate: '2026-06-20', weeksMature: 1 },
  ] };
  const rows = [
    { dimensions: ['w0', '0000'], metrics: ['500'] },
    { dimensions: ['w0', '0001'], metrics: ['200'] },
    { dimensions: ['w1', '0000'], metrics: ['400'] },
    { dimensions: ['w1', '0001'], metrics: ['160'] },
    // w1 week 2 row omitted by GA4 → should parse as 0
  ];
  const out = parseRetentionRows(rows, plan);
  assert.equal(out[0].week0Users, 500);
  assert.equal(out[0].weekActive[0], 200); // week 1
  assert.equal(out[1].week0Users, 400);
  assert.equal(out[1].weekActive[0], 160);
  assert.equal(out[1].weekActive[1], 0, 'omitted week-2 row → 0');
  assert.equal(out[0].weeksMature, 0);
});

const cohort = (over: Partial<RetentionCohort>): RetentionCohort => ({ name: 'c', week0Users: 500, weekActive: [200, 120, 90, 60], weeksMature: 4, ...over });

test('summarizeGa4Retention: pooled Week-1 + Week-4 headline across qualifying cohorts', () => {
  const s = summarizeGa4Retention({ minCohortSize: 100, cohorts: [
    cohort({ week0Users: 1000, weekActive: [400, 300, 250, 200], weeksMature: 4 }),
    cohort({ week0Users: 500, weekActive: [200, 150, 120, 100], weeksMature: 4 }),
  ] });
  // Week1 pooled = (400+200)/(1000+500) = 40%. Week4 pooled = (200+100)/1500 = 20%.
  assert.ok(s !== null);
  assert.ok(/Week 1: 40% across 2 cohorts/.test(s!) && /Week 4: 20% across 2 cohorts/.test(s!), s ?? 'null');
  assert.ok(/weighted, n>=100 each/.test(s!));
});

test('summarizeGa4Retention: each week carries its OWN cohort count (Week 4 averaged over fewer)', () => {
  // 5 qualifying cohorts: all mature to week 1, only 3 mature to week 4.
  const s = summarizeGa4Retention({ minCohortSize: 100, cohorts: [
    cohort({ week0Users: 200, weekActive: [80, 0, 0, 0], weeksMature: 1 }),
    cohort({ week0Users: 200, weekActive: [80, 0, 0, 0], weeksMature: 1 }),
    cohort({ week0Users: 200, weekActive: [80, 60, 50, 40], weeksMature: 4 }),
    cohort({ week0Users: 200, weekActive: [80, 60, 50, 40], weeksMature: 4 }),
    cohort({ week0Users: 200, weekActive: [80, 60, 50, 40], weeksMature: 4 }),
  ] });
  // Week 1 over all 5 = 400/1000... (2*80 + 3*80)/1000 = 40%. Week 4 over the 3 mature = 120/600 = 20%.
  assert.ok(/Week 1: 40% across 5 cohorts/.test(s!), s ?? 'null');
  assert.ok(/Week 4: 20% across 3 cohorts/.test(s!), 'Week 4 count reflects only the week-4-mature cohorts, not week 1');
});

test('summarizeGa4Retention: small cohorts (< min week-0) are excluded', () => {
  const s = summarizeGa4Retention({ minCohortSize: 100, cohorts: [
    cohort({ week0Users: 1000, weekActive: [500, 400, 300, 200], weeksMature: 4 }),
    cohort({ week0Users: 900, weekActive: [450, 360, 270, 180], weeksMature: 4 }),
    cohort({ week0Users: 20, weekActive: [20, 20, 20, 20], weeksMature: 4 }), // tiny → ignored (else it would inflate)
  ] });
  // Only the two big cohorts: Week1 = (500+450)/(1900) = 50%.
  assert.ok(/Week 1: 50%/.test(s!), s ?? 'null');
});

test('summarizeGa4Retention: weighting is by week-0 users (big cohort dominates)', () => {
  const s = summarizeGa4Retention({ minCohortSize: 100, cohorts: [
    cohort({ week0Users: 1000, weekActive: [400, 0, 0, 0], weeksMature: 1 }), // 40%
    cohort({ week0Users: 100, weekActive: [50, 0, 0, 0], weeksMature: 1 }), // 50%
  ] });
  // Pooled = (400+50)/1100 = 40.9% → 41% (NOT the naive mean of 45%).
  assert.ok(/Week 1: 41%/.test(s!), s ?? 'null');
});

test('summarizeGa4Retention: fewer than 2 qualifying cohorts → null (no dishonest average)', () => {
  assert.equal(summarizeGa4Retention({ minCohortSize: 100, cohorts: [cohort({ week0Users: 1000, weeksMature: 4 })] }), null);
  // Two cohorts but both too small.
  assert.equal(summarizeGa4Retention({ minCohortSize: 100, cohorts: [cohort({ week0Users: 10, weeksMature: 4 }), cohort({ week0Users: 20, weeksMature: 4 })] }), null);
});

test('summarizeGa4Retention: Week 4 omitted when too few cohorts are mature to week 4 (still shows Week 1)', () => {
  const s = summarizeGa4Retention({ minCohortSize: 100, cohorts: [
    cohort({ week0Users: 1000, weekActive: [400, 300, 0, 0], weeksMature: 2 }),
    cohort({ week0Users: 500, weekActive: [200, 150, 0, 0], weeksMature: 2 }),
  ] });
  assert.ok(/Week 1: 40%/.test(s!) && !/Week 4/.test(s!), s ?? 'null');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
