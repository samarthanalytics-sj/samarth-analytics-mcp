import assert from 'node:assert/strict';
import { auditGa4Growth, type Ga4GrowthInput } from '../ga4-growth';

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

const inp = (over: Partial<Ga4GrowthInput> = {}): Ga4GrowthInput => ({
  sessions: 10000,
  priorSessions: 9000,
  keyEvents: 500,
  priorKeyEvents: 450,
  revenue: 100000,
  priorRevenue: 90000,
  topChannel: 'Organic Social',
  ...over,
});

console.log('\nGA4 growth:');

test('a >=2x spike that conversions and revenue did NOT track → CRITICAL (worst unverified branch)', () => {
  const r = auditGa4Growth(inp({ sessions: 32000, priorSessions: 8800, keyEvents: 205, priorKeyEvents: 200, revenue: 1000, priorRevenue: 980 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'critical', 'a doubled spike with flat conversions grades to the worse branch');
  assert.equal(r.findings[0].category, 'growth');
  assert.ok(/revenue\/ROAS may be wrong/.test(r.findings[0].message), 'leads with the live-reporting stake');
  assert.ok(/worse branch/.test(r.findings[0].ifUnconfirmed ?? ''), 'documents the escalation');
  assert.ok(/Organic Social/.test(r.findings[0].recommendation ?? ''), 'names the driver channel');
  assert.equal(r.sessionsTrendPct, 264);
});

test('returning-user share weighs the verdict (held-up returning share argues against pure bot)', () => {
  const held = auditGa4Growth(inp({ sessions: 32000, priorSessions: 8800, keyEvents: 205, priorKeyEvents: 200, revenue: 1000, priorRevenue: 980, returningSharePct: 21 }));
  assert.ok(/unlikely to be pure bot/.test(held.findings[0].whyItMatters ?? ''));
  const collapsed = auditGa4Growth(inp({ sessions: 32000, priorSessions: 8800, keyEvents: 205, priorKeyEvents: 200, revenue: 1000, priorRevenue: 980, returningSharePct: 2 }));
  assert.ok(/consistent with bot/.test(collapsed.findings[0].whyItMatters ?? ''));
});

test('a spike where key events and revenue scale with it → INFO (healthy growth, not a gap)', () => {
  const r = auditGa4Growth(inp({ sessions: 32000, priorSessions: 8800, keyEvents: 1800, priorKeyEvents: 500, revenue: 360000, priorRevenue: 100000 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'info');
  assert.ok(/launch or campaign/.test(r.findings[0].message));
});

test('a brand-new revenue stream (prior period = 0) is real growth → INFO, never a false HIGH', () => {
  const r = auditGa4Growth(inp({ sessions: 30000, priorSessions: 10000, keyEvents: 205, priorKeyEvents: 200, revenue: 50000, priorRevenue: 0 }));
  assert.equal(r.findings[0].severity, 'info', 'revenue 0 → $50k is a launch, not a bot spike');
  assert.ok(/revenue is new this period/.test(r.findings[0].message));
  assert.ok(!/no revenue is recorded/.test(r.findings[0].message), 'message must not contradict the data');
});

test('a brand-new conversion stream (prior key events = 0, meaningful volume) → INFO', () => {
  const r = auditGa4Growth(inp({ sessions: 30000, priorSessions: 10000, keyEvents: 300, priorKeyEvents: 0, revenue: 0, priorRevenue: 0 }));
  assert.equal(r.findings[0].severity, 'info');
  assert.ok(/key events are new this period/.test(r.findings[0].message));
});

test('a spike with a tiny absolute conversion delta is NOT waved through as healthy → MEDIUM', () => {
  // key events 1 → 3 is +200% but only 3 conversions on 30k sessions — noise, not scaling.
  const r = auditGa4Growth(inp({ sessions: 30000, priorSessions: 10000, keyEvents: 3, priorKeyEvents: 1, revenue: 0, priorRevenue: 0 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'medium', 'too little conversion signal to confirm');
});

test('a spike on a property with no key events at all → MEDIUM (can\'t confirm)', () => {
  const r = auditGa4Growth(inp({ sessions: 32000, priorSessions: 8800, keyEvents: 0, priorKeyEvents: 0, revenue: 0, priorRevenue: 0 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'medium');
  assert.ok(/no key events/.test(r.findings[0].message));
});

test('a sharp drop → MEDIUM finding', () => {
  const r = auditGa4Growth(inp({ sessions: 3000, priorSessions: 9000, keyEvents: 100, priorKeyEvents: 450, revenue: 30000, priorRevenue: 90000 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'medium');
  assert.ok(/fell/.test(r.findings[0].message));
  assert.equal(r.sessionsTrendPct, -67);
});

test('normal variation (within ±threshold) → no finding', () => {
  assert.equal(auditGa4Growth(inp({ sessions: 10000, priorSessions: 9000 })).findings.length, 0); // +11%
  assert.equal(auditGa4Growth(inp({ sessions: 8000, priorSessions: 9000 })).findings.length, 0); // -11%
});

test('a spike off a tiny prior window is NOT judged (noise floor)', () => {
  const r = auditGa4Growth(inp({ sessions: 400, priorSessions: 50, keyEvents: 1, priorKeyEvents: 0, revenue: 0, priorRevenue: 0 }));
  assert.equal(r.assessed, false);
  assert.equal(r.findings.length, 0);
});

test('zero prior sessions → trend null, not assessed, no crash', () => {
  const r = auditGa4Growth(inp({ sessions: 5000, priorSessions: 0 }));
  assert.equal(r.sessionsTrendPct, null);
  assert.equal(r.assessed, false);
  assert.equal(r.findings.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
