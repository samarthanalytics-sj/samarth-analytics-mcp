/**
 * Retry/backoff configuration for the Google API clients (GTM + GA4).
 *
 * googleapis is built on gaxios, which retries a request when the factory
 * options carry `retry: true` plus a `retryConfig`. This module centralizes
 * that config so every client (gtmClient, ga4Client) absorbs transient
 * 429/5xx/network failures with exponential backoff instead of surfacing them
 * to the caller on the first hit — the difference between "works under load"
 * and "falls over at the GTM API's per-minute quota".
 *
 * Safety: only idempotent READ methods (GET/HEAD/OPTIONS) are ever retried.
 * Mutations (POST/PUT/DELETE — i.e. anything behind the write/publish/delete
 * guardrails) are NEVER auto-retried, so an ambiguous failure can't be
 * double-applied. This is deliberately stricter than the gaxios default
 * (which also retries PUT/DELETE).
 *
 * Tuning (all optional):
 *   GTM_MCP_RETRY_MAX               attempts after the first failure (default 3; 0 disables)
 *   GTM_MCP_RETRY_MAX_DELAY_MS      cap on a single backoff sleep (default 30000)
 *   GTM_MCP_RETRY_TOTAL_TIMEOUT_MS  cap on first-request→last-retry wall time (default 60000)
 */

/** Structural subset of gaxios's RetryConfig (gaxios is a transitive dep). */
export interface RetryConfigShape {
  retry: number;
  noResponseRetries: number;
  httpMethodsToRetry: string[];
  statusCodesToRetry: number[][];
  retryDelayMultiplier: number;
  maxRetryDelay: number;
  totalTimeout: number;
  retryBackoff?: (err: unknown, defaultDelayMs: number) => Promise<void>;
  onRetryAttempt?: (err: unknown) => void;
}

export interface RetryOptions {
  retry: boolean;
  retryConfig: RetryConfigShape;
}

/** Only ever retry read methods. Mutations must fail loudly, exactly once. */
export const SAFE_HTTP_METHODS_TO_RETRY = ['GET', 'HEAD', 'OPTIONS'] as const;

/** 408 (request timeout), 429 (quota), and all 5xx are transient. */
export const RETRYABLE_STATUS_RANGES: number[][] = [
  [408, 408],
  [429, 429],
  [500, 599],
];

/**
 * Apply full jitter to a backoff delay: uniform in [0.5x, 1.5x], clamped to
 * maxDelayMs. Pure — `rand` is injectable for tests (defaults to Math.random).
 */
export function jitteredDelay(
  baseMs: number,
  maxDelayMs: number,
  rand: () => number = Math.random
): number {
  const jittered = baseMs * (0.5 + rand());
  return Math.max(0, Math.min(jittered, maxDelayMs));
}

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface BuildRetryOptionsOpts {
  /**
   * Additional HTTP methods to retry beyond the safe defaults. Only for
   * clients whose entire surface is read-only — e.g. the GA4 Data client,
   * where runReport/runRealtimeReport are pure reads carried over POST.
   * Never pass this for a client that can mutate (GTM).
   */
  extraMethodsToRetry?: string[];
}

/**
 * Build the gaxios retry options for a Google API client factory. The result
 * is spread into the factory call, e.g. `tagmanager({ version: 'v2', auth,
 * ...buildRetryOptions() })`, and applies to every request the client makes.
 */
export function buildRetryOptions(
  env: NodeJS.ProcessEnv = process.env,
  opts: BuildRetryOptionsOpts = {}
): RetryOptions {
  const maxRetries = intFromEnv('GTM_MCP_RETRY_MAX', 3, env);
  const maxRetryDelay = intFromEnv('GTM_MCP_RETRY_MAX_DELAY_MS', 30_000, env);
  const totalTimeout = intFromEnv('GTM_MCP_RETRY_TOTAL_TIMEOUT_MS', 60_000, env);

  return {
    retry: maxRetries > 0,
    retryConfig: {
      retry: maxRetries,
      // Network errors with no response (ECONNRESET, ETIMEDOUT…) — still
      // gated on httpMethodsToRetry, so reads only.
      noResponseRetries: Math.min(2, maxRetries),
      httpMethodsToRetry: [
        ...SAFE_HTTP_METHODS_TO_RETRY,
        ...(opts.extraMethodsToRetry ?? []),
      ],
      statusCodesToRetry: RETRYABLE_STATUS_RANGES.map((r) => [...r]),
      retryDelayMultiplier: 2,
      maxRetryDelay,
      totalTimeout,
      retryBackoff: (_err, defaultDelayMs) =>
        new Promise((resolve) =>
          setTimeout(resolve, jitteredDelay(defaultDelayMs, maxRetryDelay))
        ),
      onRetryAttempt: (err) => {
        const e = err as {
          config?: { method?: string; url?: string; retryConfig?: { currentRetryAttempt?: number } };
          response?: { status?: number };
        };
        const attempt = e?.config?.retryConfig?.currentRetryAttempt ?? '?';
        const status = e?.response?.status ?? 'network-error';
        // stderr only — stdout is the JSON-RPC channel on stdio transport.
        console.error(
          `[samarth-gtm-mcp] retrying ${e?.config?.method ?? 'GET'} after ${status} ` +
            `(attempt ${attempt}/${maxRetries})`
        );
      },
    },
  };
}
