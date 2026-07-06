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

test('a big spike where conversions grew but slower than traffic → LOW (channel-mix dilution, not a break)', () => {
  // sessions +276%, key events +112%, revenue +69% — conversions clearly responded, just diluted.
  const r = auditGa4Growth(inp({ sessions: 33453, priorSessions: 8904, keyEvents: 1060, priorKeyEvents: 500, revenue: 169000, priorRevenue: 100000 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'low', 'diluted-but-growing conversions are not a CRITICAL break');
  assert.equal(r.findings[0].category, 'growth');
  assert.ok(/dilut/.test(r.findings[0].message), 'frames it as conversion-rate dilution');
  assert.ok(!/may be wrong/.test(r.findings[0].message), 'does not assert revenue is wrong when it grew');
});

test('a spike where ONLY sessions grow and revenue lags badly stays CRITICAL (revenue did not respond)', () => {
  // sessions +276%, key events +112% but revenue only +10% (ratio 0.036) → revenue lagged → worse branch.
  const r = auditGa4Growth(inp({ sessions: 33453, priorSessions: 8904, keyEvents: 1060, priorKeyEvents: 500, revenue: 110000, priorRevenue: 100000 }));
  assert.equal(r.findings[0].severity, 'critical', 'a lagging revenue metric still escalates');
});

test('a spike where revenue COLLAPSES to zero stays CRITICAL (a revenue break, never softened to LOW)', () => {
  // sessions +276%, key events +112%, but revenue 100k → 0 (a -100% wipeout) — the strongest break signal.
  const r = auditGa4Growth(inp({ sessions: 33453, priorSessions: 8904, keyEvents: 1060, priorKeyEvents: 500, revenue: 0, priorRevenue: 100000 }));
  assert.equal(r.findings[0].severity, 'critical', 'a revenue collapse must not be graded as dilution');
});

test('a NEW revenue stream (prior 0 → now positive) with diluted key events is not falsely escalated', () => {
  // prior revenue 0 → 90k is real new growth; key events +112% respond → LOW dilution, not critical.
  const r = auditGa4Growth(inp({ sessions: 33453, priorSessions: 8904, keyEvents: 1060, priorKeyEvents: 500, revenue: 90000, priorRevenue: 0 }));
  assert.notEqual(r.findings[0].severity, 'critical', 'a brand-new revenue stream is not a collapse');
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

test('a sharp drop where revenue HELD -> LOW junk-shed reframe, never a tagging warning', () => {
  // The user-reported contradiction: sessions -45% but revenue only -11%. If tagging had broken,
  // revenue would fall with the sessions; it did not, so the read is low-value traffic washing out
  // (e.g. an earlier one-off spike leaving the comparison window), graded LOW.
  const r = auditGa4Growth(inp({ sessions: 11000, priorSessions: 20000, keyEvents: 4000, priorKeyEvents: 5000, revenue: 800000, priorRevenue: 900000 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'low');
  assert.ok(/revenue held/.test(r.findings[0].message), 'leads with the revenue hold');
  assert.ok(!/can indicate broken/.test(r.findings[0].message), 'no tagging accusation when revenue held');
  assert.ok(/would drag revenue down/.test(r.findings[0].message), 'states WHY the break is ruled out');
  assert.ok(/not a tracking break/.test(r.findings[0].message), 'explicitly rules the break out');
  assert.equal(r.sessionsTrendPct, -45);
  assert.equal(r.revenueTrendPct, -11);
});

test('a sharp drop that revenue CONFIRMS keeps the MEDIUM tagging warning and says the outcomes confirm it', () => {
  const r = auditGa4Growth(inp({ sessions: 3000, priorSessions: 9000, keyEvents: 100, priorKeyEvents: 450, revenue: 30000, priorRevenue: 90000 }));
  assert.equal(r.findings[0].severity, 'medium');
  assert.ok(/revenue fell with it \(-67%\)/.test(r.findings[0].message), 'names the confirming revenue fall');
  assert.ok(/the outcomes confirm/.test(r.findings[0].message));
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
