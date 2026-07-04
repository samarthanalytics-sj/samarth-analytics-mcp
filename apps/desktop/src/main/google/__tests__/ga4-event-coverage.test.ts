import assert from 'node:assert/strict';
import { auditGa4EventCoverage, ECOMMERCE_RECOMMENDED_EVENTS } from '../ga4-event-coverage';

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

console.log('\nGA4 event coverage:');

test('ecommerce property missing recommended events → one info conversions finding', () => {
  // Sends the core spine but not the enrichment events.
  const r = auditGa4EventCoverage({ presentRecommended: ['view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'] });
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'info', 'an optional opportunity, never a warning');
  assert.equal(r[0].category, 'conversions');
  assert.ok(/view_item_list/.test(r[0].message) && /refund/.test(r[0].message), 'names the missing enrichment events');
  assert.ok(!/core purchase-funnel steps/.test(r[0].message), 'no core clause when the spine is complete');
  assert.ok(/not detected under their standard names/.test(r[0].message), 'phrased as a naming gap, not "not implemented"');
  assert.ok(/optional/i.test(r[0].recommendation) && /custom names/i.test(r[0].recommendation), 'carries the optional + custom-name caveat');
});

test('a non-ecommerce property (no anchor events) is never flagged', () => {
  const r = auditGa4EventCoverage({ presentRecommended: [] });
  assert.equal(r.length, 0, 'a content/lead-gen site must never be told it lacks cart events');
  // even if some non-anchor recommended event is somehow present, without an anchor we do not flag
  const r2 = auditGa4EventCoverage({ presentRecommended: ['view_promotion'] });
  assert.equal(r2.length, 0);
});

test('a property sending every recommended event → no finding', () => {
  const r = auditGa4EventCoverage({ presentRecommended: [...ECOMMERCE_RECOMMENDED_EVENTS] });
  assert.equal(r.length, 0, 'full coverage is a clean bill');
});

test('missing CORE funnel steps are called out explicitly', () => {
  // Sends view_item + add_to_cart (anchors present) but not begin_checkout / add_payment_info / purchase.
  const r = auditGa4EventCoverage({ presentRecommended: ['view_item', 'add_to_cart', 'view_item_list'] });
  assert.equal(r.length, 1);
  assert.ok(/core purchase-funnel steps/.test(r[0].message), 'core clause present');
  assert.ok(/begin_checkout/.test(r[0].message) && /add_payment_info/.test(r[0].message) && /purchase/.test(r[0].message), 'names the missing core steps');
});

test('the anchor gate accepts any one of purchase / add_to_cart / view_item', () => {
  for (const anchor of ['purchase', 'add_to_cart', 'view_item']) {
    const r = auditGa4EventCoverage({ presentRecommended: [anchor] });
    assert.equal(r.length, 1, `anchor ${anchor} should enable the check`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
