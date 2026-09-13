/**
 * Redaction tests.
 *
 * This module decides what is allowed to reach a log file, so the assertions run in both
 * directions: credentials must never survive, and ordinary error prose must survive intact. A
 * redactor that eats real error text is quietly as harmful as one that leaks, because it pushes
 * whoever is debugging back to guessing.
 */
import assert from 'node:assert/strict';
import { forLog, redactSecrets, userRef } from '../redact.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('credentials must not survive');

const SECRETS: [string, string][] = [
  ['google access token', 'ya29.a0AfB_byC3xyzABCDEF1234567890abcdefGHIJ'],
  ['google refresh token', '1//0eXaMpLeRefreshTokenValue123456'],
  ['google api key', 'AIzaSyD-ExampleKeyValue1234567890abcdef'],
  ['openai key', 'sk-proj-abcdefGHIJKLmnopQRSTuvwx1234567890'],
  ['supabase jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
];

for (const [label, secret] of SECRETS) {
  test(`${label} is removed`, () => {
    const out = redactSecrets(`upstream said: ${secret} was rejected`);
    assert.equal(out.includes(secret), false, `the ${label} survived redaction`);
    assert.match(out, /\[redacted:/);
  });
}

test('a bearer credential quoted in an error is removed', () => {
  const out = redactSecrets('request failed with header Authorization: Bearer abcdefghijklmnop1234567890');
  assert.equal(/abcdefghijklmnop/.test(out), false);
  assert.match(out, /Bearer \[redacted\]/);
});

test('several secrets in one string are all removed', () => {
  const out = redactSecrets('ya29.aaaaaaaaaaaaaaa then sk-proj-bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(/ya29\.a/.test(out), false);
  assert.equal(/sk-proj-b/.test(out), false);
});

console.log('real error text must survive');

test('the errors we actually debugged are left readable', () => {
  // Every one of these was load-bearing during a real production diagnosis.
  for (const msg of [
    'Google refused the token refresh: unauthorized_client',
    'accounts_list failed: Google API Error : unauthorized_client',
    'Could not load the default credentials',
    'invalid_grant: Token has been expired or revoked',
    'No Google account is connected to this profile.',
  ]) {
    assert.equal(redactSecrets(msg), msg, `redaction damaged: ${msg}`);
  }
});

test('ordinary identifiers are not mistaken for secrets', () => {
  // Container and account ids are the whole point of a GTM error message.
  const msg = 'container GTM-ABCD123 account 6305785417 workspace 12 tag 1489388038';
  assert.equal(redactSecrets(msg), msg);
});

console.log('log-line shaping');

test('newlines are collapsed so one failure is one line', () => {
  assert.equal(forLog('line one\n  line two\n\nline three'), 'line one line two line three');
});

test('long text is bounded and marked as cut', () => {
  const out = forLog('x'.repeat(5000));
  assert.ok(out.length <= 403, `expected a bounded line, got ${out.length}`);
  assert.ok(out.endsWith('...'));
});

test('redaction happens before truncation, so a secret cannot ride in on the tail', () => {
  // If truncation ran first, a secret sitting past the cut would still be inside the raw string
  // when the redactor never saw it.
  const out = forLog(`${'p'.repeat(380)} ya29.SECRETVALUE1234567890abcdef`);
  assert.equal(out.includes('ya29.SECRETVALUE'), false);
});

test('empty input is safe', () => {
  assert.equal(forLog(''), '');
  assert.equal(redactSecrets(''), '');
});

console.log('user references');

test('a user id is shortened, never logged whole', () => {
  const id = '0f024180-9c1b-4f2a-8e3d-1a2b3c4d5e6f';
  const ref = userRef(id);
  assert.equal(ref, '0f024180');
  assert.equal(ref.length, 8);
  assert.equal(id.startsWith(ref), true, 'the prefix must still correlate to the same user');
});

test('a short id is not padded or mangled', () => {
  assert.equal(userRef('abc'), 'abc');
});

console.log(`\n${passed} assertions passed`);
