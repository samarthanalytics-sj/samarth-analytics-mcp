/**
 * Reading the orchestrator's log from the website.
 *
 * The property worth defending: this log is cross-tenant, so it opens for a SUPER ADMIN of the
 * product and for nobody else, and every path that cannot establish that fails closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuperAdmin, redactSecrets, MAX_LINES, DEFAULT_LINES } from '../logs.js';

const SUPABASE = { url: 'https://db.example.co', serviceRoleKey: 'service-key' };

/** A fetch that answers the RPC with whatever is given, and records how it was called. */
function fakeFetch(answer: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('a super admin may read it', async () => {
  const { impl, calls } = fakeFetch(true);
  assert.equal(await isSuperAdmin('user-1', SUPABASE, impl), true);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/is_super_admin$/, "it asks the database's own definition");
  assert.deepEqual(calls[0].body, { _user_id: 'user-1' });
});

test('an ordinary admin may not', async () => {
  // The whole point of choosing super_admin over admin: an admin of the product does not get to
  // read every tenant's activity.
  const { impl } = fakeFetch(false);
  assert.equal(await isSuperAdmin('user-2', SUPABASE, impl), false);
});

test('anything other than a plain true is a no', async () => {
  for (const answer of [null, 'true', 1, {}, [true], undefined]) {
    const { impl } = fakeFetch(answer);
    assert.equal(await isSuperAdmin('u', SUPABASE, impl), false, `answer ${JSON.stringify(answer)} must not pass`);
  }
});

test('an unreachable database means nobody, not everybody', async () => {
  // Fails closed. The alternative is that a network problem opens a cross-tenant log.
  const thrower = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(await isSuperAdmin('u', SUPABASE, thrower), false);

  const { impl } = fakeFetch({ message: 'no such function' }, 404);
  assert.equal(await isSuperAdmin('u', SUPABASE, impl), false, 'a missing RPC must not open the log');
});

test('a deployment with no service role key opens it to nobody', async () => {
  const { impl } = fakeFetch(true);
  assert.equal(await isSuperAdmin('u', {}, impl), false);
  assert.equal(await isSuperAdmin('u', { url: SUPABASE.url }, impl), false);
  assert.equal(await isSuperAdmin('', SUPABASE, impl), false, 'no user is not a super admin');
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
