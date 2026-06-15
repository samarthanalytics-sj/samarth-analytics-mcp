/**
 * Node test for the Stytch token validator (Phase 3, slice 2).
 *
 * Generates a real RSA keypair, exposes it as a JWKS via an injected fetch, and
 * signs JWTs with Node crypto to exercise every path: valid token + claim
 * extraction, expiry, tampered signature, algorithm pinning (none/HS256),
 * issuer/audience enforcement, nested organization claim, and JWKS rotation
 * (unknown kid forces a refresh). No network, no Stytch, no extra deps.
 *
 * Run: node src/__tests__/stytchTokenValidator.node.test.mjs
 */

import assert from 'assert';
import crypto from 'node:crypto';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distMod = path.resolve(__dirname, '../../dist/auth/stytchTokenValidator.js');
if (!existsSync(distMod)) {
  console.error(`\n✗ validator test: ${distMod} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { createStytchTokenValidator } = await import(pathToFileURL(distMod).href);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// One RSA keypair = one JWKS key.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
const JWKS = { keys: [jwk] };

function signJwt(payload, { kid = 'key-1', alg = 'RS256', tamper = false } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  if (alg === 'none') return `${header}.${body}.`;
  const data = Buffer.from(`${header}.${body}`);
  let sig;
  if (alg === 'HS256') {
    sig = b64url(crypto.createHmac('sha256', 'attacker').update(data).digest());
  } else {
    sig = b64url(crypto.sign('RSA-SHA256', data, privateKey));
  }
  let token = `${header}.${body}.${sig}`;
  if (tamper) token = `${header}.${b64url(JSON.stringify({ ...payload, sub: 'evil' }))}.${sig}`;
  return token;
}

function jwksFetch(keysOverride) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => (keysOverride ? keysOverride() : JWKS) };
  };
  return { fetchImpl, calls: () => calls };
}

const NOW = 1_000_000_000_000; // fixed clock (ms)
const nowSec = Math.floor(NOW / 1000);
const goodPayload = {
  sub: 'member-123',
  organization_id: 'org-abc',
  scope: 'openid profile',
  exp: nowSec + 3600,
  iat: nowSec,
};

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

console.log('\nStytch token validator:');

await test('valid token → extracts member, org, scopes', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  const claims = await v.validate(signJwt(goodPayload));
  assert.strictEqual(claims.memberId, 'member-123');
  assert.strictEqual(claims.organizationId, 'org-abc');
  assert.deepStrictEqual(claims.scopes, ['openid', 'profile']);
});

await test('expired token → rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate(signJwt({ ...goodPayload, exp: nowSec - 3600 })), /expired/);
});

await test('tampered payload → signature fails', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate(signJwt(goodPayload, { tamper: true })), /signature/);
});

await test('alg=none → rejected (algorithm pinning)', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate(signJwt(goodPayload, { alg: 'none' })), /unsupported alg/);
});

await test('alg=HS256 forgery → rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate(signJwt(goodPayload, { alg: 'HS256' })), /unsupported alg/);
});

await test('issuer enforced when configured', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({
    jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW, issuer: 'https://stytch',
  });
  await v.validate(signJwt({ ...goodPayload, iss: 'https://stytch' }));
  await assert.rejects(() => v.validate(signJwt({ ...goodPayload, iss: 'https://evil' })), /issuer/);
});

await test('audience enforced when configured (string or array)', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({
    jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW, audience: 'my-client',
  });
  await v.validate(signJwt({ ...goodPayload, aud: 'my-client' }));
  await v.validate(signJwt({ ...goodPayload, aud: ['other', 'my-client'] }));
  await assert.rejects(() => v.validate(signJwt({ ...goodPayload, aud: 'someone-else' })), /audience/);
});

await test('nested organization claim is extracted', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  const claims = await v.validate(
    signJwt({
      sub: 'm1',
      'https://stytch.com/organization': { organization_id: 'org-nested' },
      exp: nowSec + 3600,
    })
  );
  assert.strictEqual(claims.organizationId, 'org-nested');
});

await test('missing organization_id → rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(
    () => v.validate(signJwt({ sub: 'm1', exp: nowSec + 3600 })),
    /organization_id/
  );
});

await test('unknown kid forces a JWKS refresh', async () => {
  // First fetch returns empty keys; second returns the real key.
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, status: 200, json: async () => (n === 1 ? { keys: [] } : JWKS) };
  };
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  const claims = await v.validate(signJwt(goodPayload));
  assert.strictEqual(claims.memberId, 'member-123');
  assert.ok(n >= 2, 'should have refreshed the JWKS');
});

await test('malformed token → rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate('not-a-jwt'), /malformed/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
