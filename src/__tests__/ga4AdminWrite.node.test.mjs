/**
 * Node test for the GA4 Admin WRITE tools (create/update/delete/archive).
 *
 * Imports the COMPILED tools from dist and registers them against a real
 * McpServer with mocked GA4 Admin clients. Verifies the guardrail gating
 * (GA4_MCP_ENABLE_WRITES / GA4_MCP_ENABLE_DELETES + confirm), parent/name path
 * building, updateMask derivation, the calculatedMetricId query param, the
 * property-create parent-in-body special case, and DRY_RUN short-circuiting.
 *
 * No live Google calls are made. Run: node src/__tests__/ga4AdminWrite.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/ga4AdminWrite.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

if (!existsSync(distTools)) {
  console.error(`\n✗ GA4 write test: ${distTools} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}

const { registerGa4AdminWriteTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

// A recording sub-resource with all four verbs; each returns { data } echoing the params.
function makeSub(calls, label) {
  const rec = (verb) => (params) => {
    calls.push({ label, verb, params });
    return Promise.resolve({ data: { echoed: verb, ...params } });
  };
  return { create: rec('create'), patch: rec('patch'), delete: rec('delete'), archive: rec('archive') };
}

function buildServer() {
  const calls = [];
  const S = (label) => makeSub(calls, label);
  const dataStreams = {
    ...S('dataStreams'),
    measurementProtocolSecrets: S('mpSecrets'),
    eventCreateRules: S('eventCreateRules'),
    sKAdNetworkConversionValueSchema: S('skad'),
  };
  const properties = {
    ...S('properties'),
    keyEvents: S('keyEvents'),
    customDimensions: S('customDimensions'),
    customMetrics: S('customMetrics'),
    dataStreams,
    googleAdsLinks: S('googleAdsLinks'),
    firebaseLinks: S('firebaseLinks'),
    audiences: S('audiences'),
    channelGroups: S('channelGroups'),
    calculatedMetrics: S('calculatedMetrics'),
    expandedDataSets: S('expandedDataSets'),
    displayVideo360AdvertiserLinks: S('dv360'),
    searchAds360Links: S('sa360'),
    adSenseLinks: S('adsense'),
    subpropertyEventFilters: S('subpropFilters'),
    rollupPropertySourceLinks: S('rollupLinks'),
    accessBindings: S('propAccessBindings'),
    updateDataRetentionSettings: (p) => { calls.push({ label: 'dataRetention', verb: 'patch', params: p }); return Promise.resolve({ data: p }); },
    acknowledgeUserDataCollection: (p) => { calls.push({ label: 'ack', verb: 'post', params: p }); return Promise.resolve({ data: p }); },
  };
  const accounts = { ...S('accounts'), accessBindings: S('acctAccessBindings') };
  const client = { properties, accounts };
  const alphaClient = client; // same mock tree serves both surfaces in the test
  const server = new McpServer({ name: 'ga4-write-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerGa4AdminWriteTools(server, () => client, () => alphaClient);
  return { server, calls };
}

async function callTool(server, name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `tool ${name} should be registered`);
  return tool.handler(args, { requestId: 'test' });
}
const isErr = (r) => r?.isError === true;
const text = (r) => r?.content?.[0]?.text ?? '';
const json = (r) => { assert.ok(!isErr(r), `unexpected error: ${text(r)}`); return JSON.parse(text(r)); };

// Env helpers — the tools read process.env at call time via getGuardrailConfig().
function setEnv({ writes, deletes, dry } = {}) {
  process.env.GA4_MCP_ENABLE_WRITES = writes ? 'true' : 'false';
  process.env.GA4_MCP_ENABLE_DELETES = deletes ? 'true' : 'false';
  process.env.DRY_RUN = dry ? 'true' : 'false';
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nGA4 Admin WRITE tools:');

await test('registers a broad create/update/delete/archive surface', () => {
  const { server } = buildServer();
  const names = Object.keys(server._registeredTools);
  for (const t of [
    'ga4_create_key_event', 'ga4_update_key_event', 'ga4_delete_key_event',
    'ga4_create_custom_dimension', 'ga4_archive_custom_dimension',
    'ga4_create_custom_metric', 'ga4_archive_custom_metric',
    'ga4_create_data_stream', 'ga4_delete_data_stream',
    'ga4_create_measurement_protocol_secret',
    'ga4_create_audience', 'ga4_archive_audience',
    'ga4_create_channel_group', 'ga4_create_calculated_metric',
    'ga4_create_event_create_rule', 'ga4_create_property_access_binding',
    'ga4_create_account_access_binding',
    'ga4_create_property', 'ga4_update_property', 'ga4_delete_property',
    'ga4_update_data_retention', 'ga4_update_account', 'ga4_delete_account',
    'ga4_acknowledge_user_data_collection',
  ]) assert.ok(names.includes(t), `missing tool ${t}`);
  // Custom dimensions/metrics/audiences ARCHIVE, never hard-delete.
  assert.ok(!names.includes('ga4_delete_custom_dimension'), 'custom dimensions must not expose a hard delete');
  assert.ok(!names.includes('ga4_delete_audience'), 'audiences must not expose a hard delete');
  // Pin the absolute count so a dropped catalog entry/verb fails here (20 factory
  // resources = 57 verbs + 7 bespoke lifecycle/ack tools = 64).
  const writeNames = names.filter((n) => /^ga4_(create|update|delete|archive)_/.test(n) || n === 'ga4_acknowledge_user_data_collection');
  assert.strictEqual(writeNames.length, 64, `expected 64 GA4 write tools, got ${writeNames.length}: ${writeNames.sort().join(', ')}`);
  // Every factory resource contributes at least its create tool (catches a dropped resource
  // that no other assertion names — google_ads_link, firebase_link, dv360, sa360, adsense, etc.).
  for (const n of [
    'ga4_create_google_ads_link', 'ga4_create_firebase_link', 'ga4_create_display_video_360_advertiser_link',
    'ga4_create_search_ads_360_link', 'ga4_create_adsense_link', 'ga4_create_subproperty_event_filter',
    'ga4_create_rollup_property_source_link', 'ga4_create_expanded_data_set', 'ga4_create_skadnetwork_conversion_value_schema',
  ]) assert.ok(names.includes(n), `missing ${n}`);
});

await test('every write/delete/archive tool requires a confirm gate', () => {
  const { server } = buildServer();
  for (const [name, tool] of Object.entries(server._registeredTools)) {
    const shape = tool.inputSchema?.shape ?? {};
    assert.ok('confirm' in shape, `${name} must require confirm`);
  }
});

await test('create is blocked when GA4 writes are disabled', async () => {
  setEnv({ writes: false });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_create_key_event', { property: '123', eventName: 'purchase', confirm: true });
  assert.ok(isErr(r) && /GA4_MCP_ENABLE_WRITES/.test(text(r)), `expected gate error, got: ${text(r)}`);
  assert.strictEqual(calls.length, 0, 'no API call when gated');
});

await test('create is blocked without confirm even when writes are enabled', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_create_key_event', { property: '123', eventName: 'purchase' });
  assert.ok(isErr(r) && /confirm=true/.test(text(r)), `expected confirm error, got: ${text(r)}`);
  assert.strictEqual(calls.length, 0);
});

await test('create key event: parent + requestBody wired correctly', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const body = json(await callTool(server, 'ga4_create_key_event', { property: '123', eventName: 'purchase', countingMethod: 'ONCE_PER_SESSION', confirm: true }));
  const call = calls.find((c) => c.label === 'keyEvents' && c.verb === 'create');
  assert.ok(call, 'keyEvents.create called');
  assert.strictEqual(call.params.parent, 'properties/123');
  assert.deepStrictEqual(call.params.requestBody, { eventName: 'purchase', countingMethod: 'ONCE_PER_SESSION' });
  assert.strictEqual(body.echoed, 'create');
});

await test('update derives updateMask from supplied fields and passes the name', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_update_custom_dimension', { name: 'properties/123/customDimensions/9', displayName: 'New Name', confirm: true });
  const call = calls.find((c) => c.label === 'customDimensions' && c.verb === 'patch');
  assert.strictEqual(call.params.name, 'properties/123/customDimensions/9');
  assert.strictEqual(call.params.updateMask, 'displayName');
  assert.deepStrictEqual(call.params.requestBody, { displayName: 'New Name' });
});

await test('raw body merges over typed fields on create', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_create_data_stream', { property: '5', type: 'WEB_DATA_STREAM', displayName: 'Web', defaultUri: 'https://x.com', body: { displayName: 'Overridden' }, confirm: true });
  const call = calls.find((c) => c.label === 'dataStreams' && c.verb === 'create');
  assert.strictEqual(call.params.requestBody.displayName, 'Overridden', 'body overrides typed field');
  assert.deepStrictEqual(call.params.requestBody.webStreamData, { defaultUri: 'https://x.com' });
});

await test('dataStream-parented create builds the nested parent path', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_create_measurement_protocol_secret', { property: '123', dataStreamId: '9', displayName: 'Server', confirm: true });
  const call = calls.find((c) => c.label === 'mpSecrets' && c.verb === 'create');
  assert.strictEqual(call.params.parent, 'properties/123/dataStreams/9');
});

await test('calculated metric create passes calculatedMetricId as a query param', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_create_calculated_metric', { property: '7', calculatedMetricId: 'roas', formula: '{{revenue}}/{{cost}}', confirm: true });
  const call = calls.find((c) => c.label === 'calculatedMetrics' && c.verb === 'create');
  assert.strictEqual(call.params.calculatedMetricId, 'roas', 'id goes to the query, not the body');
  assert.strictEqual(call.params.requestBody.calculatedMetricId, undefined);
});

await test('property create puts the account parent INSIDE the body', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_create_property', { accountId: '456', displayName: 'New Prop', timeZone: 'America/New_York', currencyCode: 'USD', confirm: true });
  const call = calls.find((c) => c.label === 'properties' && c.verb === 'create');
  assert.strictEqual(call.params.parent, undefined, 'no URL parent for property create');
  assert.strictEqual(call.params.requestBody.parent, 'accounts/456');
  assert.strictEqual(call.params.requestBody.propertyType, 'PROPERTY_TYPE_ORDINARY');
});

await test('access binding create carries user + roles (manage.users surface)', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_create_property_access_binding', { property: '123', user: 'a@b.com', roles: ['predefinedRoles/analyst'], confirm: true });
  const call = calls.find((c) => c.label === 'propAccessBindings' && c.verb === 'create');
  assert.deepStrictEqual(call.params.requestBody, { user: 'a@b.com', roles: ['predefinedRoles/analyst'] });
});

await test('delete is blocked when GA4 deletes are disabled (even with writes on)', async () => {
  setEnv({ writes: true, deletes: false });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_delete_data_stream', { name: 'properties/1/dataStreams/2', confirm: true });
  assert.ok(isErr(r) && /GA4_MCP_ENABLE_DELETES/.test(text(r)), `expected delete gate, got: ${text(r)}`);
  assert.strictEqual(calls.length, 0);
});

await test('archive is gated by GA4_MCP_ENABLE_DELETES, then archives', async () => {
  setEnv({ writes: true, deletes: false });
  let { server } = buildServer();
  let r = await callTool(server, 'ga4_archive_custom_dimension', { name: 'properties/1/customDimensions/2', confirm: true });
  assert.ok(isErr(r) && /GA4_MCP_ENABLE_DELETES/.test(text(r)));
  setEnv({ writes: true, deletes: true });
  const built = buildServer();
  r = await callTool(built.server, 'ga4_archive_custom_dimension', { name: 'properties/1/customDimensions/2', confirm: true });
  assert.ok(!isErr(r), text(r));
  const call = built.calls.find((c) => c.label === 'customDimensions' && c.verb === 'archive');
  assert.strictEqual(call.params.name, 'properties/1/customDimensions/2');
});

await test('delete works when enabled and targets the resource name', async () => {
  setEnv({ deletes: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_delete_key_event', { name: 'properties/1/keyEvents/2', confirm: true });
  assert.ok(!isErr(r) && /Deleted/.test(text(r)), text(r));
  const call = calls.find((c) => c.label === 'keyEvents' && c.verb === 'delete');
  assert.strictEqual(call.params.name, 'properties/1/keyEvents/2');
});

await test('DRY_RUN short-circuits without calling the API', async () => {
  setEnv({ writes: true, dry: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_create_key_event', { property: '123', eventName: 'x', confirm: true });
  assert.ok(!isErr(r) && /DRY RUN/.test(text(r)), text(r));
  assert.strictEqual(calls.length, 0, 'no API call under DRY_RUN');
});

await test('data retention update targets the settings child and derives the mask', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_update_data_retention', { property: '123', eventDataRetention: 'FOURTEEN_MONTHS', confirm: true });
  const call = calls.find((c) => c.label === 'dataRetention');
  assert.strictEqual(call.params.name, 'properties/123/dataRetentionSettings');
  assert.strictEqual(call.params.updateMask, 'eventDataRetention');
});

await test('data stream update: typed defaultUri nests under webStreamData with a valid derived mask', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_update_data_stream', { name: 'properties/5/dataStreams/9', defaultUri: 'https://new.example', confirm: true });
  const call = calls.find((c) => c.label === 'dataStreams' && c.verb === 'patch');
  assert.ok(call, 'patch was called');
  assert.deepStrictEqual(call.params.requestBody, { webStreamData: { defaultUri: 'https://new.example' } });
  assert.strictEqual(call.params.updateMask, 'webStreamData', 'mask is a real field path');
});

await test('data stream update refuses Google-tag-settings fields with directions (no API call)', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'ga4_update_data_stream', { name: 'properties/5/dataStreams/9', body: { webStreamData: { domains: ['a.com'], unwantedReferrals: ['b.com'] } }, confirm: true });
  const text = JSON.stringify(r);
  assert.ok(/Google tag settings/i.test(text), 'names the real home of the setting: ' + text);
  assert.ok(/Configure tag settings/.test(text), 'gives the GA4 UI path');
  assert.ok(text.includes('webStreamData.domains'), 'lists the offending fields');
  assert.ok(!calls.some((c) => c.label === 'dataStreams' && c.verb === 'patch'), 'the invalid body never reached the API');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
