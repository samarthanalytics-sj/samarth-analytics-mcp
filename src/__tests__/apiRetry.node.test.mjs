/**
 * Node test for the Google API retry/backoff configuration (apiRetry.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before
 * `npm test`). Verifies:
 *   - safe defaults: 3 retries, read-only HTTP methods, 408/429/5xx only,
 *   - mutations (POST/PUT/DELETE) are never in the default retry set,
 *   - env tuning (GTM_MCP_RETRY_MAX etc.) including the 0-disables contract,
 *   - the read-only-client POST opt-in,
 *   - jittered backoff stays within [0.5x, 1.5x] and respects the cap,
 *   - retryBackoff/onRetryAttempt never throw on malformed errors.
 *
 * Run: node src/__tests__/apiRetry.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRetry = path.resolve(__dirname, '../../dist/utils/apiRetry.js');

if (!existsSync(distRetry)) {
  console.error(
    `\n✗ apiRetry test: ${distRetry} not found. Run "npm run build" before "npm test".`
  );
  process.exit(1);
}

const { buildRetryOptions, jitteredDelay, retryAfterMs, effectiveRetryDelay, SAFE_HTTP_METHODS_TO_RETRY } = await import(
  pathToFileURL(distRetry).href
);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function inRanges(status, ranges) {
  return ranges.some(([min, max]) => status >= min && status <= max);
}

console.log('\nAPI retry config:');

await test('defaults: retry enabled with 3 attempts', () => {
  const opts = buildRetryOptions({});
  assert.strictEqual(opts.retry, true);
  assert.strictEqual(opts.retryConfig.retry, 3);
  assert.strictEqual(opts.retryConfig.noResponseRetries, 2);
  assert.strictEqual(opts.retryConfig.retryDelayMultiplier, 2);
});

await test('defaults: only read methods are retried, never mutations', () => {
  const { retryConfig } = buildRetryOptions({});
  assert.deepStrictEqual(retryConfig.httpMethodsToRetry, [...SAFE_HTTP_METHODS_TO_RETRY]);
  for (const mutating of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !retryConfig.httpMethodsToRetry.includes(mutating),
      `${mutating} must not be auto-retried by default`
    );
  }
});

await test('defaults: retries 408/429/5xx but no other 4xx and no 2xx/3xx', () => {
  const { retryConfig } = buildRetryOptions({});
  const ranges = retryConfig.statusCodesToRetry;
  for (const retryable of [408, 429, 500, 502, 503, 599]) {
    assert.ok(inRanges(retryable, ranges), `${retryable} should be retryable`);
  }
  for (const terminal of [200, 301, 400, 401, 403, 404, 409]) {
    assert.ok(!inRanges(terminal, ranges), `${terminal} should NOT be retryable`);
  }
});

await test('GTM_MCP_RETRY_MAX tunes the attempt count', () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX: '5' });
  assert.strictEqual(opts.retry, true);
  assert.strictEqual(opts.retryConfig.retry, 5);
});

await test('GTM_MCP_RETRY_MAX=0 disables retries entirely', () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX: '0' });
  assert.strictEqual(opts.retry, false);
  assert.strictEqual(opts.retryConfig.retry, 0);
  assert.strictEqual(opts.retryConfig.noResponseRetries, 0);
});

await test('invalid env values fall back to defaults', () => {
  const opts = buildRetryOptions({
    GTM_MCP_RETRY_MAX: 'banana',
    GTM_MCP_RETRY_MAX_DELAY_MS: '-7',
    GTM_MCP_RETRY_TOTAL_TIMEOUT_MS: '',
  });
  assert.strictEqual(opts.retryConfig.retry, 3);
  assert.strictEqual(opts.retryConfig.maxRetryDelay, 30_000);
  assert.strictEqual(opts.retryConfig.totalTimeout, 60_000);
});

await test('delay and total-timeout caps come from env', () => {
  const opts = buildRetryOptions({
    GTM_MCP_RETRY_MAX_DELAY_MS: '5000',
    GTM_MCP_RETRY_TOTAL_TIMEOUT_MS: '20000',
  });
  assert.strictEqual(opts.retryConfig.maxRetryDelay, 5000);
  assert.strictEqual(opts.retryConfig.totalTimeout, 20000);
});

await test('extraMethodsToRetry opt-in adds POST for read-only clients', () => {
  const { retryConfig } = buildRetryOptions({}, { extraMethodsToRetry: ['POST'] });
  assert.ok(retryConfig.httpMethodsToRetry.includes('POST'));
  assert.ok(retryConfig.httpMethodsToRetry.includes('GET'));
});

await test('jitteredDelay spans [0.5x, 1.5x] of the base delay', () => {
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 0), 500);
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 1), 1500);
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 0.5), 1000);
});

await test('jitteredDelay clamps to the max delay and never goes negative', () => {
  assert.strictEqual(jitteredDelay(100_000, 30_000, () => 1), 30_000);
  assert.strictEqual(jitteredDelay(0, 30_000, () => 1), 0);
  assert.ok(jitteredDelay(-50, 30_000, () => 1) >= 0);
});

await test('retryBackoff resolves (sleeps the jittered delay)', async () => {
  const { retryConfig } = buildRetryOptions({ GTM_MCP_RETRY_MAX_DELAY_MS: '10' });
  const start = Date.now();
  await retryConfig.retryBackoff({}, 5);
  assert.ok(Date.now() - start < 1000, 'backoff should resolve promptly for tiny delays');
});

await test('onRetryAttempt never throws on malformed error shapes', () => {
  const { retryConfig } = buildRetryOptions({});
  const origError = console.error;
  console.error = () => {};
  try {
    retryConfig.onRetryAttempt(undefined);
    retryConfig.onRetryAttempt({});
    retryConfig.onRetryAttempt({ config: null, response: 42 });
  } finally {
    console.error = origError;
  }
});


// ── Retry-After ──────────────────────────────────────────────────────────────
// On a 429 Google usually says how long to wait. Retrying inside that window extends the throttle
// instead of clearing it, and gaxios does not read the header itself.

await test('retryAfterMs reads delta-seconds', () => {
  assert.strictEqual(retryAfterMs({ 'retry-after': '120' }), 120_000);
  assert.strictEqual(retryAfterMs({ 'retry-after': '0' }), 0);
});

await test('retryAfterMs reads the capitalised form and header bags with get()', () => {
  assert.strictEqual(retryAfterMs({ 'Retry-After': '30' }), 30_000);
  assert.strictEqual(retryAfterMs({ get: (k) => (k === 'retry-after' ? '45' : null) }), 45_000);
});

await test('retryAfterMs reads an HTTP-date, relative to now', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:02:00 GMT' }, () => now), 120_000);
});

await test('retryAfterMs treats a PAST date as "retry now", never a negative wait', () => {
  const now = Date.parse('2026-01-01T00:05:00Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' }, () => now), 0);
});

await test('retryAfterMs returns null when there is nothing usable', () => {
  // null means "the server said nothing", which is different from "wait 0" - the caller must fall
  // back to its own backoff rather than retrying immediately.
  for (const h of [undefined, null, {}, 'not-an-object', { 'retry-after': '' }, { 'retry-after': 'soon' }, { 'retry-after': {} }]) {
    assert.strictEqual(retryAfterMs(h), null, JSON.stringify(h));
  }
});

await test('effectiveRetryDelay never waits LESS than either source asks', () => {
  assert.strictEqual(effectiveRetryDelay(2_000, 10_000, 30_000), 10_000);
  assert.strictEqual(effectiveRetryDelay(20_000, 5_000, 30_000), 20_000);
  assert.strictEqual(effectiveRetryDelay(8_000, null, 30_000), 8_000);
});

await test('effectiveRetryDelay clamps so one attempt stays bounded', () => {
  assert.strictEqual(effectiveRetryDelay(1_000, 600_000, 30_000), 30_000);
  assert.strictEqual(effectiveRetryDelay(0, 0, 30_000), 0);
  assert.ok(effectiveRetryDelay(-5, null, 30_000) >= 0, 'never negative');
});

await test('retryBackoff honours Retry-After end to end', async () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX_DELAY_MS: '30000' });
  const started = Date.now();
  await opts.retryConfig.retryBackoff({ response: { headers: { 'retry-after': '0' } } }, 0);
  assert.ok(Date.now() - started < 1_000, 'a zero Retry-After resolves promptly');
});

await test('retryBackoff still works when the error carries no headers', () => {
  const opts = buildRetryOptions({});
  assert.doesNotThrow(() => opts.retryConfig.retryBackoff(undefined, 0));
  assert.doesNotThrow(() => opts.retryConfig.retryBackoff({ response: {} }, 0));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
