/**
 * Token verification tests. No network: every case injects a fake fetch.
 *
 * These exist because the live Supabase project turned out to publish an EMPTY JWKS. It signs with
 * the legacy shared secret (HS256), so the original JWKS-only verifier rejected every real session
 * and the chat would have 401'd for all users. The routing between local and remote verification is
 * now the load-bearing part, and the dangerous failure mode is routing something to the remote path
 * that should never have been accepted at all.
 */
import assert from 'node:assert/strict';
import { AuthError, SupabaseTokenVerifier } from '../auth.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const AUTH_URL = 'https://p.supabase.co/auth/v1';
const OPTS = { authUrl: AUTH_URL, anonKey: 'anon', audience: 'authenticated' };

function token(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b(header)}.${b(payload)}.c2ln`;
}

const soon = (): number => Math.floor(Date.now() / 1000) + 3600;

/** An empty JWKS, which is what a legacy-signing Supabase project actually serves. */
const emptyJwks: typeof fetch = async (url) =>
  String(url).includes('jwks')
    ? new Response(JSON.stringify({ keys: [] }), { status: 200 })
    : new Response(JSON.stringify({ id: 'user-1', email: 'a@b.com' }), { status: 200 });

console.log('legacy HS256 projects');

await test('an HS256 token is verified against Supabase, not rejected on the empty JWKS', async () => {
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, emptyJwks);
  const user = await v.verify(token({ alg: 'HS256' }, { sub: 'x', exp: soon() }));
  assert.equal(user.id, 'user-1');
  assert.equal(user.email, 'a@b.com');
});

await test('the request carries the caller token and the anon key', async () => {
  let seen: Record<string, string> | undefined;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).includes('jwks')) return new Response('{"keys":[]}', { status: 200 });
    seen = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ id: 'u' }), { status: 200 });
  };
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  const t = token({ alg: 'HS256' }, { sub: 'x', exp: soon() });
  await v.verify(t);
  assert.equal(seen?.Authorization, `Bearer ${t}`);
  assert.equal(seen?.apikey, 'anon');
});

await test('Supabase rejecting the token is an auth failure, not a server error', async () => {
  const fake: typeof fetch = async (url) =>
    String(url).includes('jwks')
      ? new Response('{"keys":[]}', { status: 200 })
      : new Response('', { status: 401 });
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  await assert.rejects(
    () => v.verify(token({ alg: 'HS256' }, { sub: 'x', exp: soon() })),
    (e: unknown) => e instanceof AuthError && e.code === 'auth_expired',
  );
});

await test('Supabase being unreachable is not reported as a bad token', async () => {
  // Otherwise an outage would tell every user their session expired and send them to re-login.
  const fake: typeof fetch = async (url) => {
    if (String(url).includes('jwks')) return new Response('{"keys":[]}', { status: 200 });
    throw new TypeError('fetch failed');
  };
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  await assert.rejects(
    () => v.verify(token({ alg: 'HS256' }, { sub: 'x', exp: soon() })),
    (e: unknown) => e instanceof AuthError && e.code === 'verifier_unavailable',
  );
});

await test('an asymmetric token also falls back when the project published no keys', async () => {
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, emptyJwks);
  const user = await v.verify(token({ alg: 'RS256', kid: 'k1' }, { sub: 'x', exp: soon() }));
  assert.equal(user.id, 'user-1');
});

console.log('what must never reach the remote path');

await test('alg "none" is refused outright', async () => {
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, emptyJwks);
  await assert.rejects(
    () => v.verify(token({ alg: 'none' }, { sub: 'x', exp: soon() })),
    (e: unknown) => e instanceof AuthError && e.code === 'bad_algorithm',
  );
});

await test('a malformed token is refused before any network call', async () => {
  let called = false;
  const fake: typeof fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  await assert.rejects(() => v.verify('not.a.valid.jwt.at.all'), (e: unknown) => e instanceof AuthError);
  assert.equal(called, false, 'a malformed token should not cost a Supabase round trip');
});

await test('a response with no user id is refused', async () => {
  const fake: typeof fetch = async (url) =>
    String(url).includes('jwks')
      ? new Response('{"keys":[]}', { status: 200 })
      : new Response(JSON.stringify({ email: 'a@b.com' }), { status: 200 });
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  await assert.rejects(
    () => v.verify(token({ alg: 'HS256' }, { sub: 'x', exp: soon() })),
    (e: unknown) => e instanceof AuthError && e.code === 'no_subject',
  );
});

await test('without authUrl and anonKey the fallback refuses rather than skipping verification', async () => {
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, { audience: 'authenticated' }, emptyJwks);
  await assert.rejects(
    () => v.verify(token({ alg: 'HS256' }, { sub: 'x', exp: soon() })),
    (e: unknown) => e instanceof AuthError && e.code === 'misconfigured',
  );
});

console.log('caching');

await test('a repeated token does not re-ask Supabase', async () => {
  let calls = 0;
  const fake: typeof fetch = async (url) => {
    if (String(url).includes('jwks')) return new Response('{"keys":[]}', { status: 200 });
    calls++;
    return new Response(JSON.stringify({ id: 'u' }), { status: 200 });
  };
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  const t = token({ alg: 'HS256' }, { sub: 'x', exp: soon() });
  await v.verify(t);
  await v.verify(t);
  assert.equal(calls, 1, 'the second verification should hit the cache');
});

await test('an already-expired token is not cached as valid', async () => {
  // exp in the past means the cache TTL clamps to zero, so the next call re-checks.
  let calls = 0;
  const fake: typeof fetch = async (url) => {
    if (String(url).includes('jwks')) return new Response('{"keys":[]}', { status: 200 });
    calls++;
    return new Response(JSON.stringify({ id: 'u' }), { status: 200 });
  };
  const v = new SupabaseTokenVerifier(`${AUTH_URL}/.well-known/jwks.json`, OPTS, fake);
  const stale = token({ alg: 'HS256' }, { sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 });
  await v.verify(stale);
  await v.verify(stale);
  assert.equal(calls, 2, 'an expired token must be re-checked, never served from cache');
});

console.log(`\n${passed} assertions passed`);
