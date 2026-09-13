/**
 * Per-user Google identity tests.
 *
 * The property under test is isolation: a child process must be able to act as exactly one user and
 * must have nothing else to fall back to. A regression here is a cross-tenant data leak, so these
 * assertions are deliberately blunt.
 */
import assert from 'node:assert/strict';
import { McpConnection } from '../mcp-client.js';
import {
  GoogleIdentityError,
  isGoogleAuthFailure,
  SupabaseTokenProvider,
} from '../google-identity.js';
import type { OrchestratorConfig } from '../config.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Ambient credentials that must never reach a per-user child. */
const AMBIENT = {
  GOOGLE_REFRESH_TOKEN: 'server-refresh-token',
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/keys/sa.json',
  GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json',
  GOOGLE_OAUTH_CLIENT_SECRET: 'server-secret',
  GOOGLE_CLIENT_SECRET: 'legacy-secret',
  GTM_MCP_TOKEN_FILE: '/data/.gtm-mcp-tokens.json',
  GTM_MCP_TRANSPORT: 'stdio',
};

function cfgWith(env: Record<string, string>): OrchestratorConfig {
  return { mcp: { env } } as unknown as OrchestratorConfig;
}

/** buildChildEnv is private by design; these tests exercise it as the security boundary it is. */
function childEnv(cfg: OrchestratorConfig, token?: string): Record<string, string> {
  const conn = new McpConnection(cfg, token) as unknown as {
    buildChildEnv(base: Record<string, string>): Record<string, string>;
  };
  return conn.buildChildEnv({ PATH: '/usr/bin' });
}

console.log('child process isolation');

test('a per-user child carries that user token', () => {
  const env = childEnv(cfgWith(AMBIENT), 'ya29.user-alice');
  assert.equal(env.GOOGLE_ACCESS_TOKEN, 'ya29.user-alice');
});

test('every ambient Google credential is stripped from a per-user child', () => {
  const env = childEnv(cfgWith(AMBIENT), 'ya29.user-alice');
  for (const key of [
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_CLIENT_SECRET',
    'GTM_MCP_TOKEN_FILE',
  ]) {
    assert.equal(env[key], undefined, `${key} leaked into a per-user MCP child`);
  }
});

test('two users get different child environments', () => {
  const alice = childEnv(cfgWith(AMBIENT), 'ya29.alice');
  const bob = childEnv(cfgWith(AMBIENT), 'ya29.bob');
  assert.notEqual(alice.GOOGLE_ACCESS_TOKEN, bob.GOOGLE_ACCESS_TOKEN);
});

test('non-credential config still reaches the child', () => {
  const env = childEnv(cfgWith({ ...AMBIENT, GTM_MCP_ENABLE_WRITES: 'false' }), 'ya29.alice');
  assert.equal(env.GTM_MCP_TRANSPORT, 'stdio');
  assert.equal(env.GTM_MCP_ENABLE_WRITES, 'false');
  assert.equal(env.PATH, '/usr/bin');
});

test('single-identity mode leaves the environment untouched', () => {
  const env = childEnv(cfgWith(AMBIENT), undefined);
  assert.equal(env.GTM_MCP_TOKEN_FILE, '/data/.gtm-mcp-tokens.json');
  assert.equal(env.GOOGLE_ACCESS_TOKEN, undefined);
});

console.log('auth failure detection');

test('google auth failures are recognized', () => {
  for (const text of [
    'accounts_list failed: Invalid Credentials',
    'Request had invalid authentication credentials. Expected OAuth 2 access token',
    'invalid_grant: Token has been expired or revoked',
    'Could not load the default credentials',
    'Request is missing required authentication credential',
  ]) {
    assert.equal(isGoogleAuthFailure(text), true, `not detected: ${text}`);
  }
});

test('unrelated failures do not trigger a token refresh', () => {
  for (const text of [
    'tags_create failed: Input validation error: confirm is required',
    'Quota exceeded for quota metric requests',
    'Container not found',
    'Permission denied: the user does not have access to this container',
  ]) {
    assert.equal(isGoogleAuthFailure(text), false, `false positive: ${text}`);
  }
});

console.log('supabase token provider');

const OAUTH = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };

function providerWith(fake: typeof fetch): SupabaseTokenProvider {
  return new SupabaseTokenProvider('https://p.supabase.co/functions/v1', 'anon', OAUTH, fake);
}

await testAsync('forwards the end user JWT, never a service key', async () => {
  let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fake: typeof fetch = async (url, init) => {
    seen = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    };
    return new Response(JSON.stringify({ success: true, token: 'ya29.fresh' }), { status: 200 });
  };

  const identity = await providerWith(fake).getIdentity('user-1', 'jwt-for-user-1');

  assert.equal(identity.accessToken, 'ya29.fresh');
  assert.match(seen!.url, /secure-token-manager$/);
  assert.equal(seen!.headers.Authorization, 'Bearer jwt-for-user-1');
  assert.match(seen!.body, /"action":"retrieve"/);
  // The platform derives the user from the verified JWT; sending an id would be meaningless at
  // best and an IDOR attempt at worst.
  assert.equal(/user_id/.test(seen!.body), false);
});

await testAsync('a missing token is reported as HTTP 200 success:false, not a 404', async () => {
  // This is how secure-token-manager actually answers, so treating only 404 as "not connected"
  // would surface an empty token as a success.
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ success: false, error: 'Token not found' }), { status: 200 });
  await assert.rejects(
    () => providerWith(fake).getIdentity('user-1', 'jwt'),
    (err: unknown) =>
      err instanceof GoogleIdentityError &&
      err.code === 'not_connected' &&
      /Connect Google/.test(err.message),
  );
});

await testAsync('a provider outage is not reported as a disconnected account', async () => {
  const fake: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => providerWith(fake).getIdentity('u', 'jwt'),
    (err: unknown) => err instanceof GoogleIdentityError && err.code === 'provider_unavailable',
  );
});

console.log('token refresh');

await testAsync('refresh exchanges the stored refresh token with Google and stores the result', async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (url, init) => {
    const target = String(url);
    const body = String(init?.body ?? '');

    if (target.includes('oauth2.googleapis.com')) {
      calls.push('google');
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=1%2F%2Fstored-refresh/);
      assert.match(body, /client_secret=csecret/);
      return new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (body.includes('"action":"retrieve"')) {
      calls.push('retrieve');
      assert.match(body, /google_refresh_token/);
      return new Response(JSON.stringify({ success: true, token: '1//stored-refresh' }), {
        status: 200,
      });
    }
    calls.push('store');
    assert.match(body, /"action":"store"/);
    assert.match(body, /google_access_token/);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const identity = await providerWith(fake).refresh('u', 'jwt');
  assert.equal(identity.accessToken, 'ya29.new');
  assert.ok(identity.expiresAt! > Date.now());
  assert.deepEqual(calls, ['retrieve', 'google', 'store']);
});

await testAsync('a user with no refresh token is told to reconnect, not retried', async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ success: false, error: 'Token not found' }), { status: 200 });
  await assert.rejects(
    () => providerWith(fake).refresh('u', 'jwt'),
    (err: unknown) =>
      err instanceof GoogleIdentityError &&
      err.code === 'not_connected' &&
      /reconnect/i.test(err.message),
  );
});

await testAsync('a revoked grant is reported as revoked, not as a transient failure', async () => {
  const fake: typeof fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    if (String(init?.body ?? '').includes('"action":"retrieve"')) {
      return new Response(JSON.stringify({ success: true, token: '1//stale' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  await assert.rejects(
    () => providerWith(fake).refresh('u', 'jwt'),
    (err: unknown) =>
      err instanceof GoogleIdentityError &&
      err.code === 'not_connected' &&
      /revoked/i.test(err.message),
  );
});

await testAsync('refresh without an OAuth client fails loudly instead of silently', async () => {
  const provider = new SupabaseTokenProvider(
    'https://p.supabase.co/functions/v1',
    'anon',
    { clientId: '', clientSecret: '' },
    async () => new Response('{}', { status: 200 }),
  );
  await assert.rejects(
    () => provider.refresh('u', 'jwt'),
    (err: unknown) => err instanceof GoogleIdentityError && err.code === 'refresh_failed',
  );
});

await testAsync('a write-back failure does not lose the freshly minted token', async () => {
  const fake: typeof fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (String(init?.body ?? '').includes('"action":"retrieve"')) {
      return new Response(JSON.stringify({ success: true, token: '1//r' }), { status: 200 });
    }
    return new Response('server error', { status: 500 });
  };
  const identity = await providerWith(fake).refresh('u', 'jwt');
  assert.equal(identity.accessToken, 'ya29.new');
});

console.log(`\n${passed} assertions passed`);
