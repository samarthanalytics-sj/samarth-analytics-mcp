/**
 * Node test for GTM Trigger tools — focuses on the TIMER-trigger API shape: interval / intervalSeconds /
 * limit must be sent as DEDICATED TOP-LEVEL Schema$Trigger fields, never buried in parameter[] (where
 * GTM ignores them and the timer never fires). Imports the COMPILED tool from dist and registers it
 * against a real McpServer with a mock GTM client. Run: node src/__tests__/triggers.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/triggers.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

if (!existsSync(distTools)) {
  console.error(`\n✗ triggers test: ${distTools} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}

const { registerTriggerTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

function buildServer() {
  const calls = [];
  const triggers = {
    create: (p) => { calls.push({ verb: 'create', params: p }); return Promise.resolve({ data: { triggerId: '9', ...p.requestBody } }); },
    get: (p) => { calls.push({ verb: 'get', params: p }); return Promise.resolve({ data: { triggerId: '9', name: 'T', type: 'timer', fingerprint: 'f1' } }); },
    update: (p) => { calls.push({ verb: 'update', params: p }); return Promise.resolve({ data: { triggerId: '9', ...p.requestBody } }); },
  };
  const client = { accounts: { containers: { workspaces: { triggers } } } };
  const server = new McpServer({ name: 'triggers-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerTriggerTools(server, () => client);
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

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nGTM Trigger tools (timer shape):');

await test('triggers_create + triggers_update expose top-level interval / intervalSeconds / limit', () => {
  const { server } = buildServer();
  for (const n of ['triggers_create', 'triggers_update']) {
    const shape = server._registeredTools[n].inputSchema?.shape ?? {};
    for (const f of ['interval', 'intervalSeconds', 'limit']) assert.ok(f in shape, `${n} is missing top-level "${f}"`);
  }
});

await test('triggers_create sends timer interval/limit as TOP-LEVEL fields (not inside parameter[])', async () => {
  process.env.GTM_MCP_ENABLE_WRITES = 'true';
  process.env.DRY_RUN = 'false';
  const { server, calls } = buildServer();
  const r = await callTool(server, 'triggers_create', {
    accountId: '1', containerId: '2', workspaceId: '3',
    name: 'Every 5s', type: 'timer',
    interval: { type: 'template', value: '5000' },
    limit: { type: 'template', value: '3' },
    confirm: true,
  });
  json(r); // proceeded (not a dry-run / error)
  const body = calls.find((c) => c.verb === 'create').params.requestBody;
  assert.deepStrictEqual(body.interval, { type: 'template', value: '5000' }, 'interval must be a top-level Schema$Trigger field');
  assert.deepStrictEqual(body.limit, { type: 'template', value: '3' }, 'limit must be a top-level Schema$Trigger field');
});

await test('triggers_update forwards a top-level interval through the read-modify-write merge', async () => {
  process.env.GTM_MCP_ENABLE_WRITES = 'true';
  process.env.DRY_RUN = 'false';
  const { server, calls } = buildServer();
  await callTool(server, 'triggers_update', {
    accountId: '1', containerId: '2', workspaceId: '3', triggerId: '9',
    interval: { type: 'template', value: '10000' }, confirm: true,
  });
  const body = calls.find((c) => c.verb === 'update').params.requestBody;
  assert.deepStrictEqual(body.interval, { type: 'template', value: '10000' }, 'update must set the top-level interval field');
});

console.log(`\ntriggers: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
