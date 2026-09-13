/**
 * Reasons a person can act on.
 *
 * The bar for every case here: could someone who has never read this codebase decide what to do
 * next from the Reason line alone?
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainError, explainExit } from '../explain.js';

test('the incident that prompted this reads as itself', () => {
  // The real crash of 2026-08-25, which recorded "Unhandled error in the process".
  const e = explainError(
    'listen EADDRINUSE: address already in use 127.0.0.1:8787\n    at Server.setupListenHandle (node:net:2008:16)',
    { kind: 'crash', code: 'EADDRINUSE' },
  );
  assert.equal(e.reason, 'Port 8787 is already in use, so another orchestrator is probably still running');
  assert.match(e.action ?? '', /Stop the other process/);
});

test('OpenAI failures are told apart, because the responses differ', () => {
  // "Rate limited, try again" and "you have no money" are both 429s and only one clears itself.
  const credit = explainError('You exceeded your current quota, please check your plan and billing details', { kind: 'turn', status: 429 });
  assert.equal(credit.reason, 'The OpenAI account has no remaining credit');
  assert.match(credit.action ?? '', /retrying will not help/);

  const rate = explainError('Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM)', { kind: 'turn', status: 429 });
  assert.match(rate.reason, /per-minute limit/);
  assert.match(rate.action ?? '', /clears on its own/);

  assert.match(explainError('Incorrect API key provided: sk-abc', { kind: 'turn' }).reason, /rejected the API key/);
  assert.match(explainError('The model `gpt-9` does not exist or you do not have access to it', {}).reason, /rejected the configured model/);
});

test('a Google failure says which of the three it is', () => {
  // Expired, wrong scope and no permission are three different conversations with the user.
  assert.match(explainError('invalid_grant: Token has been expired or revoked.', { kind: 'tool' }).reason, /expired or been revoked/);
  assert.match(explainError('Request had insufficient authentication scopes', { kind: 'tool' }).reason, /not with the permissions/);
  assert.match(explainError('PERMISSION_DENIED: caller does not have permission', { kind: 'tool' }).reason, /cannot reach that container/);
  assert.match(explainError('Quota exceeded: quotaExceeded for gtm.accounts.list', { kind: 'tool' }).reason, /quota/i);
});

test('a missing table names the migration problem rather than the SQL', () => {
  const e = explainError('relation "public.orchestrator_events" does not exist', { kind: 'database' });
  assert.equal(e.reason, 'The database is missing public.orchestrator_events');
  assert.match(e.action ?? '', /migrations/);
});

test('Slack tokens become sentences', () => {
  assert.match(explainError('Slack answered 404 no_service', { kind: 'slack' }).reason, /no longer recognises this webhook/);
  assert.match(explainError('channel_not_found', { kind: 'slack' }).reason, /channel .* gone or closed/);
});

test('a kind-specific rule does not fire for other kinds', () => {
  // "403" means the site blocked the scanner, or that Google refused: not the same sentence.
  assert.match(explainError('Request failed with 403 Forbidden', { kind: 'scan' }).reason, /refused the scanner/);
  assert.doesNotMatch(explainError('Request failed with 403 Forbidden', { kind: 'turn' }).reason, /scanner/);
});

test('an unmatched error keeps its own first sentence rather than being labelled', () => {
  // The whole point of the fallback: an unrecognised failure's own words beat "Unexpected error".
  const e = explainError('Error: The workspace snapshot could not be built. Retrying will not help.', {});
  assert.equal(e.reason, 'The workspace snapshot could not be built');
  assert.equal(e.action, undefined);
});

test('a JSON body is described, not quoted at random', () => {
  const body = '{"error":{"message":"The container is in a bad state","code":409}}';
  assert.equal(explainError(body, {}).reason, 'The container is in a bad state');
  assert.match(explainError('{"weird":1}', {}).reason, /no readable message/);
});

test('a very long message is cut, and an empty one says so', () => {
  const long = explainError(`${'x'.repeat(500)}`, {}).reason;
  assert.ok(long.length <= 140, `got ${long.length}`);
  assert.equal(explainError('', {}).reason, 'No reason was reported');
  assert.equal(explainError('   ', {}).reason, 'No reason was reported');
});

test('a status code is used only when the words do not decide it', () => {
  assert.match(explainError('something opaque', { status: 503 }).reason, /returned a 503/);
  assert.match(explainError('something opaque', { status: 401 }).reason, /credentials were not accepted/);
  // The words win over the status: this is a 500 that says exactly what happened.
  assert.match(explainError('ECONNREFUSED 127.0.0.1:3001', { status: 500 }).reason, /Nothing is listening at 127\.0\.0\.1:3001/);
});

// ── Exits ───────────────────────────────────────────────────────────────────

test('an exit code becomes what it means on this host', () => {
  // Every external stop on Windows is this number, which is why it needs saying in words.
  assert.match(explainExit(4294967295, null, 0).reason, /Something outside the process stopped it/);
  assert.match(explainExit(3221225786, null, 0).reason, /Ctrl\+C/);
  assert.match(explainExit(1, null, 0).reason, /exited with an error/);
  assert.match(explainExit(0, null, 0).reason, /should never do/);
  assert.match(explainExit(null, 'SIGKILL', 0).reason, /killed outright/);
  assert.match(explainExit(null, null, 0).reason, /without reporting why/);
  assert.match(explainExit(7, null, 0).reason, /code 7/);
});

test('a crash loop is diagnosed as configuration, whatever the code', () => {
  const e = explainExit(1, null, 8);
  assert.match(e.reason, /8 times in a row/);
  assert.match(e.reason, /configuration rather than bad luck/);
  assert.match(e.action ?? '', /\.env/);
});
