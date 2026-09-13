import assert from 'node:assert/strict';
import { toSafeMpSecret } from '../data-service';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nMeasurement Protocol secret safety:');

test('toSafeMpSecret returns ONLY displayName — the secret value is never carried', () => {
  // The GA4 API object carries a secretValue; the projection must drop it.
  const out = toSafeMpSecret({ displayName: 'Server MP', secretValue: 'TOP-SECRET-123', name: 'x' } as { displayName: string });
  assert.deepEqual(out, { displayName: 'Server MP' });
  assert.ok(!('secretValue' in out), 'no secretValue key');
  assert.ok(!JSON.stringify(out).includes('TOP-SECRET'), 'value not serialized');
});

test('missing displayName falls back to (unnamed)', () => {
  assert.equal(toSafeMpSecret({}).displayName, '(unnamed)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
