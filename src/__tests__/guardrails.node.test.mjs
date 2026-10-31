/**
 * Simple Node test for guardrails (no Jest/framework dependency)
 * Run: node src/__tests__/guardrails.node.test.mjs
 * Or after build: node dist/__tests__/guardrails.node.test.mjs
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

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

// existsSync / fileURLToPath / pathToFileURL / path come from the static imports at the top.
const here = path.dirname(fileURLToPath(import.meta.url));
const distUserPerms = path.resolve(here, '../../dist/tools/userPermissions.js');
const distSdk = path.resolve(here, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
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
  process.env.DRY_RUN = flags.dryRun ? 'true' : 'false';
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

// A dry run sends nothing, not even the GET that shows which containers a list leaves out, so the
// dropped-container check above cannot run. The preview used to read "[DRY RUN] Would update ..." as
// if the write flag were enough; the real call would then be refused for GTM_MCP_ENABLE_DELETES.
await testAsync('REGRESSION: DRY_RUN with a containerAccess list says leaving a container out needs GTM_MCP_ENABLE_DELETES', () =>
  withFlags({ writes: true, deletes: false, dryRun: true }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ containerAccess: [{ containerId: '10', permission: 'publish' }] });
    assert.ok(!r.isError, resText(r));
    assert.match(resText(r), /^\[DRY RUN\]/);
    assert.match(resText(r), /GTM_MCP_ENABLE_DELETES=true/, `the preview must name the deletes flag: ${resText(r)}`);
    assert.deepStrictEqual(calls, [], 'a dry run sends nothing, not even the GET');
  }));

await testAsync('DRY_RUN without containerAccess does not mention the deletes flag', () =>
  withFlags({ writes: true, deletes: false, dryRun: true }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ accountPermission: 'admin' });
    assert.ok(!r.isError, resText(r));
    assert.doesNotMatch(resText(r), /GTM_MCP_ENABLE_DELETES/);
    assert.deepStrictEqual(calls, []);
  }));

await testAsync('with deletes enabled, an explicit revocation is allowed', () =>
  withFlags({ writes: true, deletes: true }, async () => {
    const { run, calls } = userPermServer();
    const r = await run({ accountPermission: 'noAccess', containerAccess: [] });
    assert.ok(!r.isError, resText(r));
    assert.deepStrictEqual(calls.find((c) => c.verb === 'update').params.requestBody, { accountAccess: { permission: 'noAccess' }, containerAccess: [] });
  }));

// ── smoke-all-tools child environment ──────────────────────────────────────
// scripts/smoke-all-tools.mjs calls EVERY tool (deletes, archives and publishes included) with
// confirm:true, and promises each one fails at the auth or guardrail layer before reaching Google.
// It stripped GTM_MCP_ENABLE_* but never GA4_MCP_ENABLE_*, and it only DELETED keys - which the
// server's `import 'dotenv/config'` then refilled from a developer .env in the repo root.
console.log('\nsmoke-all-tools child environment:');

// `here` is declared once above (user_permissions_update section).
const repoRoot = path.resolve(here, '../..');
const smokePath = path.join(repoRoot, 'scripts/smoke-all-tools.mjs');
const smokeSrc = readFileSync(smokePath, 'utf-8');
const ALL_FLAGS = [
  'GTM_MCP_ENABLE_WRITES',
  'GTM_MCP_ENABLE_PUBLISH',
  'GTM_MCP_ENABLE_DELETES',
  'GA4_MCP_ENABLE_WRITES',
  'GA4_MCP_ENABLE_DELETES',
];
const CREDS = [
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SAMARTH_GOOGLE_OAUTH_CLIENT_ID',
  'SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET',
];
// What a developer shell + .env might hold.
const HOSTILE = {
  ...Object.fromEntries(ALL_FLAGS.map((k) => [k, 'true'])),
  ...Object.fromEntries(CREDS.map((k) => [k, `leaked-${k}`])),
  GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/.config/gcloud/application_default_credentials.json',
  GTM_MCP_TOKEN_FILE: '/repo/.gtm-mcp-tokens.json',
  DOTENV_CONFIG_PATH: '/repo/.env',
  DOTENV_CONFIG_OVERRIDE: 'true',
};

// Importing the pre-fix script would RUN it (spawn the server and call every tool), so check that it
// only runs when executed directly before importing it.
let smoke;
test('REGRESSION: importing smoke-all-tools does not run it', () => {
  assert.match(smokeSrc, /if \(isMainModule\(\)\)/, 'main() runs unconditionally at import');
});
if (/if \(isMainModule\(\)\)/.test(smokeSrc)) smoke = await import(pathToFileURL(smokePath).href);

test('REGRESSION: every write/publish/delete flag, GA4 included, is pinned to "false"', () => {
  assert.ok(smoke && typeof smoke.buildSmokeChildEnv === 'function', 'buildSmokeChildEnv not exported');
  const env = smoke.buildSmokeChildEnv(HOSTILE, '/tmp/smoke-sandbox');
  for (const k of ALL_FLAGS) assert.strictEqual(env[k], 'false', k);
  // Present but empty, so dotenv cannot fill them in again.
  for (const k of CREDS) assert.strictEqual(env[k], '', k);
  assert.strictEqual(env.DRY_RUN, 'true');
  assert.strictEqual(env.DOTENV_CONFIG_OVERRIDE, undefined, 'a parent DOTENV_CONFIG_OVERRIDE must not survive');
  for (const k of ['DOTENV_CONFIG_PATH', 'GTM_MCP_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.ok(env[k].startsWith('/tmp/smoke-sandbox'), `${k} must point into the sandbox, got ${env[k]}`);
  }
});

test("REGRESSION: the server's dotenv load cannot bring credentials or flags back", () => {
  assert.ok(smoke && typeof smoke.buildSmokeChildEnv === 'function', 'buildSmokeChildEnv not exported');
  // A repo-root .env full of credentials and enabled flags, and the child started right next to it:
  // the worst case even if the sandbox cwd were lost.
  const repoLike = mkdtempSync(path.join(os.tmpdir(), 'smoke-env-repo-'));
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'smoke-env-sandbox-'));
  try {
    writeFileSync(
      path.join(repoLike, '.env'),
      Object.entries(HOSTILE)
        .filter(([k]) => !k.startsWith('DOTENV_'))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n'
    );
    const env = smoke.buildSmokeChildEnv(HOSTILE, sandbox);
    const dotenvConfig = createRequire(import.meta.url).resolve('dotenv/config');
    const probe =
      `await import(${JSON.stringify(pathToFileURL(dotenvConfig).href)});` +
      `const keys = ${JSON.stringify([...ALL_FLAGS, ...CREDS, 'GOOGLE_APPLICATION_CREDENTIALS', 'GTM_MCP_TOKEN_FILE'])};` +
      'console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))));';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: repoLike, env, encoding: 'utf-8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const k of ALL_FLAGS) assert.strictEqual(seen[k], 'false', `${k} came back from .env`);
    for (const k of CREDS) assert.strictEqual(seen[k], '', `${k} came back from .env`);
    assert.ok(!existsSync(seen.GOOGLE_APPLICATION_CREDENTIALS), 'ADC must point at a file that does not exist');
    assert.ok(seen.GTM_MCP_TOKEN_FILE.startsWith(sandbox), seen.GTM_MCP_TOKEN_FILE);
  } finally {
    rmSync(repoLike, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the child runs in the sandbox and the run aborts if the server still loads credentials', () => {
  assert.match(smokeSrc, /cwd: sandbox/, 'the child must not run in the repo root next to .env');
  // The abort keys on the exact lines buildGoogleAuth logs; keep the two in sync.
  const googleAuthSrc = readFileSync(path.join(repoRoot, 'src/auth/googleAuth.ts'), 'utf-8');
  for (const line of ['[auth] Using OAuth2 user credentials', '[auth] Using service account credentials']) {
    assert.ok(googleAuthSrc.includes(line), `googleAuth.ts no longer logs "${line}"`);
    assert.ok(smokeSrc.includes(line.replace('[auth] Using ', '')), `smoke-all-tools does not detect "${line}"`);
  }
  const abort = smokeSrc.indexOf('if (credentialsLoaded)');
  assert.ok(abort >= 0, 'no credential-leak abort');
  assert.ok(abort < smokeSrc.indexOf('"tools/call"'), 'the abort must run before any tool is called');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
