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
  const client = new OpenAiClient(cfg, fetchImpl);
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
