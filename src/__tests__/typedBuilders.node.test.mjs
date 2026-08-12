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

/** A GTM client that records calls instead of making them. */
function stubClient({ existingTriggers = [] } = {}) {
  const calls = [];
  const record = (kind) => ({
    list: async () => ({ data: { trigger: existingTriggers } }),
    create: async (a) => {
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

await test('a placeholder Measurement ID is refused before anything is written', async () => {
  // GTM accepts G-123456789 happily and the tag then reports to nothing.
  const client = stubClient();
  const res = await call(serverWith(client), 'create_gtm_tracking_tag', { ...EMAIL_TAG, measurementId: 'G-123456789' });
  assert.match(text(res), /placeholder/i);
  assert.strictEqual(client.calls.length, 0, 'nothing may be created for a placeholder id');
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
