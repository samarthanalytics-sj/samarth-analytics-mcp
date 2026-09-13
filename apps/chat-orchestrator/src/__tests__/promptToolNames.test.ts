/**
 * Every tool the system prompt names must be a tool this server actually registers.
 *
 * This is the guard for a failure that has now happened more than once in different shapes: the
 * model is told about a tool it cannot see, and then either announces the capability is missing and
 * writes out manual GTM steps for the user to follow, or calls the name and gets an unknown-tool
 * error. Both cost a round trip; the first costs the whole request.
 *
 * It is easy to reintroduce, because the domain guidance is shared verbatim with the desktop
 * assistant, whose registry is different. GTM_TRIGGER_VARIABLE_REFERENCE alone names seven tools,
 * six of which do not exist here and are rewritten by retargetToolNames.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStaticSystem, retargetToolNames } from '../prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(path.join(here, 'real-tool-inventory.json'), 'utf8')) as { n: string }[];
const REAL = new Set(RAW.map((t) => t.n));

/**
 * Names in the prompt that are not MCP tools: the orchestrator's own, and ordinary snake_case
 * prose. GA4 event names are indistinguishable from tool names by shape, which is why this is a
 * list rather than a cleverer pattern.
 *
 * Adding an example event to the prompt therefore means adding a line here. That maintenance cost
 * is deliberate: the alternative is a narrower scan, and a narrower scan is exactly how a
 * cross-registry tool name reaches the model without anyone noticing.
 */
const NOT_TOOLS = new Set([
  'enable_tool_group',
  'remember_memory',
  'forget_memory',
  // The site scanner. Orchestrator-owned like the three above: it drives the web-audit MCP, not the
  // GTM one, so it is correctly absent from that server's inventory.
  'site_scan_triggers',
  'site_pages_list',
  // GA4 event names and dataLayer keys that appear in the guidance as examples.
  'add_to_cart', 'view_item', 'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info',
  'generate_lead', 'sign_up', 'select_item', 'select_promotion', 'view_promotion', 'view_item_list',
  'remove_from_cart', 'purchase', 'search', 'file_download', 'form_start', 'form_submit',
  'page_view', 'user_engagement', 'session_start', 'first_visit', 'scroll', 'video_start',
  'item_list_id', 'transaction_id', 'search_term', 'form_id', 'form_name', 'click_text',
  'phone_click', 'email_click', 'custom_event', 'link_click', 'all_clicks', 'dom_ready',
  'window_loaded', 'history_change', 'scroll_depth', 'element_visibility', 'youtube_video',
  'js_error', 'event_data', 'request_header', 'data_layer', 'first_party', 'server_side',
  // Worked examples of custom event names in the guidance, not tools.
  'book_demo_click', 'request_quote_click', 'contact_sales_click', 'get_started_click',
  'add_to_cart_click',
]);

/** snake_case tokens with at least two underscores: the shape a tool name takes here. */
function toolLikeNames(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g) ?? [])];
}

const SYSTEM = (product: 'gtm' | 'ga4') =>
  buildStaticSystem({
    product,
    canWrite: true,
    mcpInstructions: '',
    integrations: [],
    toolGroupNotice: '',
    memoryNotice: '',
    canRemember: true,
    // On, so the scan guidance is actually inside the text this scan walks. Left off, the block
    // would be exempt from the very check it most needs: it names tools by hand.
    canScanSite: true,
  });

void test('the GTM system prompt names no tool this server lacks', () => {
  const unknown = toolLikeNames(SYSTEM('gtm')).filter((n) => !REAL.has(n) && !NOT_TOOLS.has(n));
  assert.deepEqual(
    unknown,
    [],
    `the prompt tells the model to call tools that do not exist: ${unknown.join(', ')}`,
  );
});

void test('the GA4 system prompt names no tool this server lacks', () => {
  const unknown = toolLikeNames(SYSTEM('ga4')).filter((n) => !REAL.has(n) && !NOT_TOOLS.has(n));
  assert.deepEqual(unknown, [], `unknown tools in the GA4 prompt: ${unknown.join(', ')}`);
});

void test('the trigger and variable reference actually reaches the GTM prompt', () => {
  // The whole point of step 3. Without these sentences the model has no basis for choosing a
  // Custom JavaScript variable over a Data Layer one, and it chose wrong.
  const p = SYSTEM('gtm');
  assert.match(p, /Custom JavaScript/, 'the variable-kind guidance must be present');
  assert.match(p, /Just Links/, 'the trigger guidance must be present');
  assert.match(p, /mailto/i, 'the link-click case that was got wrong must be named');
});

void test('it is NOT sent to a GA4 chat, which has no container to build in', () => {
  assert.equal(/Just Links \/ link_click/.test(SYSTEM('ga4')), false);
});

void test('the scan guidance is present when the scanner is, and absent when it is not', () => {
  // Naming a tool the deployment does not have is the exact failure this whole file guards, and a
  // deployment with no browser has no scanner. So the block is conditional, and both halves matter.
  assert.match(SYSTEM('gtm'), /site_scan_triggers/);
  const noScanner = buildStaticSystem({
    product: 'gtm',
    canWrite: true,
    mcpInstructions: '',
    canScanSite: false,
  });
  assert.equal(/site_scan_triggers/.test(noScanner), false);
  assert.equal(/site_pages_list/.test(noScanner), false);
});

void test('a GA4 chat is not told to scan a website', () => {
  // It has no container to build a trigger in, so the pages would be read for nothing.
  assert.equal(/site_scan_triggers/.test(SYSTEM('ga4')), false);
});

void test('retargeting rewrites the desktop names and leaves the shared ones alone', () => {
  const out = retargetToolNames(
    'use create_gtm_trigger then create_gtm_tag, or create_gtm_tag_with_trigger; ' +
      'call enable_gtm_builtin_variables; create_gtm_tracking_tag stays.',
  );
  assert.match(out, /triggers_create/);
  assert.match(out, /tags_create/);
  assert.match(out, /built_in_variables_enable/);
  assert.match(out, /create_gtm_tracking_tag/, 'a tool that exists on BOTH sides must survive');
  assert.equal(/create_gtm_trigger\b/.test(out), false);
  assert.equal(/create_gtm_tag_with_trigger/.test(out), false);
});

void test('a longer name is not half-rewritten by a shorter one', () => {
  // create_gtm_tag is a prefix of create_gtm_tag_with_trigger. Applied in the wrong order this
  // produces "tags_create_with_trigger", a name that exists nowhere.
  const out = retargetToolNames('create_gtm_tag_with_trigger');
  assert.equal(out, 'create_gtm_tracking_tag');
  assert.equal(/tags_create_with_trigger/.test(out), false);
});
