/**
 * Reading the orchestrator's log from the website.
 *
 * The property worth defending: this log is cross-tenant, so access is granted by THIS process's
 * environment and by nothing else, and an unconfigured deployment grants it to nobody.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLogAdmin, logAdmins, redactSecrets, MAX_LINES, DEFAULT_LINES } from '../logs.js';

const withEnv = (value: string | undefined, fn: () => void): void => {
  const before = process.env.ORCHESTRATOR_LOG_ADMINS;
  if (value === undefined) delete process.env.ORCHESTRATOR_LOG_ADMINS;
  else process.env.ORCHESTRATOR_LOG_ADMINS = value;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.ORCHESTRATOR_LOG_ADMINS;
    else process.env.ORCHESTRATOR_LOG_ADMINS = before;
  }
};

test('an unconfigured deployment lets nobody read the log', () => {
  // The default has to be closed. A log that opens itself as soon as someone signs in as an admin
  // somewhere else is not a decision this process made.
  withEnv(undefined, () => {
    assert.equal(logAdmins().size, 0);
    assert.equal(isLogAdmin({ id: 'anyone', email: 'admin@example.com' }), false);
  });
});

test('an empty or whitespace allowlist is still nobody', () => {
  withEnv('  ,  , ', () => {
    assert.equal(logAdmins().size, 0);
    assert.equal(isLogAdmin({ id: 'x', email: 'y@example.com' }), false);
  });
});

test('the allowlist matches on id or email, case-insensitively', () => {
  // Whoever configures this knows one or the other, and should not have to look up a UUID.
  withEnv('Admin@Example.COM, 9f8e7d6c', () => {
    assert.equal(isLogAdmin({ id: 'u1', email: 'admin@example.com' }), true);
    assert.equal(isLogAdmin({ id: '9F8E7D6C', email: 'someone@else.com' }), true);
    assert.equal(isLogAdmin({ id: 'u2', email: 'other@example.com' }), false);
    assert.equal(isLogAdmin({}), false, 'a user with neither is not an admin by omission');
  });
});

test('credentials are stripped on the way out', () => {
  // A second net, not the first: lines are already written through forLog(). It exists because the
  // cost of those two disagreeing is a live token sitting in a browser tab.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const cases: Array<[string, RegExp]> = [
    [`[req] GET /v1/x authorization=Bearer abcdef0123456789abcdef`, /\[redacted\]/],
    [`token ${jwt} used`, /\[jwt redacted\]/],
    ['GOOGLE_ACCESS_TOKEN=ya29.a0AfB_byBcDeFgHiJkLmNoP', /\[google token redacted\]/],
    ['key sk-abcdefghijklmnopqrstuvwxyz012345', /\[api key redacted\]/],
    ['{"access_token":"abc123secret","x":1}', /\[redacted\]/],
  ];
  for (const [line, expected] of cases) {
    const out = redactSecrets(line);
    assert.match(out, expected, `not redacted: ${line}`);
  }
});

test('ordinary log lines survive redaction unchanged', () => {
  // Over-redacting makes the log useless, which is its own failure: an operator reading a wall of
  // [redacted] cannot tell a working deploy from a broken one.
  const line = '[2026-08-13 17:25:19] [req] POST /v1/chat -> 200 9801ms origin=https://aitagmanager.com';
  assert.equal(redactSecrets(line), line);
  const tool = '[write] create_gtm_tracking_tag applied directly (gtm_draft) for user f5f1283f';
  assert.equal(redactSecrets(tool), tool);
});

test('the line ceiling is a real ceiling', () => {
  assert.ok(DEFAULT_LINES < MAX_LINES, 'the default must be below the cap');
  assert.ok(MAX_LINES <= 5000, 'a request must not be able to ask for the whole 5MB file');
});
