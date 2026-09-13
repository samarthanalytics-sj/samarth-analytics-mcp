/**
 * Node test for the HTTP transport's bind/refuse decision (httpBinding.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before `npm test`), matching the
 * other .node.test.mjs files here.
 *
 * The hole: with GTM_MCP_TRANSPORT=http and no auth configured, the bearer check lived inside
 * `if (staticToken)` so it never ran, and `app.listen(port)` binds every interface - so the server
 * served its own Google credentials to anyone who could reach the port, behind one stderr warning.
 *
 * Run: node src/__tests__/httpBinding.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/utils/httpBinding.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ httpBinding test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { resolveHttpBinding, bindingBanner, LOOPBACK, ALL_INTERFACES } = await import(
  pathToFileURL(distPath).href
);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log('\nHTTP binding:');

// ── the hole itself ───────────────────────────────────────────────────────────
await test('no auth at all REFUSES to start', () => {
  const b = resolveHttpBinding({});
  assert.ok(b.refuse, 'must refuse');
  assert.match(b.refuse, /no authentication is configured/i);
  // The message has to name the ways out, or it just blocks the operator.
  assert.match(b.refuse, /GTM_MCP_HTTP_AUTH_TOKEN/);
  assert.match(b.refuse, /STYTCH_PROJECT_ID/);
  assert.match(b.refuse, /GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED/);
});

await test('the refusal explains WHAT would leak, not just that it refused', () => {
  const b = resolveHttpBinding({});
  assert.match(b.refuse, /Google credentials/i);
  assert.match(b.refuse, /GTM/);
});

// ── the deliberate opt-in ─────────────────────────────────────────────────────
await test('the opt-in allows start but binds LOOPBACK, not every interface', () => {
  const b = resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true' });
  assert.strictEqual(b.refuse, undefined);
  assert.strictEqual(b.host, LOOPBACK);
  assert.strictEqual(b.authMode, 'none');
});

await test('the opt-in is strict `true`, matching every other gate here', () => {
  // "1", "TRUE", "yes" must NOT open the server.
  for (const v of ['1', 'TRUE', 'True', 'yes', 'on', '']) {
    assert.ok(resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: v }).refuse, `value ${JSON.stringify(v)} must not open it`);
  }
});

await test('going open on a public interface takes a SECOND explicit step, and warns', () => {
  const b = resolveHttpBinding({
    GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true',
    GTM_MCP_HTTP_HOST: ALL_INTERFACES,
  });
  assert.strictEqual(b.refuse, undefined);
  assert.strictEqual(b.host, ALL_INTERFACES);
  assert.ok(b.warning, 'the dangerous combination must say so');
  assert.match(b.warning, /UNAUTHENTICATED/);
});

await test('loopback aliases do not trigger the public-interface warning', () => {
  for (const h of [LOOPBACK, '::1', 'localhost']) {
    const b = resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true', GTM_MCP_HTTP_HOST: h });
    assert.strictEqual(b.warning, undefined, `${h} is not public`);
  }
});

// ── authenticated servers are UNCHANGED ───────────────────────────────────────
// Defaulting these to loopback would have broken every hosted deployment to fix a hole that only
// exists without auth.
await test('a static token keeps the old all-interfaces default', () => {
  const b = resolveHttpBinding({ GTM_MCP_HTTP_AUTH_TOKEN: 'secret' });
  assert.strictEqual(b.refuse, undefined);
  assert.strictEqual(b.host, ALL_INTERFACES);
  assert.strictEqual(b.authMode, 'static-token');
  assert.strictEqual(b.warning, undefined);
});

await test('Stytch multi-user keeps the old all-interfaces default', () => {
  const b = resolveHttpBinding({ STYTCH_PROJECT_ID: 'project-live-x' });
  assert.strictEqual(b.host, ALL_INTERFACES);
  assert.strictEqual(b.authMode, 'stytch');
  assert.strictEqual(b.refuse, undefined);
});

await test('an explicit host overrides the default for authenticated servers too', () => {
  const b = resolveHttpBinding({ GTM_MCP_HTTP_AUTH_TOKEN: 's', GTM_MCP_HTTP_HOST: LOOPBACK });
  assert.strictEqual(b.host, LOOPBACK);
});

await test('whitespace-only config counts as unset', () => {
  assert.ok(resolveHttpBinding({ GTM_MCP_HTTP_AUTH_TOKEN: '   ', STYTCH_PROJECT_ID: '  ' }).refuse);
});

// ── the banner ────────────────────────────────────────────────────────────────
await test('the banner reports the host actually bound, never a hardcoded localhost', () => {
  const open = bindingBanner({ host: ALL_INTERFACES, authMode: 'static-token' }, 3001);
  assert.match(open, /all interfaces/);
  assert.ok(!/localhost/.test(open), 'must not claim localhost while on every interface');
  const local = bindingBanner({ host: LOOPBACK, authMode: 'none' }, 3001);
  assert.match(local, /127\.0\.0\.1/);
});

await test('the banner names the authentication mode, including NONE', () => {
  assert.match(bindingBanner({ host: LOOPBACK, authMode: 'none' }, 1), /NONE/);
  assert.match(bindingBanner({ host: LOOPBACK, authMode: 'stytch' }, 1), /Stytch/);
  assert.match(bindingBanner({ host: LOOPBACK, authMode: 'static-token' }, 1), /bearer token/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
