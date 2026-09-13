/** DevLog redaction: the security boundary. Nothing secret may cross main -> renderer. */
import assert from 'node:assert/strict';
import { redact, redactAll, redactString, isSecretKey, safeUrl, MAX_STRING, MAX_ARRAY, MAX_DEPTH } from '../devlog.js';

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('devlog redaction');

// ── secret KEYS ──────────────────────────────────────────────────────────────
t('isSecretKey catches token/secret/key names across casings', () => {
  for (const k of ['token', 'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'apiKey', 'api_key', 'developerToken', 'developer_token', 'clientSecret', 'client_secret', 'password', 'Authorization', 'authToken', 'cookie', 'privateKey', 'x-goog-api-key']) {
    assert.equal(isSecretKey(k), true, `${k} should be secret`);
  }
});

t('isSecretKey does NOT over-match benign keys', () => {
  for (const k of ['author', 'name', 'accountId', 'containerId', 'keyword', 'keywords', 'tokenCount', 'description', 'title', 'sessionsCount', 'monkey']) {
    assert.equal(isSecretKey(k), false, `${k} should NOT be secret`);
  }
});

t('a secret-keyed value is replaced wholesale, at any nesting depth', () => {
  const out = redact({ llm: { provider: 'anthropic', apiKey: 'sk-ant-REALSECRET123' }, developerToken: 'DEVTOKENXYZ', ok: true }) as Record<string, any>;
  assert.equal(out.llm.apiKey, '[redacted]');
  assert.equal(out.developerToken, '[redacted]');
  assert.equal(out.llm.provider, 'anthropic', 'non-secret siblings survive');
  assert.equal(out.ok, true);
});

// ── secret-shaped STRINGS ────────────────────────────────────────────────────
t('redactString scrubs bearer tokens, Google tokens, API keys and JWTs', () => {
  assert.match(redactString('Authorization: Bearer ya29.a0AfB_longtokenvalue'), /Bearer \[redacted\]/);
  assert.equal(/ya29\.a0AfB/.test(redactString('token=ya29.a0AfB_longtokenvalue here')), false);
  assert.match(redactString('key AIzaSyD-1234567890abcdefghijklmnopqrstuv end'), /\[redacted-api-key\]/);
  assert.match(redactString('jwt eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeKKF here'), /\[redacted-jwt\]/);
  assert.match(redactString('refresh 1//0abcDEF_ghiJKL end'), /\[redacted-refresh-token\]/);
});

t('redactString scrubs credential query/form params but keeps benign ones', () => {
  const s = redactString('GET /v2/x?access_token=SECRETTOK&accountId=123&api_key=AB12');
  assert.equal(/SECRETTOK/.test(s), false);
  assert.equal(/AB12/.test(s), false);
  assert.match(s, /accountId=123/, 'benign param preserved');
});

t('a plain readable log line is left intact', () => {
  assert.equal(redactString('[gtm-accounts] 3 account(s): Acme(111), Beta(222)'), '[gtm-accounts] 3 account(s): Acme(111), Beta(222)');
});

// ── shape safety (structured-clone-safe, capped, non-throwing) ───────────────
t('redact returns clone-safe values (functions/buffers/symbols become descriptors)', () => {
  const out = redact({ fn: () => 1, buf: Buffer.from('hi'), sym: Symbol('s'), n: 5, b: false, nil: null }) as Record<string, any>;
  assert.match(out.fn, /\[Function/);
  assert.match(out.buf, /\[Buffer 2 bytes\]/);
  assert.match(out.sym, /Symbol\(s\)/);
  assert.equal(out.n, 5);
  assert.equal(out.b, false);
  assert.equal(out.nil, null);
  // Must survive a structured-clone round trip (what the IPC channel does).
  assert.doesNotThrow(() => structuredClone(out));
});

t('redact breaks circular references instead of throwing', () => {
  const a: any = { name: 'a' };
  a.self = a;
  const out = redact(a) as Record<string, any>;
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

t('redact caps string length, array length and depth', () => {
  const longStr = 'x'.repeat(MAX_STRING + 500);
  assert.ok((redact(longStr) as string).length < MAX_STRING + 60);
  const bigArr = Array.from({ length: MAX_ARRAY + 50 }, (_, i) => i);
  const outArr = redact(bigArr) as unknown[];
  assert.equal(outArr.length, MAX_ARRAY + 1);
  assert.match(String(outArr[MAX_ARRAY]), /\+50 more/);
  // Depth cap: build a chain deeper than MAX_DEPTH.
  let deep: any = { v: 'leaf' };
  for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { child: deep };
  assert.doesNotThrow(() => structuredClone(redact(deep)));
});

t('redact never throws on a getter that throws', () => {
  const evil = {} as Record<string, unknown>;
  Object.defineProperty(evil, 'boom', { enumerable: true, get() { throw new Error('nope'); } });
  assert.doesNotThrow(() => redact({ evil }));
});

t('an Error becomes {name,message,stack} with the message redacted', () => {
  const out = redact(new Error('failed with token ya29.SECRETVALUE123')) as Record<string, any>;
  assert.equal(out.name, 'Error');
  assert.equal(/ya29\.SECRET/.test(out.message), false);
  assert.ok('stack' in out);
});

t('redactAll maps an argument list', () => {
  const out = redactAll(['msg', { apiKey: 'x' }, 5]);
  assert.equal(out[0], 'msg');
  assert.equal((out[1] as any).apiKey, '[redacted]');
  assert.equal(out[2], 5);
});

// ── safeUrl (http scope) ─────────────────────────────────────────────────────
t('safeUrl keeps host+path, redacts secret query params, preserves benign ones', () => {
  const u = safeUrl('https://tagmanager.googleapis.com/tagmanager/v2/accounts/111/containers?access_token=SECRET&fields=name');
  assert.match(u, /tagmanager\.googleapis\.com\/tagmanager\/v2\/accounts\/111/);
  assert.equal(/SECRET/.test(u), false);
  assert.match(u, /fields=name/);
});

t('safeUrl on an unparseable value still strips the query', () => {
  assert.equal(safeUrl('not a url?token=SECRET'), 'not a url');
});

console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
