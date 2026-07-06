import assert from 'node:assert/strict';
import { ga4VisualsHtml, stripDuplicateCharts, buildTrendInsights, findChannelSpike } from '../ga4-visuals-html';
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
  channelDaily: [
    { channel: 'Organic Social', series: [{ date: '20260610', sessions: 50 }, { date: '20260611', sessions: 60 }, { date: '20260612', sessions: 55 }, { date: '20260613', sessions: 1500 }, { date: '20260614', sessions: 58 }] },
    { channel: 'Direct', series: [{ date: '20260610', sessions: 50 }, { date: '20260611', sessions: 60 }, { date: '20260612', sessions: 55 }, { date: '20260613', sessions: 500 }, { date: '20260614', sessions: 57 }] },
  ],
  devices: [{ name: 'mobile', sessions: 800 }, { name: 'desktop', sessions: 200 }],
  channels: [{ name: 'Organic Social', sessions: 700 }, { name: 'Direct', sessions: 300 }],
  drivingChannel: { name: 'Organic Social', dayShare: 0.75, windowShare: 0.7 },
  channelTrusted: true,
  channelCaveat: null,
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

test('data-point dots carry a value tooltip (hover shows the value for that date)', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(/<circle/.test(h), 'data-point dots rendered');
  assert.ok(/<title>[^<]*: [\d,]+ sessions<\/title>/.test(h), 'each point has a value tooltip');
});

test('adaptive grouping: daily → weekly → monthly as the window grows', () => {
  const mk = (days: number): Ga4VisualsView['daily'] =>
    Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''), sessions: 100 + (i % 7) * 10 }));
  assert.match(ga4VisualsHtml(view({ daily: mk(20), channelDaily: [] })), /\(daily/);
  assert.match(ga4VisualsHtml(view({ daily: mk(70), channelDaily: [] })), /\(weekly/);
  assert.match(ga4VisualsHtml(view({ daily: mk(220), channelDaily: [] })), /\(monthly/);
});

test('renders a per-channel multi-line chart with a legend', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(h.includes('Sessions by channel'), 'multi-line chart heading');
  // two channel polylines (total trend line is one; multi-line adds one per channel)
  assert.ok((h.match(/<polyline/g) ?? []).length >= 3, 'a line per channel plus the trend line');
  assert.ok(h.includes('Organic Social') && h.includes('Direct'), 'channel legend names');
});

test('a single channel (or none) → no multi-line chart (needs >=2 series)', () => {
  const one = ga4VisualsHtml(view({ channelDaily: [{ channel: 'Direct', series: [{ date: '20260610', sessions: 10 }, { date: '20260611', sessions: 12 }] }] }));
  assert.ok(!one.includes('Sessions by channel'));
});

test('renders colour-coded device + channel bars', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(h.includes('Device split') && h.includes('Channel mix'));
  assert.ok(h.includes('mobile') && h.includes('Organic Social'));
  assert.ok(h.includes('#4F7BD1') || h.includes('#1FA5B8'), 'lab palette colours present');
});

test('untrusted channel attribution greys the channel charts and shows a caveat', () => {
  const h = ga4VisualsHtml(view({ channelTrusted: false }));
  assert.ok(/not safe to quote/i.test(h), 'caveat shown');
  assert.ok(/opacity:\.5/.test(h), 'channel charts greyed');
  const ok = ga4VisualsHtml(view({ channelTrusted: true }));
  assert.ok(!/opacity:\.5/.test(ok), 'trusted → not greyed');
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

test('buildTrendInsights derives peak, driving channel, concentration and device from the graph data', () => {
  const ins = buildTrendInsights(view());
  const by = (t: string): { tone: string; body: string } | undefined => ins.find((i) => i.title === t);
  assert.ok(by('Peak') && /2,000 sessions/.test(by('Peak')!.body), 'peak day + value');
  const drv = by('What drove it');
  assert.ok(drv && /Organic Social/.test(drv.body) && /peak day/.test(drv.body), 'names the peak-day driving channel (same source as the chart marker)');
  assert.ok(drv && /75% of that day/.test(drv.body), 'quotes the peak-day share from the shared driving-channel signal');
  const conc = by('Concentration risk');
  assert.ok(conc && conc.tone === 'watch' && /70%/.test(conc.body), 'flags single-channel concentration');
  assert.ok(by('Device') && /80% mobile/.test(by('Device')!.body), 'device skew');
});

test('buildTrendInsights flags an untrusted channel split with a caveat', () => {
  const ins = buildTrendInsights(view({ channelTrusted: false }));
  assert.ok(ins.some((i) => i.title === 'Caveat' && i.tone === 'watch'), 'caveat insight when channel attribution is unsafe');
});

test('ga4VisualsHtml renders the deep-insights panel beside the charts', () => {
  const h = ga4VisualsHtml(view());
  assert.ok(/What the data shows/.test(h), 'insights panel header');
  assert.ok(/What drove it/.test(h) && /Organic Social/.test(h), 'driver insight rendered in the panel');
});

test('stripDuplicateCharts removes the baseline Unicode device + channel blocks, keeps the rest', () => {
  const md = [
    '## 6 · Property baseline',
    '',
    '- **Sessions:** 32,822',
    '',
    '**Device split**',
    '',
    '```',
    'mobile       ████ 98%',
    'desktop      ░░░░ 2%',
    '```',
    '',
    '**Channel mix (sessions)**',
    '',
    '```',
    'Organic Social  ████ 56%',
    '```',
    '',
    '## 7 · Decision readiness',
  ].join('\n');
  const out = stripDuplicateCharts(md);
  assert.ok(!out.includes('Device split') && !out.includes('Channel mix'), 'unicode chart blocks removed');
  assert.ok(!out.includes('████') && !out.includes('░░░░'), 'bar glyphs removed');
  assert.ok(out.includes('**Sessions:** 32,822') && out.includes('## 7 · Decision readiness'), 'surrounding content kept');
});


test('findChannelSpike flags a one-bucket channel spike, null when traffic is steady', () => {
  const spike = findChannelSpike([
    { channel: 'Direct', points: [{ label: 'Wk Apr 8', value: 300 }, { label: 'Wk Apr 15', value: 22362 }, { label: 'Wk Apr 22', value: 310 }, { label: 'Wk Apr 29', value: 305 }] },
    { channel: 'Organic Shopping', points: [{ label: 'Wk Apr 8', value: 2000 }, { label: 'Wk Apr 15', value: 2100 }, { label: 'Wk Apr 22', value: 1900 }, { label: 'Wk Apr 29', value: 2050 }] },
  ]);
  assert.ok(spike, 'spike detected');
  assert.equal(spike.channel, 'Direct');
  assert.equal(spike.peakLabel, 'Wk Apr 15');
  assert.ok(spike.peakSharePct >= 90, 'one week holds nearly all of the channel');
  assert.equal(spike.periods, 1, 'single-bucket burst reported as one period');
  assert.equal(findChannelSpike([
    { channel: 'A', points: [{ label: 'w1', value: 100 }, { label: 'w2', value: 110 }, { label: 'w3', value: 105 }, { label: 'w4', value: 95 }] },
    { channel: 'B', points: [{ label: 'w1', value: 200 }, { label: 'w2', value: 210 }, { label: 'w3', value: 190 }, { label: 'w4', value: 205 }] },
  ]), null, 'steady channels produce no decomposition');
});

test('findChannelSpike catches a burst STRADDLING a bucket boundary (each half < 60%, the adjacent pair >= 60%)', () => {
  // The disappearing-finding bug: the same real-world burst lands in one weekly bucket when the
  // window starts on one date and splits across two buckets when the window shifts. The finding must
  // not silently vanish on the split run.
  const spike = findChannelSpike([
    { channel: 'Direct', points: [
      { label: 'Wk Apr 8', value: 500 }, { label: 'Wk Apr 15', value: 11000 }, { label: 'Wk Apr 22', value: 11362 },
      { label: 'Wk Apr 29', value: 480 }, { label: 'Wk May 6', value: 505 }, { label: 'Wk May 13', value: 490 },
    ] },
    { channel: 'Organic Shopping', points: [
      { label: 'Wk Apr 8', value: 2000 }, { label: 'Wk Apr 15', value: 2100 }, { label: 'Wk Apr 22', value: 1900 },
      { label: 'Wk Apr 29', value: 2050 }, { label: 'Wk May 6', value: 1980 }, { label: 'Wk May 13', value: 2020 },
    ] },
  ]);
  assert.ok(spike, 'straddled burst still detected');
  assert.equal(spike.channel, 'Direct');
  assert.equal(spike.periods, 2, 'reported as two adjacent periods');
  assert.equal(spike.peakLabel, 'Wk Apr 15 + Wk Apr 22', 'labels both buckets');
  assert.ok(spike.peakSharePct >= 90, 'the pair holds nearly all of the channel');
  // A genuinely spread channel (every pair below 60%) still produces nothing.
  assert.equal(findChannelSpike([
    { channel: 'Direct', points: [
      { label: 'w1', value: 4000 }, { label: 'w2', value: 4100 }, { label: 'w3', value: 3900 },
      { label: 'w4', value: 4050 }, { label: 'w5', value: 3980 }, { label: 'w6', value: 4020 },
    ] },
  ]), null, 'no pair qualifies on steady traffic');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
