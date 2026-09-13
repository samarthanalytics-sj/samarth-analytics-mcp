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

// ── Telling the two stories apart ────────────────────────────────────────────
//
// One process serves the chat and the tag-suggestions page, so the log interleaves them. Answering
// "why was that scan slow" means skipping past chat turns, and a text box only helps someone who
// already knows which prefixes to type.

test('a line is filed under the part of the system it came from', async () => {
  const { classifyLine } = await import('../logs.js');
  const cases: Array<[string, string | undefined]> = [
    ['[2026-08-13 17:00:00] [scan] https://x.com -> 13 suggestion(s) in 9000ms', 'suggestions'],
    ['[2026-08-13 17:00:00] [suggestions] created 3/3 tag(s)', 'suggestions'],
    ['[2026-08-13 17:00:00] [req] POST /v1/suggestions/scan -> 200 9801ms', 'suggestions'],
    ['[2026-08-13 17:00:00] [tools] 38 of 97 tools visible this turn', 'chat'],
    ['[2026-08-13 17:00:00] [openai] 429 rate_limit_exceeded', 'chat'],
    ['[2026-08-13 17:00:00] [req] POST /v1/chat -> 200 6355ms', 'chat'],
    ['[2026-08-13 17:00:00] [orchestrator] listening on http://127.0.0.1:8787', 'system'],
    ['[2026-08-13 17:00:00] [pool] closed MCP session (idle)', 'system'],
  ];
  for (const [line, expected] of cases) {
    assert.equal(classifyLine(line), expected, line);
  }
});

test('a write gets its own category rather than being guessed at', async () => {
  // Both surfaces create tags and the line does not say which asked. Filing every write under chat
  // would hide the ones a scan made from someone looking for exactly those; leaving them
  // uncategorised would make the most interesting lines unreachable from every filter.
  const { classifyLine } = await import('../logs.js');
  assert.equal(classifyLine('[2026-08-13 17:00:00] [write] create_gtm_tracking_tag applied'), 'writes');
  assert.equal(classifyLine('[2026-08-13 17:00:00] [tool] ga4_delete_key_event failed'), 'writes');
  assert.equal(classifyLine('a line with no tag at all'), undefined);
});

test('the other shapes in this file are classified too', async () => {
  // Measured against the real log: these three accounted for two thirds of what used to fall
  // through, so every category filter was hiding most of the file.
  const { classifyLine } = await import('../logs.js');
  assert.equal(classifyLine('[supervisor 2026-08-13T12:35:10.443Z] started orchestrator (pid 18360)'), 'system');
  assert.equal(classifyLine('[samarth-gtm-mcp] Server ready on stdio transport'), 'system');
  assert.equal(classifyLine('[auth] Using OAuth2 user credentials'), 'system');
  assert.equal(
    classifyLine('[2026-08-25 13:30:00] [event] orchestrator.started started: Orchestrator Started'),
    'system',
    'a lifecycle event is filed under system, whatever task it names',
  );
  assert.equal(classifyLine('[req] GET /.aws/credentials -> 404 1ms origin=-'), 'system', 'a probe is not chat');
  assert.equal(classifyLine('[req] GET /v1/resources/gtm/accounts -> 200 2630ms'), 'chat');
});

test('a whole crash lands in one place, not half of it', async () => {
  // The half that names the cause is usually the useful half.
  const { classifyLine } = await import('../logs.js');
  for (const line of [
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:8787',
    "  code: 'EADDRINUSE',",
    '  errno: -4091,',
    '    at Server.setupListenHandle (node:net:1817:16)',
    "Emitted 'error' event on Server instance at:",
  ]) {
    assert.equal(classifyLine(line), 'system', line);
  }
});

test('problems are found across categories, and a duration is not a status code', async () => {
  const { isProblem } = await import('../logs.js');
  assert.equal(isProblem('[openai] 429 rate_limit_exceeded tokens-per-minute:0/30000'), true);
  assert.equal(isProblem('[tool] ga4_delete_key_event failed for user f5f1283f'), true);
  assert.equal(isProblem('[req] GET /v1/resources/gtm/accounts -> 502 1341ms'), true);
  assert.equal(isProblem('Not creating "X": placeholder Measurement ID'), true);
  // The one that matters: a healthy request that took 500ms is not a 500.
  assert.equal(isProblem('[req] POST /v1/chat -> 200 500ms origin=https://aitagmanager.com'), false);
  assert.equal(isProblem('[orchestrator] listening on http://127.0.0.1:8787'), false);
});

// ── Who a line is about ──────────────────────────────────────────────────────

test('a person is identified by a stable handle, not their address', async () => {
  const { userTag } = await import('../redact.js');
  const a = userTag({ id: 'u1', email: 'Jane@Acme.com' });
  assert.equal(a, userTag({ id: 'different-id', email: 'jane@acme.com' }), 'stable, and case-insensitive');
  assert.equal(a.includes('jane'), false, 'the local part does not appear');
  assert.match(a, /^[0-9a-f]{10}@acme\.com$/, 'the domain stays readable: it names the tenant');
});

test('someone with no email is still followable through the log', async () => {
  const { userTag } = await import('../redact.js');
  assert.equal(userTag({ id: 'abcdefgh12345678' }), 'u:abcdefgh');
  assert.equal(userTag({}), 'u:anonymou');
});

test('the new chat and scan lines land in the right categories', async () => {
  const { classifyLine } = await import('../logs.js');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [chat] turn START user=abc@acme.com product=gtm'), 'chat');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [chat] turn FAILED user=abc code=rate_limited: ...'), 'chat');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [scan] OK user=abc url=https://x.com scanned=8'), 'suggestions');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [scan] not read: https://x.com/a - over scan budget'), 'suggestions');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [suggestions] INJECT user=abc created=3'), 'suggestions');
  assert.equal(classifyLine('[2026-08-13 18:00:00] [suggestions] FAILED "GA4 - X": quota'), 'suggestions');
});

test('a failure line reads as a failure to the Problems filter', async () => {
  const { isProblem } = await import('../logs.js');
  assert.equal(isProblem('[chat] turn FAILED user=abc after 900ms code=rate_limited: Rate limit reached'), true);
  assert.equal(isProblem('[scan] FAILED user=abc url=https://x.com code=scanner_not_built: not built'), true);
  assert.equal(isProblem('[suggestions] FAILED "GA4 - Event - Email Click": quota exceeded'), true);
  assert.equal(isProblem('[suggestions] listener FAILED "cHTML - Calendly": timeout'), true);
  // And the successes do not, or the filter is just the log again.
  assert.equal(isProblem('[chat] turn OK user=abc in 5300ms'), false);
  assert.equal(isProblem('[suggestions] created "GA4 - Event - Email Click" id=12 trigger=created'), false);
});
