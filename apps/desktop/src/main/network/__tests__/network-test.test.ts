import assert from 'node:assert/strict';
import { runNetworkTest, DEFAULT_ENDPOINTS } from '../network-test';

let passed = 0;
let failed = 0;
let pending = 0;
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); } });
}

console.log('\nnetwork-test:');

test('default endpoint list is non-empty with unique hosts and labels', async () => {
  assert.ok(DEFAULT_ENDPOINTS.length >= 4);
  assert.equal(new Set(DEFAULT_ENDPOINTS.map((e) => e.host)).size, DEFAULT_ENDPOINTS.length, 'hosts unique');
  assert.ok(DEFAULT_ENDPOINTS.every((e) => e.label.trim().length > 0), 'every endpoint labeled');
});

test('results mirror the endpoint order and carry the probe outcome verbatim', async () => {
  const results = await runNetworkTest(
    async (host) => (host === 'b.example' ? { ok: false, ms: 5001, error: 'timed out' } : { ok: true, ms: 42 }),
    [
      { host: 'a.example', label: 'A' },
      { host: 'b.example', label: 'B' },
      { host: 'c.example', label: 'C' },
    ]
  );
  assert.deepEqual(results.map((r) => r.host), ['a.example', 'b.example', 'c.example'], 'order preserved');
  assert.deepEqual(results[0], { host: 'a.example', label: 'A', ok: true, ms: 42 });
  assert.deepEqual(results[1], { host: 'b.example', label: 'B', ok: false, ms: 5001, error: 'timed out' });
});

test('a prober failure marks the row failed - never a fabricated pass', async () => {
  const results = await runNetworkTest(async () => ({ ok: false, ms: 10, error: 'ENOTFOUND' }), [{ host: 'x.example', label: 'X' }]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'ENOTFOUND');
});
