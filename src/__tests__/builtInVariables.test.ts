/**
 * Built-in variable tools: the path each verb is given.
 *
 * delete and revert look like siblings and are not. tagmanager v2 builds delete as `{+path}` but
 * revert as `{+path}/built_in_variables:revert`, so the collection segment belongs in delete's
 * `path` and must NOT be in revert's. Passing delete's path to revert produced
 * .../built_in_variables/built_in_variables:revert, a URL that does not exist, and every revert
 * came back as a 404 the caller could only read as "the API said no".
 *
 * Run: tsx src/__tests__/builtInVariables.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBuiltInVariableTools } from '../tools/builtInVariables.js';

const WS = { accountId: '1', containerId: '2', workspaceId: '3' };
const WORKSPACE_PATH = 'accounts/1/containers/2/workspaces/3';

type Call = { verb: string; params: Record<string, unknown> };

function buildServer() {
  const calls: Call[] = [];
  const record = (verb: string, data: unknown) => (params: Record<string, unknown>) => {
    calls.push({ verb, params });
    return Promise.resolve({ data });
  };
  const client = {
    accounts: {
      containers: {
        workspaces: {
          built_in_variables: {
            create: record('create', { builtInVariable: [] }),
            delete: record('delete', {}),
            revert: record('revert', { enabled: true }),
          },
        },
      },
    },
  };
  const server = new McpServer(
    { name: 'built-in-variables-test', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  registerBuiltInVariableTools(server, () => client as never);
  return { server, calls };
}

/** Flips a guardrail flag for one call only, then puts it back exactly as it was. */
async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
}

const callTool = async (server: McpServer, name: string, args: Record<string, unknown>) => {
  const tool = (server as never as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content?: { text?: string }[] }> }> })._registeredTools[name];
  assert.ok(tool, `tool ${name} should be registered`);
  return tool.handler(args, { requestId: 'test' });
};
const text = (r: { content?: { text?: string }[] }) => r.content?.[0]?.text ?? '';

test('REGRESSION: revert addresses the workspace, not the built_in_variables collection', async () => {
  // Pre-fix `path` ended in /built_in_variables, and the client appended the segment a second
  // time, so the revert never reached the API.
  const { server, calls } = buildServer();
  const r = await withEnv('GTM_MCP_ENABLE_WRITES', 'true', () =>
    callTool(server, 'built_in_variables_revert', { ...WS, type: 'clickUrl', confirm: true })
  );
  assert.ok(!r.isError, text(r));
  const revert = calls.find((c) => c.verb === 'revert');
  assert.ok(revert, 'revert must have been called');
  assert.equal(revert.params['path'], WORKSPACE_PATH);
  assert.ok(
    !String(revert.params['path']).includes('built_in_variables'),
    'the client appends /built_in_variables:revert itself'
  );
  assert.equal(revert.params['type'], 'clickUrl');
});

test('delete keeps the collection segment revert must not have', async () => {
  // The other half of the asymmetry: delete really is addressed at the collection, so a future
  // "make these two consistent" edit must break this test rather than pass quietly.
  const { server, calls } = buildServer();
  const r = await withEnv('GTM_MCP_ENABLE_DELETES', 'true', () =>
    callTool(server, 'built_in_variables_disable', { ...WS, types: ['clickUrl'], confirm: true })
  );
  assert.ok(!r.isError, text(r));
  const del = calls.find((c) => c.verb === 'delete');
  assert.ok(del, 'delete must have been called');
  assert.equal(del.params['path'], `${WORKSPACE_PATH}/built_in_variables`);
});

test('revert still refuses without the write flag and without confirm', async () => {
  // Over-reporting guard: the path fix must not have loosened the gate in front of it.
  const { server, calls } = buildServer();
  const noFlag = await withEnv('GTM_MCP_ENABLE_WRITES', 'false', () =>
    callTool(server, 'built_in_variables_revert', { ...WS, type: 'clickUrl', confirm: true })
  );
  assert.equal(noFlag.isError, true);
  assert.match(text(noFlag), /GTM_MCP_ENABLE_WRITES/);

  const noConfirm = await withEnv('GTM_MCP_ENABLE_WRITES', 'true', () =>
    callTool(server, 'built_in_variables_revert', { ...WS, type: 'clickUrl', confirm: false })
  );
  assert.equal(noConfirm.isError, true);
  assert.match(text(noConfirm), /confirm=true/);

  assert.equal(calls.length, 0, 'no API call may escape the guardrail');
});
