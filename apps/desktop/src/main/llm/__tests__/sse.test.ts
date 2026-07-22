// Pure tests for the LLM SSE retry-delay logic, the retry NOTICE (so a rate-limit wait is visible
// instead of a silent hang), and the wall-clock request budget.
// Run: tsx apps/desktop/src/main/llm/__tests__/sse.test.ts

import assert from 'node:assert/strict';
import {
  MAX_RETRIES,
  PROVIDER_REQUEST_TIMEOUT_MS,
  retryDelayMs,
  startStream,
  withRequestTimeout,
  type RetryNotice,
} from '../sse';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

async function main(): Promise<void> {
console.log('\nsse.retryDelayMs:');

test('Retry-After header (seconds) wins', () => {
  assert.equal(retryDelayMs('2', 'ignored', 0), 2250); // 2000 + 250 pad
});

test('parses "try again in N.Ns" from the message when no header', () => {
  // OpenAI 429 shape from the field report.
  assert.equal(retryDelayMs(null, 'Rate limit reached … Please try again in 27.106s.', 0), 27356); // ceil(27106)+250
});

test('header takes precedence over the message hint', () => {
  assert.equal(retryDelayMs('1', 'try again in 30s', 3), 1250);
});

test('falls back to capped exponential backoff', () => {
  assert.equal(retryDelayMs(null, 'no hint here', 0), 1000);
  assert.equal(retryDelayMs(null, 'no hint here', 1), 2000);
  assert.equal(retryDelayMs(null, 'no hint here', 3), 8000);
  assert.equal(retryDelayMs(null, 'no hint here', 10), 30000, 'backoff capped at 30s');
});

test('a huge suggested delay is capped at 60s', () => {
  assert.equal(retryDelayMs('600', 'x', 0), 60000);
  assert.equal(retryDelayMs(null, 'try again in 999s', 0), 60000);
});

test('ignores non-numeric / non-positive header', () => {
  assert.equal(retryDelayMs('soon', 'no hint', 0), 1000);
  assert.equal(retryDelayMs('0', 'no hint', 1), 2000);
});

/* ── Hand-written fakes (no mocking library in this repo): a Response-shaped literal and a fetch
      that replays a scripted list of them. ── */

interface FakeRes { ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string> }

function res429(retryAfter: string | null, message = 'Rate limit reached for gpt-4o'): FakeRes {
  return {
    ok: false,
    status: 429,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
    text: async () => JSON.stringify({ error: { message } }),
  };
}
function res503(): FakeRes {
  return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'overloaded' };
}
function resOk(): FakeRes {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' };
}

/** A fetch that returns the scripted responses in order (repeating the last one), counting calls. */
function scriptedFetch(script: FakeRes[]): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = async (): Promise<FakeRes> => script[Math.min(i++, script.length - 1)];
  return { fetchImpl: impl as unknown as typeof fetch, calls: () => i };
}

/** A sleep that records what it was asked to wait, and returns immediately. */
function recordingSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleepImpl: async (ms: number) => { waits.push(ms); }, waits };
}

console.log('\nsse.startStream retry visibility:');

await testAsync('a 429 emits a retry notice with the server-suggested delay, then succeeds', async () => {
  const { fetchImpl, calls } = scriptedFetch([res429('2'), resOk()]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  const out = await startStream('u', {}, {}, 'OpenAI', undefined, {
    fetchImpl,
    sleepImpl,
    onRetry: (n) => notices.push(n),
  });
  assert.equal(out.ok, true, 'the retry succeeded');
  assert.equal(calls(), 2, 'one retry means two fetches');
  assert.equal(notices.length, 1, 'exactly one retry was announced');
  assert.equal(notices[0].provider, 'OpenAI');
  assert.equal(notices[0].status, 429);
  assert.equal(notices[0].delayMs, 2250, 'the announced delay is the one actually slept');
  assert.equal(notices[0].attempt, 1);
  assert.equal(notices[0].maxAttempts, MAX_RETRIES);
  assert.match(notices[0].reason ?? '', /Rate limit reached/);
  assert.deepEqual(waits, [2250], 'announced BEFORE the wait, with the same number');
});

await testAsync('the notice fires for a 503 overload too, with backoff timing', async () => {
  const { fetchImpl } = scriptedFetch([res503(), resOk()]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  await startStream('u', {}, {}, 'Anthropic', undefined, { fetchImpl, sleepImpl, onRetry: (n) => notices.push(n) });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, 503);
  assert.equal(notices[0].provider, 'Anthropic');
  assert.deepEqual(waits, [1000], 'first backoff step');
});

await testAsync('retries STOP at MAX_RETRIES and then throw the rate-limit error', async () => {
  const { fetchImpl, calls } = scriptedFetch([res429('1')]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  await assert.rejects(
    () => startStream('u', {}, {}, 'OpenAI', undefined, { fetchImpl, sleepImpl, onRetry: (n) => notices.push(n) }),
    /rate limit reached \(429\)/i
  );
  assert.equal(notices.length, MAX_RETRIES, `exactly ${MAX_RETRIES} retries announced`);
  assert.equal(waits.length, MAX_RETRIES, 'and exactly that many waits');
  assert.equal(calls(), MAX_RETRIES + 1, 'the original attempt plus its retries, then it gives up');
  assert.deepEqual(notices.map((n) => n.attempt), [1, 2, 3, 4], 'attempts are numbered for the UI');
});

await testAsync('a retry that would outlast the request budget is refused, not slept through', async () => {
  const { fetchImpl, calls } = scriptedFetch([res429('60')]); // asks for a 60s wait
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  await assert.rejects(
    () =>
      startStream('u', {}, {}, 'OpenAI', undefined, {
        fetchImpl,
        sleepImpl,
        onRetry: (n) => notices.push(n),
        deadlineAt: Date.now() + 500, // only half a second of budget left
      }),
    /longer than this request's remaining time budget/
  );
  assert.equal(waits.length, 0, 'never slept past the budget');
  assert.equal(notices.length, 0, 'and never promised a retry it could not make');
  assert.equal(calls(), 1);
});

await testAsync('a non-retryable status throws immediately with the provider message', async () => {
  const bad: FakeRes = { ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'bad tools' } }) };
  const { fetchImpl, calls } = scriptedFetch([bad]);
  const { sleepImpl } = recordingSleep();
  await assert.rejects(() => startStream('u', {}, {}, 'Gemini', undefined, { fetchImpl, sleepImpl }), /Gemini API error 400: bad tools/);
  assert.equal(calls(), 1, 'a 400 is never retried');
});

await testAsync('an aborted signal stops the retry loop (Stop must not be out-waited)', async () => {
  const ac = new AbortController();
  ac.abort();
  const { fetchImpl } = scriptedFetch([res429('1')]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  await assert.rejects(
    () => startStream('u', {}, {}, 'OpenAI', ac.signal, { fetchImpl, sleepImpl, onRetry: (n) => notices.push(n) }),
    /rate limit reached/i
  );
  assert.deepEqual(waits, [], 'no sleeping once the user has stopped');
  assert.deepEqual(notices, []);
});

console.log('\nsse.withRequestTimeout (wall-clock budget):');

test('the default budget is a few minutes, not unbounded', () => {
  assert.equal(PROVIDER_REQUEST_TIMEOUT_MS, 180_000);
});

await testAsync('a hung request fails with a clear timeout error instead of hanging forever', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      withRequestTimeout(
        'OpenAI',
        undefined,
        // A request that never settles on its own, and only unblocks when the budget aborts it.
        ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
        30
      ),
    /OpenAI did not respond within 0s|did not respond within/
  );
  assert.ok(Date.now() - started < 2000, 'it gave up on the budget, it did not wait out the request');
});

await testAsync('the timeout error names the provider and says what to do', async () => {
  const err = await withRequestTimeout<never>('Gemini', undefined, ({ signal }) =>
    new Promise<never>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), 20
  ).catch((e: unknown) => e as Error);
  assert.match(err.message, /^Gemini did not respond within/);
  assert.match(err.message, /Resend the message/);
  assert.equal(err.name, 'Error', 'NOT an AbortError, so the gateway cannot mistake it for the user pressing Stop');
});

await testAsync('the Stop control still aborts promptly, and is NOT reported as a timeout', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = withRequestTimeout('OpenAI', ac.signal, ({ signal }) =>
    new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
    60_000
  );
  ac.abort();
  const err = await p.catch((e: Error) => e);
  assert.equal((err as Error & { name: string }).name, 'AbortError', 'the abort surfaces as an abort, so the gateway says "Stopped."');
  assert.ok(Date.now() - started < 2000, 'stopped promptly, it did not wait for the budget');
});

await testAsync('an already-aborted signal never leaves the request running', async () => {
  const ac = new AbortController();
  ac.abort();
  let sawAborted = false;
  await withRequestTimeout('OpenAI', ac.signal, async ({ signal }) => {
    sawAborted = signal.aborted;
    return 'done';
  }, 60_000);
  assert.equal(sawAborted, true, 'the derived signal starts aborted, so fetch fails immediately');
});

await testAsync('a normal fast request returns its value and clears the timer', async () => {
  const value = await withRequestTimeout('OpenAI', undefined, async ({ deadlineAt }) => {
    assert.ok(deadlineAt > Date.now(), 'a deadline is handed to the retry loop');
    return 42;
  }, 5_000);
  assert.equal(value, 42);
});

await testAsync('retries cannot silently outlive the budget: the sleep is cut short and reported as a timeout', async () => {
  // Real sleep, tiny budget: the 60s retry wait is aborted by the budget and must surface as the
  // clear timeout error, never as a bare "aborted".
  const { fetchImpl } = scriptedFetch([res429('60')]);
  const err = await withRequestTimeout<Response>(
    'OpenAI',
    undefined,
    ({ signal, deadlineAt }) =>
      startStream('u', {}, {}, 'OpenAI', signal, {
        fetchImpl,
        // deadlineAt deliberately far away, so the loop DOES try to sleep and the budget is what stops it.
        deadlineAt: deadlineAt + 600_000,
      }),
    40
  ).catch((e: unknown) => e as Error);
  assert.match((err as Error).message, /did not respond within/);
});

await testAsync('a DAILY limit is not retried: it fails at once with the real cause', async () => {
  // Four retries inside a minute cannot refill a daily budget. Retrying only delayed the same
  // answer by ~30s and reported it as a per-minute limit.
  const daily = 'Rate limit reached for gpt-4o-mini in organization org-abc on tokens per day (TPD): Limit 200000, Used 199420, Requested 1200.';
  const { fetchImpl, calls } = scriptedFetch([res429('60', daily)]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  await assert.rejects(
    startStream('u', {}, {}, 'OpenAI', undefined, { fetchImpl, sleepImpl, onRetry: (n) => notices.push(n) }),
    (e: Error) => /daily/i.test(e.message) && /daily reset|different model|tier/i.test(e.message),
  );
  assert.equal(calls(), 1, 'exactly one request, no retries');
  assert.deepEqual(waits, [], 'nothing was slept');
  assert.equal(notices.length, 0, 'no misleading "retrying" notice');
});

await testAsync('an out-of-credit 429 is not retried and does not claim to be a rate limit', async () => {
  const quota = 'You exceeded your current quota, please check your plan and billing details.';
  const { fetchImpl, calls } = scriptedFetch([res429(null, quota)]);
  const { sleepImpl, waits } = recordingSleep();
  await assert.rejects(
    startStream('u', {}, {}, 'OpenAI', undefined, { fetchImpl, sleepImpl }),
    (e: Error) => /out of credit/i.test(e.message) && /billing/i.test(e.message) && !/per-minute limit/i.test(e.message),
  );
  assert.equal(calls(), 1, 'no pointless retries');
  assert.deepEqual(waits, []);
});

await testAsync('a per-MINUTE limit still retries exactly as before', async () => {
  // An ORDINARY per-minute squeeze: the request (19,121) fits the ceiling (30,000), the window just has
  // not refilled. This is the self-healing case that must keep retrying quietly. The fixture here used to
  // be OpenAI's "Request too large" variant (Requested 30062 > Limit 30000), which is the OPPOSITE case:
  // waiting can never shrink the request, so it is no longer retried. See the test below.
  const tpm = 'Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 19183, Requested 19121. Please try again in 17s.';
  const { fetchImpl, calls } = scriptedFetch([res429('2', tpm), resOk()]);
  const { sleepImpl, waits } = recordingSleep();
  const notices: RetryNotice[] = [];
  const out = await startStream('u', {}, {}, 'OpenAI', undefined, { fetchImpl, sleepImpl, onRetry: (n) => notices.push(n) });
  assert.equal(out.ok, true);
  assert.equal(calls(), 2, 'the transient case is unchanged');
  assert.equal(notices.length, 1);
  assert.deepEqual(waits, [2250]);
});

await testAsync('a request LARGER than the whole per-minute limit is not retried', async () => {
  // "Request too large": an empty bucket is still too small, so the four backoff attempts would burn
  // roughly 14s to fail identically. Fail fast and say what actually has to change instead.
  const tooBig = 'Request too large for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Requested 30062. The input or output tokens must be reduced in order to run successfully.';
  const { fetchImpl, calls } = scriptedFetch([res429('2', tooBig), resOk()]);
  const { sleepImpl, waits } = recordingSleep();
  await assert.rejects(
    startStream('u', {}, {}, 'OpenAI', undefined, { fetchImpl, sleepImpl }),
    (e: Error) => /larger than the whole/i.test(e.message) && /waiting cannot fix this/i.test(e.message),
  );
  assert.equal(calls(), 1, 'no retry: waiting cannot shrink the request');
  assert.deepEqual(waits, [], 'and no time is spent sleeping');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
