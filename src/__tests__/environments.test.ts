/**
 * environments_update must be a read-modify-write.
 *
 * GTM's environments.update is a full replace: whatever the PUT body contains BECOMES the
 * environment. The tool used to send only the caller-supplied fields, so updating just the preview
 * `url` blanked the environment's name, description and enableDebug (or was rejected outright for
 * the missing name). tags_update / triggers_update / variables_update already fetch-then-overlay
 * for exactly this reason; this one was the outlier and lost data silently.
 *
 * Run: tsx src/__tests__/environments.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEnvironmentTools } from '../tools/environments.js';
import type { GtmClient } from '../utils/gtmClient.js';

/** The environment as it exists in GTM before the caller's patch. */
const EXISTING = {
  path: 'accounts/1/containers/2/environments/7',
  accountId: '1',
  containerId: '2',
  environmentId: '7',
  type: 'user',
  fingerprint: 'fp-original',
  name: 'Staging',
  description: 'QA env',
  enableDebug: true,
  url: 'https://old.example.com',
};

type Call = Record<string, unknown>;

function buildServer(existing: Record<string, unknown> = EXISTING) {
  const updateCalls: Call[] = [];
  const getCalls: Call[] = [];
  const environments = {
    get: (params: Call) => {
      getCalls.push(params);
      return Promise.resolve({ data: { ...existing } });
    },
    update: (params: Call) => {
      updateCalls.push(params);
      return Promise.resolve({ data: { ...(params.requestBody as object) } });
    },
  };
  const client = { accounts: { containers: { environments } } } as unknown as GtmClient;
  const server = new McpServer({ name: 'environments-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerEnvironmentTools(server, () => client);
  return { server, getCalls, updateCalls };
}

const ARGS = { accountId: '1', containerId: '2', environmentId: '7', confirm: true };

async function runUpdate(server: McpServer, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools['environments_update'];
  const r = await tool.handler({ ...ARGS, ...extra }, { requestId: 'test' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
}

/** Writes must be enabled for the handler to reach the API at all. */
process.env.GTM_MCP_ENABLE_WRITES = 'true';
process.env.DRY_RUN = 'false';

test('environments_update preserves fields the caller did not supply', async () => {
  const { server, getCalls, updateCalls } = buildServer();
  await runUpdate(server, { url: 'https://staging.example.com' });

  assert.equal(getCalls.length, 1, 'the current environment must be fetched before the full-replace PUT');
  assert.equal(getCalls[0].path, 'accounts/1/containers/2/environments/7');

  assert.equal(updateCalls.length, 1);
  const body = updateCalls[0].requestBody as Record<string, unknown>;
  assert.equal(body.url, 'https://staging.example.com', 'the supplied field is applied');
  assert.equal(body.name, 'Staging', 'name must survive a url-only update');
  assert.equal(body.description, 'QA env', 'description must survive a url-only update');
  assert.equal(body.enableDebug, true, 'enableDebug must survive a url-only update');
});

test('environments_update does NOT echo server-managed read-only fields into the full-replace PUT', async () => {
  const withReadOnly = {
    ...EXISTING,
    authorizationCode: 'auth-secret-123',
    authorizationTimestamp: '2026-01-01T00:00:00Z',
    containerVersionId: '42',
    tagManagerUrl: 'https://tagmanager.google.com/x',
  };
  const { server, updateCalls } = buildServer(withReadOnly);
  await runUpdate(server, { name: 'Renamed' });
  const body = updateCalls[0].requestBody as Record<string, unknown>;
  assert.equal(body.name, 'Renamed', 'the rename is applied');
  assert.equal(body.description, 'QA env', 'writable fields are still preserved');
  for (const k of ['authorizationCode', 'authorizationTimestamp', 'containerVersionId', 'tagManagerUrl', 'path', 'type', 'accountId', 'environmentId']) {
    assert.equal(body[k], undefined, `read-only field ${k} must not be echoed into the full-replace body`);
  }
});

test('environments_update falls back to the stored fingerprint when the caller omits one', async () => {
  const { server, updateCalls } = buildServer();
  await runUpdate(server, { description: 'new note' });
  assert.equal(updateCalls[0].fingerprint, 'fp-original');
});

test('environments_update still honours a caller-supplied fingerprint', async () => {
  const { server, updateCalls } = buildServer();
  await runUpdate(server, { description: 'new note', fingerprint: 'fp-caller' });
  assert.equal(updateCalls[0].fingerprint, 'fp-caller');
});

test('environments_update can still clear nothing by sending no changes at all', async () => {
  const { server, updateCalls } = buildServer();
  await runUpdate(server);
  const body = updateCalls[0].requestBody as Record<string, unknown>;
  assert.equal(body.name, 'Staging');
  assert.equal(body.description, 'QA env');
  assert.equal(body.url, 'https://old.example.com');
  assert.equal(body.enableDebug, true);
});
