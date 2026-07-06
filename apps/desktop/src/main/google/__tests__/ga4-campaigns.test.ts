import assert from 'node:assert/strict';
import { rankGa4Campaigns, type CampaignRow } from '../ga4-campaigns';

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

const row = (campaign: string, sessions: number, keyEvents: number, revenue: number, engagementRate = 0.5): CampaignRow => ({
  campaign,
  sessions,
  keyEvents,
  revenue,
  engagementRate,
});

console.log('\nGA4 campaign ranker:');

test('ranks by CONVERSIONS when any tagged campaign has key events', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('big_traffic', 1000, 5, 100),
      row('high_conv', 200, 50, 500),
      row('mid', 400, 20, 300),
    ],
    totalSessions: 1600,
    windowDays: 28,
  });
  assert.equal(r.primaryMetric, 'conversions');
  assert.deepEqual(r.taggedCampaigns.map((c) => c.campaign), ['high_conv', 'mid', 'big_traffic']);
  assert.equal(r.bestCampaign?.campaign, 'high_conv');
});

test('ranks by REVENUE when there are no conversions but some revenue', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('a', 500, 0, 100),
      row('b', 200, 0, 900),
      row('c', 800, 0, 400),
    ],
    totalSessions: 1500,
    windowDays: 28,
  });
  assert.equal(r.primaryMetric, 'revenue');
  assert.deepEqual(r.taggedCampaigns.map((c) => c.campaign), ['b', 'c', 'a']);
});

test('ranks by SESSIONS when there are neither conversions nor revenue', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('small', 100, 0, 0),
      row('large', 900, 0, 0),
      row('mid', 400, 0, 0),
    ],
    totalSessions: 1400,
    windowDays: 28,
  });
  assert.equal(r.primaryMetric, 'sessions');
  assert.deepEqual(r.taggedCampaigns.map((c) => c.campaign), ['large', 'mid', 'small']);
});

test('tiebreak: equal primary metric falls back to revenue, then sessions', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('tie_low_rev', 500, 10, 100),
      row('tie_high_rev', 300, 10, 900), // same conversions, more revenue → first
      row('tie_same_rev_more_sessions', 700, 10, 100), // ties tie_low_rev on conv+rev → more sessions wins
    ],
    totalSessions: 1500,
    windowDays: 28,
  });
  assert.equal(r.primaryMetric, 'conversions');
  assert.deepEqual(
    r.taggedCampaigns.map((c) => c.campaign),
    ['tie_high_rev', 'tie_same_rev_more_sessions', 'tie_low_rev']
  );
});

test('splits untagged buckets out and computes untagged share of total sessions', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('real', 300, 10, 100),
      row('(organic)', 200, 0, 0),
      row('(direct)', 150, 0, 0),
      row('(not set)', 100, 0, 0),
      row('', 50, 0, 0), // blank campaign is also untagged
      row('(referral)', 100, 0, 0),
      row('(data not available)', 50, 0, 0),
      row('(data deleted)', 50, 0, 0),
    ],
    totalSessions: 1000,
    windowDays: 28,
  });
  assert.deepEqual(r.taggedCampaigns.map((c) => c.campaign), ['real']);
  // untagged = 200+150+100+50+100+50+50 = 700
  assert.equal(r.untaggedSessions, 700);
  assert.equal(Math.round(r.untaggedSharePct), 70);
});

test('untagged membership is case-insensitive and trims whitespace', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('real', 400, 5, 0),
      row('  (Organic)  ', 300, 0, 0),
      row('(DIRECT)', 300, 0, 0),
    ],
    totalSessions: 1000,
    windowDays: 28,
  });
  assert.deepEqual(r.taggedCampaigns.map((c) => c.campaign), ['real']);
  assert.equal(r.untaggedSessions, 600);
});

test('no tagged campaigns → ONE medium attribution finding', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('(organic)', 600, 0, 0),
      row('(direct)', 400, 0, 0),
    ],
    totalSessions: 1000,
    windowDays: 28,
  });
  assert.equal(r.taggedCampaigns.length, 0);
  assert.equal(r.bestCampaign, null);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'medium');
  assert.equal(r.findings[0].category, 'attribution');
  assert.match(r.findings[0].message, /No sessions are attributed to a marketing campaign/);
  assert.match(r.findings[0].recommendation!, /utm_campaign/);
});

test('best-campaign INFO finding names the winner with conversions, revenue, sessions', () => {
  const r = rankGa4Campaigns({
    rows: [row('summer_sale', 400, 40, 4000), row('(organic)', 100, 0, 0)],
    totalSessions: 500,
    windowDays: 28,
  });
  const info = r.findings.find((f) => f.severity === 'info');
  assert.ok(info, 'info finding present');
  assert.equal(info!.category, 'attribution');
  assert.match(info!.message, /Top campaign by conversions/);
  assert.match(info!.message, /"summer_sale"/);
  assert.match(info!.message, /40 conversions/);
  // No currencyCode supplied → bare number, never a misleading '$'.
  assert.match(info!.message, /40 conversions, 4000, 400 sessions/);
  assert.ok(!info!.message.includes('$'), 'no hardcoded dollar sign when currency is unknown');
  assert.match(info!.message, /400 sessions/);
});

test('revenue is labelled with the property currency code when known (INR, USD, …)', () => {
  const inr = rankGa4Campaigns({
    rows: [row('diwali', 400, 40, 1250), row('(organic)', 100, 0, 0)],
    totalSessions: 500,
    windowDays: 28,
    currencyCode: 'INR',
  });
  const info = inr.findings.find((f) => f.severity === 'info');
  assert.match(info!.message, /INR 1250/);
  assert.equal(inr.currencyCode, 'INR', 'currency echoed on the report');

  // Non-integer revenue keeps 2 decimals with the currency prefix.
  const usd = rankGa4Campaigns({
    rows: [row('promo', 400, 40, 4000.5)],
    totalSessions: 500,
    windowDays: 28,
    currencyCode: 'USD',
  });
  assert.match(usd.findings.find((f) => f.severity === 'info')!.message, /USD 4000\.50/);
});

test('tagged campaigns AND >=40% untagged → also a LOW untagged finding', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('real', 500, 10, 100),
      row('(organic)', 300, 0, 0),
      row('(direct)', 200, 0, 0), // untagged = 500 → 50% >= 40%
    ],
    totalSessions: 1000,
    windowDays: 28,
  });
  assert.ok(r.taggedCampaigns.length > 0);
  const low = r.findings.find((f) => f.severity === 'low');
  assert.ok(low, 'low untagged finding present');
  assert.equal(low!.category, 'attribution');
  assert.match(low!.message, /untagged/);
  // still has the info best-campaign finding too
  assert.ok(r.findings.some((f) => f.severity === 'info'));
});

test('tagged campaigns with untagged < 40% → NO low untagged finding', () => {
  const r = rankGa4Campaigns({
    rows: [
      row('real', 800, 10, 100),
      row('(organic)', 200, 0, 0), // 20% < 40%
    ],
    totalSessions: 1000,
    windowDays: 28,
  });
  assert.ok(!r.findings.some((f) => f.severity === 'low'), 'no low finding under 40% untagged');
});

test('dateRange is formatted from supplied bounds; summary is a human sentence', () => {
  const r = rankGa4Campaigns({
    rows: [row('real', 500, 5, 0)],
    totalSessions: 500,
    windowDays: 28,
    startDate: '2026-01-01',
    endDate: '2026-01-28',
  });
  assert.equal(r.dateRange, 'Jan 1 – Jan 28, 2026');
  assert.match(r.summary, /Ranked 1 campaign/);
  assert.match(r.summary, /"real"/);
});

test('empty input → sessions metric, no tagged campaigns, medium finding, null best', () => {
  const r = rankGa4Campaigns({ rows: [], totalSessions: 0, windowDays: 28 });
  assert.equal(r.primaryMetric, 'sessions');
  assert.equal(r.taggedCampaigns.length, 0);
  assert.equal(r.bestCampaign, null);
  assert.equal(r.untaggedSessions, 0);
  assert.equal(r.untaggedSharePct, 0);
  assert.equal(r.dateRange, null);
  assert.equal(r.findings[0].severity, 'medium');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
