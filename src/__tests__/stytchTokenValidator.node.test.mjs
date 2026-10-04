/**
 * Node test for the Stytch token validator (Phase 3, slice 2).
 *
 * Generates a real RSA keypair, exposes it as a JWKS via an injected fetch, and
 * signs JWTs with Node crypto to exercise every path: valid token + claim
 * extraction, expiry, tampered signature, algorithm pinning (none/HS256),
 * issuer/audience enforcement, nested organization claim, and JWKS rotation
 * (unknown kid forces a refresh, but at most once per cooldown window), plus
 * Connected-App-only token typing (client_id required, session JWTs rejected)
 * and the issuer/audience pins derived from the project id.
 * No network, no Stytch, no extra deps.
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
const { createStytchTokenValidator, resolveStytchTokenPins } = await import(pathToFileURL(distMod).href);

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
// Every accepted token must be a Connected App access token, so fixtures carry client_id.
const goodPayload = {
  sub: 'member-123',
  client_id: 'connected-app-test-1',
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

await test('token with no exp claim → rejected (no unbounded lifetime)', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  const { exp, ...noExp } = goodPayload;
  await assert.rejects(() => v.validate(signJwt(noExp)), /exp/);
});

await test('token with string exp claim → rejected (must be numeric)', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(
    () => v.validate(signJwt({ ...goodPayload, exp: String(nowSec + 3600) })),
    /exp/
  );
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
      client_id: 'connected-app-test-1',
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
    () => v.validate(signJwt({ sub: 'm1', client_id: 'connected-app-test-1', exp: nowSec + 3600 })),
    /organization_id/
  );
});

// ── Token type + derived issuer/audience pins (REGRESSION) ───────────────────
// Issuer/audience used to be pinned only when STYTCH_JWT_ISSUER / STYTCH_JWT_AUDIENCE were set
// (the hosted server sets neither), and any project-signed JWT with sub + organization passed,
// including a B2B session JWT. The shape below is a real Connected App access token minted by the
// hosted deployment (values anonymised).
const PROJECT_ID = 'project-test-11111111-2222-3333-4444-555555555555';
const realShapedPayload = {
  aud: [PROJECT_ID],
  client_id: 'connected-app-test-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  exp: nowSec + 8 * 3600,
  'https://stytch.com/organization': {
    organization_id: 'organization-test-org-1',
    slug: 'acme',
  },
  iat: nowSec,
  iss: `stytch.com/${PROJECT_ID}`,
  jti: 'jti-1',
  nbf: nowSec,
  scope: 'email profile openid',
  sub: 'member-test-member-1',
};

function pinnedValidator(fetchImpl) {
  const pins = resolveStytchTokenPins(PROJECT_ID, {});
  return createStytchTokenValidator({
    jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW, issuer: pins.issuer, audience: pins.audience,
  });
}

await test('pins default to the project id when STYTCH_JWT_ISSUER / AUDIENCE are unset or blank', async () => {
  for (const env of [{}, { STYTCH_JWT_ISSUER: '', STYTCH_JWT_AUDIENCE: '  ' }]) {
    const pins = resolveStytchTokenPins(PROJECT_ID, env);
    assert.strictEqual(pins.issuer, `stytch.com/${PROJECT_ID}`);
    assert.strictEqual(pins.audience, PROJECT_ID);
    assert.strictEqual(pins.issuerDerived, true);
    assert.strictEqual(pins.audienceDerived, true);
  }
});

await test('env pins override the derived defaults', async () => {
  const pins = resolveStytchTokenPins(PROJECT_ID, {
    STYTCH_JWT_ISSUER: 'https://auth.example.com',
    STYTCH_JWT_AUDIENCE: 'custom-aud',
  });
  assert.strictEqual(pins.issuer, 'https://auth.example.com');
  assert.strictEqual(pins.audience, 'custom-aud');
  assert.strictEqual(pins.issuerDerived, false);
  assert.strictEqual(pins.audienceDerived, false);
});

await test('a token shaped exactly like the live Connected App token passes the derived pins', async () => {
  const { fetchImpl } = jwksFetch();
  const claims = await pinnedValidator(fetchImpl).validate(signJwt(realShapedPayload));
  assert.strictEqual(claims.memberId, 'member-test-member-1');
  assert.strictEqual(claims.organizationId, 'organization-test-org-1');
  assert.deepStrictEqual(claims.scopes, ['email', 'profile', 'openid']);
});

await test('REGRESSION: a B2B session-JWT-shaped token is rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const { client_id, scope, ...base } = realShapedPayload;
  const sessionJwt = {
    ...base,
    'https://stytch.com/session': {
      id: 'member-session-test-1',
      started_at: '2026-10-04T00:00:00Z',
      authentication_factors: [],
    },
  };
  await assert.rejects(() => pinnedValidator(fetchImpl).validate(signJwt(sessionJwt)), /session/);
  // Even if a session JWT somehow carried a client_id, the session claim alone disqualifies it.
  await assert.rejects(
    () => pinnedValidator(fetchImpl).validate(signJwt({ ...sessionJwt, client_id })),
    /session/
  );
});

await test('REGRESSION: a token without a client_id (or a blank one) is rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const { client_id, ...noClient } = realShapedPayload;
  await assert.rejects(() => pinnedValidator(fetchImpl).validate(signJwt(noClient)), /client_id/);
  await assert.rejects(
    () => pinnedValidator(fetchImpl).validate(signJwt({ ...noClient, client_id: '  ' })),
    /client_id/
  );
  await assert.rejects(
    () => pinnedValidator(fetchImpl).validate(signJwt({ ...noClient, client_id: 42 })),
    /client_id/
  );
});

await test('REGRESSION: wrong or missing iss is rejected under the derived pins', async () => {
  const { fetchImpl } = jwksFetch();
  const v = pinnedValidator(fetchImpl);
  await assert.rejects(
    () => v.validate(signJwt({ ...realShapedPayload, iss: 'stytch.com/project-test-other' })),
    /issuer/
  );
  const { iss, ...noIss } = realShapedPayload;
  await assert.rejects(() => v.validate(signJwt(noIss)), /issuer/);
});

await test('REGRESSION: wrong or missing aud is rejected under the derived pins', async () => {
  const { fetchImpl } = jwksFetch();
  const v = pinnedValidator(fetchImpl);
  await assert.rejects(
    () => v.validate(signJwt({ ...realShapedPayload, aud: ['project-test-other'] })),
    /audience/
  );
  const { aud, ...noAud } = realShapedPayload;
  await assert.rejects(() => v.validate(signJwt(noAud)), /audience/);
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

await test('repeated unknown kids do NOT refetch the JWKS per request (throttled)', async () => {
  // Regression: an unknown kid used to force a network fetch on every request, so an
  // unauthenticated caller could drive one outbound JWKS request per request they sent.
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, status: 200, json: async () => JWKS };
  };
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => v.validate(signJwt(goodPayload, { kid: `bogus-${i}` })),
      /no JWKS key/
    );
  }
  assert.strictEqual(n, 2, `expected 1 initial fetch + 1 forced refresh, got ${n}`);
});

await test('a rotated kid is still picked up once the refresh cooldown passes', async () => {
  let clock = NOW;
  let n = 0;
  let rotated = false;
  const fetchImpl = async () => {
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => (rotated ? { keys: [{ ...jwk, kid: 'key-2' }] } : JWKS),
    };
  };
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => clock });
  await v.validate(signJwt(goodPayload)); // caches key-1 (fetch 1)
  await assert.rejects(
    () => v.validate(signJwt(goodPayload, { kid: 'key-2' })),
    /no JWKS key/
  ); // forced refresh (fetch 2), key-2 not published yet
  rotated = true;
  await assert.rejects(
    () => v.validate(signJwt(goodPayload, { kid: 'key-2' })),
    /no JWKS key/
  ); // inside the cooldown: no fetch
  assert.strictEqual(n, 2, `cooldown should have suppressed the third fetch, got ${n}`);
  clock = NOW + 61_000;
  const claims = await v.validate(signJwt(goodPayload, { kid: 'key-2' }));
  assert.strictEqual(claims.memberId, 'member-123');
  assert.strictEqual(n, 3, `rotation should refresh after the cooldown, got ${n}`);
});

await test('malformed token → rejected', async () => {
  const { fetchImpl } = jwksFetch();
  const v = createStytchTokenValidator({ jwksUrl: 'https://x/jwks', fetchImpl, now: () => NOW });
  await assert.rejects(() => v.validate('not-a-jwt'), /malformed/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
