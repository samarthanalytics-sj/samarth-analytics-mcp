// GTM API quota / rate-limit handling. The Tag Manager API enforces a low
// "Queries per minute per user" write quota, so a batch of fixes (or a chatty
// session) can trip it with a 429 / RESOURCE_EXHAUSTED. These errors are
// TRANSIENT — waiting a moment and retrying succeeds — so we back off and retry
// rather than surfacing the raw quota error to the user.

/** GTM API rate-limit / quota errors (per-minute-per-user etc.) — retryable. */
export const QUOTA_RE =
  /quota exceeded|rate.?limit|rateLimitExceeded|userRateLimitExceeded|queries per (minute|second|day)|\b429\b|RESOURCE_EXHAUSTED/i;

/** Transient GTM SERVER errors (backend hiccups) — retryable with a short backoff. */
export const TRANSIENT_5XX_RE =
  /\b(500|502|503|504)\b|internal error|backend error|(?:service|server) (?:is )?(?:currently )?unavailable|temporarily unavailable|try again later/i;

/** GTM conflates 404 and 403 into "Not found or permission denied." On a FRESH container/workspace
 *  the WRITE path briefly lags the READ path, so a create can hit this and then succeed seconds later
 *  with identical args. Retryable, but only a FEW times: a genuinely wrong id / no-access must still
 *  fail fast with the honest message rather than looping. */
export const NOT_FOUND_OR_PERMISSION_RE = /not found or permission denied/i;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read the server's reset hint from a quota error, in ms — so the wait lines up with when the quota
 * actually resets instead of a blind exponential guess. Honors the standard `Retry-After` header
 * (delta-seconds or an HTTP date) that googleapis surfaces on the GaxiosError; returns undefined when
 * there is none, in which case the caller falls back to exponential backoff. Defensive: any odd shape
 * yields undefined rather than throwing.
 */
export function readRetryAfterMs(error: unknown): number | undefined {
  try {
    const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers;
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (raw == null) return undefined;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1_000; // delta-seconds
    const when = Date.parse(s); // HTTP-date
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/** One class of retryable error: which errors it covers, and how patiently to retry them. Each rule
 *  keeps its OWN attempt budget, so a call can ride out a few 5xx blips AND a longer quota wait AND a
 *  short fresh-container 404 window without one class stealing another's retries. */
export interface RetryRule {
  /** Short name for logs (e.g. "quota", "server", "propagation"). */
  label: string;
  /** True when this rule should handle the given error. Rules are tried in order; first match wins. */
  match: (error: unknown, message: string) => boolean;
  /** Retries AFTER the first attempt. */
  maxRetries: number;
  /** First backoff in ms; doubles each retry (default 2000). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 30000). */
  maxDelayMs?: number;
  /** When true, wait AT LEAST the server's Retry-After hint (used for quota so it resumes on reset). */
  honorRetryAfter?: boolean;
}

export interface WithRetryOptions {
  rules: RetryRule[];
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Extract the server's reset hint (ms). Defaults to reading Retry-After. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Fired before each backoff sleep, so a caller can log/count the wait or surface it to the UI. */
  onBackoff?: (info: { rule: string; attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying on any error matched by one of `rules`, each with its OWN backoff and attempt
 * budget. A non-matching error throws immediately. This is the engine behind withQuotaRetry and the
 * GTM create path (quota + transient 5xx + fresh-container 404).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const retryAfterMs = opts.retryAfterMs ?? readRetryAfterMs;
  const used = new Map<RetryRule, number>();
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rule = opts.rules.find((r) => r.match(e, msg));
      const n = rule ? used.get(rule) ?? 0 : 0;
      if (rule && n < rule.maxRetries) {
        const base = rule.baseDelayMs ?? 2_000;
        const cap = rule.maxDelayMs ?? 30_000;
        const backoff = base * 2 ** n; // 2s, 4s, 8s, …
        const hint = rule.honorRetryAfter ? retryAfterMs(e) ?? 0 : 0;
        const delay = Math.min(cap, Math.max(backoff, hint));
        used.set(rule, n + 1);
        opts.onBackoff?.({ rule: rule.label, attempt: n + 1, delayMs: delay, error: e });
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}

export interface QuotaRetryOptions {
  /** Retries AFTER the first attempt (default 3 → up to 4 tries total). */
  maxRetries?: number;
  /** First backoff in ms; doubles each retry (default 2000 → 2s, 4s, 8s). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 30000). */
  maxDelayMs?: number;
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Extract the server's reset hint (ms) from the error; the wait is at LEAST this long (capped),
   *  so a per-minute quota resumes when it truly resets. Defaults to reading Retry-After. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Fired right before each backoff sleep, so a caller can log/count the wait or surface it to the
   *  UI (e.g. "waiting Ns for the write limit to reset") instead of an unexplained pause. */
  onBackoff?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying ONLY on a GTM quota / rate-limit error. Backs off exponentially (2s, 4s, 8s …
 * capped), but if the error carries a reset hint (Retry-After) the wait honors it so the retry
 * resumes exactly when the quota window reopens. Any non-quota error throws immediately (no pointless
 * retries). Defaults to 3 retries. Thin wrapper over withRetry with a single quota rule.
 */
export async function withQuotaRetry<T>(fn: () => Promise<T>, opts: QuotaRetryOptions = {}): Promise<T> {
  return withRetry(fn, {
    rules: [
      {
        label: 'quota',
        match: (_e, msg) => QUOTA_RE.test(msg),
        maxRetries: opts.maxRetries ?? 3,
        baseDelayMs: opts.baseDelayMs ?? 2_000,
        maxDelayMs: opts.maxDelayMs ?? 30_000,
        honorRetryAfter: true,
      },
    ],
    sleep: opts.sleep,
    retryAfterMs: opts.retryAfterMs,
    onBackoff: opts.onBackoff ? ({ attempt, delayMs, error }) => opts.onBackoff!({ attempt, delayMs, error }) : undefined,
  });
}
