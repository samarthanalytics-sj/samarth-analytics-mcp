/**
 * Simple Node test for guardrails (no Jest/framework dependency)
 * Run: node src/__tests__/guardrails.node.test.mjs
 * Or after build: node dist/__tests__/guardrails.node.test.mjs
 */

import assert from 'assert';

// Inline the tested logic to avoid heavy imports in this environment

function getGuardrailConfig() {
  return {
    writesEnabled: process.env.GTM_MCP_ENABLE_WRITES === 'true',
    publishEnabled: process.env.GTM_MCP_ENABLE_PUBLISH === 'true',
    deletesEnabled: process.env.GTM_MCP_ENABLE_DELETES === 'true',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

function checkGuardrails(opType, confirm, config) {
  if (confirm !== true) {
    throw new Error('confirm=true is required');
  }
  if (opType === 'write' && !config.writesEnabled) {
    throw new Error('GTM_MCP_ENABLE_WRITES is required');
  }
  if (opType === 'delete' && !config.deletesEnabled) {
    throw new Error('GTM_MCP_ENABLE_DELETES is required');
  }
  if (opType === 'publish' && !config.publishEnabled) {
    throw new Error('GTM_MCP_ENABLE_PUBLISH is required');
  }
  return { dryRun: config.dryRun };
}

function buildPath(accountId, containerId, workspaceId, resource, resourceId) {
  let path = `accounts/${accountId}`;
  if (containerId) path += `/containers/${containerId}`;
  if (workspaceId) path += `/workspaces/${workspaceId}`;
  if (resource) path += `/${resource}`;
  if (resourceId) path += `/${resourceId}`;
  return path;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── guardrails ─────────────────────────────────────────────────────────────
console.log('\nGuardrails:');

const readOnly = { writesEnabled: false, publishEnabled: false, deletesEnabled: false, dryRun: false };
const full = { writesEnabled: true, publishEnabled: true, deletesEnabled: true, dryRun: false };
const dryRun = { writesEnabled: true, publishEnabled: true, deletesEnabled: true, dryRun: true };

test('throws when confirm is false', () => {
  assert.throws(() => checkGuardrails('write', false, full), /confirm=true/);
});

test('throws when confirm is undefined', () => {
  assert.throws(() => checkGuardrails('write', undefined, full), /confirm=true/);
});

test('throws writes disabled', () => {
  assert.throws(() => checkGuardrails('write', true, readOnly), /GTM_MCP_ENABLE_WRITES/);
});

test('throws publish disabled', () => {
  assert.throws(() => checkGuardrails('publish', true, readOnly), /GTM_MCP_ENABLE_PUBLISH/);
});

test('throws deletes disabled', () => {
  assert.throws(() => checkGuardrails('delete', true, readOnly), /GTM_MCP_ENABLE_DELETES/);
});

test('allows write when enabled', () => {
  const r = checkGuardrails('write', true, full);
  assert.strictEqual(r.dryRun, false);
});

test('returns dryRun=true in dry-run config', () => {
  const r = checkGuardrails('write', true, dryRun);
  assert.strictEqual(r.dryRun, true);
});

// ── buildPath ──────────────────────────────────────────────────────────────
console.log('\nbuildPath:');

test('account only', () => {
  assert.strictEqual(buildPath('123'), 'accounts/123');
});

test('account + container', () => {
  assert.strictEqual(buildPath('123', '456'), 'accounts/123/containers/456');
});

test('account + container + workspace', () => {
  assert.strictEqual(buildPath('123', '456', '789'), 'accounts/123/containers/456/workspaces/789');
});

test('full path with resource', () => {
  assert.strictEqual(
    buildPath('123', '456', '789', 'tags', '99'),
    'accounts/123/containers/456/workspaces/789/tags/99'
  );
});

// ── user_permissions_update: revoking access is delete-tier ───────────────────
// The real tool, compiled, against a recording client. user_permissions_update was write-tier only,
// yet it can do exactly what the delete-tier user_permissions_delete does: set noAccess, or (the API
// replaces the record) drop a container from the list. With GTM_MCP_ENABLE_WRITES=true and
// GTM_MCP_ENABLE_DELETES=false - a server configured to refuse deletes - it locked users out.
console.log('\nuser_permissions_update tiering:');

const { existsSync } = await import('fs');
const { fileURLToPath, pathToFileURL } = await import('url');
const nodePath = (await import('path')).default;
const here = nodePath.dirname(fileURLToPath(import.meta.url));
const distUserPerms = nodePath.resolve(here, '../../dist/tools/userPermissions.js');
const distSdk = nodePath.resolve(here, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
if (!existsSync(distUserPerms)) {
  console.error(`\n✗ guardrails test: ${distUserPerms} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}
const { registerUserPermissionTools } = await import(pathToFileURL(distUserPerms).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

/** The record as GTM holds it before the update: user on the account, edit on two containers. */
const EXISTING_PERMISSION = {
  path: 'accounts/1/user_permissions/7',
  emailAddress: 'someone@example.com',
  accountAccess: { permission: 'user' },
  containerAccess: [
    { containerId: '10', permission: 'edit' },
    { containerId: '20', permission: 'read' },
  ],
};

function userPermServer() {
  const calls = [];
  const client = {
    accounts: {
      user_permissions: {
        get: async (p) => { calls.push({ verb: 'get', params: p }); return { data: structuredClone(EXISTING_PERMISSION) }; },
        update: async (p) => { calls.push({ verb: 'update', params: p }); return { data: p.requestBody }; },
      },
    },
  };
  const server = new McpServer({ name: 'guardrails-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerUserPermissionTools(server, () => client);
  const run = (args) =>
    server._registeredTools.user_permissions_update.handler(
      { accountId: '1', userPermissionId: '7', confirm: true, ...args },
      { requestId: 'test' }
    );
  return { run, calls };
}

const withFlags = async (flags, fn) => {
  const saved = { w: process.env.GTM_MCP_ENABLE_WRITES, d: process.env.GTM_MCP_ENABLE_DELETES, dry: process.env.DRY_RUN };
  process.env.GTM_MCP_ENABLE_WRITES = flags.writes ? 'true' : 'false';
  process.env.GTM_MCP_ENABLE_DELETES = flags.deletes ? 'true' : 'false';
  process.env.DRY_RUN = 'false';
  try { await fn(); } finally {
    for (const [k, v] of [['GTM_MCP_ENABLE_WRITES', saved.w], ['GTM_MCP_ENABLE_DELETES', saved.d], ['DRY_RUN', saved.dry]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};
const resText = (r) => r?.content?.[0]?.text ?? '';

await testAsync('accountPermission "noAccess" needs GTM_MCP_ENABLE_DELETES (writes on, deletes off)', () =>
  withFlags({ writes: true, deletes: false }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ accountPermission: 'noAccess' });
    assert.ok(r.isError && /GTM_MCP_ENABLE_DELETES/.test(resText(r)), `expected the delete gate, got: ${resText(r)}`);
    assert.strictEqual(calls.filter((c) => c.verb === 'update').length, 0, 'no update may be sent');
  }));

await testAsync('a container set to "noAccess" needs GTM_MCP_ENABLE_DELETES', () =>
  withFlags({ writes: true, deletes: false }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ containerAccess: [{ containerId: '10', permission: 'noAccess' }, { containerId: '20', permission: 'read' }] });
    assert.ok(r.isError && /GTM_MCP_ENABLE_DELETES/.test(resText(r)), `expected the delete gate, got: ${resText(r)}`);
    assert.strictEqual(calls.filter((c) => c.verb === 'update').length, 0);
  }));

await testAsync('leaving a container out of containerAccess revokes it, so it needs GTM_MCP_ENABLE_DELETES', () =>
  withFlags({ writes: true, deletes: false }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ containerAccess: [{ containerId: '10', permission: 'publish' }] });
    assert.ok(r.isError && /GTM_MCP_ENABLE_DELETES/.test(resText(r)), `expected the delete gate, got: ${resText(r)}`);
    assert.ok(/\b20\b/.test(resText(r)), 'names the container that would lose access');
    assert.strictEqual(calls.filter((c) => c.verb === 'update').length, 0);
  }));

await testAsync('a plain user -> admin change still goes through, keeping the container grants', () =>
  withFlags({ writes: true, deletes: false }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ accountPermission: 'admin' });
    assert.ok(!r.isError, resText(r));
    const update = calls.find((c) => c.verb === 'update');
    assert.ok(update, 'the update was sent');
    assert.strictEqual(update.params.path, 'accounts/1/user_permissions/7');
    assert.deepStrictEqual(update.params.requestBody.accountAccess, { permission: 'admin' });
    // Full-replace API: an omitted containerAccess used to go out absent, stripping both grants.
    assert.deepStrictEqual(update.params.requestBody.containerAccess, EXISTING_PERMISSION.containerAccess);
  }));

await testAsync('with deletes enabled, an explicit revocation is allowed', () =>
  withFlags({ writes: true, deletes: true }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ accountPermission: 'noAccess', containerAccess: [] });
    assert.ok(!r.isError, resText(r));
    assert.deepStrictEqual(calls.find((c) => c.verb === 'update').params.requestBody, { accountAccess: { permission: 'noAccess' }, containerAccess: [] });
  }));

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
