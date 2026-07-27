import assert from 'node:assert/strict';
import { withQuotaRetry, QUOTA_RE, readRetryAfterMs } from '../quota-retry';

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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
