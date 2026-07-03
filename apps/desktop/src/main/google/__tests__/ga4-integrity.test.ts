import assert from 'node:assert/strict';
import { auditGa4EventDeltas, auditGa4Transactions } from '../ga4-integrity';

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

console.log('\nGA4 integrity:');

test('per-event: a KEY event that dropped to zero → high; a non-key event → medium (campaign/seasonal framing)', () => {
  const hi = auditGa4EventDeltas({
    events: [
      { name: 'purchase', count: 0, priorCount: 800 }, // key event stopped firing
      { name: 'page_view', count: 12000, priorCount: 11500 }, // healthy
    ],
    keyEventNames: ['purchase'],
  });
  const f = hi.find((x) => /stopped firing/i.test(x.message));
  assert.ok(f && f.severity === 'high' && /Key event "purchase"/.test(f.message) && f.category === 'integrity');
  // the same drop-to-zero on a NON-key event is medium and acknowledges a retired campaign/seasonal event.
  const med = auditGa4EventDeltas({ events: [{ name: 'promo_banner_click', count: 0, priorCount: 800 }] });
  assert.ok(med.some((x) => x.severity === 'medium' && /retired campaign or seasonal/i.test(x.message)));
  // a tiny prior volume (< 30) is noise, not flagged.
  assert.equal(auditGa4EventDeltas({ events: [{ name: 'rare', count: 0, priorCount: 5 }], keyEventNames: ['rare'] }).length, 0);
});

test('per-event: a >80% plunge on an established event → medium', () => {
  const r = auditGa4EventDeltas({ events: [{ name: 'add_to_cart', count: 40, priorCount: 900 }] });
  assert.ok(r.some((x) => x.severity === 'medium' && /fell \d+%/.test(x.message) && /add_to_cart/.test(x.message)));
  // a mild dip (not below 20%) isn't flagged
  assert.equal(auditGa4EventDeltas({ events: [{ name: 'add_to_cart', count: 700, priorCount: 900 }] }).length, 0);
});

test('transactions: gated on ecommerce — no findings when the property has none', () => {
  assert.equal(auditGa4Transactions({ hasEcommerce: false, transactions: [{ id: 'T1', purchases: 3 }], notSetShare: 40 }).length, 0);
});

test('transactions: a duplicated transaction id → high (double-counted revenue)', () => {
  const r = auditGa4Transactions({
    hasEcommerce: true,
    transactions: [{ id: 'T1', purchases: 2 }, { id: 'T2', purchases: 1 }, { id: 'T3', purchases: 3 }],
    notSetShare: 0,
  });
  const f = r.find((x) => /more than one purchase/i.test(x.message));
  assert.ok(f && f.severity === 'high');
  assert.ok(/2 transaction id/.test(f.message) && /3 duplicate/.test(f.message)); // T1(+1) + T3(+2) = 3 extra across 2 ids
});

test('transactions: missing transaction_id share → medium (<20%) / high (>=20%)', () => {
  assert.ok(auditGa4Transactions({ hasEcommerce: true, transactions: [], notSetShare: 8 }).some((x) => x.severity === 'medium' && /no transaction_id/i.test(x.message)));
  assert.ok(auditGa4Transactions({ hasEcommerce: true, transactions: [], notSetShare: 30 }).some((x) => x.severity === 'high'));
  // clean ecommerce → nothing
  assert.equal(auditGa4Transactions({ hasEcommerce: true, transactions: [{ id: 'T1', purchases: 1 }], notSetShare: 1 }).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
