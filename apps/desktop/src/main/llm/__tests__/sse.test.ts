// Pure tests for the LLM SSE retry-delay logic.
// Run: tsx apps/desktop/src/main/llm/__tests__/sse.test.ts

import assert from 'node:assert/strict';
import { retryDelayMs } from '../sse';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
