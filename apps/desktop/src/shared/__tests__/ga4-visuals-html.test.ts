import assert from 'node:assert/strict';
import { ga4VisualsHtml } from '../ga4-visuals-html';
import type { Ga4VisualsView } from '../ipc';

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

const view = (over: Partial<Ga4VisualsView> = {}): Ga4VisualsView => ({
  daily: [
    { date: '20260610', sessions: 100 },
    { date: '20260611', sessions: 120 },
    { date: '20260612', sessions: 110 },
    { date: '20260613', sessions: 2000 },
    { date: '20260614', sessions: 115 },
  ],
  peakIndex: 3,
  trendLabel: 'One-day spike',
  trendSummary: 'A single spike on Jun 13 driven by <Organic Social>.',
  devices: [{ name: 'mobile', sessions: 800 }, { name: 'desktop', sessions: 200 }],
  channels: [{ name: 'Organic Social', sessions: 700 }, { name: 'Direct', sessions: 300 }],
  ...over,
});

console.log('\nGA4 visuals HTML:');

test('renders an SVG line chart with the peak marked', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(h.includes('<svg'), 'line chart SVG');
  assert.ok(h.includes('<polyline'), 'the trend line');
  assert.ok(h.includes('peak'), 'peak marker');
  assert.ok(h.includes('One-day spike'), 'trend label pill');
});

test('renders colour-coded device + channel bars', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(h.includes('Device split') && h.includes('Channel mix'));
  assert.ok(h.includes('mobile') && h.includes('Organic Social'));
  assert.ok(h.includes('#3b82f6') || h.includes('#22c55e'), 'palette colours present');
});

test('dynamic text is HTML-escaped (no injection)', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(h.includes('&lt;Organic Social&gt;') && !h.includes('<Organic Social>'), 'summary escaped');
});

test('no daily data and no bars → empty string (panel renders nothing)', () => {
  assert.equal(ga4VisualsHtml(view({ daily: [], devices: [], channels: [] })), '');
});

test('output uses no em dashes (house style)', () => {
  assert.ok(!ga4VisualsHtml(view({ trendSummary: 'A — B spike.' })).includes('—'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
