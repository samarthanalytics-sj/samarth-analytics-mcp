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
  findGtmContainer,
  normalizeContainerQuery,
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

console.log('pasted container id, normalisation');

for (const [input, expected] of [
  ['GTM-ABC1234', { kind: 'publicId', value: 'GTM-ABC1234' }],
  ['  gtm-abc1234  ', { kind: 'publicId', value: 'GTM-ABC1234' }],
  ['111222', { kind: 'containerId', value: '111222' }],
  [
    'https://tagmanager.google.com/#/container/accounts/6000/containers/111/workspaces/3',
    { kind: 'containerId', value: '111' },
  ],
] as const) {
  await test(`accepts ${JSON.stringify(input)}`, async () => {
    assert.deepEqual(normalizeContainerQuery(input), expected);
  });
}

for (const bad of ['', '   ', 'G-ABC123', 'not an id', 'GTM-', '<script>']) {
  await test(`rejects ${JSON.stringify(bad)}`, async () => {
    assert.equal(normalizeContainerQuery(bad), null);
  });
}

console.log('pasted container id, resolution');

/** An MCP whose reply depends on which tool was asked, so a scan can be simulated. */
function scriptedMcp(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const handler = handlers[name];
      if (!handler) return { ok: false, text: `${name} not scripted` };
      return { ok: true, text: JSON.stringify(handler(args)) };
    },
  } as unknown as McpConnection;
}

await test('finds a container in the second account and stops there', async () => {
  let containerCalls = 0;
  const mcp = scriptedMcp({
    accounts_list: () => ({
      accounts: [
        { accountId: '1', name: 'First' },
        { accountId: '2', name: 'Second' },
        { accountId: '3', name: 'Third' },
      ],
    }),
    containers_list: (args) => {
      containerCalls++;
      return args.accountId === '2'
        ? { containers: [{ accountId: '2', containerId: '99', name: 'Found', publicId: 'GTM-ABC1234' }] }
        : { containers: [] };
    },
  });

  const result = await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-ABC1234' });
  assert.equal(result.found, true);
  assert.equal(result.found && result.container.accountId, '2');
  // The third account is never touched: the scan is the expensive part, so it must short-circuit.
  assert.equal(containerCalls, 2);
});

await test('matches a public id case-insensitively', async () => {
  const mcp = scriptedMcp({
    accounts_list: () => ({ accounts: [{ accountId: '1', name: 'A' }] }),
    containers_list: () => ({
      containers: [{ containerId: '5', name: 'X', publicId: 'gtm-lower99' }],
    }),
  });
  assert.equal((await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-LOWER99' })).found, true);
});

await test('matches a numeric container id', async () => {
  const mcp = scriptedMcp({
    accounts_list: () => ({ accounts: [{ accountId: '1', name: 'A' }] }),
    containers_list: () => ({ containers: [{ containerId: '777', name: 'By number' }] }),
  });
  const result = await findGtmContainer(mcp, { kind: 'containerId', value: '777' });
  assert.equal(result.found && result.container.name, 'By number');
});

await test('a complete search that finds nothing reports itself as exhaustive', async () => {
  const mcp = scriptedMcp({
    accounts_list: () => ({ accounts: [{ accountId: '1', name: 'A' }] }),
    containers_list: () => ({ containers: [{ containerId: '5', publicId: 'GTM-OTHER11', name: 'X' }] }),
  });
  const result = await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-MISSING1' });
  assert.deepEqual(result, { found: false, accountsSearched: 1, exhaustive: true });
});

await test('a truncated account list makes a miss non-exhaustive', async () => {
  const mcp = scriptedMcp({
    accounts_list: () => ({ accounts: [{ accountId: '1', name: 'A' }], truncated: true }),
    containers_list: () => ({ containers: [] }),
  });
  // "Not found" here must not be reported to the user as "does not exist".
  assert.equal((await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-ABC1234' })).found, false);
  assert.equal(
    (await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-ABC1234' }) as { exhaustive: boolean })
      .exhaustive,
    false,
  );
});

await test('a truncated container list makes a miss non-exhaustive', async () => {
  const mcp = scriptedMcp({
    accounts_list: () => ({ accounts: [{ accountId: '1', name: 'A' }] }),
    containers_list: () => ({ containers: [{ containerId: '5', name: 'X' }], truncated: true }),
  });
  const result = await findGtmContainer(mcp, { kind: 'publicId', value: 'GTM-ABC1234' });
  assert.equal(result.found === false && result.exhaustive, false);
});

await test('an unreadable account is skipped, and the search stops claiming completeness', async () => {
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === 'accounts_list') {
        return {
          ok: true,
          text: JSON.stringify({
            accounts: [
              { accountId: '1', name: 'Denied' },
              { accountId: '2', name: 'Fine' },
            ],
          }),
        };
      }
      if (args.accountId === '1') return { ok: false, text: 'containers_list failed: forbidden' };
      return { ok: true, text: JSON.stringify({ containers: [{ containerId: '8', name: 'Y' }] }) };
    },
  } as unknown as McpConnection;

  // The readable account is still searched, so one bad grant does not break the feature.
  const hit = await findGtmContainer(mcp, { kind: 'containerId', value: '8' });
  assert.equal(hit.found, true);

  const miss = await findGtmContainer(mcp, { kind: 'containerId', value: '404' });
  assert.equal(miss.found === false && miss.exhaustive, false);
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
