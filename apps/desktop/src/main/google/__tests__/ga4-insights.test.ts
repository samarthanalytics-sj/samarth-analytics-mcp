import assert from 'node:assert/strict';
import { deriveGa4Insights } from '../ga4-insights';
import type { Ga4Baseline } from '../data-service';

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

// A minimal Ga4Baseline with everything empty/neutral; each test overrides only what it exercises.
const base = (over: Partial<Ga4Baseline> = {}): Ga4Baseline => ({
  startDate: '2026-06-01', endDate: '2026-06-30', priorStartDate: '2026-05-01', priorEndDate: '2026-05-31',
  sessions: 10000, priorSessions: 9000, keyEvents: 300, priorKeyEvents: 280, revenue: 100000, priorRevenue: 90000,
  avgEngagementSec: 60, engagementRate: 0.5, engagedSessionsPerUser: 1.2, trendPct: 11,
  peakDay: null, dailySessions: [], peakDayChannels: null, channelDaily: [],
  devices: [], newVsReturning: [], topCountries: [],
  channelPerformance: [], landingPages: [], devicePerformance: [], geoPerformance: [], llmTraffic: [], funnelSteps: [],
  ...over,
});

console.log('\nGA4 insights:');

test('no baseline → no insights', () => {
  assert.deepEqual(deriveGa4Insights(null, 'USD'), []);
});

test('peak day is called out only when it is a real spike vs the daily average', () => {
  const spike = deriveGa4Insights(base({ peakDay: { date: '20260615', sessions: 1800 }, dailySessions: [
    { date: '20260614', sessions: 900 }, { date: '20260615', sessions: 1800 }, { date: '20260616', sessions: 950 },
  ] }), 'USD');
  assert.ok(spike.some((i) => /peaked on Jun 15 at 1,800 sessions/.test(i)), spike.join(' | '));
  // A near-average "peak" is not worth calling out.
  const flat = deriveGa4Insights(base({ peakDay: { date: '20260615', sessions: 1010 }, dailySessions: [
    { date: '20260614', sessions: 1000 }, { date: '20260615', sessions: 1010 }, { date: '20260616', sessions: 990 },
  ] }), 'USD');
  assert.ok(!flat.some((i) => /peaked/.test(i)), 'no peak-day bullet when it is not a spike');
});

test('near-100% conversion rates → the data-quality flag, and conversion-based insights are suppressed', () => {
  const ins = deriveGa4Insights(base({ channelPerformance: [
    { channel: 'Direct', sessions: 6000, keyEvents: 5400, convRate: 0.9, revenue: 50000, engagementRate: 0.5 },
    { channel: 'Organic Shopping', sessions: 4000, keyEvents: 3400, convRate: 0.85, revenue: 80000, engagementRate: 0.5 },
  ] }), 'INR');
  assert.ok(ins.some((i) => /near 100% on the channels that carry most of your traffic/.test(i)), 'flag present, session-weighted wording');
  assert.ok(ins.some((i) => /Organic Shopping brings the most revenue \(INR 80,000\)/.test(i)), 'revenue insight still shown');
  assert.ok(!ins.some((i) => /converts best/.test(i)), 'no "converts best" claim when the rate is unreliable');
});

test('landing-page leak is not claimed for a low-traffic top page (< 100 sessions)', () => {
  const ins = deriveGa4Insights(base({ landingPages: [
    { page: '/a', sessions: 40, keyEvents: 0, convRate: 0.005, revenue: 0, engagementRate: 0.3 }, // top by volume but tiny
    { page: '/b', sessions: 30, keyEvents: 6, convRate: 0.20, revenue: 5000, engagementRate: 0.6 },
  ] }), 'USD');
  assert.ok(!ins.some((i) => /CRO opportunity/.test(i)), 'no CRO claim when even the top entry page is negligible');
});

test('fmtYmd guards a malformed month (never renders "undefined")', () => {
  const ins = deriveGa4Insights(base({ peakDay: { date: '20261301', sessions: 3000 }, dailySessions: [
    { date: '20261230', sessions: 500 }, { date: '20261301', sessions: 3000 }, { date: '20261302', sessions: 520 },
  ] }), 'USD');
  const peak = ins.find((i) => /peaked/.test(i)) ?? '';
  assert.ok(!/undefined/.test(peak), 'no "undefined" month in the peak-day bullet');
  assert.ok(/peaked on 20261301 at/.test(peak), 'falls back to the raw date string on a bad month');
});

test('trustworthy conversion → channel best-converter, landing leak, and device-gap insights appear', () => {
  const ins = deriveGa4Insights(base({
    channelPerformance: [
      { channel: 'Direct', sessions: 6000, keyEvents: 120, convRate: 0.02, revenue: 20000, engagementRate: 0.5 },
      { channel: 'Paid Search', sessions: 3000, keyEvents: 240, convRate: 0.08, revenue: 90000, engagementRate: 0.6 },
    ],
    landingPages: [
      { page: '/', sessions: 5000, keyEvents: 50, convRate: 0.01, revenue: 10000, engagementRate: 0.4 },
      { page: '/pricing', sessions: 2000, keyEvents: 200, convRate: 0.10, revenue: 60000, engagementRate: 0.7 },
    ],
    devicePerformance: [
      { device: 'mobile', sessions: 7000, keyEvents: 140, convRate: 0.02, revenue: 20000, engagementRate: 0.45 },
      { device: 'desktop', sessions: 3000, keyEvents: 180, convRate: 0.06, revenue: 40000, engagementRate: 0.65 },
    ],
  }), 'USD');
  assert.ok(ins.some((i) => /Paid Search brings the most revenue \(USD 90,000\) and converts best at 8%/.test(i)), ins.join(' | '));
  assert.ok(ins.some((i) => /\/ is your top entry page \(5,000 sessions\) but converts at only 1%, below \/pricing's 10%/.test(i)), 'landing leak');
  assert.ok(ins.some((i) => /Most visits are on mobile but desktop converts better \(6% vs 2%\)/.test(i)), 'device gap');
});

test('unverified conversion/revenue tag the dependent insights as provisional (trust matrix)', () => {
  const b = base({
    channelPerformance: [
      { channel: 'Direct', sessions: 6000, keyEvents: 120, convRate: 0.02, revenue: 20000, engagementRate: 0.5 },
      { channel: 'Paid Search', sessions: 3000, keyEvents: 240, convRate: 0.08, revenue: 90000, engagementRate: 0.6 },
    ],
    funnelSteps: [{ event: 'view_item', users: 10000 }, { event: 'add_to_cart', users: 3000 }],
  });
  // Both unverified → the revenue+conversion channel bullet gets the combined tag; the funnel bullet
  // (conversion only) gets the conversion tag.
  const both = deriveGa4Insights(b, 'USD', { convSafe: false, revSafe: false });
  assert.ok(both.some((i) => /converts best at 8%\. \(provisional - conversion & revenue unverified\)/.test(i)), both.join(' | '));
  assert.ok(both.some((i) => /drop-off:.*\(provisional - conversion tracking unverified\)/.test(i)), 'funnel tagged conversion-only');
  // Revenue-only unverified → the channel bullet is tagged revenue-only; the funnel bullet stays clean.
  const revOnly = deriveGa4Insights(b, 'USD', { convSafe: true, revSafe: false });
  assert.ok(revOnly.some((i) => /converts best at 8%\. \(provisional - revenue unverified\)/.test(i)), revOnly.join(' | '));
  assert.ok(revOnly.some((i) => /where 70% of users leave\.$/.test(i)), 'funnel untagged when conversion is safe');
  // No trust matrix supplied → no tags at all (backward compatible).
  assert.ok(!deriveGa4Insights(b, 'USD').some((i) => /provisional/.test(i)), 'no provisional tags without a trust matrix');
});

test('best-converter ignores tiny high-variance rows (volume guard)', () => {
  const ins = deriveGa4Insights(base({ channelPerformance: [
    { channel: 'Direct', sessions: 9000, keyEvents: 180, convRate: 0.02, revenue: 50000, engagementRate: 0.5 },
    { channel: 'Referral-blip', sessions: 20, keyEvents: 18, convRate: 0.9, revenue: 100, engagementRate: 0.5 }, // 90% off 20 sessions
  ] }), 'USD');
  assert.ok(!ins.some((i) => /Referral-blip converts best/.test(i)), 'a 20-session 90% row is not "best converting"');
});

test('funnel: names the biggest step-to-step drop-off', () => {
  const ins = deriveGa4Insights(base({ funnelSteps: [
    { event: 'view_item', users: 10000 }, { event: 'add_to_cart', users: 3000 }, // 70% drop here
    { event: 'begin_checkout', users: 2400 }, { event: 'purchase', users: 1800 },
  ] }), 'USD');
  assert.ok(ins.some((i) => /Biggest funnel drop-off: View item to Add to cart, where 70% of users leave/.test(i)), ins.join(' | '));
});

test('AI-assistant materiality bullet', () => {
  const ins = deriveGa4Insights(base({ sessions: 10000, llmTraffic: [
    { source: 'claude.ai', sessions: 300, keyEvents: 20, convRate: 0.06, revenue: 5000, engagementRate: 0.7 },
    { source: 'chatgpt.com', sessions: 100, keyEvents: 4, convRate: 0.04, revenue: 1000, engagementRate: 0.5 },
  ] }), 'USD');
  assert.ok(ins.some((i) => /AI assistants sent 400 sessions \(4.0% of traffic\), led by claude.ai/.test(i)), ins.join(' | '));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
