/**
 * Node test for the GA4 Admin read-only tools.
 *
 * Imports the COMPILED tools from dist (CI runs `npm run build` before
 * `npm test`) and registers them against a real McpServer with mocked GA4
 * Admin clients. Verifies:
 *   - all expected ga4_* tools register,
 *   - list tools shape responses via buildListResult,
 *   - get tools pass the normalized resource name to the API,
 *   - enhanced measurement uses the v1alpha client,
 *   - none of the GA4 tools are write/delete (no confirm gate).
 *
 * No live Google calls are made.
 *
 * Run: node src/__tests__/ga4Admin.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/ga4Admin.js');
const distSdk = path.resolve(
  __dirname,
  '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'
);

if (!existsSync(distTools)) {
  console.error(
    `\n✗ GA4 Admin test: ${distTools} not found. Run "npm run build" before "npm test".`
  );
  process.exit(1);
}

const { registerGa4AdminTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

const EXPECTED_TOOLS = [
  'ga4_account_summaries_list',
  'ga4_properties_list',
  'ga4_property_get',
  'ga4_data_streams_list',
  'ga4_enhanced_measurement_get',
  'ga4_custom_dimensions_list',
  'ga4_custom_metrics_list',
  'ga4_data_retention_get',
  'ga4_key_events_list',
  'ga4_google_ads_links_list',
];

function makeMocks() {
  const calls = {};
  const rec = (k) => {
    calls[k] = [];
    return (params) => {
      calls[k].push(params);
      return Promise.resolve({ data: mockData[k] });
    };
  };
  const mockData = {
    accountSummaries: { accountSummaries: [{ name: 'accountSummaries/1' }] },
    properties_list: { properties: [{ name: 'properties/123' }] },
    properties_get: { name: 'properties/123', displayName: 'Test' },
    dataStreams: { dataStreams: [{ name: 'properties/123/dataStreams/9' }] },
    customDimensions: { customDimensions: [{ parameterName: 'p' }] },
    customMetrics: { customMetrics: [{ parameterName: 'm' }] },
    keyEvents: { keyEvents: [{ eventName: 'purchase' }] },
    googleAdsLinks: { googleAdsLinks: [{ customerId: '111' }] },
    dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS' },
    enhanced: { streamEnabled: true, scrollsEnabled: true },
  };

  const client = {
    accountSummaries: { list: rec('accountSummaries') },
    properties: {
      list: rec('properties_list'),
      get: rec('properties_get'),
      getDataRetentionSettings: rec('dataRetention'),
      dataStreams: { list: rec('dataStreams') },
      customDimensions: { list: rec('customDimensions') },
      customMetrics: { list: rec('customMetrics') },
      keyEvents: { list: rec('keyEvents') },
      googleAdsLinks: { list: rec('googleAdsLinks') },
    },
  };
  const alphaClient = {
    properties: { dataStreams: { getEnhancedMeasurementSettings: rec('enhanced') } },
  };
  return { client, alphaClient, calls };
}

function buildServer() {
  const { client, alphaClient, calls } = makeMocks();
  const server = new McpServer(
    { name: 'ga4-test', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  registerGa4AdminTools(
    server,
    () => client,
    () => alphaClient
  );
  return { server, calls };
}

async function callTool(server, name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `tool ${name} should be registered`);
  const result = await tool.handler(args, { requestId: 'test' });
  return result;
}

function parseText(result) {
  assert.ok(!result.isError, `tool returned error: ${result?.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nGA4 Admin tools:');

await test('registers exactly the expected read-only tool set', () => {
  const { server } = buildServer();
  const registered = Object.keys(server._registeredTools).filter((n) => n.startsWith('ga4_'));
  for (const t of EXPECTED_TOOLS) {
    assert.ok(registered.includes(t), `missing tool ${t}`);
  }
  assert.strictEqual(registered.length, EXPECTED_TOOLS.length, 'unexpected extra ga4_ tools');
});

await test('no GA4 tool exposes a confirm gate (all read-only)', () => {
  const { server } = buildServer();
  for (const t of EXPECTED_TOOLS) {
    const shape = server._registeredTools[t].inputSchema?.shape ?? {};
    assert.ok(!('confirm' in shape), `${t} should not require confirm`);
  }
});

await test('account summaries list shapes a buildListResult body', async () => {
  const { server } = buildServer();
  const body = parseText(await callTool(server, 'ga4_account_summaries_list', {}));
  assert.strictEqual(body.count, 1);
  assert.deepStrictEqual(body.accountSummaries, [{ name: 'accountSummaries/1' }]);
});

await test('properties_list builds a parent filter from a bare account id', async () => {
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_properties_list', { accountId: '456' });
  assert.strictEqual(calls.properties_list[0].filter, 'parent:accounts/456');
});

await test('property_get normalizes a bare id to properties/{id}', async () => {
  const { server, calls } = buildServer();
  const body = parseText(await callTool(server, 'ga4_property_get', { property: '123' }));
  assert.strictEqual(calls.properties_get[0].name, 'properties/123');
  assert.strictEqual(body.name, 'properties/123');
});

await test('property_get accepts an already-qualified properties/{id}', async () => {
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_property_get', { property: 'properties/789' });
  assert.strictEqual(calls.properties_get[0].name, 'properties/789');
});

await test('data_retention_get targets the dataRetentionSettings child resource', async () => {
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_data_retention_get', { property: '123' });
  assert.strictEqual(calls.dataRetention[0].name, 'properties/123/dataRetentionSettings');
});

await test('data_streams_list passes parent and returns dataStreams', async () => {
  const { server, calls } = buildServer();
  const body = parseText(await callTool(server, 'ga4_data_streams_list', { property: '123' }));
  assert.strictEqual(calls.dataStreams[0].parent, 'properties/123');
  assert.strictEqual(body.count, 1);
});

await test('enhanced_measurement_get builds the full settings name via alpha client', async () => {
  const { server, calls } = buildServer();
  await callTool(server, 'ga4_enhanced_measurement_get', {
    property: '123',
    dataStreamId: '9',
  });
  assert.strictEqual(
    calls.enhanced[0].name,
    'properties/123/dataStreams/9/enhancedMeasurementSettings'
  );
});

await test('key_events_list returns keyEvents under the current Admin naming', async () => {
  const { server } = buildServer();
  const body = parseText(await callTool(server, 'ga4_key_events_list', { property: '123' }));
  assert.deepStrictEqual(body.keyEvents, [{ eventName: 'purchase' }]);
});

await test('a 403/scope error is surfaced as isError with a re-consent hint', async () => {
  const failing = new McpServer(
    { name: 'ga4-test', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  registerGa4AdminTools(
    failing,
    () => ({
      properties: { get: () => Promise.reject(new Error('PERMISSION_DENIED: insufficient scope')) },
    }),
    () => ({})
  );
  const res = await failing._registeredTools['ga4_property_get'].handler(
    { property: '1' },
    { requestId: 't' }
  );
  assert.ok(res.isError, 'should be an error result');
  assert.ok(/analytics\.readonly/.test(res.content[0].text), 'should include scope hint');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
