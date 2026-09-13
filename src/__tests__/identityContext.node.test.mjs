/**
 * Node test for the per-request identity seam (Phase 1 of multi-user OAuth).
 *
 * Imports the COMPILED modules from dist (CI builds before `npm test`). Verifies:
 *   - resolveAuth() returns the fallback when no identity context is active,
 *   - runWithAuth() makes resolveAuth()/getActiveAuth() return the scoped auth,
 *   - the scoped identity survives across awaits (AsyncLocalStorage propagation),
 *   - nested and concurrent contexts don't bleed into each other,
 *   - the GTM/GA4 client factories cache per-auth (no global singleton):
 *     same auth → same client, different auth → different client.
 *
 * Run: node src/__tests__/identityContext.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');
const idMod = path.join(distDir, 'auth/identityContext.js');
const gtmMod = path.join(distDir, 'utils/gtmClient.js');
const ga4Mod = path.join(distDir, 'utils/ga4Client.js');

for (const f of [idMod, gtmMod, ga4Mod]) {
  if (!existsSync(f)) {
    console.error(`\n✗ identityContext test: ${f} not found. Run "npm run build" before "npm test".`);
    process.exit(1);
  }
}

const { runWithAuth, getActiveAuth, resolveAuth } = await import(pathToFileURL(idMod).href);
const { getGtmClient, resetGtmClient } = await import(pathToFileURL(gtmMod).href);
const {
  getGa4AdminClient,
  getGa4AdminAlphaClient,
  getGa4DataClient,
  resetGa4AdminClient,
} = await import(pathToFileURL(ga4Mod).href);

// Sentinel "auth" objects — the factories only store them on the googleapis
// client and never call them in this test, so plain objects suffice.
const authA = { id: 'A' };
const authB = { id: 'B' };

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

console.log('\nIdentity context + per-auth client caching:');

await test('resolveAuth returns the fallback outside any context', () => {
  assert.strictEqual(resolveAuth(authA), authA);
  assert.strictEqual(getActiveAuth(), undefined);
});

await test('runWithAuth scopes the active identity', () => {
  const out = runWithAuth(authB, () => resolveAuth(authA));
  assert.strictEqual(out, authB, 'scoped auth should override the fallback');
  assert.strictEqual(getActiveAuth(), undefined, 'context must not leak after run');
});

await test('scoped identity survives across awaits', async () => {
  const out = await runWithAuth(authB, async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    return resolveAuth(authA);
  });
  assert.strictEqual(out, authB);
});

await test('nested contexts use the innermost identity', () => {
  const out = runWithAuth(authA, () => runWithAuth(authB, () => resolveAuth(authA)));
  assert.strictEqual(out, authB);
  // ...and the outer context is restored after the inner returns
  const outer = runWithAuth(authA, () => {
    runWithAuth(authB, () => resolveAuth(authA));
    return resolveAuth(authB);
  });
  assert.strictEqual(outer, authA);
});

await test('concurrent contexts do not bleed into each other', async () => {
  const [ra, rb] = await Promise.all([
    runWithAuth(authA, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return resolveAuth(authB);
    }),
    runWithAuth(authB, async () => {
      await new Promise((r) => setTimeout(r, 2));
      return resolveAuth(authA);
    }),
  ]);
  assert.strictEqual(ra, authA);
  assert.strictEqual(rb, authB);
});

await test('getGtmClient caches per auth, not globally', () => {
  resetGtmClient();
  const a1 = getGtmClient(authA);
  const a2 = getGtmClient(authA);
  const b1 = getGtmClient(authB);
  assert.strictEqual(a1, a2, 'same auth must return the same cached client');
  assert.notStrictEqual(a1, b1, 'different auth must return a different client');
});

await test('GA4 admin/alpha/data clients each cache per auth', () => {
  resetGa4AdminClient();
  assert.strictEqual(getGa4AdminClient(authA), getGa4AdminClient(authA));
  assert.notStrictEqual(getGa4AdminClient(authA), getGa4AdminClient(authB));
  assert.strictEqual(getGa4AdminAlphaClient(authA), getGa4AdminAlphaClient(authA));
  assert.notStrictEqual(getGa4AdminAlphaClient(authA), getGa4AdminAlphaClient(authB));
  assert.strictEqual(getGa4DataClient(authA), getGa4DataClient(authA));
  assert.notStrictEqual(getGa4DataClient(authA), getGa4DataClient(authB));
});

await test('resetGtmClient clears the per-auth cache', () => {
  const before = getGtmClient(authA);
  resetGtmClient();
  const after = getGtmClient(authA);
  assert.notStrictEqual(before, after, 'reset should force a fresh client');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
