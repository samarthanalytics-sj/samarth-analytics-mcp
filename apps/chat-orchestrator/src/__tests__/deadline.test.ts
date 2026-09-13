/**
 * Deadline tests. No network, no timers longer than a few milliseconds.
 *
 * The behaviour under test is the one that made a working service look broken: when the origin
 * does not answer, Cloudflare answers for it, and its error page has no CORS header, so the browser
 * reports the whole thing as unreachable. These assert that this server gives up first and gives up
 * loudly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deadline, DeadlineError } from '../deadline.js';

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const rejectsAfter = (ms: number, err: Error): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(err), ms));

void test('work that finishes in time passes its value through untouched', async () => {
  assert.equal(await deadline(after(5, 'done'), 1000, 'too slow'), 'done');
});

void test('work that overruns rejects with a DeadlineError carrying the message', async () => {
  await assert.rejects(
    () => deadline(after(1000, 'never'), 10, 'That lookup took too long.'),
    (err: unknown) => {
      assert.ok(err instanceof DeadlineError);
      assert.equal(err.message, 'That lookup took too long.');
      assert.equal(err.code, 'timed_out');
      assert.equal(err.waitedMs, 10);
      return true;
    },
  );
});

void test("the underlying failure wins when it lands first, not a timeout that didn't happen", async () => {
  // Reporting "timed out" for a request that actually failed in 5ms would send someone looking for
  // a slow server instead of reading the real error.
  const real = new Error('Google said no');
  await assert.rejects(() => deadline(rejectsAfter(5, real), 1000, 'too slow'), /Google said no/);
});

void test('a deadline of zero or less is off, not instant', async () => {
  // A misread env var must not turn every request into a timeout.
  assert.equal(await deadline(after(5, 'ok'), 0, 'x'), 'ok');
  assert.equal(await deadline(after(5, 'ok'), -1, 'x'), 'ok');
  assert.equal(await deadline(after(5, 'ok'), Number.NaN, 'x'), 'ok');
});

void test('a late rejection after the deadline does not become an unhandled rejection', async () => {
  // The losing promise still settles. If its rejection were left unattached, Node would tear the
  // whole orchestrator down some milliseconds after an ordinary slow request.
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandled);

  await assert.rejects(
    () => deadline(rejectsAfter(20, new Error('arrived late')), 5, 'too slow'),
    DeadlineError,
  );
  await after(60, null);

  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null, `a late rejection escaped: ${String(unhandled)}`);
});

void test('a late SUCCESS after the deadline is dropped quietly', async () => {
  const p = deadline(after(30, 'late'), 5, 'too slow');
  await assert.rejects(() => p, DeadlineError);
  await after(50, null);
  // Nothing to assert beyond not crashing: the point is that the resolved value goes nowhere,
  // because the response was already sent.
});
