/**
 * Node test for the authorize page's request parsing (src/authorizeRequest.ts).
 *
 * The consent step must send Stytch the same request the prebuilt
 * <B2BIdentityProvider /> sent: a missing `scope` falls back to
 * openid/email/profile, and every RFC 8707 `resource` reaches both
 * oauthAuthorizeStart and oauthAuthorizeSubmit as `resources`.
 *
 * No browser, no Stytch, no extra deps: the module is transpiled with the
 * package's own TypeScript and imported from a data: URL, so this runs on
 * plain Node without a TS loader.
 *
 * Run: npm --prefix apps/mcp-authorize test   (also part of `run check`)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..');
const source = readFileSync(path.join(srcDir, 'authorizeRequest.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { parseAuthorizeParams, authorizeStartBody, authorizeSubmitBody } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${String(e && e.message ? e.message : e).split('\n').join('\n    ')}`);
  }
}

const BASE = {
  response_type: 'code',
  client_id: 'connected-app-test-123',
  redirect_uri: 'http://localhost:33418/oauth/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  state: 'st-1',
};
const qs = (extra = {}, base = BASE) => {
  const q = new URLSearchParams(base);
  for (const [k, v] of Object.entries(extra)) {
    for (const one of [].concat(v)) q.append(k, one);
  }
  return `?${q.toString()}`;
};

console.log('authorizeRequest');

test('no scope falls back to openid/email/profile (start and submit)', () => {
  const { error, params } = parseAuthorizeParams(qs());
  assert.equal(error, null);
  assert.deepEqual(params.scopes, ['openid', 'email', 'profile']);
  assert.deepEqual(authorizeStartBody(params).scopes, ['openid', 'email', 'profile']);
  assert.deepEqual(authorizeSubmitBody(params, true).scopes, ['openid', 'email', 'profile']);
});

test('empty scope falls back too, like the prebuilt', () => {
  const { params } = parseAuthorizeParams(qs({ scope: '' }));
  assert.deepEqual(params.scopes, ['openid', 'email', 'profile']);
});

test('fallback scopes are a fresh array per request', () => {
  const a = parseAuthorizeParams(qs()).params.scopes;
  a.push('mutated');
  assert.deepEqual(parseAuthorizeParams(qs()).params.scopes, ['openid', 'email', 'profile']);
});

test('an explicit scope is used as sent', () => {
  const { params } = parseAuthorizeParams(qs({ scope: 'openid  email' }));
  assert.deepEqual(params.scopes, ['openid', 'email']);
});

test('resource is forwarded as resources to start and submit', () => {
  const { params } = parseAuthorizeParams(qs({ resource: 'https://mcp.example.com' }));
  assert.deepEqual(params.resources, ['https://mcp.example.com']);
  assert.deepEqual(authorizeStartBody(params).resources, ['https://mcp.example.com']);
  assert.deepEqual(authorizeSubmitBody(params, true).resources, ['https://mcp.example.com']);
  assert.deepEqual(authorizeSubmitBody(params, false).resources, ['https://mcp.example.com']);
});

test('every resource value is forwarded, in request order', () => {
  const { params } = parseAuthorizeParams(
    qs({ resource: ['https://mcp.example.com', 'https://mcp.example.com/mcp'] })
  );
  assert.deepEqual(authorizeSubmitBody(params, true).resources, [
    'https://mcp.example.com',
    'https://mcp.example.com/mcp',
  ]);
});

test('no resource: the bodies carry no resources key at all', () => {
  const { params } = parseAuthorizeParams(qs({ scope: 'openid' }));
  assert.equal('resources' in params, false);
  assert.equal('resources' in authorizeStartBody(params), false);
  assert.equal('resources' in authorizeSubmitBody(params, true), false);
});

test('start body is the preflight fields only', () => {
  const { params } = parseAuthorizeParams(qs({ scope: 'openid email', prompt: 'consent', nonce: 'n-1' }));
  assert.deepEqual(authorizeStartBody(params), {
    client_id: BASE.client_id,
    redirect_uri: BASE.redirect_uri,
    response_type: 'code',
    scopes: ['openid', 'email'],
    prompt: 'consent',
  });
});

test('submit body adds state, nonce, PKCE challenge and the decision', () => {
  const { params } = parseAuthorizeParams(
    qs({ scope: 'openid', nonce: 'n-1', resource: 'https://mcp.example.com' })
  );
  assert.deepEqual(authorizeSubmitBody(params, false), {
    client_id: BASE.client_id,
    redirect_uri: BASE.redirect_uri,
    response_type: 'code',
    scopes: ['openid'],
    prompt: undefined,
    resources: ['https://mcp.example.com'],
    state: 'st-1',
    nonce: 'n-1',
    code_challenge: BASE.code_challenge,
    consent_granted: false,
  });
});

test('missing client_id / redirect_uri is still an error', () => {
  const { client_id, redirect_uri, ...rest } = BASE;
  void client_id;
  void redirect_uri;
  assert.equal(
    parseAuthorizeParams(qs({}, rest)).error,
    'Missing client_id, redirect_uri in the authorization request.'
  );
  assert.equal(parseAuthorizeParams(qs({}, { ...rest, client_id: 'c' })).error, 'Missing redirect_uri in the authorization request.');
});

test('Consent.tsx sends exactly these bodies', () => {
  const consent = readFileSync(path.join(srcDir, 'Consent.tsx'), 'utf8');
  for (const re of [
    /parseAuthorizeParams\(window\.location\.search\)/,
    /oauthAuthorizeStart\(authorizeStartBody\(parsed\.params\)\)/,
    /oauthAuthorizeSubmit\(authorizeSubmitBody\(parsed\.params, consentGranted\)\)/,
  ]) {
    assert.ok(re.test(consent), `Consent.tsx does not match ${re}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
