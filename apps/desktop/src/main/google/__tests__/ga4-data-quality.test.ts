import assert from 'node:assert/strict';
import { auditGa4DataQuality, formatDateRange, windowDates } from '../ga4-data-quality';

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

test('windowDates returns exactly `days` INCLUSIVE days ending today (DST-immune, cross-month/year)', () => {
  assert.deepEqual(windowDates('2026-01-28', 28), { startDate: '2026-01-01', endDate: '2026-01-28' });
  assert.deepEqual(windowDates('2026-03-01', 7), { startDate: '2026-02-23', endDate: '2026-03-01' }); // crosses Feb (28d)
  assert.deepEqual(windowDates('2026-01-03', 7), { startDate: '2025-12-28', endDate: '2026-01-03' }); // crosses year
  assert.deepEqual(windowDates('2026-01-15', 1), { startDate: '2026-01-15', endDate: '2026-01-15' }); // single day
});

test('formatDateRange renders a clean span and tolerates missing/cross-year bounds', () => {
  assert.equal(formatDateRange('2026-01-01', '2026-01-28'), 'Jan 1 – Jan 28, 2026');
  assert.equal(formatDateRange('2025-12-05', '2026-01-01'), 'Dec 5, 2025 – Jan 1, 2026');
  assert.equal(formatDateRange(undefined, '2026-01-28'), null);
  assert.equal(formatDateRange('2026-01-01', undefined), null);
  assert.equal(formatDateRange('garbage', '2026-01-28'), null);
});

test('the date range, when supplied, is shown in findings and echoed on the result', () => {
  const withDates = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Unassigned', sessions: 300 }, { name: 'Direct', sessions: 700 }],
    sourceMediums: [],
    windowDays: 28,
    startDate: '2026-01-01',
    endDate: '2026-01-28',
  });
  assert.equal(withDates.dateRange, 'Jan 1 – Jan 28, 2026');
  assert.equal(withDates.startDate, '2026-01-01');
  // no-data path also carries the range
  const noData = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28, startDate: '2026-01-01', endDate: '2026-01-28' });
  assert.match(noData.findings[0].message, /the last 28 days \(Jan 1 – Jan 28, 2026\)/);
  // healthy-summary path also carries the range
  const healthy = auditGa4DataQuality({ totalSessions: 1000, channelGroups: [{ name: 'Direct', sessions: 1000 }], sourceMediums: [], windowDays: 7, startDate: '2026-01-22', endDate: '2026-01-28' });
  assert.match(healthy.findings[0].message, /\(Jan 22 – Jan 28, 2026\)/);
});

test('without dates, findings fall back to "the last N days" and dateRange is null', () => {
  const r = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28 });
  assert.equal(r.dateRange, null);
  assert.match(r.findings[0].message, /the last 28 days —/);
  assert.ok(!r.findings[0].message.includes('('), 'no empty parens');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
