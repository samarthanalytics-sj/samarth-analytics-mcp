import assert from 'node:assert/strict';
import { runLoopbackOAuth } from '../loopback';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const client = { clientId: 'x.apps.googleusercontent.com', clientSecret: 'secret' };

async function main(): Promise<void> {
  console.log('\nLoopback OAuth cancellation:');

  // A blocked/denied consent screen may never redirect back; a retry must be
  // able to cancel the pending flow instead of being wedged until the timeout.
  await test('aborting mid-flow rejects with "cancelled" (does not hang)', async () => {
    const ctrl = new AbortController();
    await assert.rejects(
      runLoopbackOAuth(client, {
        // openBrowser fires once the loopback server is listening — abort there.
        openBrowser: async () => {
          ctrl.abort();
        },
        signal: ctrl.signal,
        timeoutMs: 60_000,
      }),
      /cancelled/i
    );
  });

  await test('a pre-aborted signal rejects immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      runLoopbackOAuth(client, { openBrowser: async () => undefined, signal: ctrl.signal }),
      /cancelled/i
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
