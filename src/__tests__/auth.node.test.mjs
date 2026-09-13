/**
 * Simple Node test for auth env-var resolution and token file helpers.
 * Mirrors the resolution logic in src/auth/googleAuth.ts without importing
 * the TS source — this matches the style of guardrails.node.test.mjs.
 *
 * Run: node src/__tests__/auth.node.test.mjs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_REDIRECT_URI = 'http://localhost:3001/oauth/callback';
const DEFAULT_TOKEN_FILE = '.gtm-mcp-tokens.json';

function resolveOAuthClient(env) {
  const redirectUri =
    env.GOOGLE_OAUTH_REDIRECT_URI ?? env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  if (env.SAMARTH_GOOGLE_OAUTH_CLIENT_ID && env.SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      clientId: env.SAMARTH_GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri,
      source: 'samarth-hosted',
    };
  }
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUri, source: 'self-hosted' };
  }
  return null;
}

function getTokenFilePath(env, cwd) {
  const configured = env.GTM_MCP_TOKEN_FILE;
  if (configured && configured.trim().length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }
  return path.resolve(cwd, DEFAULT_TOKEN_FILE);
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`     ${err.message}`);
  }
}

console.log('auth resolution tests:');

test('returns null when nothing is configured', () => {
  assert.strictEqual(resolveOAuthClient({}), null);
});

test('prefers new GOOGLE_OAUTH_* names over legacy', () => {
  const r = resolveOAuthClient({
    GOOGLE_OAUTH_CLIENT_ID: 'new-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'new-secret',
    GOOGLE_CLIENT_ID: 'old-id',
    GOOGLE_CLIENT_SECRET: 'old-secret',
  });
  assert.strictEqual(r.clientId, 'new-id');
  assert.strictEqual(r.clientSecret, 'new-secret');
  assert.strictEqual(r.source, 'self-hosted');
});

test('falls back to legacy GOOGLE_CLIENT_* names', () => {
  const r = resolveOAuthClient({
    GOOGLE_CLIENT_ID: 'old-id',
    GOOGLE_CLIENT_SECRET: 'old-secret',
  });
  assert.strictEqual(r.clientId, 'old-id');
  assert.strictEqual(r.source, 'self-hosted');
});

test('SAMARTH_GOOGLE_OAUTH_* takes precedence and reports samarth-hosted', () => {
  const r = resolveOAuthClient({
    SAMARTH_GOOGLE_OAUTH_CLIENT_ID: 's-id',
    SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET: 's-secret',
    GOOGLE_OAUTH_CLIENT_ID: 'new-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'new-secret',
  });
  assert.strictEqual(r.clientId, 's-id');
  assert.strictEqual(r.source, 'samarth-hosted');
});

test('default redirect URI is used when none set', () => {
  const r = resolveOAuthClient({
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  });
  assert.strictEqual(r.redirectUri, DEFAULT_REDIRECT_URI);
});

test('custom redirect URI is honoured (new var name)', () => {
  const r = resolveOAuthClient({
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:9999/cb',
  });
  assert.strictEqual(r.redirectUri, 'http://localhost:9999/cb');
});

console.log('token file path tests:');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-mcp-test-'));

test('default path resolves to cwd/.gtm-mcp-tokens.json', () => {
  const p = getTokenFilePath({}, tmpDir);
  assert.strictEqual(p, path.join(tmpDir, DEFAULT_TOKEN_FILE));
});

test('relative GTM_MCP_TOKEN_FILE resolves against cwd', () => {
  const p = getTokenFilePath({ GTM_MCP_TOKEN_FILE: 'sub/tokens.json' }, tmpDir);
  assert.strictEqual(p, path.join(tmpDir, 'sub/tokens.json'));
});

test('absolute GTM_MCP_TOKEN_FILE is preserved', () => {
  const abs = path.join(tmpDir, 'abs-tokens.json');
  const p = getTokenFilePath({ GTM_MCP_TOKEN_FILE: abs }, '/somewhere/else');
  assert.strictEqual(p, abs);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll auth tests passed.');
}
