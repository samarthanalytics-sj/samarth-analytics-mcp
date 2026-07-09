import assert from 'node:assert/strict';
import { buildSlackPayload, buildSlackTestPayload, sendSlackWebhook, isValidSlackWebhook, type FetchLike } from '../slack-notify';
import type { Ga4MonitorResult, Ga4MonitorAlert } from '../../google/ga4-monitor';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) done(); });
}
let pending = 0;
const wrap = (name: string, fn: () => void | Promise<void>): void => { pending++; test(name, fn); };
function done(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const alert = (over: Partial<Ga4MonitorAlert> = {}): Ga4MonitorAlert => ({ id: 'no_data', kind: 'no_data', severity: 'critical', title: 'No data is being received', detail: '0 active users and 0 sessions yesterday.', recommendation: 'Check the tag.', ...over });
const result = (over: Partial<Ga4MonitorResult> = {}): Ga4MonitorResult => ({ property: 'properties/123', health: 'critical', summary: '1 issue needs attention.', checks: [], alerts: [alert()], ...over });

console.log('\nSlack notify:');

wrap('isValidSlackWebhook accepts only Slack Incoming Webhook URLs', () => {
  assert.ok(isValidSlackWebhook('https://hooks.slack.com/services/T000/B000/xyzABC123'));
  assert.ok(!isValidSlackWebhook('https://example.com/hook'));
  assert.ok(!isValidSlackWebhook('http://hooks.slack.com/services/x'), 'must be https');
  assert.ok(!isValidSlackWebhook('  '), 'empty rejected');
});

wrap('buildSlackPayload renders the labeled alert template (Severity/Property/Issue/Summary/Actions)', () => {
  const p = buildSlackPayload('Acme (123)', result(), result().alerts);
  assert.ok(p.text.includes('Acme (123)') && p.text.includes('No data is being received'), 'fallback text summarises');
  const types = (p.blocks as Array<{ type: string }>).map((b) => b.type);
  assert.ok(types[0] === 'header', 'starts with a header block');
  const json = JSON.stringify(p.blocks);
  assert.ok(json.includes('GA4 Monitoring Alert'), 'header title');
  assert.ok(json.includes('*Severity:* Critical'), 'worst severity stated up top');
  assert.ok(json.includes('*Property:* Acme (123)') && json.includes('*Property ID:* 123'), 'property + bare numeric id');
  assert.ok(json.includes('*Issue*') && json.includes('*Summary*') && json.includes('*Recommended Actions*'), 'labeled sections');
  assert.ok(json.includes('\u2022 Check the tag.'), 'recommendation falls back to a single action bullet');
  assert.ok(!json.includes('*Impact*'), 'no Impact section when the alert has none');
});

wrap('structured alert fields render as Summary metric lines, Impact, and curated action bullets', () => {
  const a = alert({
    kind: 'conversion_break',
    title: 'Traffic changed but conversions did not keep pace',
    summaryLines: ['\u{1F4C8} Sessions: +344% (10,158 \u2192 45,140)', '\u{1F4CA} Key Events: +167% (300 \u2192 800)', '\u{1F4B0} Revenue: +61%'],
    impact: 'Revenue & ROAS unreliable today; campaign spend decisions at risk.',
    actions: ['Verify Purchase and Key Event tracking in GA4 DebugView/Realtime', 'Check for duplicate event firing'],
  });
  const p = buildSlackPayload('Purple Tresor Property - GA4', result({ alerts: [a], property: 'properties/353451709' }), [a]);
  const json = JSON.stringify(p.blocks);
  assert.ok(json.includes('Sessions: +344%'), 'metric summary lines used instead of prose');
  assert.ok(!json.includes('0 active users'), 'prose detail not duplicated when structured lines exist');
  assert.ok(json.includes('*Impact*') && json.includes('ROAS unreliable'), 'impact section rendered');
  assert.ok(json.includes('\u2022 Verify Purchase and Key Event tracking'), 'curated bullets rendered');
  assert.ok(json.includes('*Property ID:* 353451709'), 'numeric property id');
});

wrap('buildSlackTestPayload names the property and reads as a connection confirmation', () => {
  const p = buildSlackTestPayload('Acme (123)');
  assert.ok(p.text.includes('Acme (123)') && /connected/i.test(p.text), 'fallback text confirms the connection');
  assert.ok(JSON.stringify(p.blocks).includes('Acme (123)'), 'property named in the message');
});

wrap('buildSlackPayload caps at 10 alert sections and notes the remainder', () => {
  const many = Array.from({ length: 14 }, (_, i) => alert({ id: `k${i}`, title: `Issue ${i}` }));
  const p = buildSlackPayload('Acme', result({ alerts: many }), many);
  assert.ok(JSON.stringify(p.blocks).includes('and 4 more issue(s)'), 'overflow note present');
});

wrap('sendSlackWebhook posts JSON and reports ok on 200', async () => {
  const captured: { body: string } = { body: '' };
  const fetchImpl: FetchLike = async (_url, init) => { captured.body = init.body; return { ok: true, status: 200, text: async () => 'ok' }; };
  const r = await sendSlackWebhook('https://hooks.slack.com/services/T/B/x', buildSlackPayload('Acme', result(), result().alerts), { fetchImpl });
  assert.ok(r.ok && r.status === 200, JSON.stringify(r));
  assert.ok(JSON.parse(captured.body).blocks, 'posted a JSON body with blocks');
});

wrap('sendSlackWebhook rejects a non-Slack URL without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, text: async () => '' }; };
  const r = await sendSlackWebhook('https://evil.example/hook', buildSlackPayload('A', result(), []), { fetchImpl });
  assert.ok(!r.ok && !called, 'invalid URL short-circuits');
});

wrap('sendSlackWebhook surfaces a non-2xx as a structured error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'no_service' });
  const r = await sendSlackWebhook('https://hooks.slack.com/services/T/B/x', buildSlackPayload('A', result(), []), { fetchImpl });
  assert.ok(!r.ok && r.status === 404 && /404/.test(r.error ?? ''), JSON.stringify(r));
});
