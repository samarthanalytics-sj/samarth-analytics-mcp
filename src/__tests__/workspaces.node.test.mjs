/**
 * Node test for the GTM Workspaces tools — focused on workspace_resolve_conflict.
 *
 * Imports the COMPILED tools from dist and registers them against a real
 * McpServer with a mocked GTM client. Verifies that resolve_conflict sends the
 * GTM Entity ENVELOPE ({ "tag": {...} } / { "trigger": {...} } …) — the shape
 * the API actually requires — rather than the raw entity, and that the write
 * guardrail + confirm gate hold.
 *
 * No live Google calls are made. Run: node src/__tests__/workspaces.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/workspaces.js');
const distSdk = path.resolve(
  __dirname,
  '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'
);

if (!existsSync(distTools)) {
  console.error(`\n✗ workspaces test: ${distTools} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}

const { registerWorkspaceTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

function buildServer() {
  const calls = [];
  const workspaces = {
    resolve_conflict: (params) => {
      calls.push({ verb: 'resolve_conflict', params });
      return Promise.resolve({ data: { resolved: true } });
    },
  };
  const client = { accounts: { containers: { workspaces } } };
  const server = new McpServer({ name: 'workspaces-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerWorkspaceTools(server, () => client);
  return { server, calls };
}

async function callTool(server, name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `tool ${name} should be registered`);
  return tool.handler(args, { requestId: 'test' });
}
const isErr = (r) => r?.isError === true;
const textOf = (r) => r?.content?.[0]?.text ?? '';

function setEnv({ writes = true, dry = false } = {}) {
  process.env.GTM_MCP_ENABLE_WRITES = writes ? 'true' : 'false';
  process.env.DRY_RUN = dry ? 'true' : 'false';
}

let passed = 0,
  failed = 0;
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

console.log('\nGTM Workspaces tools:');

await test('resolve_conflict wraps a RAW entity in the Entity envelope keyed by entityType', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const rawTag = { name: 'GA4 Event', type: 'gaawe', firingTriggerId: ['12'] };
  const r = await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp-123',
    entityType: 'tag',
    entityJson: JSON.stringify(rawTag),
    confirm: true,
  });
  assert.ok(!isErr(r), textOf(r));
  const call = calls.find((c) => c.verb === 'resolve_conflict');
  assert.ok(call, 'resolve_conflict called');
  assert.strictEqual(call.params.fingerprint, 'fp-123', 'fingerprint passed as a query param');
  assert.strictEqual(
    call.params.path,
    'accounts/1/containers/2/workspaces/3',
    'workspace path built correctly'
  );
  // The body must be the Entity envelope, not the raw tag.
  assert.deepStrictEqual(call.params.requestBody, { tag: rawTag });
  assert.strictEqual(call.params.requestBody.name, undefined, 'raw entity must not sit at the top level');
});

await test('resolve_conflict keys the envelope by the chosen entityType (trigger)', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const rawTrigger = { name: 'Form Submit', type: 'formSubmission' };
  await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'trigger',
    entityJson: JSON.stringify(rawTrigger),
    confirm: true,
  });
  const call = calls.find((c) => c.verb === 'resolve_conflict');
  assert.deepStrictEqual(call.params.requestBody, { trigger: rawTrigger });
});

await test('resolve_conflict includes changeStatus when supplied', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'variable',
    entityJson: JSON.stringify({ name: 'DLV - foo', type: 'v' }),
    changeStatus: 'modified',
    confirm: true,
  });
  const call = calls.find((c) => c.verb === 'resolve_conflict');
  assert.strictEqual(call.params.requestBody.changeStatus, 'modified');
  assert.deepStrictEqual(call.params.requestBody.variable, { name: 'DLV - foo', type: 'v' });
});

await test('resolve_conflict does not double-wrap an already-enveloped body', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const enveloped = { tag: { name: 'Already Wrapped', type: 'html' } };
  await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'tag',
    entityJson: JSON.stringify(enveloped),
    confirm: true,
  });
  const call = calls.find((c) => c.verb === 'resolve_conflict');
  assert.deepStrictEqual(call.params.requestBody, enveloped, 'must not nest tag inside tag');
  assert.strictEqual(call.params.requestBody.tag.tag, undefined);
});

await test('resolve_conflict rejects invalid JSON without calling the API', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'tag',
    entityJson: '{not valid json',
    confirm: true,
  });
  assert.ok(isErr(r) && /valid JSON/.test(textOf(r)), textOf(r));
  assert.strictEqual(calls.length, 0, 'no API call on bad JSON');
});

await test('resolve_conflict is blocked when GTM writes are disabled', async () => {
  setEnv({ writes: false });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'tag',
    entityJson: JSON.stringify({ name: 'x', type: 'html' }),
    confirm: true,
  });
  assert.ok(isErr(r) && /GTM_MCP_ENABLE_WRITES/.test(textOf(r)), textOf(r));
  assert.strictEqual(calls.length, 0, 'no API call when gated');
});

await test('resolve_conflict requires confirm=true', async () => {
  setEnv({ writes: true });
  const { server, calls } = buildServer();
  const r = await callTool(server, 'workspace_resolve_conflict', {
    accountId: '1',
    containerId: '2',
    workspaceId: '3',
    fingerprint: 'fp',
    entityType: 'tag',
    entityJson: JSON.stringify({ name: 'x', type: 'html' }),
  });
  assert.ok(isErr(r) && /confirm=true/.test(textOf(r)), textOf(r));
  assert.strictEqual(calls.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
