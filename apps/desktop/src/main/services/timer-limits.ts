// Ceilings for the background schedulers' setInterval delays.
//
// Node stores a timer delay as a signed 32-bit integer. A delay above 2^31-1 ms (about 24.8 days), or
// a non-finite one, is silently replaced with 1 ms (only a TimeoutOverflowWarning is printed), so a
// monitor configured for "every 30 days" would instead fire a thousand times a second against the
// GTM / GA4 / Ads APIs and Slack. Each scheduler clamps its persisted interval to these ceilings in
// normalize() and asserts the final delay right before arming the timer.

/** The largest delay setInterval honours. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Largest whole-minute interval that fits (35791 min, about 24.8 days). */
export const MAX_INTERVAL_MINUTES = Math.floor(MAX_TIMER_MS / 60_000);
/** Largest whole-hour interval that fits (596 h, about 24.8 days). */
export const MAX_INTERVAL_HOURS = Math.floor(MAX_TIMER_MS / 3_600_000);

/** Return `ms` unchanged when setInterval will honour it; throw rather than let Node fire every 1 ms. */
export function assertTimerMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    throw new RangeError(`Timer delay ${ms} ms is outside 1..${MAX_TIMER_MS}; Node would fire it every 1 ms.`);
  }
  return ms;
}
