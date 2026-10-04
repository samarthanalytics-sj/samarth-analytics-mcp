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
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/utils/httpBinding.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ httpBinding test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const {
  resolveHttpBinding,
  resolveHttpPort,
  DEFAULT_HTTP_PORT,
  bindingBanner,
  needsRebindingGuard,
  rebindingRejection,
  LOOPBACK,
  ALL_INTERFACES,
} = await import(pathToFileURL(distPath).href);

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

// ── the port ──────────────────────────────────────────────────────────────────
// It used to be parseInt(GTM_MCP_HTTP_PORT ?? PORT ?? '3001'): an empty GTM_MCP_HTTP_PORT is not
// nullish, so it shadowed the host-injected PORT, parsed to NaN, and app.listen threw.
console.log('\nHTTP port:');

await test('nothing set → the 3001 default', () => {
  assert.deepStrictEqual(resolveHttpPort({}), { port: DEFAULT_HTTP_PORT });
  assert.strictEqual(DEFAULT_HTTP_PORT, 3001);
});

await test('GTM_MCP_HTTP_PORT wins over PORT', () => {
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: '4000', PORT: '10000' }), { port: 4000 });
});

await test('PORT (Render/Fly) is used when GTM_MCP_HTTP_PORT is unset', () => {
  assert.deepStrictEqual(resolveHttpPort({ PORT: '10000' }), { port: 10000 });
});

await test('REGRESSION: an empty or blank GTM_MCP_HTTP_PORT counts as unset and falls through to PORT', () => {
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: '', PORT: '10000' }), { port: 10000 });
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: '   ', PORT: '10000' }), { port: 10000 });
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: '', PORT: '' }), { port: DEFAULT_HTTP_PORT });
});

await test('REGRESSION: a non-numeric or out-of-range port refuses with the variable named, never NaN', () => {
  for (const [name, v] of [
    ['GTM_MCP_HTTP_PORT', 'abc'],
    ['GTM_MCP_HTTP_PORT', '3001abc'],
    ['GTM_MCP_HTTP_PORT', '0'],
    ['GTM_MCP_HTTP_PORT', '65536'],
    ['GTM_MCP_HTTP_PORT', '-1'],
    ['PORT', '12.5'],
  ]) {
    const r = resolveHttpPort({ [name]: v });
    assert.ok(r.refuse, `${name}=${v} must refuse`);
    assert.ok(r.refuse.includes(name), r.refuse);
    assert.ok(Number.isInteger(r.port), 'port is never NaN');
  }
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: '65535' }), { port: 65535 });
  assert.deepStrictEqual(resolveHttpPort({ GTM_MCP_HTTP_PORT: ' 8080 ' }), { port: 8080 });
});

await test('index.ts takes its port from resolveHttpPort, not a raw parseInt', () => {
  // index.ts cannot be imported (it starts a server at load), so check the wiring in its source.
  const indexSrc = readFileSync(path.resolve(here, '../index.ts'), 'utf-8');
  assert.match(indexSrc, /resolveHttpPort\(process\.env\)/);
  assert.ok(!/parseInt\(\s*process\.env\.GTM_MCP_HTTP_PORT/.test(indexSrc), 'the NaN-prone parseInt is back');
});

// ── DNS rebinding ─────────────────────────────────────────────────────────────
// The unauthenticated loopback server had no Host/Origin check, so a hostile page that re-pointed
// its own DNS name at 127.0.0.1 could drive /mcp from the operator's browser.
console.log('\nDNS rebinding guard:');

await test('REGRESSION: the unauthenticated loopback server is guarded', () => {
  for (const h of [LOOPBACK, '::1', 'localhost']) {
    const b = resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true', GTM_MCP_HTTP_HOST: h });
    assert.strictEqual(needsRebindingGuard(b), true, h);
  }
  assert.strictEqual(
    needsRebindingGuard(resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true' })),
    true,
    'the default opt-in binding'
  );
});

await test('authenticated servers and the twice-opted-in public host are not guarded', () => {
  assert.strictEqual(needsRebindingGuard(resolveHttpBinding({ GTM_MCP_HTTP_AUTH_TOKEN: 's' })), false);
  assert.strictEqual(needsRebindingGuard(resolveHttpBinding({ STYTCH_PROJECT_ID: 'p' })), false);
  assert.strictEqual(
    needsRebindingGuard(
      resolveHttpBinding({ GTM_MCP_HTTP_AUTH_TOKEN: 's', GTM_MCP_HTTP_HOST: LOOPBACK })
    ),
    false,
    'a token-gated loopback server does not need it'
  );
  assert.strictEqual(
    needsRebindingGuard(
      resolveHttpBinding({ GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true', GTM_MCP_HTTP_HOST: ALL_INTERFACES })
    ),
    false,
    'behind an auth proxy the Host header is not predictable'
  );
});

await test('loopback Host headers pass, with or without a port', () => {
  for (const h of ['127.0.0.1:3001', 'localhost:3001', '[::1]:3001', 'localhost', '127.0.0.1', 'LOCALHOST:3001']) {
    assert.strictEqual(rebindingRejection(h, undefined), undefined, h);
  }
});

await test('REGRESSION: a rebound Host header is rejected', () => {
  for (const h of ['evil.example:3001', 'evil.example', '127.0.0.1.nip.io:3001', '10.0.0.5:3001']) {
    assert.match(rebindingRejection(h, undefined) ?? '', /Invalid Host/, h);
  }
  assert.match(rebindingRejection(undefined, undefined) ?? '', /Missing Host/);
  assert.ok(rebindingRejection('', undefined));
});

await test('a loopback browser Origin passes; no Origin (non-browser client) passes', () => {
  assert.strictEqual(rebindingRejection('127.0.0.1:3001', 'http://localhost:5173'), undefined);
  assert.strictEqual(rebindingRejection('127.0.0.1:3001', 'http://127.0.0.1:3001'), undefined);
  assert.strictEqual(rebindingRejection('[::1]:3001', 'http://[::1]:3001'), undefined);
  assert.strictEqual(rebindingRejection('127.0.0.1:3001', undefined), undefined);
});

await test('REGRESSION: a foreign or opaque Origin is rejected even with a loopback Host', () => {
  for (const o of ['https://evil.example', 'http://evil.example:3001', 'null', 'file:///tmp/x.html', 'not a url']) {
    assert.match(rebindingRejection('127.0.0.1:3001', o) ?? '', /Invalid Origin/, o);
  }
});

await test('index.ts installs the guard as middleware ahead of the /mcp routes', () => {
  const indexSrc = readFileSync(path.resolve(here, '../index.ts'), 'utf-8');
  const guard = indexSrc.indexOf('needsRebindingGuard(binding)');
  assert.ok(guard >= 0, 'the guard is not wired');
  assert.match(indexSrc.slice(guard, guard + 400), /app\.use\(/);
  assert.match(indexSrc.slice(guard, guard + 400), /rebindingRejection\(req\.headers\.host, req\.headers\.origin\)/);
  for (const route of ["app.post('/mcp'", "app.get('/mcp'", "app.delete('/mcp'"]) {
    const at = indexSrc.indexOf(route);
    assert.ok(at > guard, `${route} must be registered after the guard`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
