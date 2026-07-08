/**
 * Node test for the Google identity resolver (Phase 3, slice 1).
 *
 * Imports the COMPILED module from dist. Uses an injected fetch + clock, so it
 * never touches the network. Verifies:
 *   - resolves an OAuth2Client carrying the vended Google access token,
 *   - caches per member (one Stytch call until expiry),
 *   - re-pulls after the cached token nears expiry, reusing the SAME client
 *     instance (so downstream per-auth client caches stay valid),
 *   - different members get different clients and separate calls,
 *   - NEVER requests include_refresh_token,
 *   - surfaces a clear error on a non-2xx Stytch response,
 *   - deriveApiBase picks live vs test host from the project id.
 *
 * Run: node src/__tests__/googleIdentityResolver.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distMod = path.resolve(__dirname, '../../dist/auth/googleIdentityResolver.js');
if (!existsSync(distMod)) {
  console.error(`\n✗ resolver test: ${distMod} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { createGoogleIdentityResolver, deriveApiBase, GoogleScopeError } = await import(
  pathToFileURL(distMod).href
);

let passed = 0;
let failed = 0;
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

// A controllable fake of Stytch's get-google-access-token endpoint.
function makeFetch(opts = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (opts.fail) {
      return {
        ok: false,
        status: opts.status ?? 500,
        text: async () => opts.body ?? "error",
      };
    }
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: `${opts.token ?? "tok"}-${n}`,
        access_token_expires_in: opts.expiresIn ?? 3600,
        scopes: opts.scopes ?? [
          "https://www.googleapis.com/auth/tagmanager.readonly",
          "https://www.googleapis.com/auth/analytics.readonly",
        ],
      }),
    };
  };
  return { fetchImpl, calls };
}

console.log('\nGoogle identity resolver:');

await test('deriveApiBase: live vs test host', () => {
  assert.strictEqual(deriveApiBase('project-live-abc'), 'https://api.stytch.com');
  assert.strictEqual(deriveApiBase('project-test-abc'), 'https://test.stytch.com');
});

await test('resolves a client carrying the vended access token', async () => {
  const { fetchImpl, calls } = makeFetch({ token: 'A' });
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x',
    secret: 's',
    fetchImpl,
    now: () => 1000,
  });
  const client = await r.resolve('org1', 'mem1');
  assert.strictEqual(client.credentials.access_token, 'A-1');
  assert.strictEqual(calls.length, 1);
  // Basic auth header present
  assert.ok(String(calls[0].init.headers.Authorization).startsWith('Basic '));
});

await test('never requests include_refresh_token', async () => {
  const { fetchImpl, calls } = makeFetch();
  const r = createGoogleIdentityResolver({ projectId: 'project-test-x', secret: 's', fetchImpl, now: () => 0 });
  await r.resolve('org1', 'mem1');
  assert.ok(!calls[0].url.includes('include_refresh_token'), 'must not pull the raw refresh token');
  // sanity: hits the documented path
  assert.ok(calls[0].url.includes('/v1/b2b/organizations/org1/members/mem1/oauth_providers/google'));
});

await test('caches per member until expiry (one call)', async () => {
  const { fetchImpl, calls } = makeFetch({ expiresIn: 3600 });
  let t = 0;
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x', secret: 's', fetchImpl, now: () => t, refreshBufferSeconds: 60,
  });
  const c1 = await r.resolve('org1', 'mem1');
  t = 1000; // 1s later, well within TTL
  const c2 = await r.resolve('org1', 'mem1');
  assert.strictEqual(calls.length, 1, 'second resolve should hit the cache');
  assert.strictEqual(c1, c2, 'same instance returned from cache');
  assert.strictEqual(r.cacheSize(), 1);
});

await test('re-pulls after expiry, reusing the same client instance', async () => {
  const { fetchImpl, calls } = makeFetch({ token: 'R', expiresIn: 100 });
  let t = 0;
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x', secret: 's', fetchImpl, now: () => t, refreshBufferSeconds: 10,
  });
  const c1 = await r.resolve('org1', 'mem1'); // token R-1, stale at 90_000ms
  assert.strictEqual(c1.credentials.access_token, 'R-1');
  t = 95_000; // past (100-10)s
  const c2 = await r.resolve('org1', 'mem1');
  assert.strictEqual(calls.length, 2, 'should re-pull after expiry');
  assert.strictEqual(c1, c2, 'same OAuth2Client instance reused across refresh');
  assert.strictEqual(c2.credentials.access_token, 'R-2', 'credentials refreshed in place');
});

await test('different members get different clients and separate calls', async () => {
  const { fetchImpl, calls } = makeFetch();
  const r = createGoogleIdentityResolver({ projectId: 'project-test-x', secret: 's', fetchImpl, now: () => 0 });
  const a = await r.resolve('org1', 'memA');
  const b = await r.resolve('org1', 'memB');
  assert.notStrictEqual(a, b);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(r.cacheSize(), 2);
});

await test('throws a clear error on a non-2xx Stytch response', async () => {
  const { fetchImpl } = makeFetch({ fail: true, status: 404, body: 'route_not_found' });
  const r = createGoogleIdentityResolver({ projectId: 'project-test-x', secret: 's', fetchImpl, now: () => 0 });
  await assert.rejects(() => r.resolve('org1', 'mem1'), /HTTP 404/);
});

await test('throws when access_token is missing', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ scopes: [] }) });
  const r = createGoogleIdentityResolver({ projectId: 'project-test-x', secret: 's', fetchImpl, now: () => 0 });
  await assert.rejects(() => r.resolve('org1', 'mem1'), /no access_token/);
});

await test('GoogleScopeError when grant lacks every required scope', async () => {
  const { fetchImpl } = makeFetch({
    scopes: ['https://www.googleapis.com/auth/userinfo.email', 'openid'],
  });
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x',
    secret: 's',
    fetchImpl,
    now: () => 0,
    requiredAnyScopes: [
      'https://www.googleapis.com/auth/tagmanager.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
  await assert.rejects(() => r.resolve('org1', 'mem1'), GoogleScopeError);
  assert.strictEqual(r.cacheSize(), 0, 'a rejected grant must not be cached');
});

await test('requiredAnyScopes passes when at least one is granted (host-prefix tolerant)', async () => {
  // Granted only the GTM read scope; required list also names GA4 — one match is enough.
  const { fetchImpl } = makeFetch({
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
  });
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x',
    secret: 's',
    fetchImpl,
    now: () => 0,
    requiredAnyScopes: [
      'https://www.googleapis.com/auth/tagmanager.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
  const client = await r.resolve('org1', 'mem1');
  assert.ok(client.credentials.access_token, 'resolves a usable client');
});

await test('bounds the cache at maxCacheEntries, evicting the LRU (touch-on-hit)', async () => {
  // now() fixed at 0 → nothing expires by TTL, so only the LRU bound can evict.
  const { fetchImpl, calls } = makeFetch();
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x',
    secret: 's',
    fetchImpl,
    now: () => 0,
    maxCacheEntries: 2,
  });
  await r.resolve('org1', 'mem1'); // miss → calls 1, cache [mem1]
  await r.resolve('org1', 'mem2'); // miss → calls 2, cache [mem1, mem2]
  await r.resolve('org1', 'mem1'); // hit  → calls 2, mem1 now most-recent [mem2, mem1]
  assert.strictEqual(calls.length, 2, 'touch is a cache hit, no extra Stytch call');

  await r.resolve('org1', 'mem3'); // miss → evicts the LRU (mem2), cache [mem1, mem3]
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(r.cacheSize(), 2, 'cache never exceeds maxCacheEntries');

  await r.resolve('org1', 'mem1'); // still cached (survived as most-recently-used) → no call
  assert.strictEqual(calls.length, 3, 'mem1 was retained, not evicted');

  await r.resolve('org1', 'mem2'); // evicted earlier → re-pulls
  assert.strictEqual(calls.length, 4, 'the LRU member (mem2) was evicted and must re-pull');
  assert.strictEqual(r.cacheSize(), 2);
});

await test('evicts expired entries before the LRU when the bound is hit', async () => {
  // mem1 gets a short TTL and goes stale; when the bound is hit it should be
  // dropped as expired (not counted against the live LRU victim).
  const { fetchImpl, calls } = makeFetch({ expiresIn: 100 });
  let t = 0;
  const r = createGoogleIdentityResolver({
    projectId: 'project-test-x',
    secret: 's',
    fetchImpl,
    now: () => t,
    refreshBufferSeconds: 10,
    maxCacheEntries: 2,
  });
  await r.resolve('org1', 'mem1'); // stale at (100-10)s = 90_000ms
  await r.resolve('org1', 'mem2');
  t = 95_000; // mem1 + mem2 now both past their staleness point
  await r.resolve('org1', 'mem3'); // bound hit → expired sweep clears room first
  assert.ok(r.cacheSize() <= 2, 'cache stays within the bound');
  assert.ok(calls.length >= 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
