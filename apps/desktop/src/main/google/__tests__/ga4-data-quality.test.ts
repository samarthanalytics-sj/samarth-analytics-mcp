import assert from 'node:assert/strict';
import { auditGa4DataQuality } from '../ga4-data-quality';

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

console.log('\nGA4 data-quality audit:');

test('no sessions → a single high "not collecting" finding', () => {
  const r = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28 });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
  assert.match(r.findings[0].message, /not be collecting/);
});

test('high Unassigned share and a (not set) source/medium are both flagged with shares', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [
      { name: 'Direct', sessions: 600 },
      { name: 'Unassigned', sessions: 300 }, // 30% → high
      { name: 'Organic Search', sessions: 100 },
    ],
    sourceMediums: [
      { name: '(direct) / (none)', sessions: 600 },
      { name: '(not set)', sessions: 120 }, // 12% → medium
      { name: 'google / organic', sessions: 100 },
    ],
    windowDays: 28,
  });
  const unassigned = r.findings.find((f) => /Unassigned/.test(f.message))!;
  assert.equal(unassigned.severity, 'high', '30% Unassigned → high');
  assert.match(unassigned.message, /30\.0%/);
  const notSet = r.findings.find((f) => /\(not set\)/.test(f.message))!;
  assert.equal(notSet.severity, 'medium', '12% (not set) → medium');
  assert.match(notSet.message, /12\.0%/);
  assert.ok(r.findings.every((f) => f.category === 'data_quality'));
});

test('shares below 5% produce no problem findings, just an info "looks healthy"', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Direct', sessions: 960 }, { name: 'Unassigned', sessions: 40 }], // 4% → not flagged
    sourceMediums: [{ name: 'google / organic', sessions: 980 }, { name: '(not set)', sessions: 20 }], // 2% → not flagged
    windowDays: 7,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'info');
  assert.match(r.findings[0].message, /No major data-quality issues/);
});

test('threshold boundaries: 5% → low, 10% → medium, 25% → high', () => {
  const at = (sessions: number) =>
    auditGa4DataQuality({
      totalSessions: 1000,
      channelGroups: [{ name: 'Unassigned', sessions }, { name: 'Direct', sessions: 1000 - sessions }],
      sourceMediums: [],
      windowDays: 28,
    }).findings.find((f) => /in the "Unassigned" channel/.test(f.message))?.severity;
  assert.equal(at(50), 'low'); // 5%
  assert.equal(at(100), 'medium'); // 10%
  assert.equal(at(250), 'high'); // 25%
  assert.equal(at(49), undefined); // 4.9% → not flagged
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
