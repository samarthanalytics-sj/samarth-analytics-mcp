import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  createPkcePair,
  createState,
  describeGoogleOAuthError,
  adsAuthScopes,
  grantedScopes,
  hasAdsScope,
  GOOGLE_ADS_SCOPE,
  parseTokenResponse,
  parseUserinfo,
  DESKTOP_GOOGLE_SCOPES,
} from '../oauth';
import {
  extractClient,
  loadGoogleOAuthClient,
  loadGoogleOAuthClientWithSource,
  parseEnvFile,
  loadEnvFiles,
} from '../oauth-config';

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

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('\nGoogle OAuth helpers:');

test('createPkcePair: challenge is S256(verifier), url-safe', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()));
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test('createState is non-empty and url-safe', () => {
  const s = createState();
  assert.ok(s.length > 0);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});

test('buildAuthUrl carries PKCE + offline + chooser params', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:5555/callback',
      scopes: DESKTOP_GOOGLE_SCOPES,
      state: 'st8',
      codeChallenge: 'chal',
    })
  );
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), 'st8');
  assert.ok(url.searchParams.get('prompt')?.includes('select_account'));
  assert.ok(url.searchParams.get('scope')?.includes('tagmanager.readonly'));
  assert.ok(url.searchParams.get('scope')?.includes('tagmanager.edit.containers'));
  assert.ok(url.searchParams.get('scope')?.includes('tagmanager.edit.containerversions'));
  assert.ok(!url.searchParams.get('scope')?.includes('tagmanager.publish')); // never publish
  assert.ok(url.searchParams.get('scope')?.includes('analytics.readonly'));
  // Incremental auth: without this, the opt-in Google Ads re-consent returns a token that REPLACES the
  // vaulted one and silently drops the Tag Manager + Analytics grants.
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
});

test('the Google Ads scope is part of a normal sign-in, so there is no second connect step', () => {
  // A token's scopes are fixed at grant time, so an account that signed in before this cannot be
  // upgraded in place; including adwords here at least means every NEW sign-in and every re-connect
  // covers Google Ads without the user having to find a separate button.
  assert.ok(DESKTOP_GOOGLE_SCOPES.includes(GOOGLE_ADS_SCOPE));
  const url = new URL(
    buildAuthUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', scopes: DESKTOP_GOOGLE_SCOPES, state: 's', codeChallenge: 'x' })
  );
  assert.ok(url.searchParams.get('scope')?.includes('adwords'));
  // Still never publish.
  assert.ok(!url.searchParams.get('scope')?.includes('tagmanager.publish'));
});

test('adsAuthScopes requests the UNION, so a re-consent cannot drop existing grants', () => {
  const scopes = adsAuthScopes();
  assert.ok(scopes.includes(GOOGLE_ADS_SCOPE));
  for (const s of DESKTOP_GOOGLE_SCOPES) assert.ok(scopes.includes(s), `union dropped ${s}`);
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/tagmanager.publish'));
  // No duplicate now that adwords is in the defaults: a repeated scope is harmless to Google but makes
  // the consent URL and any scope diffing noisy.
  assert.equal(new Set(scopes).size, scopes.length);
});

test('hasAdsScope reads the granted scope string the token actually carries', () => {
  assert.equal(hasAdsScope(`${GOOGLE_ADS_SCOPE} openid email`), true);
  // A token minted BEFORE adwords joined the defaults: this is the case the readiness check exists for,
  // since a token's scopes are fixed at grant time and cannot be upgraded in place.
  const legacyScopes = DESKTOP_GOOGLE_SCOPES.filter((s) => s !== GOOGLE_ADS_SCOPE);
  assert.equal(hasAdsScope(legacyScopes.join(' ')), false);
  assert.equal(hasAdsScope(DESKTOP_GOOGLE_SCOPES.join(' ')), true);
  // A missing scope must be detectable BEFORE a call: it surfaces as a 403 insufficient-scope, which is
  // not invalid_grant, so the auth-expired chokepoint never catches it.
  assert.equal(hasAdsScope(undefined), false);
  assert.equal(hasAdsScope(''), false);
  assert.equal(hasAdsScope(null), false);
  // A substring must not false-positive.
  assert.equal(hasAdsScope('https://www.googleapis.com/auth/adwords.readonly'), false);
  assert.equal(grantedScopes('  a   b  ').size, 2);
});

test('buildTokenExchangeBody includes verifier + auth-code grant', () => {
  const body = new URLSearchParams(
    buildTokenExchangeBody({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'abc',
      redirectUri: 'http://127.0.0.1:1/callback',
      codeVerifier: 'ver',
    })
  );
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'abc');
  assert.equal(body.get('code_verifier'), 'ver');
  assert.equal(body.get('client_secret'), 'sec');
});

test('parseTokenResponse: maps fields + computes expiry', () => {
  const t = parseTokenResponse(
    { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's', token_type: 'Bearer' },
    1_000_000
  );
  assert.equal(t.access_token, 'at');
  assert.equal(t.refresh_token, 'rt');
  assert.equal(t.expiry_date, 1_000_000 + 3600 * 1000);
  assert.equal(t.token_type, 'Bearer');
});

test('parseTokenResponse: error + missing access_token throw', () => {
  assert.throws(() => parseTokenResponse({ error: 'invalid_grant' }, 0), /invalid_grant/);
  assert.throws(() => parseTokenResponse({ scope: 'x' }, 0), /no access_token/);
});

test('describeGoogleOAuthError: business-account codes get actionable text', () => {
  assert.match(describeGoogleOAuthError('admin_policy_enforced'), /admin/i);
  assert.match(describeGoogleOAuthError('org_internal'), /Internal/);
  assert.match(describeGoogleOAuthError('redirect_uri_mismatch'), /Desktop app/);
  assert.match(describeGoogleOAuthError('access_denied'), /Test user|admin/i);
  // unknown codes still surface the code + any description
  assert.match(describeGoogleOAuthError('weird_code', 'extra'), /weird_code.*extra/);
});

test('parseUserinfo: extracts email, rejects missing email', () => {
  const u = parseUserinfo({ email: 'me@example.com', name: 'Me' });
  assert.equal(u.email, 'me@example.com');
  assert.equal(u.name, 'Me');
  assert.throws(() => parseUserinfo({ name: 'no email' }), /no email/);
});

// --- oauth-config ---
const dir = mkdtempSync(join(tmpdir(), 'samarth-oauth-'));
const savedId = process.env.GOOGLE_DESKTOP_CLIENT_ID;
const savedSecret = process.env.GOOGLE_DESKTOP_CLIENT_SECRET;
const savedAltId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const savedAltSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
function clearEnv(): void {
  delete process.env.GOOGLE_DESKTOP_CLIENT_ID;
  delete process.env.GOOGLE_DESKTOP_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}

test('loadGoogleOAuthClient: null when unset', () => {
  clearEnv();
  assert.equal(loadGoogleOAuthClient(join(dir, 'nope.json')), null);
});

test('loadGoogleOAuthClient: env takes precedence', () => {
  clearEnv();
  process.env.GOOGLE_DESKTOP_CLIENT_ID = 'env-id';
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET = 'env-sec';
  const c = loadGoogleOAuthClient(join(dir, 'nope.json'));
  assert.deepEqual(c, { clientId: 'env-id', clientSecret: 'env-sec' });
});

test('loadGoogleOAuthClient: file fallback', () => {
  clearEnv();
  const f = join(dir, 'oauth-client.json');
  writeFileSync(f, JSON.stringify({ clientId: 'file-id', clientSecret: 'file-sec' }));
  assert.deepEqual(loadGoogleOAuthClient(f), { clientId: 'file-id', clientSecret: 'file-sec' });
});

test('loadGoogleOAuthClient: malformed file → null', () => {
  clearEnv();
  const f = join(dir, 'bad.json');
  writeFileSync(f, '{ not json');
  assert.equal(loadGoogleOAuthClient(f), null);
});

test('extractClient: accepts our format, snake_case, and Google installed/web wrappers', () => {
  assert.deepEqual(extractClient({ clientId: 'a', clientSecret: 'b' }), {
    clientId: 'a',
    clientSecret: 'b',
  });
  assert.deepEqual(extractClient({ client_id: 'a', client_secret: 'b' }), {
    clientId: 'a',
    clientSecret: 'b',
  });
  assert.deepEqual(extractClient({ installed: { client_id: 'a', client_secret: 'b' } }), {
    clientId: 'a',
    clientSecret: 'b',
  });
  assert.deepEqual(extractClient({ web: { client_id: 'a', client_secret: 'b' } }), {
    clientId: 'a',
    clientSecret: 'b',
  });
  assert.equal(extractClient({ nope: 1 }), null);
});

test("loadGoogleOAuthClientWithSource: reads Google's downloaded installed JSON with BOM", () => {
  clearEnv();
  const f = join(dir, 'client_secret_download.json');
  const googleJson = JSON.stringify({
    installed: {
      client_id: '123-abc.apps.googleusercontent.com',
      client_secret: 'GOCSPX-zzz',
      redirect_uris: ['http://localhost'],
    },
  });
  writeFileSync(f, '﻿' + googleJson); // leading BOM, like PowerShell/Notepad
  const res = loadGoogleOAuthClientWithSource(f);
  assert.equal(res.source, 'file');
  assert.equal(res.client?.clientId, '123-abc.apps.googleusercontent.com');
  assert.equal(res.client?.clientSecret, 'GOCSPX-zzz');
});

test('loadGoogleOAuthClientWithSource: trims whitespace + reports source', () => {
  clearEnv();
  process.env.GOOGLE_DESKTOP_CLIENT_ID = '  abc.apps.googleusercontent.com\n';
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET = ' sec ';
  const env = loadGoogleOAuthClientWithSource(join(dir, 'nope.json'));
  assert.equal(env.source, 'env');
  assert.equal(env.client?.clientId, 'abc.apps.googleusercontent.com', 'trimmed');
  assert.equal(env.client?.clientSecret, 'sec');

  clearEnv();
  const none = loadGoogleOAuthClientWithSource(join(dir, 'nope.json'));
  assert.equal(none.source, 'none');
  assert.equal(none.client, null);
});

// ── .env file loading ────────────────────────────────────────────────────────

test('parseEnvFile: KEY=VALUE, comments, blanks, export prefix, quotes, inline comment', () => {
  const parsed = parseEnvFile(
    '\uFEFF# comment\n\nexport A=1\nB = spaced \nC="qu#oted"\nD=\'single\'\nE=val # trailing\nnot a line\n'
  );
  assert.deepEqual(parsed, { A: '1', B: 'spaced', C: 'qu#oted', D: 'single', E: 'val' });
});

test('loadEnvFiles: sets unset vars, never overrides env or earlier files, skips missing', () => {
  const f1 = join(dir, 'first.env');
  const f2 = join(dir, 'second.env');
  writeFileSync(f1, 'SAMARTH_TEST_A=from-first\nSAMARTH_TEST_B=from-first\n');
  writeFileSync(f2, 'SAMARTH_TEST_B=from-second\nSAMARTH_TEST_C=from-second\n');
  delete process.env.SAMARTH_TEST_A;
  delete process.env.SAMARTH_TEST_C;
  process.env.SAMARTH_TEST_B = 'from-shell';
  try {
    loadEnvFiles([join(dir, 'missing.env'), f1, f2]);
    assert.equal(process.env.SAMARTH_TEST_A, 'from-first');
    assert.equal(process.env.SAMARTH_TEST_B, 'from-shell'); // real env wins
    assert.equal(process.env.SAMARTH_TEST_C, 'from-second');
  } finally {
    delete process.env.SAMARTH_TEST_A;
    delete process.env.SAMARTH_TEST_B;
    delete process.env.SAMARTH_TEST_C;
  }
});

test('loadEnvFiles + resolver: .env client id/secret reach loadGoogleOAuthClientWithSource', () => {
  const f = join(dir, 'client.env');
  writeFileSync(f, 'GOOGLE_DESKTOP_CLIENT_ID=envfile-id.apps.googleusercontent.com\nGOOGLE_DESKTOP_CLIENT_SECRET=envfile-secret\n');
  clearEnv();
  try {
    loadEnvFiles([f]);
    const res = loadGoogleOAuthClientWithSource(join(dir, 'nope.json'));
    assert.equal(res.source, 'env');
    assert.equal(res.client?.clientId, 'envfile-id.apps.googleusercontent.com');
    assert.equal(res.client?.clientSecret, 'envfile-secret');
  } finally {
    clearEnv();
  }
});


// restore env + cleanup
if (savedId === undefined) delete process.env.GOOGLE_DESKTOP_CLIENT_ID;
else process.env.GOOGLE_DESKTOP_CLIENT_ID = savedId;
if (savedSecret === undefined) delete process.env.GOOGLE_DESKTOP_CLIENT_SECRET;
else process.env.GOOGLE_DESKTOP_CLIENT_SECRET = savedSecret;
if (savedAltId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
else process.env.GOOGLE_OAUTH_CLIENT_ID = savedAltId;
if (savedAltSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedAltSecret;
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
