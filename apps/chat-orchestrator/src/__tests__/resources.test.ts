/**
 * Resource picker tests.
 *
 * These functions decide what a user sees in a dropdown and which ids then reach the Google API, so
 * the assertions concentrate on the ways a list can lie: a truncated page presented as the whole
 * set, a failed call presented as an empty account, and a GA4 resource name passed through in the
 * form the tools cannot accept.
 */
import assert from 'node:assert/strict';
import {
  listGa4Properties,
  listGtmAccounts,
  listGtmContainers,
  listGtmWorkspaces,
  ResourceError,
} from '../resources.js';
import type { McpConnection } from '../mcp-client.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** A stand-in MCP that returns a canned payload and records what it was asked for. */
function fakeMcp(response: { ok: boolean; text: string }): {
  mcp: McpConnection;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return response;
    },
  } as unknown as McpConnection;
  return { mcp, calls };
}

const json = (body: unknown) => ({ ok: true, text: JSON.stringify(body) });

console.log('GTM accounts');

await test('maps id and name', async () => {
  const { mcp } = fakeMcp(
    json({ accounts: [{ accountId: '6000', name: 'Samarth Analytics' }], count: 1 }),
  );
  const result = await listGtmAccounts(mcp);
  assert.deepEqual(result.items, [{ accountId: '6000', name: 'Samarth Analytics' }]);
  assert.equal(result.truncated, false);
});

await test('carries truncation through instead of hiding it', async () => {
  const { mcp } = fakeMcp(
    json({ accounts: [{ accountId: '1', name: 'A' }], count: 1, truncated: true }),
  );
  assert.equal((await listGtmAccounts(mcp)).truncated, true);
});

await test('an entry with no id is dropped rather than rendered unselectable', async () => {
  const { mcp } = fakeMcp(json({ accounts: [{ name: 'No id' }, { accountId: '7', name: 'Fine' }] }));
  const result = await listGtmAccounts(mcp);
  assert.deepEqual(result.items.map((a) => a.accountId), ['7']);
});

await test('an unnamed account still gets a label', async () => {
  const { mcp } = fakeMcp(json({ accounts: [{ accountId: '42' }] }));
  assert.equal((await listGtmAccounts(mcp)).items[0].name, 'Account 42');
});

console.log('failures are raised, not flattened to an empty list');

await test('a tool error throws', async () => {
  const { mcp } = fakeMcp({ ok: false, text: 'accounts_list failed: insufficient permissions' });
  await assert.rejects(() => listGtmAccounts(mcp), (err: unknown) => {
    assert.ok(err instanceof ResourceError);
    assert.equal(err.code, 'tool_failed');
    assert.match(err.message, /insufficient permissions/);
    return true;
  });
});

await test('a non-JSON result throws rather than showing nothing', async () => {
  const { mcp } = fakeMcp({ ok: true, text: 'not json at all' });
  await assert.rejects(() => listGtmAccounts(mcp), (err: unknown) => {
    assert.ok(err instanceof ResourceError);
    assert.equal(err.code, 'bad_result');
    return true;
  });
});

await test('a genuinely empty account is an empty list, not an error', async () => {
  const { mcp } = fakeMcp(json({ accounts: [], count: 0 }));
  const result = await listGtmAccounts(mcp);
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, false);
});

console.log('GTM containers');

await test('passes the account id and keeps the public id and usage context', async () => {
  const { mcp, calls } = fakeMcp(
    json({
      containers: [
        {
          accountId: '6000',
          containerId: '111',
          name: 'Main Web',
          publicId: 'GTM-ABC123',
          usageContext: ['web'],
        },
      ],
    }),
  );
  const result = await listGtmContainers(mcp, '6000');
  assert.deepEqual(calls[0], { name: 'containers_list', args: { accountId: '6000' } });
  assert.equal(result.items[0].publicId, 'GTM-ABC123');
  assert.deepEqual(result.items[0].usageContext, ['web']);
});

await test('an empty usageContext becomes undefined rather than an empty suffix', async () => {
  const { mcp } = fakeMcp(json({ containers: [{ containerId: '1', name: 'X', usageContext: [] }] }));
  assert.equal((await listGtmContainers(mcp, '6000')).items[0].usageContext, undefined);
});

await test('a container missing its accountId inherits the one that was asked for', async () => {
  const { mcp } = fakeMcp(json({ containers: [{ containerId: '9', name: 'Orphan' }] }));
  assert.equal((await listGtmContainers(mcp, '6000')).items[0].accountId, '6000');
});

console.log('GTM workspaces');

await test('passes both ids', async () => {
  const { mcp, calls } = fakeMcp(
    json({ workspaces: [{ workspaceId: '3', name: 'Default Workspace' }] }),
  );
  const result = await listGtmWorkspaces(mcp, '6000', '111');
  assert.deepEqual(calls[0].args, { accountId: '6000', containerId: '111' });
  assert.equal(result.items[0].name, 'Default Workspace');
});

console.log('GA4 properties');

await test('flattens property summaries and strips the resource prefix', async () => {
  const { mcp } = fakeMcp(
    json({
      accountSummaries: [
        {
          account: 'accounts/123',
          displayName: 'Client Group',
          propertySummaries: [
            { property: 'properties/456789', displayName: 'Main Site' },
            { property: 'properties/987654', displayName: 'App' },
          ],
        },
      ],
    }),
  );
  const result = await listGa4Properties(mcp);
  // Every GA4 tool in this MCP takes the bare id; passing "properties/456789" through would fail.
  assert.deepEqual(result.items, [
    { propertyId: '456789', displayName: 'Main Site', accountName: 'Client Group' },
    { propertyId: '987654', displayName: 'App', accountName: 'Client Group' },
  ]);
});

await test('keeps the account name so duplicate property names stay distinguishable', async () => {
  const { mcp } = fakeMcp(
    json({
      accountSummaries: [
        {
          displayName: 'Agency A',
          propertySummaries: [{ property: 'properties/1', displayName: 'Website' }],
        },
        {
          displayName: 'Agency B',
          propertySummaries: [{ property: 'properties/2', displayName: 'Website' }],
        },
      ],
    }),
  );
  const result = await listGa4Properties(mcp);
  assert.deepEqual(result.items.map((p) => p.accountName), ['Agency A', 'Agency B']);
});

await test('an account with no properties contributes nothing', async () => {
  const { mcp } = fakeMcp(
    json({ accountSummaries: [{ displayName: 'Empty', propertySummaries: [] }] }),
  );
  assert.deepEqual((await listGa4Properties(mcp)).items, []);
});

await test('a malformed property summary is skipped, not rendered as undefined', async () => {
  const { mcp } = fakeMcp(
    json({
      accountSummaries: [
        {
          displayName: 'Mixed',
          propertySummaries: [null, { displayName: 'No resource name' }, { property: 'properties/5' }],
        },
      ],
    }),
  );
  const result = await listGa4Properties(mcp);
  assert.deepEqual(result.items, [
    { propertyId: '5', displayName: 'Property 5', accountName: 'Mixed' },
  ]);
});

await test('truncation survives the flatten', async () => {
  const { mcp } = fakeMcp(json({ accountSummaries: [], truncated: true }));
  assert.equal((await listGa4Properties(mcp)).truncated, true);
});

console.log(`\n${passed} resource test(s) passed`);
