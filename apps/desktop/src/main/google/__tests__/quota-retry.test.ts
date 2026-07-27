import assert from 'node:assert/strict';
import { withQuotaRetry, withRetry, QUOTA_RE, TRANSIENT_5XX_RE, NOT_FOUND_OR_PERMISSION_RE, readRetryAfterMs, type RetryRule } from '../quota-retry';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const quotaErr = (): Error =>
  new Error(
    "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'tagmanager.googleapis.com'",
  );
const noSleep = async (): Promise<void> => {};

async function main(): Promise<void> {
  console.log('\nquota-retry:');

  await test('QUOTA_RE matches the real GTM quota message and 429 / RESOURCE_EXHAUSTED', () => {
    assert.ok(QUOTA_RE.test(quotaErr().message));
    assert.ok(QUOTA_RE.test('Error 429: rate limit'));
    assert.ok(QUOTA_RE.test('RESOURCE_EXHAUSTED'));
    assert.ok(!QUOTA_RE.test('Tag not found'), 'a normal error is not retryable');
  });

  await test('retries a quota error then succeeds (default 3 retries)', async () => {
    let calls = 0;
    const out = await withQuotaRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw quotaErr();
        return 'ok';
      },
      { sleep: noSleep },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 3, 'failed twice, succeeded on the 3rd attempt');
  });

  await test('a non-quota error throws immediately — no retries', async () => {
    let calls = 0;
    await assert.rejects(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw new Error('Invalid tag id');
        },
        { sleep: noSleep },
      ),
      /Invalid tag id/,
    );
    assert.equal(calls, 1, 'called once, not retried');
  });

  await test('gives up after maxRetries and rethrows the quota error', async () => {
    let calls = 0;
    await assert.rejects(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw quotaErr();
        },
        { sleep: noSleep, maxRetries: 3 },
      ),
      /Quota exceeded/,
    );
    assert.equal(calls, 4, '1 initial + 3 retries');
  });

  await test('backs off exponentially (2s, 4s, 8s)', async () => {
    const delays: number[] = [];
    await assert.rejects(
      withQuotaRetry(async () => Promise.reject(quotaErr()), {
        maxRetries: 3,
        baseDelayMs: 2000,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );
    assert.deepEqual(delays, [2000, 4000, 8000]);
  });

  await test('readRetryAfterMs parses a delta-seconds Retry-After header and an HTTP date', () => {
    const withHeader = (v: string): unknown => ({ response: { headers: { 'retry-after': v } } });
    assert.equal(readRetryAfterMs(withHeader('45')), 45_000, 'delta-seconds -> ms');
    assert.equal(readRetryAfterMs({ response: { headers: { 'Retry-After': '10' } } }), 10_000, 'capitalized header too');
    assert.equal(readRetryAfterMs({}), undefined, 'no header -> undefined');
    assert.equal(readRetryAfterMs(new Error('boom')), undefined, 'a plain error -> undefined');
    const httpDate = readRetryAfterMs(withHeader(new Date(Date.now() + 30_000).toUTCString()));
    assert.ok(typeof httpDate === 'number' && httpDate > 20_000 && httpDate <= 30_000, `HTTP-date -> ~30s, got ${httpDate}`);
  });

  await test('honors the reset hint: waits AT LEAST Retry-After, capped by maxDelayMs', async () => {
    const delays: number[] = [];
    const err = Object.assign(new Error('Error 429: Queries per minute per user'), {
      response: { headers: { 'retry-after': '50' } }, // server says the minute resets in 50s
    });
    await assert.rejects(
      withQuotaRetry(async () => Promise.reject(err), {
        maxRetries: 2,
        baseDelayMs: 2000, // exponential would be 2s, 4s
        maxDelayMs: 65_000,
        sleep: async (ms) => { delays.push(ms); },
      }),
    );
    // Each wait is max(exponential, 50s hint) — so the retry resumes when the quota actually resets.
    assert.deepEqual(delays, [50_000, 50_000]);
  });

  await test('onBackoff fires once per retry with the attempt number and the delay', async () => {
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    await assert.rejects(
      withQuotaRetry(async () => Promise.reject(quotaErr()), {
        maxRetries: 3,
        baseDelayMs: 2000,
        sleep: async () => {},
        onBackoff: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
      }),
    );
    assert.deepEqual(seen, [
      { attempt: 1, delayMs: 2000 },
      { attempt: 2, delayMs: 4000 },
      { attempt: 3, delayMs: 8000 },
    ]);
  });

  // ── withRetry: the multi-rule engine behind the GTM create path ──

  const err = (msg: string): Error => new Error(msg);
  // The three rules the GTM create path uses (short delays so tests run instantly).
  const gtmCreateRules: RetryRule[] = [
    { label: 'quota', match: (_e, m) => QUOTA_RE.test(m), maxRetries: 8, baseDelayMs: 1, honorRetryAfter: true },
    { label: 'server', match: (_e, m) => TRANSIENT_5XX_RE.test(m), maxRetries: 4, baseDelayMs: 1 },
    { label: 'propagation', match: (_e, m) => NOT_FOUND_OR_PERMISSION_RE.test(m), maxRetries: 4, baseDelayMs: 1 },
  ];
  const runRules = <T>(fn: () => Promise<T>, backoffs?: string[]): Promise<T> =>
    withRetry(fn, { rules: gtmCreateRules, sleep: async () => {}, onBackoff: ({ rule }) => backoffs?.push(rule) });

  await test('the create regexes classify the observed GTM errors', () => {
    assert.ok(TRANSIENT_5XX_RE.test('Error 503: The service is currently unavailable'));
    assert.ok(TRANSIENT_5XX_RE.test('Internal error encountered.'));
    assert.ok(NOT_FOUND_OR_PERMISSION_RE.test('Not found or permission denied.'), 'the exact GTM message');
    assert.ok(!NOT_FOUND_OR_PERMISSION_RE.test('Tag not found'), 'a plain not-found is NOT the conflated write error');
    assert.ok(!TRANSIENT_5XX_RE.test('Invalid argument'));
  });

  await test('withRetry retries a transient 5xx then succeeds', async () => {
    let calls = 0;
    const out = await runRules(async () => { calls += 1; if (calls < 3) throw err('Error 503: service unavailable'); return 'ok'; });
    assert.equal(out, 'ok');
    assert.equal(calls, 3, 'failed twice on 503, succeeded on the 3rd');
  });

  await test('withRetry rides out the fresh-container 404, then the identical create succeeds', async () => {
    let calls = 0;
    const out = await runRules(async () => { calls += 1; if (calls < 3) throw err('Not found or permission denied.'); return 'created'; });
    assert.equal(out, 'created', 'the propagation window cleared and the create went through');
    assert.equal(calls, 3);
  });

  await test('withRetry gives the conflated 404 only a BOUNDED retry (a genuine wrong id still fails)', async () => {
    let calls = 0;
    await assert.rejects(runRules(async () => { calls += 1; throw err('Not found or permission denied.'); }), /Not found or permission denied/);
    assert.equal(calls, 5, '1 initial + 4 bounded retries, then it gives up (does not loop forever)');
  });

  await test('withRetry gives EACH rule its own budget (5xx blips + a 404 window in one call)', async () => {
    const seq = ['Error 503: x', 'Error 503: x', 'Not found or permission denied.', 'Not found or permission denied.', 'ok'];
    let i = 0;
    const backoffs: string[] = [];
    const out = await runRules(async () => { const v = seq[i++]; if (v !== 'ok') throw err(v); return v; }, backoffs);
    assert.equal(out, 'ok');
    assert.deepEqual(backoffs, ['server', 'server', 'propagation', 'propagation'], 'server and propagation budgets did not steal from each other');
  });

  await test('withRetry throws immediately on an unmatched error', async () => {
    let calls = 0;
    await assert.rejects(runRules(async () => { calls += 1; throw err('Invalid argument: name'); }), /Invalid argument/);
    assert.equal(calls, 1, 'no retry for a non-transient error');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
