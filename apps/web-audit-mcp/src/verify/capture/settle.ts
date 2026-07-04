/**
 * Settle-window waiter — the determinism core of the capture layer.
 *
 * Instead of a fixed sleep, capturing stops when no NEW GA4 collect request has
 * arrived for `quietMs` (default 2000) or a hard cap of `maxMs` (default 10000)
 * is reached, whichever comes first. The clock/sleep are injected so this can
 * be unit-tested deterministically without a browser.
 */

export interface SettleOptions {
  quietMs: number;
  maxMs: number;
}

export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SettleResult {
  /** A full `quietMs` window elapsed with no new GA4 collect (clean settle). */
  reachedQuiet: boolean;
  waitedMs: number;
  hitCount: number;
}

export const DEFAULT_SETTLE: SettleOptions = { quietMs: 2000, maxMs: 10_000 };

export function realClock(): SettleClock {
  return {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
  };
}

/**
 * Poll `getGa4HitCount` until the collect stream goes quiet for `quietMs`, or
 * `maxMs` elapses. Returns whether a clean quiet window was reached plus the
 * final hit count and elapsed time.
 */
export async function waitForSettle(
  getGa4HitCount: () => number,
  opts: SettleOptions,
  clock: SettleClock,
  pollMs = 100,
): Promise<SettleResult> {
  const start = clock.now();
  let lastCount = getGa4HitCount();
  let lastChange = start;

  for (;;) {
    const elapsed = clock.now() - start;
    if (elapsed >= opts.maxMs) {
      return { reachedQuiet: false, waitedMs: elapsed, hitCount: getGa4HitCount() };
    }
    const cur = getGa4HitCount();
    if (cur !== lastCount) {
      lastCount = cur;
      lastChange = clock.now();
    }
    if (clock.now() - lastChange >= opts.quietMs) {
      return { reachedQuiet: true, waitedMs: clock.now() - start, hitCount: cur };
    }
    const remaining = opts.maxMs - (clock.now() - start);
    if (remaining <= 0) {
      return { reachedQuiet: false, waitedMs: clock.now() - start, hitCount: getGa4HitCount() };
    }
    await clock.sleep(Math.min(pollMs, remaining));
  }
}
