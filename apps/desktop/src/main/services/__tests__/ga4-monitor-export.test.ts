import assert from 'node:assert/strict';
import { monitorRunToCsv, monitorRunToHtml } from '../ga4-monitor-export';
import type { Ga4MonitorRun } from '../../../shared/ipc';

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

const run = (over: Partial<Ga4MonitorRun> = {}): Ga4MonitorRun => ({
  at: Date.parse('2026-07-09T14:15:00Z'),
  property: 'properties/353451709',
  propertyLabel: 'Purple Tresor Property - GA4',
  timeZone: 'Asia/Kolkata',
  health: 'critical',
  summary: '2 issues need attention (1 critical, 1 high).',
  checks: [
    { id: 'data_flow', label: 'Data collection', status: 'pass', detail: '86 active users right now · 2,219 sessions yesterday (Jul 8, 2026)' },
    { id: 'reconciliation', label: 'Revenue reconciliation', status: 'fail', detail: 'Campaign and channel revenue do not reconcile: 7 campaigns claim INR 387,580, "paid" shows INR 37,030.' },
    { id: 'consent_signal', label: 'Consent Mode signal', status: 'skip', detail: 'Site probe could not run this sweep.' },
  ],
  alerts: [
    {
      id: 'attribution_mismatch',
      kind: 'attribution_mismatch',
      severity: 'high',
      title: 'Campaign and channel revenue do not reconcile',
      detail: 'Campaign and channel revenue do not reconcile: 7 paid-format campaigns claim INR 387,580, but paid channels show INR 37,030.',
      plain: 'Your ads look about 10x less profitable than they are: campaigns brought in about INR 388,000, but only INR 37,000 of it is credited to paid ads.',
      impact: 'Paid-media budget and ROAS decisions made on revenue attributed to the wrong channel',
      actions: ['This is a tracking fix your analytics person or agency can make in about an hour - forward them this alert.'],
      recommendation: 'Verify Google Ads auto-tagging (gclid) and the GA4-Google Ads link, add utm_medium=cpc/paid to ad links.',
    },
  ],
  newAlertIds: [],
  slackSent: 0,
  slackError: null,
  ...over,
});

console.log('\nGA4 monitor export:');

test('CSV: metadata preamble, one row per alert and per check, quotes escaped', () => {
  const csv = monitorRunToCsv(run());
  assert.ok(csv.startsWith('GA4 monitoring report,Purple Tresor Property - GA4\r\n'), 'title row');
  assert.ok(csv.includes('Property ID,353451709'), 'bare numeric id');
  assert.ok(csv.includes('Reporting timezone,Asia/Kolkata'), 'timezone stated');
  assert.ok(csv.includes('Type,Status,Name,What we found,Technical detail,Recommendation'), 'header row');
  assert.ok(/Alert,High,Campaign and channel revenue do not reconcile,"Your ads look about 10x/.test(csv), 'alert row leads with the plain voice');
  assert.ok(csv.includes('""paid"" shows INR 37,030'), 'embedded quotes doubled per RFC 4180');
  assert.ok(/Check,Pass,Data collection/.test(csv) && /Check,Failing,Revenue reconciliation/.test(csv) && /Check,Not checked,Consent Mode signal/.test(csv), 'check rows with readable statuses');
  const detailCell = '"Campaign and channel revenue do not reconcile: 7 paid-format campaigns claim INR 387,580';
  assert.ok(csv.includes(detailCell), 'technical detail rides in its own column (comma-quoted)');
});

test('CSV: a healthy run still exports (no alerts, checks only)', () => {
  const csv = monitorRunToCsv(run({ health: 'healthy', summary: 'Everything looks healthy.', alerts: [] }));
  assert.ok(csv.includes('Health,Healthy'));
  assert.ok(!csv.includes('Alert,'), 'no alert rows');
  assert.ok(csv.includes('Check,Pass,Data collection'), 'checks still listed');
});

test('HTML: self-contained printable doc - plain lead, technical underneath, full check table, escaped', () => {
  const html = monitorRunToHtml(run({ propertyLabel: 'Acme <script>alert(1)</script>' }));
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'full document');
  assert.ok(!html.includes('<script>'), 'HTML injection escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped, not dropped');
  assert.ok(html.includes('Your ads look about 10x less profitable'), 'alert leads with the plain consequence');
  assert.ok(html.includes('Verify Google Ads auto-tagging'), 'technical fix present for whoever fixes it');
  assert.ok(html.includes('For whoever fixes it'), 'fixer section labeled');
  assert.ok(html.includes('Revenue reconciliation') && html.includes('Consent Mode signal'), 'every check row rendered');
  assert.ok(html.includes('reporting timezone Asia/Kolkata'), 'timezone stated');
  assert.ok(!/[—–]/.test(html), 'no em/en dashes in generated report output');
});

test('HTML: healthy run says none-open honestly instead of an empty section', () => {
  const html = monitorRunToHtml(run({ health: 'healthy', summary: 'Everything looks healthy.', alerts: [] }));
  assert.ok(html.includes('None - every check that ran came back clean.'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
