/**
 * workspace_create_version_and_publish must report WHY create_version produced no version.
 *
 * GTM answers a create_version on a workspace that does not compile, or that is out of sync with
 * the live container, with compilerError / syncStatus and NO containerVersion at all. The handler
 * used to run the missing-versionId guard first, so exactly that case returned a bare
 * "Failed to get version ID from create_version response." and discarded the API's reason: the
 * compilerError branch below it was unreachable in the one situation it was written for, and
 * syncStatus (syncError / mergeConflict) was never read in either branch.
 *
 * Run: tsx src/__tests__/publish.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPublishTools } from '../tools/publish.js';
import type { GtmClient } from '../utils/gtmClient.js';

type Call = Record<string, unknown>;

/** `createResponse` is the body GTM returns from workspaces.create_version. */
function buildServer(createResponse: Record<string, unknown>) {
  const createCalls: Call[] = [];
  const publishCalls: Call[] = [];
  const workspaces = {
    create_version: (params: Call) => {
      createCalls.push(params);
      return Promise.resolve({ data: { ...createResponse } });
    },
  };
  const versions = {
    publish: (params: Call) => {
      publishCalls.push(params);
      return Promise.resolve({ data: { compilerError: false, containerVersion: { containerVersionId: '42' } } });
    },
  };
  const client = { accounts: { containers: { workspaces, versions } } } as unknown as GtmClient;
  const server = new McpServer({ name: 'publish-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerPublishTools(server, () => client);
  return { server, createCalls, publishCalls };
}

const ARGS = { accountId: '1', containerId: '2', workspaceId: '5', confirm: true };

async function run(server: McpServer, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools['workspace_create_version_and_publish'];
  return (await tool.handler({ ...ARGS, ...extra }, { requestId: 'test' })) as {
    isError?: boolean;
    content: { text: string }[];
  };
}

/** Publishing must be enabled for the handler to reach create_version at all. */
process.env.GTM_MCP_ENABLE_PUBLISH = 'true';
process.env.DRY_RUN = 'false';

test('REGRESSION: a compile failure with no version reports the compiler error, not "Failed to get version ID"', async () => {
  const body = { compilerError: true, syncStatus: { mergeConflict: false, syncError: false } };
  const { server, publishCalls } = buildServer(body);
  const r = await run(server);

  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.ok(!text.includes('Failed to get version ID'), `the generic message must not win: ${text}`);
  assert.ok(text.includes('compiler errors'), text);
  assert.ok(text.includes('"compilerError": true'), 'the API response must be dumped so the cause survives');
  assert.equal(publishCalls.length, 0, 'nothing may be published');
});

test('REGRESSION: a merge conflict is surfaced instead of being swallowed', async () => {
  const body = { syncStatus: { mergeConflict: true, syncError: false } };
  const { server, publishCalls } = buildServer(body);
  const r = await run(server);

  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.ok(text.includes('merge conflict'), text);
  assert.ok(text.includes('"mergeConflict": true'), 'the syncStatus must reach the caller');
  assert.equal(publishCalls.length, 0);
});

test('REGRESSION: a sync error is surfaced instead of being swallowed', async () => {
  const { server, publishCalls } = buildServer({ syncStatus: { mergeConflict: false, syncError: true } });
  const r = await run(server);

  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes('a sync error'), r.content[0].text);
  assert.equal(publishCalls.length, 0);
});

test('REGRESSION: a versionless response with no stated cause still carries the raw API body', async () => {
  const { server, publishCalls } = buildServer({ newWorkspacePath: 'accounts/1/containers/2/workspaces/6' });
  const r = await run(server);

  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.ok(text.includes('Failed to get version ID'), text);
  assert.ok(text.includes('newWorkspacePath'), 'the response must be dumped, not dropped');
  assert.equal(publishCalls.length, 0);
});

test('a compile failure that DID produce a version still names the version and refuses to publish', async () => {
  const body = { compilerError: true, containerVersion: { containerVersionId: '77' } };
  const { server, publishCalls } = buildServer(body);
  const r = await run(server);

  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes('Version created (77)'), r.content[0].text);
  assert.equal(publishCalls.length, 0);
});

test('a clean create still publishes: the new diagnosis must not block the happy path', async () => {
  const body = {
    compilerError: false,
    syncStatus: { mergeConflict: false, syncError: false },
    containerVersion: { containerVersionId: '42' },
  };
  const { server, publishCalls } = buildServer(body);
  const r = await run(server);

  assert.ok(!r.isError, r.content[0].text);
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].path, 'accounts/1/containers/2/versions/42');
  assert.equal(JSON.parse(r.content[0].text).publishedVersionId, '42');
});
