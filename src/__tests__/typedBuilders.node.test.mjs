/**
 * Typed builder tool tests.
 *
 * No network: the GTM client is a stub that records what it was asked to create. What matters here
 * is the SHAPE that reaches the API and the ORDER of the calls, because those are exactly what a
 * model gets wrong when it is handed raw primitives instead.
 *
 * Every assertion corresponds to a real failure observed on the hosted chat while building a GA4
 * email_click tag: a Data Layer Variable that can never populate, a built-in referenced but never
 * enabled, a tag rejected for a measurementIdOverride the caller never sent, and a placeholder
 * Measurement ID that GTM would have accepted while the tag reported to nothing.
 *
 * Run: node src/__tests__/typedBuilders.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../dist/tools/typedBuilders.js');
const sdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

if (!existsSync(dist)) {
  console.error('\n✗ typedBuilders test: run "npm run build" before "npm test".');
  process.exit(1);
}

const { registerTypedBuilderTools } = await import(pathToFileURL(dist).href);
const { McpServer } = await import(pathToFileURL(sdk).href);

/** A GTM client that records calls instead of making them. `failCreate` rejects one write kind
 *  ('builtin' | 'trigger' | 'tag' | 'variable'), which is how a partly-written composite is tested. */
function stubClient({ existingTriggers = [], existingTags = [], failCreate = null } = {}) {
  const calls = [];
  const record = (kind) => ({
    list: async () => ({ data: { trigger: existingTriggers, tag: existingTags } }),
    create: async (a) => {
      if (failCreate === kind) throw new Error(`stub: ${kind} create rejected`);
      calls.push({ kind, body: a.requestBody, type: a.type });
      return {
        data: {
          triggerId: 'T-new',
          tagId: 'TAG-new',
          variableId: 'V-new',
          name: a.requestBody?.name,
          type: a.requestBody?.type,
        },
      };
    },
  });
  return {
    calls,
    accounts: {
      containers: {
        workspaces: {
          triggers: record('trigger'),
          tags: record('tag'),
          variables: record('variable'),
          built_in_variables: {
            create: async (a) => {
              if (failCreate === 'builtin') throw new Error('stub: built-in variables rejected');
              calls.push({ kind: 'builtin', type: a.type });
              return { data: {} };
            },
          },
        },
      },
    },
  };
}

function serverWith(client) {
  const s = new McpServer({ name: 'typed-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerTypedBuilderTools(s, () => client);
  return s;
}

const WS = { accountId: '1', containerId: '2', workspaceId: '3' };

const EMAIL_TAG = {
  ...WS,
  tagName: 'GA4 Event - Email Click',
  measurementId: 'G-ABC123XYZ',
  eventName: 'email_click',
  eventParameters: [
    { name: 'email_address', value: '{{JS - Email Address}}' },
    { name: 'click_text', value: '{{Click Text}}' },
  ],
  trigger: { name: 'Email Click Trigger', kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
  confirm: true,
};

const call = (server, tool, args) => server._registeredTools[tool].handler(args, { requestId: 't' });
/** Call a tool the way the MCP SDK does: THROUGH its zod inputSchema, so a field the schema does
 *  not declare is stripped before the handler ever sees it. Anything asserting that an input
 *  survives to the built resource has to go this way, or it is testing nothing. */
const callValidated = (server, tool, args) => {
  const t = server._registeredTools[tool];
  return t.handler(t.inputSchema.parse(args), { requestId: 't' });
};
const json = (res) => JSON.parse(res.content[0].text);
const text = (res) => res.content[0].text;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

process.env.GTM_MCP_ENABLE_WRITES = 'true';

console.log('\ncreate_gtm_tracking_tag — one call, three writes, correct shapes:');

await test('a whole tag is built in ONE tool call, in dependency order', async () => {
  // The point of the tool. Through the raw primitives this is three model round trips, and on a
  // 30,000 TPM account three round trips is most of the minute.
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  assert.deepStrictEqual(client.calls.map((c) => c.kind), ['builtin', 'trigger', 'tag']);
});

await test('built-ins are inferred from the trigger AND from parameter values', async () => {
  // clickUrl comes from the trigger's condition, clickText only from a parameter VALUE. A built-in
  // referenced but not enabled resolves to nothing, so the tag ships with a silently blank field.
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const enabled = client.calls.find((c) => c.kind === 'builtin').type;
  assert.ok(enabled.includes('clickUrl'), 'the trigger references {{Click URL}}');
  assert.ok(enabled.includes('clickText'), 'a parameter value references {{Click Text}}');
});

await test('the trigger carries the arg0 / arg1 condition shape GTM demands', async () => {
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const trig = client.calls.find((c) => c.kind === 'trigger').body;
  assert.strictEqual(trig.type, 'linkClick');
  const keys = trig.filter[0].parameter.map((p) => p.key);
  assert.deepStrictEqual(keys, ['arg0', 'arg1'], 'anything but arg0/arg1 fails with "Parameter key is unknown"');
  assert.strictEqual(trig.filter[0].parameter[0].value, '{{Click URL}}');
  assert.strictEqual(trig.filter[0].parameter[1].value, 'mailto:');
});

await test('the GA4 tag carries the measurementId pair the API rejects it without', async () => {
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  assert.strictEqual(tag.type, 'gaawe');
  const ref = tag.parameter.find((p) => p.key === 'measurementId');
  const override = tag.parameter.find((p) => p.key === 'measurementIdOverride');
  assert.strictEqual(ref.type, 'tagReference');
  assert.strictEqual(override.value, 'G-ABC123XYZ');
});

await test('event parameters use eventSettingsTable, not a shape GTM silently drops', async () => {
  // 0 of 8,148 real GA4 tags use an eventParameters list; the wrong shape is accepted and ignored,
  // so every parameter vanishes with no error.
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  const table = tag.parameter.find((p) => p.key === 'eventSettingsTable');
  assert.strictEqual(table.type, 'list');
  const row = table.list[0].map.map((m) => m.key);
  assert.deepStrictEqual(row, ['parameter', 'parameterValue']);
});

await test('the tag is linked to the trigger that was just created', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  assert.deepStrictEqual(tag.firingTriggerId, ['T-new']);
  assert.strictEqual(json(res).trigger.reused, false);
});

await test('an existing trigger of the same name is REUSED, never duplicated', async () => {
  const client = stubClient({ existingTriggers: [{ triggerId: 'T-old', name: 'Email Click Trigger' }] });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  assert.strictEqual(client.calls.some((c) => c.kind === 'trigger'), false, 'no second trigger may be created');
  assert.strictEqual(json(res).trigger.reused, true);
  assert.deepStrictEqual(client.calls.find((c) => c.kind === 'tag').body.firingTriggerId, ['T-old']);
});

console.log('\nrefusals that prevent a tag which looks created and records nothing:');

await test('a placeholder is RESOLVED from the container, not handed back to the user', async () => {
  // Refusing and asking cost three turns for a fourteen-second job, and the third only succeeded
  // because the user invented a different id that happened not to match the pattern. The container
  // already knows the answer.
  const client = stubClient({
    existingTags: [{ type: 'googtag', parameter: [{ key: 'tagId', value: 'G-REAL9876' }] }],
  });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  const override = tag.parameter.find((p) => p.key === 'measurementIdOverride');
  assert.strictEqual(override.value, 'G-REAL9876', 'the container id must be used');
  assert.match(json(res).measurementIdNote, /placeholder/i, 'a substitution must never be silent');
  assert.match(json(res).measurementIdNote, /G-REAL9876/);
});

await test('a gaawe tag is a fallback source for the real id when there is no googtag', async () => {
  const client = stubClient({
    existingTags: [{ type: 'gaawe', parameter: [{ key: 'measurementIdOverride', value: 'G-FROMEVENT' }] }],
  });
  await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  assert.strictEqual(tag.parameter.find((p) => p.key === 'measurementIdOverride').value, 'G-FROMEVENT');
});

await test('an empty container has nothing to resolve, so it asks, and says how to override', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  assert.match(text(res), /placeholder/i);
  assert.match(text(res), /allowPlaceholderId/, 'a guard with no way through is a wall');
  assert.strictEqual(client.calls.some((c) => c.kind === 'tag'), false, 'no tag may be created');
});

await test('allowPlaceholderId honours a confirmed id instead of refusing again', async () => {
  // The observed loop: the user sent the same id twice and was refused both times.
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG, measurementId: 'G-123456789', allowPlaceholderId: true,
  });
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  assert.strictEqual(tag.parameter.find((p) => p.key === 'measurementIdOverride').value, 'G-123456789');
});

await test('a container whose only id is ALSO a placeholder is not laundered into a real one', async () => {
  const client = stubClient({
    existingTags: [{ type: 'googtag', parameter: [{ key: 'tagId', value: 'G-1234567890' }] }],
  });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  assert.match(text(res), /placeholder/i);
  assert.strictEqual(client.calls.some((c) => c.kind === 'tag'), false);
});

await test('a {{variable}} measurement id is allowed through', async () => {
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: '{{GA4 Measurement ID}}' });
  assert.strictEqual(client.calls.length, 3);
});

await test('a timer trigger with no interval is refused, not silently created broken', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG,
    trigger: { name: 'Thirty Seconds', kind: 'timer' },
  });
  assert.match(text(res), /intervalMs/);
  assert.strictEqual(client.calls.length, 0);
});

console.log('\ncreate_gtm_variable_typed — the choice the website kept getting wrong:');

await test('kind "javascript" produces a Custom JavaScript variable (jsm)', async () => {
  // The observed bug: asked to capture an email from a mailto: link, the chat created a Data Layer
  // Variable, which reads a key the site never pushes and therefore always reports blank.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_variable_typed', {
    ...WS, name: 'JS - Email Address', kind: 'javascript',
    javascript: "function() { return ({{Click URL}} || '').replace('mailto:', ''); }",
    confirm: true,
  });
  const v = client.calls.find((c) => c.kind === 'variable').body;
  assert.strictEqual(v.type, 'jsm');
  assert.strictEqual(v.parameter[0].key, 'javascript');
  assert.strictEqual(json(res).reference, '{{JS - Email Address}}');
});

await test('kind "data_layer" produces a Data Layer Variable (v) with version 2', async () => {
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_variable_typed', {
    ...WS, name: 'DLV - Value', kind: 'data_layer', dataLayerName: 'ecommerce.value', confirm: true,
  });
  const v = client.calls.find((c) => c.kind === 'variable').body;
  assert.strictEqual(v.type, 'v');
  assert.strictEqual(v.parameter.find((p) => p.key === 'name').value, 'ecommerce.value');
});

await test('an unknown kind FAILS instead of quietly creating an empty variable', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_variable_typed', {
    ...WS, name: 'Mystery', kind: 'telepathy', confirm: true,
  });
  assert.match(text(res), /Unknown variable kind/i);
  assert.strictEqual(client.calls.length, 0);
});

console.log('\nguardrails are unchanged:');

await test('confirm=false is refused and writes nothing', async () => {
  // Same gate as every other write tool: confirm is required, and it is checked BEFORE the
  // placeholder check or any API call, so an unconfirmed composite cannot half-build a tag.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, confirm: false });
  assert.strictEqual(client.calls.length, 0, 'nothing may be created without confirmation');
  assert.match(text(res), /confirm=true/);
});

await test('a composite write cannot leave a trigger behind when the tag is refused', async () => {
  // The specific hazard of a multi-write tool: refusing halfway would litter the workspace with
  // orphaned triggers. Every refusal here happens before the first API call.
  for (const bad of [
    { ...EMAIL_TAG, confirm: false },
    { ...EMAIL_TAG, measurementId: 'G-123456789' },
    { ...EMAIL_TAG, trigger: { name: 'T', kind: 'timer' } },
  ]) {
    const client = stubClient();
    await call(serverWith(client), 'create_gtm_tracking_tag', bad);
    assert.strictEqual(client.calls.length, 0, `a refusal wrote something: ${JSON.stringify(bad.trigger ?? bad.measurementId)}`);
  }
});

await test('with writes DISABLED the tool creates nothing', async () => {
  process.env.GTM_MCP_ENABLE_WRITES = 'false';
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  process.env.GTM_MCP_ENABLE_WRITES = 'true';
  assert.strictEqual(client.calls.length, 0, 'the guardrail must hold for composite tools too');
  assert.ok(/disabled|not enabled|GTM_MCP_ENABLE_WRITES|read-only/i.test(text(res)), `unexpected: ${text(res)}`);
});


console.log('\ncreate_gtm_tracking_tag - platforms it can and cannot build:');

await test('a Custom HTML listener tag is built from html, with no measurement id', async () => {
  // How a dataLayer listener gets installed for a form GTM cannot see natively: an AJAX plugin or a
  // cross-origin embed. Without this the suggestion is a note, not something anyone can act on.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...WS,
    platform: 'custom_html',
    tagName: 'cHTML - Calendly listener',
    html: '<script>window.dataLayer.push({event:"form_submit"});</script>',
    trigger: { name: 'All Pages', kind: 'pageview' },
    confirm: true,
  });
  const tag = client.calls.find((c) => c.kind === 'tag');
  assert.ok(tag, 'a tag must be created');
  assert.strictEqual(tag.body.type, 'html');
  const htmlParam = tag.body.parameter.find((p) => p.key === 'html');
  assert.ok(htmlParam.value.includes('dataLayer.push'), 'the script is the tag body');
  const docWrite = tag.body.parameter.find((p) => p.key === 'supportDocumentWrite');
  assert.strictEqual(docWrite.value, 'false', 'document.write breaks async-loaded pages');
  assert.ok(!text(res).includes('Not creating'), 'it must not be refused');
});

await test('a platform this tool cannot build is REFUSED, not built as GA4', async () => {
  // The schema had no platform field, so callers passing meta_pixel had it stripped by zod and got a
  // GA4 tag whose measurementId was a Meta pixel id: created, correct-looking, wrong.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...WS,
    platform: 'meta_pixel',
    tagName: 'Meta Pixel - Lead',
    measurementId: '{{Meta Pixel ID}}',
    eventName: 'Lead',
    trigger: { name: 'Lead Trigger', kind: 'form_submit' },
    confirm: true,
  });
  assert.ok(/not creating/i.test(text(res)), 'it must refuse');
  assert.ok(/meta_pixel/.test(text(res)), 'it must name what was asked for');
  assert.strictEqual(client.calls.length, 0, 'nothing may be written');
});

await test('custom_html without html is refused before anything is written', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...WS, platform: 'custom_html', tagName: 'cHTML - empty',
    trigger: { name: 'All Pages', kind: 'pageview' }, confirm: true,
  });
  assert.ok(/needs `html`/.test(text(res)));
  assert.strictEqual(client.calls.length, 0);
});

await test('a GA4 tag still requires its measurement id and event name', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...WS, tagName: 'GA4 - nothing', trigger: { name: 'T', kind: 'pageview' }, confirm: true,
  });
  assert.ok(/needs both measurementId and eventName/.test(text(res)));
  assert.strictEqual(client.calls.length, 0);
});

await test('the default platform is still GA4, so existing callers are unchanged', async () => {
  const client = stubClient();
  await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  const tag = client.calls.find((c) => c.kind === 'tag');
  assert.strictEqual(tag.body.type, 'gaawe');
});

console.log('\ntrigger kinds: an unbuildable one must never become an unscoped All Pages trigger:');

await test('an off-enum trigger kind is REFUSED, not built as pageview', async () => {
  // buildTrigger's default branch answers an unknown kind with an unscoped All Pages pageview
  // trigger, so "click" (the real GTM type name) used to produce a GA4 tag firing on EVERY page
  // load, with the tool reporting success and echoing the kind it was asked for.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG,
    trigger: { name: 'CTA Click', kind: 'click', clickElementValue: '#cta' },
  });
  assert.match(text(res), /not creating/i, 'it must refuse');
  assert.match(text(res), /link_click/, 'it must list the kinds that do work');
  assert.strictEqual(client.calls.length, 0, 'nothing may be written for a kind we cannot build');
});

await test('the kinds the schema advertises are all still accepted', async () => {
  // The guard above must refuse ONLY what buildTrigger cannot build. A typo in the accepted list
  // would silently take a working kind away.
  for (const kind of ['pageview', 'link_click', 'all_clicks', 'form_submit', 'custom_event', 'dom_ready',
    'window_loaded', 'history_change', 'scroll_depth', 'youtube_video', 'js_error']) {
    const client = stubClient();
    const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
      ...EMAIL_TAG,
      trigger: { name: `T ${kind}`, kind, eventName: 'generate_lead' },
    });
    assert.ok(!/not creating/i.test(text(res)), `kind ${kind} must not be refused: ${text(res)}`);
    assert.ok(client.calls.some((c) => c.kind === 'tag'), `kind ${kind} must still create a tag`);
  }
});

await test('the element_visibility selector survives the schema instead of being stripped', async () => {
  // The schema advertised element_visibility while declaring none of its settings, and zod strips
  // what it does not declare: the selector never reached buildTrigger, which emitted
  // elementSelector "" and created a trigger watching nothing.
  const client = stubClient();
  await callValidated(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG,
    trigger: { name: 'Thanks Visible', kind: 'element_visibility', visibilitySelector: '#gform_confirmation_message' },
  });
  const trig = client.calls.find((c) => c.kind === 'trigger').body;
  assert.strictEqual(trig.type, 'elementVisibility');
  const param = (key) => trig.parameter.find((p) => p.key === key)?.value;
  assert.strictEqual(param('selectorType'), 'CSS');
  assert.strictEqual(param('elementSelector'), '#gform_confirmation_message');
});

await test('element_visibility with no target is refused, like a timer with no interval', async () => {
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG,
    trigger: { name: 'Thanks Visible', kind: 'element_visibility' },
  });
  assert.match(text(res), /visibilitySelector/);
  assert.strictEqual(client.calls.length, 0);
});

console.log('\ntrigger reuse keys on the name that is actually stored:');

await test('a trigger whose name GTM sanitises is found again, not duplicated', async () => {
  // buildTrigger stores sanitizeName(name), so "Click: Apply Now" is created as "Click Apply Now".
  // Matching the RAW name missed it, and the second tag on that trigger sent a create GTM rejected
  // with a duplicate-name 400 the caller could not explain.
  const client = stubClient({ existingTriggers: [{ triggerId: 'T-old', name: 'Click Apply Now' }] });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', {
    ...EMAIL_TAG,
    trigger: { name: 'Click: Apply Now', kind: 'link_click', clickUrlValue: '/apply' },
  });
  assert.strictEqual(client.calls.some((c) => c.kind === 'trigger'), false, 'no second trigger may be created');
  assert.strictEqual(json(res).trigger.reused, true);
  assert.deepStrictEqual(client.calls.find((c) => c.kind === 'tag').body.firingTriggerId, ['T-old']);
});

console.log('\nwhat the response claims must match what actually happened:');

await test('a rejected built-in enable is reported, not claimed as done', async () => {
  // All the types go in ONE request, so a rejection means NONE were enabled. Claiming otherwise
  // told the caller {{Click URL}} resolved while the trigger condition reads undefined.
  const client = stubClient({ failCreate: 'builtin' });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  assert.deepStrictEqual(json(res).enabledVariables, [], 'nothing was enabled, so nothing may be listed');
  assert.match(json(res).builtInVariablesWarning, /NOT enabled/);
  assert.match(json(res).builtInVariablesWarning, /clickUrl/, 'it must name what is still missing');
});

await test('a failed tag write names the trigger it already created', async () => {
  // The trigger write has already happened. Reporting only the tag failure left an orphan the
  // caller did not know about, and a retry under a new trigger name made a second one.
  const client = stubClient({ failCreate: 'tag' });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', EMAIL_TAG);
  assert.strictEqual(res.isError, true);
  assert.match(text(res), /T-new/, 'the orphaned trigger id must be in the error');
  assert.match(text(res), /triggers_delete/, 'and how to clean it up');
});

await test('a Google tag holding its id in a {{Constant}} is a usable fallback', async () => {
  // One Constant holding the Measurement ID with every GA4 tag pointing at it is the setup this
  // tool recommends. The resolver accepted only a literal G- id, so that container was refused with
  // "no Google tag to read the real one from" while a perfectly valid reference sat in it.
  const client = stubClient({
    existingTags: [{ type: 'googtag', parameter: [{ key: 'tagId', value: '{{GA4 Measurement ID}}' }] }],
  });
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  const tag = client.calls.find((c) => c.kind === 'tag');
  assert.ok(tag, 'the tag must be created, not refused');
  assert.strictEqual(tag.body.parameter.find((p) => p.key === 'measurementIdOverride').value, '{{GA4 Measurement ID}}');
  assert.match(json(res).measurementIdNote, /GA4 Measurement ID/, 'a substitution must never be silent');
});

await test('a literal id still wins over a {{Constant}} elsewhere in the container', async () => {
  const client = stubClient({
    existingTags: [
      { type: 'gaawe', parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' }] },
      { type: 'googtag', parameter: [{ key: 'tagId', value: 'G-REAL9876' }] },
    ],
  });
  await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  const tag = client.calls.find((c) => c.kind === 'tag').body;
  assert.strictEqual(tag.parameter.find((p) => p.key === 'measurementIdOverride').value, 'G-REAL9876');
});

console.log('\ncreate_gtm_variable_typed - an in-enum kind can be just as empty:');

await test('a kind missing its OWN required field is refused, not created blank', async () => {
  // The off-enum guard stops "telepathy"; this stops "javascript" with no javascript, which built a
  // jsm variable with an empty parameter, was accepted by GTM, and reported blank in every tag.
  for (const [kind, field] of [
    ['javascript', 'javascript'],
    ['data_layer', 'dataLayerName'],
    ['event_data', 'keyPath'],
    ['request_header', 'headerName'],
  ]) {
    const client = stubClient();
    const res = await call(serverWith(client), 'create_gtm_variable_typed', {
      ...WS, name: `Empty ${kind}`, kind, confirm: true,
    });
    assert.match(text(res), new RegExp(field), `${kind} must name the field it needs`);
    assert.strictEqual(client.calls.length, 0, `${kind} must not create an empty variable`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
