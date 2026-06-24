import assert from 'node:assert/strict';
import { withQuotaRetry, QUOTA_RE } from '../quota-retry';

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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
