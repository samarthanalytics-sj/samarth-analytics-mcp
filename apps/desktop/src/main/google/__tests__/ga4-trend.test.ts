import assert from 'node:assert/strict';
import { analyzeGa4Trend, type Ga4TrendInput } from '../ga4-trend';

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

const days = (vals: number[]): Ga4TrendInput['dailySessions'] =>
  vals.map((v, i) => ({ date: `202606${String(i + 1).padStart(2, '0')}`, sessions: v }));
const inp = (vals: number[], over: Partial<Ga4TrendInput> = {}): Ga4TrendInput => ({
  dailySessions: days(vals),
  peakDayChannels: null,
  windowChannels: [],
  ...over,
});

console.log('\nGA4 trend:');

test('a flat series with one huge day → one-day spike, peak indexed', () => {
  const r = analyzeGa4Trend(inp([100, 110, 95, 105, 100, 2000, 100, 105, 98, 102]));
  assert.equal(r.pattern, 'one_day_spike');
  assert.equal(r.patternLabel, 'One-day spike');
  assert.equal(r.peakIndex, 5);
  assert.ok(r.peak && r.peak.sessions === 2000 && r.peak.xAvg > 5);
  assert.match(r.summary, /one-day spike/);
});

test('the spike is attributed to the platform that drove the peak day', () => {
  const r = analyzeGa4Trend(
    inp([100, 110, 95, 105, 100, 2000, 100, 105, 98, 102], {
      peakDayChannels: [{ name: 'Organic Social', sessions: 1700 }, { name: 'Direct', sessions: 300 }],
      windowChannels: [{ name: 'Organic Social', sessions: 900 }, { name: 'Direct', sessions: 2000 }],
    }),
  );
  assert.ok(r.drivingChannel && r.drivingChannel.name === 'Organic Social');
  assert.ok(r.drivingChannel!.dayShare > r.drivingChannel!.windowShare, 'concentrated on the peak day');
  assert.match(r.summary, /Organic Social/);
});

test('a one-day spike on a SHORT window (n=7) is still detected, not mislabelled a trend', () => {
  const r = analyzeGa4Trend(inp([200, 220, 190, 210, 205, 195, 900]));
  assert.equal(r.pattern, 'one_day_spike', 'a 4.5x day on a 7-day window is a spike, not an uptrend');
  assert.equal(r.peakIndex, 6);
  // and the same on a 5-day window
  assert.equal(analyzeGa4Trend(inp([100, 100, 100, 100, 1000])).pattern, 'one_day_spike');
});

test('a modest weekend bump (3x) is NOT a spike (avoids false positives)', () => {
  assert.notEqual(analyzeGa4Trend(inp([100, 100, 100, 100, 100, 300, 90])).pattern, 'one_day_spike');
});

test('growth from a literal zero baseline → upward trend, not volatile', () => {
  const r = analyzeGa4Trend(inp([0, 0, 0, 0, 0, 500, 600, 700, 800, 900]));
  assert.equal(r.pattern, 'uptrend');
  assert.match(r.summary, /near-zero start/);
});

test('a steadily rising series → upward trend (back half higher than front half)', () => {
  const r = analyzeGa4Trend(inp([100, 120, 140, 160, 180, 200, 220, 240, 260, 280]));
  assert.equal(r.pattern, 'uptrend');
  assert.ok(r.deltaPct !== null && r.deltaPct > 30);
});

test('a steadily falling series → downward trend', () => {
  const r = analyzeGa4Trend(inp([280, 260, 240, 220, 200, 180, 160, 140, 120, 100]));
  assert.equal(r.pattern, 'downtrend');
});

test('a flat series → steady (no spike, no trend)', () => {
  const r = analyzeGa4Trend(inp([100, 105, 98, 102, 100, 101, 99, 103, 100, 100]));
  assert.equal(r.pattern, 'steady');
  assert.equal(r.drivingChannel, null);
});

test('fewer than 5 days → insufficient, no crash', () => {
  const r = analyzeGa4Trend(inp([100, 200, 150]));
  assert.equal(r.pattern, 'insufficient');
  assert.equal(r.peak, null);
});

test('trailing in-progress (partial) day is excluded so it does not force a false downtrend', () => {
  const vals = [100, 100, 100, 100, 100, 100, 5]; // 6 steady days + a low partial "today" (20260607)
  const guarded = analyzeGa4Trend(inp(vals, { todayYmd: '20260607' }));
  assert.equal(guarded.partialLastDayExcluded, true);
  assert.equal(guarded.pattern, 'steady'); // the partial day is dropped → no false drop
  assert.match(guarded.summary, /in-progress day is excluded/);
  // Without the guard, the same low partial day forces a downtrend classification.
  const unguarded = analyzeGa4Trend(inp(vals));
  assert.equal(unguarded.partialLastDayExcluded, false);
  assert.equal(unguarded.pattern, 'downtrend');
  // A todayYmd that isn't the last series day (historical range) → no exclusion.
  assert.equal(analyzeGa4Trend(inp(vals, { todayYmd: '20260615' })).partialLastDayExcluded, false);
  // Dashed YYYY-MM-DD is accepted too.
  assert.equal(analyzeGa4Trend(inp(vals, { todayYmd: '2026-06-07' })).partialLastDayExcluded, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
