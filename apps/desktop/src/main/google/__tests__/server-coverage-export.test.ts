import assert from 'node:assert/strict';
import { serverCoverageToCsv, serverCoverageToHtml } from '../server-coverage-export';
import type { ServerCoverageView } from '../../../shared/ipc';

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

const view = (over: Partial<ServerCoverageView> = {}): ServerCoverageView => ({
  rows: [
    { platform: 'ga4', event: 'purchase', webTag: 'GA4 - Purchase', status: 'covered', by: 'client + relay "GA4 Relay"' },
    { platform: 'meta', event: 'generate_lead, "quoted"', webTag: 'Meta - Lead', status: 'missing', recommendation: 'No server tag handles "generate_lead" for meta. Ask the chat: create_meta_capi_server_tag for this event.' },
    { platform: 'pinterest', event: 'Pinterest Pixel', webTag: 'Pinterest Pixel', status: 'not_matchable', recommendation: 'This pixel fires on a non-custom-event trigger - verify it manually.' },
  ],
  unusedServer: [{ tag: 'Meta CAPI - Old', platform: 'meta', event: 'old_event' }],
  ga4: { client: true, relay: true, webMeasurementIds: ['G-ABC1234'], serverMeasurementIds: ['G-OTHER999'], idsMatch: false },
  webWiring: { status: 'not_wired', webUrl: '', serverUrls: ['https://sgtm.example.com'] },
  summary: { webEvents: 3, covered: 1, missing: 1, notMatchable: 1, coveragePct: 50 },
  score: { configuration: 90, coverage: 50, overall: 70 },
  ...over,
});

console.log('\nserver-coverage-export:');

test('CSV: scores, warnings, one row per event + unused server rows, RFC-4180 quoting', () => {
  const csv = serverCoverageToCsv(view(), { webName: 'Web, Site', serverName: 'Server' });
  assert.ok(csv.startsWith('Web <-> Server coverage,"Web, Site vs Server"'), 'comma-bearing title quoted');
  assert.ok(csv.includes('Overall score,70') && csv.includes('Coverage,50%'));
  assert.ok(/Warning,"?The web Google tag has NO server_container_url/.test(csv), 'wiring warning');
  assert.ok(/Warning,.*Measurement ID mismatch/.test(csv), 'ids warning');
  assert.ok(/purchase,GA4,GA4 - Purchase,Covered/.test(csv));
  assert.ok(csv.includes('"generate_lead, ""quoted"""'), 'embedded comma + quotes escaped');
  assert.ok(/old_event,META,,Server-only/.test(csv), 'unused server row');
  assert.ok(!/[—–]/.test(csv), 'no em/en dashes');
});

test('HTML: printable doc with scores, colored statuses, warnings, escaped content, no dashes', () => {
  const html = serverCoverageToHtml(view({ rows: [{ platform: 'ga4', event: '<script>x</script>', webTag: 'T', status: 'covered', by: 'relay' }] }), { webName: 'Web <b>', serverName: 'Srv' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<script>x'), 'event name escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped not dropped');
  assert.ok(html.includes('Web &lt;b&gt;'), 'meta names escaped');
  assert.ok(html.includes('#15803d') && html.includes('Covered'), 'covered rendered green');
  assert.ok(html.includes('NO server_container_url'), 'wiring warning present');
  assert.ok(!/[—–]/.test(html), 'no em/en dashes');
});

test('coverage n/a renders honestly in both formats', () => {
  const v = view({ score: { configuration: 100, coverage: null, overall: 100 }, summary: { webEvents: 1, covered: 0, missing: 0, notMatchable: 1, coveragePct: null } });
  assert.ok(serverCoverageToCsv(v, { webName: 'W', serverName: 'S' }).includes('Coverage,n/a (nothing matchable)'));
  assert.ok(serverCoverageToHtml(v, { webName: 'W', serverName: 'S' }).includes('<b>n/a</b>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
