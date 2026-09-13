import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { AccountClientManager, mergeGoogleTokens, isInvalidGrant, GoogleAuthExpiredError } from '../account-clients';
import type { TokenStore } from '../account-clients';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'samarth-clients-'));
const configFile = join(dir, 'oauth-client.json');
writeFileSync(configFile, JSON.stringify({ clientId: 'cid', clientSecret: 'sec' }));

class FakeStore implements TokenStore {
  tokens = new Map<string, string>();
  setCalls = 0;
  getGoogleToken(id: string): string | null {
    return this.tokens.get(id) ?? null;
  }
  setGoogleToken(id: string, json: string): void {
    this.setCalls++;
    this.tokens.set(id, json);
  }
}

console.log('\nAccountClientManager:');

test('mergeGoogleTokens preserves refresh_token, takes fresh access_token', () => {
  const merged = mergeGoogleTokens(
    { access_token: 'old', refresh_token: 'rt', expiry_date: 1 },
    { access_token: 'new', expiry_date: 2 }
  );
  assert.equal(merged.access_token, 'new');
  assert.equal(merged.refresh_token, 'rt', 'refresh_token preserved across refresh');
  assert.equal(merged.expiry_date, 2);
});

test('getClient throws when the account has no vaulted token', () => {
  const mgr = new AccountClientManager(new FakeStore(), configFile);
  assert.throws(() => mgr.getClient('missing'), /not signed in/);
});

test('getClient throws when no OAuth client is configured', () => {
  const store = new FakeStore();
  store.setGoogleToken('a', JSON.stringify({ refresh_token: 'rt' }));
  const mgr = new AccountClientManager(store, join(dir, 'nope.json'));
  assert.throws(() => mgr.getClient('a'), /not configured/);
});

test('getClient builds, caches, and re-vaults on token refresh', () => {
  const store = new FakeStore();
  store.setGoogleToken('a', JSON.stringify({ access_token: 'a0', refresh_token: 'rt' }));
  store.setCalls = 0;
  const mgr = new AccountClientManager(store, configFile);

  const c1 = mgr.getClient('a');
  const c2 = mgr.getClient('a');
  assert.equal(c1, c2, 'same client cached per account');
  assert.ok(c1 instanceof OAuth2Client);

  // Simulate google-auth-library refreshing the access token.
  c1.emit('tokens', { access_token: 'a1', expiry_date: 999 });
  assert.equal(store.setCalls, 1, 're-vaulted once on refresh');
  const saved = JSON.parse(store.getGoogleToken('a') as string);
  assert.equal(saved.access_token, 'a1', 'fresh access token persisted');
  assert.equal(saved.refresh_token, 'rt', 'refresh token preserved');
});

test('invalidate drops the cached client', () => {
  const store = new FakeStore();
  store.setGoogleToken('a', JSON.stringify({ refresh_token: 'rt' }));
  const mgr = new AccountClientManager(store, configFile);
  const c1 = mgr.getClient('a');
  mgr.invalidate('a');
  const c2 = mgr.getClient('a');
  assert.notEqual(c1, c2, 'a fresh client after invalidate');
});

test('isInvalidGrant detects the invalid_grant shapes, ignores transient errors', () => {
  assert.ok(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } }), 'gaxios response shape');
  assert.ok(isInvalidGrant(new Error('invalid_grant')), 'message');
  assert.ok(isInvalidGrant({ cause: { message: 'Token has been expired or revoked.' } }), 'cause message');
  assert.ok(!isInvalidGrant(new Error('ETIMEDOUT')), 'network timeout is NOT invalid_grant');
  assert.ok(!isInvalidGrant({ response: { data: { error: 'quotaExceeded' } } }), 'quota is NOT invalid_grant');
  assert.ok(!isInvalidGrant(undefined), 'undefined is safe');
});

async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

void (async () => {
await atest('a dead refresh token (invalid_grant) → AUTH_EXPIRED, drops client, notifies once', async () => {
  const store = new FakeStore();
  store.setGoogleToken('a', JSON.stringify({ refresh_token: 'rt' }));
  let notified = 0;
  const factory = (id: string, secret: string): OAuth2Client => {
    const c = new OAuth2Client(id, secret);
    // Force the underlying request to reject exactly as Google does for a dead refresh token.
    (c as unknown as { request: () => Promise<never> }).request = () =>
      Promise.reject({ response: { data: { error: 'invalid_grant' } } });
    return c;
  };
  const mgr = new AccountClientManager(store, configFile, factory, () => { notified++; });
  const client = mgr.getClient('a');
  await assert.rejects(
    () => (client.request as unknown as (o: unknown) => Promise<unknown>)({ url: 'https://x' }),
    (e: unknown) => e instanceof GoogleAuthExpiredError && (e as { code?: string }).code === 'AUTH_EXPIRED'
  );
  assert.equal(notified, 1, 'onAuthExpired fired once');
  // A second call on the same client still throws AUTH_EXPIRED but must not re-notify.
  await assert.rejects(() => (client.request as unknown as (o: unknown) => Promise<unknown>)({ url: 'https://x' }));
  assert.equal(notified, 1, 'not re-notified from the same client');
});

await atest('a non-auth error passes through untouched', async () => {
  const store = new FakeStore();
  store.setGoogleToken('a', JSON.stringify({ refresh_token: 'rt' }));
  let notified = 0;
  const factory = (id: string, secret: string): OAuth2Client => {
    const c = new OAuth2Client(id, secret);
    (c as unknown as { request: () => Promise<never> }).request = () => Promise.reject(new Error('ETIMEDOUT'));
    return c;
  };
  const mgr = new AccountClientManager(store, configFile, factory, () => { notified++; });
  const client = mgr.getClient('a');
  await assert.rejects(
    () => (client.request as unknown as (o: unknown) => Promise<unknown>)({ url: 'https://x' }),
    /ETIMEDOUT/
  );
  assert.equal(notified, 0, 'transient error does NOT flag reauth');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
})();
