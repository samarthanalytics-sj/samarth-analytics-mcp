/**
 * Classification of OpenAI 429s.
 *
 * A 429 covers two situations that need opposite responses: a per-minute limit that clears on its
 * own, and a spent balance that never will. Both were reported as "retry in a moment", and the
 * retry loop backed off three times before saying so.
 *
 * The bodies here are verbatim from this account's own logs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isBillingFailure, OpenAiClient, OpenAiError } from '../openai.js';
import type { OrchestratorConfig } from '../config.js';

const CREDIT_EXHAUSTED = JSON.stringify({
  error: {
    message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
    type: 'insufficient_quota',
    param: null,
    code: 'credit_balance_exhausted',
  },
});

const TPM_LIMIT = JSON.stringify({
  error: {
    message: 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 5333. Please try again in 10.666s.',
    type: 'tokens',
  },
});

const cfg = {
  openai: { apiKey: 'k', baseUrl: 'https://api.openai.test/v1', model: 'gpt-4o', maxOutputTokens: 100, requestTimeoutMs: 5_000 },
} as unknown as OrchestratorConfig;

function respondWith(body: string, headers: Record<string, string> = {}): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(body, { status: 429, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

void test('a spent balance is recognised from error.type even though code says something else', () => {
  // OpenAI splits this across the two fields: type=insufficient_quota, code=credit_balance_exhausted.
  // Reading only `code` missed it, which is how the retries ran and the wrong message was shown.
  assert.ok(isBillingFailure('insufficient_quota'));
  assert.ok(isBillingFailure('credit_balance_exhausted'));
  assert.equal(isBillingFailure('rate_limit_exceeded'), false);
  assert.equal(isBillingFailure('tokens'), false);
});

void test('a spent balance is NOT retried', async () => {
  const { fetchImpl, calls } = respondWith(CREDIT_EXHAUSTED);
  const client = new OpenAiClient(cfg, fetchImpl);
  await assert.rejects(
    () => client.streamChat([], [], { onDelta() {} }, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof OpenAiError);
      assert.ok(isBillingFailure(err.code), `expected a billing code, got "${err.code}"`);
      return true;
    },
  );
  assert.equal(calls(), 1, 'a spent balance fails the same way on the fourth attempt as the first');
});

void test('a real per-minute limit IS retried, and carries the ceiling', async () => {
  const { fetchImpl, calls } = respondWith(TPM_LIMIT, { 'x-ratelimit-limit-tokens': '30000', 'retry-after': '1' });
  // Sleep is injected: a spent token window now waits 20s+ before retrying, and a suite that
  // actually served that wait would take minutes and time out its own request budget.
  const client = new OpenAiClient(cfg, fetchImpl, async () => {});
  await assert.rejects(
    () => client.streamChat([], [], { onDelta() {} }, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof OpenAiError);
      assert.equal(isBillingFailure(err.code), false);
      assert.equal(err.limitTokens, 30_000, 'the ceiling must reach the message the user reads');
      return true;
    },
  );
  assert.ok(calls() > 1, 'a pace limit is worth retrying');
});

// Retrying into a token window that is already spent.
//
// From a real turn: five retries on Retry-After hints of 1.75 to 7.7 seconds, "Used 30000" every
// time, and the turn failed after 38 seconds having never had room to run. OpenAI's hint says when
// the next few tokens free up, not when there is space for the whole request.

const TPM_429 =
  'OpenAI returned 429: { "error": { "message": "Rate limit reached for gpt-4o in organization ' +
  'org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 3884. Please try again in ' +
  '7.768s.", "type": "tokens", "code": "rate_limit_exceeded" } } retry-after:2';

const RPM_429 =
  'OpenAI returned 429: { "error": { "message": "Rate limit reached for gpt-4o in organization ' +
  'org-x on requests per min (RPM): Limit 500, Used 500. Please try again in 120ms.", ' +
  '"code": "rate_limit_exceeded" } } retry-after:1';

test('the backoff floor applies to a spent token window and not to a rate limit', async () => {
  const { retryDelayMs } = await import('../openai.js');
  // OpenAI's own hint, which is the number that failed: 2 seconds into a window with no room.
  assert.equal(retryDelayMs(0, '2', false), 2_000, 'an ordinary 429 keeps the short hint');
  assert.ok(
    retryDelayMs(0, '2', true) >= 20_000,
    'a spent window waits long enough for the rolling minute to drain',
  );
  // It escalates rather than repeating the same too-short wait five times.
  assert.ok(retryDelayMs(2, '2', true) > retryDelayMs(0, '2', true));
  assert.ok(retryDelayMs(9, '2', true) <= 60_000, 'and is still bounded');
});

test('a spent TOKEN window is told apart from a request-rate limit', async () => {
  const { isTokenWindowSaturated } = await import('../openai.js');
  assert.equal(isTokenWindowSaturated(TPM_429), true);
  assert.equal(
    isTokenWindowSaturated(RPM_429),
    false,
    'a request-rate 429 clears in a second and must keep the short backoff',
  );
  assert.equal(isTokenWindowSaturated('OpenAI returned 500: server error'), false);
});

test('the caller is told it is waiting, and for how long', async () => {
  // A turn that pauses in silence is indistinguishable from one that has hung, and the reasonable
  // response to a hang is a reload - which throws away the turn that was about to succeed.
  const { fetchImpl } = respondWith(TPM_LIMIT, { 'x-ratelimit-limit-tokens': '30000', 'retry-after': '2' });
  const waits: Array<{ ms: number; reason: string; attempt: number; of: number }> = [];
  const client = new OpenAiClient(cfg, fetchImpl, async () => {});

  await assert.rejects(() =>
    client.streamChat([], [], { onDelta() {}, onWait: (w) => waits.push(w) }, new AbortController().signal),
  );

  assert.ok(waits.length > 0, 'every sleep is announced before it happens');
  assert.equal(waits[0].reason, 'token_window');
  assert.ok(waits[0].ms >= 20_000, 'and reports the real wait, not the hint that was too short');
  assert.equal(waits[0].of, 3);
  assert.equal(waits[0].attempt, 1);
});
