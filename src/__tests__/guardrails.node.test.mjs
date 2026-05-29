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

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
