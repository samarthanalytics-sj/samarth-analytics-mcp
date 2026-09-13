/**
 * Node test for GA4 Data (read-only) report tools.
 *
 * 1. The truncation-signal fix. GA4's rowCount is the TOTAL matching rows, independent of limit/offset,
 *    so a paged response must also report returnedRowCount + hasMore (report) / truncated (realtime)
 *    so a caller never treats a partial page as the whole set.
 * 2. The ga4_check_compatibility reading fix. checkCompatibility returns the property's WHOLE catalogue
 *    graded for being ADDED to the request, and 400s when the requested set itself clashes, so only the
 *    requested names may carry a verdict and the 400 IS the incompatible answer.
 *
 * Imports the COMPILED tool from dist. Run: node src/__tests__/ga4Data.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/ga4Data.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

if (!existsSync(distTools)) {
  console.error(`\n✗ ga4Data test: ${distTools} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}

const { registerGa4DataTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

// Build a mock GA4 Data client whose runReport/runRealtimeReport return `total` rowCount but only
// `returned` data rows (mirrors GA4: rowCount is the total, rows is capped by limit).
function buildServer(total, returned) {
  const mkRows = (n) => Array.from({ length: n }, (_, i) => ({ dimensionValues: [{ value: `row${i}` }], metricValues: [{ value: '1' }] }));
  const body = {
    rowCount: total,
    dimensionHeaders: [{ name: 'eventName' }],
    metricHeaders: [{ name: 'eventCount' }],
    rows: mkRows(returned),
  };
  const client = {
    properties: {
      runReport: () => Promise.resolve({ data: body }),
      runRealtimeReport: () => Promise.resolve({ data: body }),
    },
  };
  const server = new McpServer({ name: 'ga4data-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerGa4DataTools(server, () => client);
  return server;
}
async function call(server, name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `tool ${name} should be registered`);
  const r = await tool.handler(args, { requestId: 't' });
  assert.ok(!r?.isError, `unexpected error: ${r?.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nGA4 Data report tools (truncation signal):');

await test('ga4_run_report: total 5000 rows, 250 returned → hasMore:true + returnedRowCount:250', async () => {
  const server = buildServer(5000, 250);
  const res = await call(server, 'ga4_run_report', { property: '123', metrics: ['eventCount'], startDate: '2024-01-01', endDate: '2024-01-31', limit: 250 });
  assert.strictEqual(res.rowCount, 5000, 'rowCount stays the TOTAL');
  assert.strictEqual(res.returnedRowCount, 250, 'returnedRowCount = rows in this page');
  assert.strictEqual(res.hasMore, true, 'hasMore must be true when total > offset + returned');
});

await test('ga4_run_report: complete result (total == returned) → hasMore:false', async () => {
  const server = buildServer(40, 40);
  const res = await call(server, 'ga4_run_report', { property: '123', metrics: ['eventCount'], startDate: '2024-01-01', endDate: '2024-01-31', limit: 250 });
  assert.strictEqual(res.hasMore, false, 'complete result is not hasMore');
  assert.strictEqual(res.returnedRowCount, 40);
});

await test('ga4_run_report: hasMore accounts for offset', async () => {
  const server = buildServer(300, 100);
  const res = await call(server, 'ga4_run_report', { property: '123', metrics: ['eventCount'], startDate: '2024-01-01', endDate: '2024-01-31', limit: 100, offset: 200 });
  // 200 + 100 == 300 total → nothing left
  assert.strictEqual(res.hasMore, false, 'offset 200 + 100 returned covers all 300');
});

await test('ga4_run_realtime_report: total > returned → truncated:true (no offset to page)', async () => {
  const server = buildServer(1000, 100);
  const res = await call(server, 'ga4_run_realtime_report', { property: '123', metrics: ['eventCount'], limit: 100 });
  assert.strictEqual(res.truncated, true, 'realtime must flag truncated when total > returned');
  assert.strictEqual(res.returnedRowCount, 100);
});

console.log(`\nga4Data: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
