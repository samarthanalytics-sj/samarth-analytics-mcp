/**
 * The MCP `prompts/list` surface — the "prompts tab" a client shows. Verifies the one guided
 * server-side-setup prompt is registered and its recipe names each ordered piece + resource shape.
 * Pure (no GTM API): registers the prompt on a real McpServer and invokes its callback.
 * Run with: tsx src/__tests__/prompts.test.ts
 */
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerServerSidePrompts } from '../prompts/serverSide.js';
import { registerEcommerceFunnelPrompts } from '../prompts/ecommerceFunnel.js';
import { registerCommandPrompts } from '../prompts/commands.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

console.log('\nMCP prompts:');

const server = new McpServer({ name: 'test', version: '0.0.1' }, { capabilities: { tools: {}, prompts: {} } });
registerServerSidePrompts(server);
registerEcommerceFunnelPrompts(server);
registerCommandPrompts(server);

// The SDK keeps registered prompts in _registeredPrompts, keyed by name (this is what prompts/list reads).
const prompts = (server as unknown as { _registeredPrompts: Record<string, { callback: (a: Record<string, string>) => { messages: Array<{ role: string; content: { type: string; text: string } }> } }> })._registeredPrompts;

check('the server-side setup prompt is registered (appears in the prompts tab)', !!prompts && Object.keys(prompts).includes('setup_server_side_container'));

const res = prompts['setup_server_side_container'].callback({ accountId: '123', containerName: 'ex.com - Server', measurementId: 'G-ABC123', adsConversionId: 'AW-999' });
const msg = res.messages[0];
check('it returns ONE user message', res.messages.length === 1 && msg.role === 'user' && msg.content.type === 'text');

const text = msg.content.text;
// The recipe must cover every ordered step + the exact resource types the MCP create tools need.
for (const needle of [
  'usageContext', // 1 · server container
  'clientName', 'eventName', // 2 · built-ins
  'gaaw_client', // 3 · GA4 client
  'FPID', 'cookieManagement', // 3 · server-managed first-party cookies (reference architecture)
  'gtm_client', 'allowedContainerIds', // 3 · first-party serving of the web container
  '"ed"', '"c"', '"rh"', // 4 · variables (event data / constant / request header)
  'customEvent', '{{_event}}', '{{Client Name}}', // 5 · per-event trigger
  'never URL-encoded', 'ed - page_location', // 5 · exact event names + page-scoped campaign filter
  'sgtmgaaw', // 6 · GA4 server tag
  'taggingServerUrls', 'server_container_url', // 7 · host wiring
]) {
  check(`recipe includes "${needle}"`, text.includes(needle));
}
// Provided args are interpolated.
check('interpolates the GA4 Measurement ID arg', text.includes('G-ABC123'));
check('interpolates the Ads conversion id arg (only when given)', text.includes('AW-999') && text.toLowerCase().includes('sgtmadsct'));
// Omitting the ads arg drops the Ads/Conversion-Linker block.
const noAds = prompts['setup_server_side_container'].callback({}).messages[0].content.text;
check('no Ads conversion id → no server Ads tag block', !noAds.includes('sgtmadsct'));

// ── setup_ecommerce_funnel (web funnel + consent defaults + verify) ────────────
check('the ecommerce-funnel prompt is registered', Object.keys(prompts).includes('setup_ecommerce_funnel'));
const fun = prompts['setup_ecommerce_funnel'].callback({ accountId: '123', containerId: '456', measurementId: 'G-ABC123' });
const funMsg = fun.messages[0];
check('funnel prompt returns ONE user message', fun.messages.length === 1 && funMsg.role === 'user' && funMsg.content.type === 'text');
const funText = funMsg.content.text;
for (const needle of [
  'view_item', 'add_to_cart', 'begin_checkout', 'purchase', // the standard funnel, in the recipe
  'customEvent', '{{_event}}', // per-event trigger shape
  '"gaawe"', 'sendEcommerceData', 'getEcommerceDataFrom', // native ecommerce forwarding (no hand-mapping)
  'ecommerce.value', 'dataLayerVersion', // dlv variable shape
  '2147479572', "gtag('consent', 'default'", 'wait_for_update', 'ad_user_data', // consent defaults on Consent Initialization
  'SKIP any piece that already exists', // idempotent re-runs
  'VERIFY', // ends with the QA checklist
]) {
  check(`funnel recipe includes "${needle}"`, funText.includes(needle));
}
check('funnel recipe interpolates the GA4 Measurement ID', funText.includes('G-ABC123'));
// A custom events arg replaces the standard funnel list.
const custom = prompts['setup_ecommerce_funnel'].callback({ events: 'purchase, generate_lead' }).messages[0].content.text;
check('custom events arg replaces the funnel list', custom.includes('purchase → generate_lead') && !custom.includes('view_cart →'));

// ── command slash-prompts: /audit /report /create-tag /debug /explain ──────────
// Each must register under its exact slash-command name, return one user message, drive a REAL tool,
// and keep the read-only / draft-only guardrail language.
for (const name of ['audit', 'report', 'create-tag', 'debug', 'explain']) {
  check(`the "${name}" slash-command prompt is registered`, Object.keys(prompts).includes(name));
  const r = prompts[name].callback({});
  check(`"${name}" returns ONE user message`, r.messages.length === 1 && r.messages[0].role === 'user' && r.messages[0].content.type === 'text');
}
// /audit → audit_container, read-only.
const auditText = prompts['audit'].callback({ container: 'GTM-ABC123' }).messages[0].content.text;
check('audit prompt calls audit_container', auditText.includes('audit_container'));
check('audit prompt is read-only (no writes)', /read-?only/i.test(auditText) && auditText.includes('GTM-ABC123'));
// audit_container REQUIRES a workspaceId — the recipe must resolve one (adversarial-review fix).
check('audit resolves a workspaceId (audit_container requires all three ids)', auditText.includes('workspaceId') && auditText.includes('workspaces_list'));
// It must NOT claim audit_container detects Consent Mode / security (it does not).
check('audit does not falsely claim consent/security detection', /does NOT check Consent Mode/i.test(auditText));
// /report → ga4_run_report, read-only, honours the dateRange arg.
const reportText = prompts['report'].callback({ property: 'properties/42', dateRange: 'last 7 days' }).messages[0].content.text;
check('report prompt calls ga4_run_report + interpolates args', reportText.includes('ga4_run_report') && reportText.includes('properties/42') && reportText.includes('last 7 days'));
check('report prompt stays read-only', /read-?only/i.test(reportText));
// ga4_run_report takes startDate/endDate, NOT a dateRanges arg (adversarial-review fix).
check('report uses startDate/endDate, not a dateRanges arg', reportText.includes('startDate') && reportText.includes('endDate') && !reportText.includes('with dateRanges'));
// /create-tag → the create recipe, draft-only + confirm=true + write flag.
const ctText = prompts['create-tag'].callback({ description: 'contact form submit' }).messages[0].content.text;
check('create-tag drives tags_create + triggers_create', ctText.includes('tags_create') && ctText.includes('triggers_create'));
// GA4 event params must go via tags_add_ga4_event_parameters (eventSettingsTable), not tags_create (adversarial-review fix).
check('create-tag adds GA4 event params via tags_add_ga4_event_parameters', ctText.includes('tags_add_ga4_event_parameters'));
check('create-tag keeps the write guardrail (draft/confirm/enable flag)', /draft/i.test(ctText) && ctText.includes('confirm=true') && ctText.includes('GTM_MCP_ENABLE_WRITES'));
check('create-tag interpolates the description', ctText.includes('contact form submit'));
// /debug → diagnostic read tools, read-only, names the symptom.
const dbgText = prompts['debug'].callback({ tag: 'Purchase Tag', symptom: 'never fires' }).messages[0].content.text;
check('debug inspects tags/triggers/variables', dbgText.includes('tags_get') && dbgText.includes('triggers_get') && dbgText.includes('variables_'));
check('debug is read-only + carries the symptom + tag', /read-?only/i.test(dbgText) && dbgText.includes('Purchase Tag') && dbgText.includes('never fires'));
// /explain with no topic asks; with a topic, guides concept-vs-resource.
check('explain with no topic asks what to explain', /ask the user/i.test(prompts['explain'].callback({}).messages[0].content.text));
const explText = prompts['explain'].callback({ topic: 'Consent Mode v2' }).messages[0].content.text;
check('explain interpolates the topic + can fetch a resource read-only', explText.includes('Consent Mode v2') && explText.includes('tags_get'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
