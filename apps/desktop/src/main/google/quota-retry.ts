// GTM API quota / rate-limit handling. The Tag Manager API enforces a low
// "Queries per minute per user" write quota, so a batch of fixes (or a chatty
// session) can trip it with a 429 / RESOURCE_EXHAUSTED. These errors are
// TRANSIENT — waiting a moment and retrying succeeds — so we back off and retry
// rather than surfacing the raw quota error to the user.

/** GTM API rate-limit / quota errors (per-minute-per-user etc.) — retryable. */
export const QUOTA_RE =
  /quota exceeded|rate.?limit|rateLimitExceeded|userRateLimitExceeded|queries per (minute|second|day)|\b429\b|RESOURCE_EXHAUSTED/i;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface QuotaRetryOptions {
  /** Retries AFTER the first attempt (default 3 → up to 4 tries total). */
  maxRetries?: number;
  /** First backoff in ms; doubles each retry (default 2000 → 2s, 4s, 8s). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 30000). */
  maxDelayMs?: number;
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, retrying ONLY on a GTM quota / rate-limit error with exponential
 * backoff (2s, 4s, 8s … capped). Any non-quota error throws immediately (no
 * pointless retries). Defaults to 3 retries.
 */
export async function withQuotaRetry<T>(fn: () => Promise<T>, opts: QuotaRetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 2_000;
  const cap = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (QUOTA_RE.test(msg) && attempt < maxRetries) {
        const delay = Math.min(cap, base * 2 ** attempt); // 2s, 4s, 8s, …
        attempt += 1;
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}
