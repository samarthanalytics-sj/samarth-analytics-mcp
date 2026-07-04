import assert from 'node:assert/strict';
import { auditGa4DeadDimensions } from '../ga4-dead-dimensions';
import type { Ga4DimensionUsage } from '../ga4-dead-dimensions';

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

const u = (over: Partial<Ga4DimensionUsage>): Ga4DimensionUsage => ({
  parameterName: 'p',
  displayName: 'D',
  scope: 'EVENT',
  hasData: true,
  checked: true,
  ...over,
});

console.log('\nGA4 dead dimensions:');

test('a checked dimension with no data on a live property → one low customdef finding naming it', () => {
  const r = auditGa4DeadDimensions({
    usage: [u({ parameterName: 'membership_tier', displayName: 'Membership Tier', hasData: false })],
    activelyMeasuring: true,
    windowDays: 90,
  });
  assert.equal(r.length, 1, 'exactly one aggregated finding');
  assert.equal(r[0].severity, 'low');
  assert.equal(r[0].category, 'customdef', 'customdef so it feeds Event Tracking, never gates channel attribution');
  assert.ok(/Membership Tier/.test(r[0].message), 'names the dead dimension (displayName)');
  assert.ok(/90 days/.test(r[0].message), 'states the window');
  assert.ok(/does not backfill/i.test(r[0].recommendation), 'carries the recently-registered caveat');
});

test('all dimensions have data → no finding', () => {
  const r = auditGa4DeadDimensions({
    usage: [u({ hasData: true }), u({ parameterName: 'q', hasData: true })],
    activelyMeasuring: true,
    windowDays: 90,
  });
  assert.equal(r.length, 0);
});

test('inconclusive (checked=false: item-scoped or errored) is never flagged dead', () => {
  const r = auditGa4DeadDimensions({
    usage: [
      u({ parameterName: 'item_color', scope: 'ITEM', hasData: false, checked: false }),
      u({ parameterName: 'errored', hasData: false, checked: false }),
    ],
    activelyMeasuring: true,
    windowDays: 90,
  });
  assert.equal(r.length, 0, 'not-checked dimensions are inconclusive, not dead');
});

test('a property with no traffic emits nothing even if dimensions look empty', () => {
  const r = auditGa4DeadDimensions({
    usage: [u({ hasData: false }), u({ parameterName: 'q', hasData: false })],
    activelyMeasuring: false,
    windowDays: 90,
  });
  assert.equal(r.length, 0, 'cannot tell dead from idle when there is no traffic');
});

test('mixed: only the checked-and-empty ones are counted (live + inconclusive excluded)', () => {
  const r = auditGa4DeadDimensions({
    usage: [
      u({ parameterName: 'dead_a', displayName: 'Dead A', hasData: false, checked: true }),
      u({ parameterName: 'dead_b', displayName: 'Dead B', hasData: false, checked: true }),
      u({ parameterName: 'live', hasData: true, checked: true }),
      u({ parameterName: 'skipped', scope: 'ITEM', hasData: false, checked: false }),
    ],
    activelyMeasuring: true,
    windowDays: 90,
  });
  assert.equal(r.length, 1);
  assert.ok(/^2 registered custom dimensions/.test(r[0].message), 'counts exactly the 2 dead ones');
  assert.ok(/Dead A/.test(r[0].message) && /Dead B/.test(r[0].message));
  assert.ok(!/skipped/.test(r[0].message) && !/live/.test(r[0].message), 'excludes live + inconclusive');
});

test('more than 8 dead dimensions are summarised as "and N more"', () => {
  const usage = Array.from({ length: 11 }, (_, i) => u({ parameterName: `d${i}`, displayName: `Dim ${i}`, hasData: false }));
  const r = auditGa4DeadDimensions({ usage, activelyMeasuring: true, windowDays: 90 });
  assert.equal(r.length, 1);
  assert.ok(/^11 registered custom dimensions/.test(r[0].message), 'full count in the lead');
  assert.ok(/and 3 more/.test(r[0].message), 'names 8, summarises the remaining 3');
});

test('falls back to parameterName when displayName is blank', () => {
  const r = auditGa4DeadDimensions({
    usage: [u({ parameterName: 'raw_param', displayName: '', hasData: false })],
    activelyMeasuring: true,
    windowDays: 90,
  });
  assert.ok(/raw_param/.test(r[0].message));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
