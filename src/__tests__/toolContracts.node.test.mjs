/**
 * Tool-schema contract tests.
 *
 * These do not exercise the GTM API. They assert that the DESCRIPTIONS a model reads before calling
 * a tool state the things the API will reject it for getting wrong. Both cases here are real
 * failures observed in production chat:
 *
 *   tags_create advertised a tag type of "ga4". There is no such GTM type; the API answers
 *   "vendorTemplate.key: Unknown entity type". The model was following the documentation it was
 *   given, so no amount of prompt tuning would have fixed it.
 *
 *   The trigger condition schema left `key` undescribed. GTM accepts only "arg0" and "arg1" there
 *   and answers "filter[0].parameter[0]: Parameter key is unknown" for anything else. The
 *   convention was documented, but only inside two guided-workflow prompts, so an ordinary
 *   "create a click trigger" conversation never saw it.
 *
 * A tool description is an interface. Run: node src/__tests__/toolContracts.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTags = path.resolve(__dirname, '../../dist/tools/tags.js');
const distTriggers = path.resolve(__dirname, '../../dist/tools/triggers.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

for (const f of [distTags, distTriggers]) {
  if (!existsSync(f)) {
    console.error(`\n✗ toolContracts test: ${f} not found. Run "npm run build" before "npm test".`);
    process.exit(1);
  }
}

const { registerTagTools } = await import(pathToFileURL(distTags).href);
const { registerTriggerTools } = await import(pathToFileURL(distTriggers).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

const server = new McpServer({ name: 'contracts-test', version: '0.0.1' }, { capabilities: { tools: {} } });
const client = { accounts: { containers: { workspaces: { tags: {}, triggers: {} } } } };
registerTagTools(server, () => client);
registerTriggerTools(server, () => client);

const { toJsonSchemaCompat } = await import(
  pathToFileURL(path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js')).href
);

/**
 * One field as the MODEL receives it.
 *
 * Converted to JSON Schema rather than read off the zod object, because that conversion is what
 * the MCP server actually sends. A description nested inside an array item is invisible to
 * `shape[field].description` but is exactly the text that has to reach the caller. The converter
 * and options are the ones the SDK's tools/list handler uses.
 */
function fieldJson(toolName, field) {
  const inputSchema = server._registeredTools[toolName]?.inputSchema;
  const props = inputSchema ? toJsonSchemaCompat(inputSchema, { strictUnions: true, pipeStrategy: 'input' }).properties ?? {} : {};
  assert.ok(field in props, `${toolName} has no "${field}" field`);
  return JSON.stringify(props[field]);
}

/** The top-level description text for one field. */
function fieldDescription(toolName, field) {
  const shape = server._registeredTools[toolName]?.inputSchema?.shape ?? {};
  assert.ok(field in shape, `${toolName} has no "${field}" field`);
  return shape[field].description ?? '';
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nTool schema contracts (what the model is told before it calls):');

await test('tags_create names the REAL GA4 tag types and disowns "ga4"', () => {
  const d = fieldDescription('tags_create', 'type');
  assert.ok(/\bgaawe\b/.test(d), 'the GA4 event type "gaawe" must be named');
  assert.ok(/\bgoogtag\b/.test(d), 'the Google tag type "googtag" must be named');
  assert.ok(
    /no "ga4" type/i.test(d),
    'must say explicitly that "ga4" is not a type — it was advertised as one and the API rejects it',
  );
});

await test('tags_update points at the same type vocabulary', () => {
  const d = fieldDescription('tags_update', 'type');
  assert.ok(/gaawe|tags_create/.test(d), 'must reference the real types or the tool that lists them');
  assert.ok(/no "ga4" type/i.test(d), 'must carry the same warning as tags_create');
});

await test('no tag tool still advertises a bare "ga4" type', () => {
  for (const tool of ['tags_create', 'tags_update']) {
    const d = fieldDescription(tool, 'type');
    // The literal in quotes, other than inside the explicit "there is no" warning.
    const stray = d.replace(/there is no "ga4" type\.?/gi, '');
    assert.ok(!/"ga4"/.test(stray), `${tool} still offers "ga4" as a value`);
  }
});

await test('trigger conditions state the arg0 / arg1 key contract', () => {
  for (const tool of ['triggers_create', 'triggers_update']) {
    for (const field of ['filter', 'customEventFilter', 'autoEventFilter']) {
      const json = fieldJson(tool, field);
      assert.ok(/arg0/.test(json), `${tool}.${field} never mentions arg0`);
      assert.ok(/arg1/.test(json), `${tool}.${field} never mentions arg1`);
      assert.ok(
        /Parameter key is unknown/.test(json),
        `${tool}.${field} should name the error a wrong key produces, so the fix is obvious`,
      );
    }
  }
});

await test('trigger conditions warn that a built-in variable must be enabled first', () => {
  const json = fieldJson('triggers_create', 'filter');
  assert.ok(
    /built_in_variables_enable/.test(json),
    'must name the tool that enables a built-in, since referencing a disabled one fails at the API',
  );
});

await test('tags_create states what a GA4 event tag needs to be accepted', () => {
  const d = fieldDescription('tags_create', 'parameter');
  // The observed failure: "vendorTemplate.parameter.measurementIdOverride: The value must not be
  // empty" — an error naming a field the caller never sent. Cost a whole round trip to discover.
  assert.ok(/measurementIdOverride/.test(d), 'must name the field the API demands');
  assert.ok(/tagReference/.test(d), 'must show the measurementId tagReference that pairs with it');
  assert.ok(/eventSettingsTable/.test(d), 'must keep the shared nesting example, not replace it');
});

await test('workspace-scoped list results echo the scope they were read from', async () => {
  const scoped = new McpServer({ name: 'scope-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerTagTools(scoped, () => ({
    accounts: { containers: { workspaces: { tags: { list: () => Promise.resolve({ data: { tag: [] } }) } } } },
  }));

  const res = await scoped._registeredTools.tags_list.handler(
    { accountId: '6000000002', containerId: '200000001', workspaceId: '2' },
    { requestId: 'test' },
  );
  const body = JSON.parse(res.content[0].text);

  // The EMPTY case is the one that needs this. "There are no tags in your selected workspace"
  // cannot be checked by the person reading it, and a container holds more than one workspace,
  // so an empty answer from the wrong one looks exactly like an empty answer from the right one.
  assert.strictEqual(body.count, 0, 'fixture returns no tags');
  assert.ok(body.scope, 'an empty list must still say where it looked');
  assert.strictEqual(body.scope.workspaceId, '2');
  assert.strictEqual(body.scope.containerId, '200000001');
  assert.strictEqual(body.scope.accountId, '6000000002');
});

// ── ID arguments cannot retarget a request ───────────────────────────────────────────────────────
// Every GTM id was a bare z.string() pasted into a googleapis {+path}, which is expanded as a
// RESERVED string: '/', ':', '?' and '#' reach the URL raw. workspace_quick_preview - read tier, no
// flag, no confirm - called with containerId '2/versions/5:publish#' sent
// POST .../containers/2/versions/5:publish (the '#' drops the real suffix as a fragment): a live
// publish with every GTM_MCP_ENABLE_* flag off. These go through a REAL MCP client and server over
// an in-memory transport, so the SDK's own schema validation is what is being tested.
console.log('\nID arguments are validated before a handler runs (full MCP round trip):');

const distIndex = path.resolve(__dirname, '../../dist/tools/index.js');
const { registerAllTools } = await import(pathToFileURL(distIndex).href);
const { Client } = await import(
  pathToFileURL(path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href
);
const { InMemoryTransport } = await import(
  pathToFileURL(path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js')).href
);

/** A client where every property is a further client and every call is recorded and answered {data:{}}. */
function recordingClient(calls, trail = []) {
  return new Proxy(function () {}, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop === 'bind' || prop === 'call' || prop === 'apply') return Reflect.get(target, prop);
      if (prop === 'context') return { _options: {} };
      return recordingClient(calls, [...trail, prop]);
    },
    apply(_target, _this, args) {
      calls.push({ method: trail.join('.'), params: args[0] });
      return Promise.resolve({ data: {} });
    },
  });
}

async function connectAll() {
  const calls = [];
  const fake = () => recordingClient(calls);
  const mcp = new McpServer({ name: 'id-contracts', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerAllTools(mcp, fake, fake, fake, fake);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverT);
  const client = new Client({ name: 'id-contracts-client', version: '0.0.1' });
  await client.connect(clientT);
  return { mcp, client, calls };
}
const { mcp: allTools, client: mcpClient, calls: apiCalls } = await connectAll();
const callText = (r) => r?.content?.[0]?.text ?? '';

const SMUGGLED = ['2/versions/5:publish#', '2:combine?containerId=999&settingSource=other#', '2:combine?x=1#', '1#', '1/../2', '1%2F2', ''];

await test('workspace_quick_preview (read tier) refuses a smuggled containerId and sends nothing', async () => {
  for (const containerId of SMUGGLED) {
    apiCalls.length = 0;
    const r = await mcpClient.callTool({ name: 'workspace_quick_preview', arguments: { accountId: '1', containerId, workspaceId: '3' } });
    assert.ok(r.isError, `containerId ${JSON.stringify(containerId)} must be refused: ${callText(r)}`);
    assert.match(callText(r), /Input validation error/);
    assert.strictEqual(apiCalls.length, 0, `no API call for ${JSON.stringify(containerId)}: ${JSON.stringify(apiCalls)}`);
  }
  // The legitimate call still reaches the API with the path it always had.
  apiCalls.length = 0;
  const ok = await mcpClient.callTool({ name: 'workspace_quick_preview', arguments: { accountId: '1', containerId: '2', workspaceId: '3' } });
  assert.ok(!ok.isError, callText(ok));
  assert.deepStrictEqual(apiCalls.map((c) => [c.method, c.params.path]), [
    ['accounts.containers.workspaces.quick_preview', 'accounts/1/containers/2/workspaces/3'],
  ]);
});

await test('folders_entities (read tier, also a POST) refuses a smuggled id in any position', async () => {
  const base = { accountId: '1', containerId: '2', workspaceId: '3', folderId: '4' };
  for (const field of Object.keys(base)) {
    apiCalls.length = 0;
    const r = await mcpClient.callTool({ name: 'folders_entities', arguments: { ...base, [field]: '7/versions/7:publish#' } });
    assert.ok(r.isError && /Input validation error/.test(callText(r)), `${field}: ${callText(r)}`);
    assert.strictEqual(apiCalls.length, 0, field);
  }
});

await test('versions_set_latest with the write flag ON still cannot be pointed at :publish', async () => {
  const saved = process.env.GTM_MCP_ENABLE_WRITES;
  process.env.GTM_MCP_ENABLE_WRITES = 'true';
  try {
    apiCalls.length = 0;
    const r = await mcpClient.callTool({
      name: 'versions_set_latest',
      arguments: { accountId: '1', containerId: '2', containerVersionId: '5:publish#', confirm: true },
    });
    assert.ok(r.isError && /Input validation error/.test(callText(r)), callText(r));
    assert.strictEqual(apiCalls.length, 0, JSON.stringify(apiCalls));
    const ok = await mcpClient.callTool({
      name: 'versions_set_latest',
      arguments: { accountId: '1', containerId: '2', containerVersionId: '5', confirm: true },
    });
    assert.ok(!ok.isError, callText(ok));
    assert.strictEqual(apiCalls[0].params.path, 'accounts/1/containers/2/versions/5');
  } finally {
    if (saved === undefined) delete process.env.GTM_MCP_ENABLE_WRITES; else process.env.GTM_MCP_ENABLE_WRITES = saved;
  }
});

await test('versions_get still accepts "live" (and only that word besides digits)', async () => {
  apiCalls.length = 0;
  const ok = await mcpClient.callTool({ name: 'versions_get', arguments: { accountId: '1', containerId: '2', containerVersionId: 'live' } });
  assert.ok(!ok.isError, callText(ok));
  assert.strictEqual(apiCalls[0].method, 'accounts.containers.versions.live');
  const bad = await mcpClient.callTool({ name: 'versions_get', arguments: { accountId: '1', containerId: '2', containerVersionId: 'live:publish#' } });
  assert.ok(bad.isError, callText(bad));
});

await test('GA4: a smuggled property / name is refused by the schema (writes and deletes on)', async () => {
  const saved = { w: process.env.GA4_MCP_ENABLE_WRITES, d: process.env.GA4_MCP_ENABLE_DELETES };
  process.env.GA4_MCP_ENABLE_WRITES = 'true';
  process.env.GA4_MCP_ENABLE_DELETES = 'true';
  try {
    apiCalls.length = 0;
    for (const [name, args] of [
      ['ga4_create_audience', { property: '1/customDimensions/7:archive#', confirm: true }],
      ['ga4_create_channel_group', { property: '1/../../accounts/123/accessBindings:batchDelete#', confirm: true }],
      ['ga4_delete_key_event', { name: 'accounts/123', confirm: true }],
      ['ga4_property_get', { property: '1?x=1' }],
      ['ga4_run_report', { property: '1:runPivotReport#', metrics: ['sessions'] }],
    ]) {
      const r = await mcpClient.callTool({ name, arguments: args });
      assert.ok(r.isError && /Input validation error/.test(callText(r)), `${name}: ${callText(r)}`);
    }
    assert.strictEqual(apiCalls.length, 0, JSON.stringify(apiCalls));
  } finally {
    for (const [k, v] of [['GA4_MCP_ENABLE_WRITES', saved.w], ['GA4_MCP_ENABLE_DELETES', saved.d]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/**
 * Every field that is pasted into a resource path, on EVERY registered tool. A new tool that adds
 * one of these as a bare z.string() fails here. The exceptions are fields that share a name with a
 * path id but are not one: query or body values with their own formats (a G-/AW- Google tag id, a
 * CAPI vendor id), which googleapis encodes and which never touch the path.
 */
const PATH_ID_FIELDS = new Set([
  'accountId', 'containerId', 'workspaceId', 'tagId', 'triggerId', 'variableId', 'folderId',
  'containerVersionId', 'environmentId', 'userPermissionId', 'templateId', 'clientId', 'zoneId',
  'transformationId', 'gtagConfigId', 'destinationId', 'property', 'dataStreamId',
]);
const NOT_A_PATH_ID = new Set([
  'containers_lookup.destinationId', // query param: a G-/AW- destination id
  'destinations_link.destinationId', // query param: a G-/AW- destination id
  'containers_move_tag_id.tagId', // query param: a Google tag id such as G-XXXX
  'create_gtm_tracking_tag.tagId', // body: the G- id a base Google tag configures
  'create_line_yahoo_capi_server_tag.tagId', // body: the vendor's tag id
  'create_nextdoor_capi_server_tag.clientId', // body: the vendor's client id
  // repeated query params (arrays of ids), encoded by googleapis
  'folders_move_entities.tagId',
  'folders_move_entities.triggerId',
  'folders_move_entities.variableId',
]);

await test('every path-id field of every registered tool refuses a smuggled value', () => {
  const tools = Object.entries(allTools._registeredTools);
  assert.ok(tools.length > 150, `expected the full tool surface, got ${tools.length}`);
  const open = [];
  let checked = 0;
  for (const [toolName, tool] of tools) {
    const shape = tool.inputSchema?.shape ?? {};
    for (const [field, schema] of Object.entries(shape)) {
      const isGa4Name = field === 'name' && /^ga4_(update|delete|archive)_/.test(toolName);
      if (!PATH_ID_FIELDS.has(field) && !isGa4Name) continue;
      if (NOT_A_PATH_ID.has(`${toolName}.${field}`)) continue;
      checked++;
      for (const v of SMUGGLED) {
        if (schema.safeParse(v).success) open.push(`${toolName}.${field} accepts ${JSON.stringify(v)}`);
      }
      if (isGa4Name) continue;
      // ...and a plain numeric id is still accepted, so legitimate calls keep working.
      if (!schema.safeParse('123').success) open.push(`${toolName}.${field} refuses the plain id "123"`);
    }
  }
  assert.ok(checked > 300, `only ${checked} id fields were checked`);
  assert.deepStrictEqual(open, [], `id fields that still let a path through:\n  ${open.join('\n  ')}`);
});

// tools/list converts every input schema to JSON Schema in one response, and zod 4's converter
// throws on a type it cannot represent. One such field on one tool would fail the listing for
// every client, so the whole surface goes through the real request here.
await test('tools/list returns a JSON Schema for every registered tool', async () => {
  const { tools } = await mcpClient.listTools();
  const registered = Object.keys(allTools._registeredTools).length;
  assert.strictEqual(tools.length, registered);
  const bad = tools.filter((t) => t.inputSchema?.type !== 'object').map((t) => t.name);
  assert.deepStrictEqual(bad, [], `tools without an object input schema: ${bad.join(', ')}`);
  const triggers = tools.find((t) => t.name === 'triggers_create');
  assert.ok(/arg0/.test(JSON.stringify(triggers.inputSchema.properties.filter)), 'nested descriptions must survive the listing');
});

await mcpClient.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
