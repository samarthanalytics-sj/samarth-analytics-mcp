import assert from 'node:assert/strict';
import { auditGa4ParamMatrix, type Ga4ParamSignals } from '../ga4-param-matrix';

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

const base = (over: Partial<Ga4ParamSignals> = {}): Ga4ParamSignals => ({
  events: [
    { name: 'page_view', count: 10000, value: 0 },
    { name: 'purchase', count: 120, value: 48000 },
    { name: 'view_item', count: 3000, value: 0 },
  ],
  searchTermNotSetPct: null,
  items: { viewed: 2900, addedToCart: 400, checkedOut: 200, purchased: 118 },
  txnNotSetShare: 0,
  registeredParams: [],
  ...over,
});

console.log('\nGA4 param matrix:');

test('healthy signals produce NO finding', () => {
  assert.deepEqual(auditGa4ParamMatrix(base()), []);
});

test('purchase without value → HIGH required-missing (zero revenue recorded)', () => {
  const f = auditGa4ParamMatrix(base({ events: [{ name: 'purchase', count: 120, value: 0 }], items: { viewed: 0, addedToCart: 0, checkedOut: 0, purchased: 118 } }));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high');
  assert.equal(f[0].category, 'params');
  assert.ok(/purchase → value/.test(f[0].message) && /NO value/.test(f[0].message), f[0].message);
  assert.ok(/DebugView/.test(f[0].recommendation));
});

test('funnel step firing with ZERO items → MEDIUM naming the empty report', () => {
  const f = auditGa4ParamMatrix(base({
    events: [{ name: 'view_item', count: 3000, value: 0 }],
    items: { viewed: 0, addedToCart: 0, checkedOut: 0, purchased: 0 },
  }));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium', 'no purchase affected -> medium');
  assert.ok(/view_item → items\[\]/.test(f[0].message) && /item views/.test(f[0].message), f[0].message);
});

test('transaction_id: WHOLESALE-missing flagged here; partial gaps left to transaction-integrity', () => {
  const whole = auditGa4ParamMatrix(base({ txnNotSetShare: 100 }));
  assert.ok(whole.some((f) => /transaction_id/.test(f.message) && /never sent/.test(f.message)));
  const partial = auditGa4ParamMatrix(base({ txnNotSetShare: 40 }));
  assert.ok(!partial.some((f) => /transaction_id/.test(f.message)), 'partial share is the integrity check’s finding');
});

test('search_term mostly "(not set)" → LOW recommended gap with the share', () => {
  const f = auditGa4ParamMatrix(base({ events: [{ name: 'search', count: 500, value: 0 }], items: null, searchTermNotSetPct: 82 }));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'low');
  assert.ok(/search → search_term/.test(f[0].message) && /82%/.test(f[0].message), f[0].message);
  const ok = auditGa4ParamMatrix(base({ events: [{ name: 'search', count: 500, value: 0 }], items: null, searchTermNotSetPct: 2 }));
  assert.deepEqual(ok, [], 'small (not set) share is normal');
});

test('generate_lead without value → LOW recommended gap (lead-gen ROAS reads zero)', () => {
  const f = auditGa4ParamMatrix(base({ events: [{ name: 'generate_lead', count: 60, value: 0 }], items: null }));
  assert.equal(f.length, 1);
  assert.ok(/generate_lead → value/.test(f[0].message) && /ROAS/.test(f[0].message));
});

test('sign_up method: honest NOT VERIFIABLE when unregistered, silent when registered', () => {
  const f = auditGa4ParamMatrix(base({ events: [{ name: 'sign_up', count: 90, value: 0 }], items: null }));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.ok(/sign_up → method/.test(f[0].message) && /not evidence of absence/i.test(f[0].message), f[0].message);
  const reg = auditGa4ParamMatrix(base({ events: [{ name: 'sign_up', count: 90, value: 0 }], items: null, registeredParams: ['method'] }));
  assert.deepEqual(reg, [], 'registered param -> nothing to report');
});

test('events that never fired produce no rows (no phantom requirements)', () => {
  const f = auditGa4ParamMatrix(base({ events: [{ name: 'page_view', count: 5000, value: 0 }], items: null }));
  assert.deepEqual(f, []);
});

test('items null (query not run) never claims items are missing', () => {
  const f = auditGa4ParamMatrix(base({ items: null }));
  assert.deepEqual(f, [], 'absence of the signal is not evidence');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
