// Shared Server-Sent-Events plumbing for streaming LLM responses. Reads a fetch
// Response body and yields the payload of each `data:` line. Uses global fetch /
// web streams (Node 20 / Electron undici), no dependencies.

import { parseRateLimit } from '../../shared/rate-limit';

/** Transient statuses worth retrying: rate limit (429) + upstream overload (500/503). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503;
}

/**
 * How long to wait before retrying, in ms. Prefers the server's own guidance: the `Retry-After`
 * header (seconds), else a "try again in N.Ns" hint in the error message, falling back to capped
 * exponential backoff. PURE + exported for testing. Capped at 60s so a huge server delay can't hang.
 */
export function retryDelayMs(headerRetryAfter: string | null, message: string, attempt: number): number {
  const CAP = 60_000;
  const ra = Number(headerRetryAfter);
  if (headerRetryAfter && Number.isFinite(ra) && ra > 0) return Math.min(Math.ceil(ra * 1000) + 250, CAP);
  const m = /try again in ([\d.]+)\s*s/i.exec(message ?? '');
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n * 1000) + 250, CAP);
  }
  return Math.min(1000 * 2 ** attempt, 30_000); // 1s, 2s, 4s, 8s, …
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { cleanup(); reject(new Error('aborted')); };
    const cleanup = (): void => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const MAX_RETRIES = 4;

/**
 * WALL-CLOCK BUDGET for ONE provider request, retries included.
 *
 * 3 minutes. Rationale for the number: a normal streamed answer (even a long GA4 audit, or a
 * reasoning model that thinks for a while before its first token) finishes well inside it, so this
 * never kills legitimate slow generation; but it is short enough that a wedged connection or a chain
 * of rate-limit sleeps surfaces as a clear error instead of an open-ended hang. Before this existed
 * there was NO timeout anywhere in the LLM path: 4 retries x the 60s delay cap = 240s of silent
 * sleeping inside a single fetch, with nothing shown to the user. The budget covers the retry sleeps
 * too, so retries can never quietly exceed it.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 180_000;

/** Announced just before a transient failure is retried, so the UI can show the wait. */
export interface RetryNotice {
  /** Provider label, e.g. "OpenAI". */
  provider: string;
  /** The HTTP status that triggered the retry (429 / 500 / 503). */
  status: number;
  /** 1-based retry number (the attempt about to be made). */
  attempt: number;
  /** How many retries are allowed in total. */
  maxAttempts: number;
  /** How long we are about to wait before retrying. */
  delayMs: number;
  /** The provider's own error text, trimmed. */
  reason?: string;
}

export interface StartStreamOptions {
  /** Fired BEFORE each retry sleep so the retry is visible instead of silent. */
  onRetry?: (notice: RetryNotice) => void;
  /**
   * Epoch-ms deadline for the whole request (from withRequestTimeout). A retry whose wait would
   * run past it is refused up front with the real rate-limit reason, rather than sleeping into a
   * generic timeout.
   */
  deadlineAt?: number;
  /** Test seam: hand-written fake fetch. Production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: hand-written fake sleep, so retry tests don't wait in real time. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The user-facing text for a rate limit we could not wait out. */
function rateLimitMessage(providerLabel: string, msg: string, note: string): string {
  return (
    `${providerLabel} rate limit reached (429): this is your ${providerLabel} account's per-minute limit, not the app. ` +
    `${msg} ${note}`
  );
}

export async function startStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  signal?: AbortSignal,
  options?: StartStreamOptions
): Promise<Response> {
  const doFetch = options?.fetchImpl ?? fetch;
  const doSleep = options?.sleepImpl ?? sleep;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    let j: { error?: { message?: string } | string } | null = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = null;
    }
    const msg = (typeof j?.error === 'object' ? j?.error?.message : j?.error) ?? text.slice(0, 300);

    // A 429 that retrying CANNOT clear: a daily budget, or an account out of credit. Retrying four
    // times only delays the same answer by ~30s and reports it as a per-minute limit, sending the
    // user to the wrong page. Fail now with the real cause. Unrecognised 429s stay retryable.
    if (res.status === 429) {
      const info = parseRateLimit(String(msg), providerLabel);
      if (!info.retryable) throw new Error(`${info.summary} ${info.advice}`);
    }

    // Transient rate-limit / overload: wait the server-suggested time and retry, so a burst
    // (e.g. an account's tokens-per-minute cap) self-heals instead of hard-failing the chat.
    if (isRetryableStatus(res.status) && attempt < MAX_RETRIES && !signal?.aborted) {
      const delayMs = retryDelayMs(res.headers.get('retry-after'), msg, attempt);
      const remainingMs = options?.deadlineAt != null ? options.deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
      if (delayMs < remainingMs) {
        // Tell the user we are waiting. A silent 60s sleep here was the observed "Thinking…" hang.
        options?.onRetry?.({
          provider: providerLabel,
          status: res.status,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES,
          delayMs,
          reason: msg ? String(msg).slice(0, 200) : undefined,
        });
        await doSleep(delayMs, signal);
        continue;
      }
      // Not enough of the request budget left to wait this one out: fail NOW with the real reason
      // instead of sleeping into a generic timeout.
      if (res.status === 429) {
        throw new Error(
          rateLimitMessage(
            providerLabel,
            String(msg),
            `It asked us to wait ${Math.round(delayMs / 1000)}s, which is longer than this request's remaining time budget. ` +
              'Wait a moment and resend, use a smaller model, or raise your account\'s rate limit.'
          )
        );
      }
      throw new Error(
        `${providerLabel} API error ${res.status}: ${msg} (retrying would need ${Math.round(delayMs / 1000)}s, ` +
          'longer than this request\'s remaining time budget)'
      );
    }
    if (res.status === 429) {
      throw new Error(
        rateLimitMessage(
          providerLabel,
          String(msg),
          'Wait a moment and resend, use a smaller model, or raise your account\'s rate limit.'
        )
      );
    }
    throw new Error(`${providerLabel} API error ${res.status}: ${msg}`);
  }
}

/**
 * Runs one provider request under a wall-clock budget.
 *
 * It derives an AbortSignal that fires either when the CALLER's signal aborts (the composer's Stop
 * button, unchanged, still the only user-facing cancel) or when the budget expires, and hands the
 * deadline down so the retry loop can refuse a sleep it cannot afford. A budget expiry is rewritten
 * into a plain, explicit Error: without that it would surface as an AbortError and the gateway would
 * report the turn as "Stopped." as though the user had cancelled it.
 */
export async function withRequestTimeout<T>(
  providerLabel: string,
  signal: AbortSignal | undefined,
  run: (ctx: { signal: AbortSignal; deadlineAt: number }) => Promise<T>,
  timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await run({ signal: controller.signal, deadlineAt: Date.now() + timeoutMs });
  } catch (e) {
    if (timedOut && !signal?.aborted) {
      throw new Error(
        `${providerLabel} did not respond within ${Math.round(timeoutMs / 1000)}s, so the request was cancelled. ` +
          'This is usually a rate-limit backoff or a stalled connection, not a failed answer. ' +
          'Resend the message, or use a smaller model / shorter request.'
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

export async function* sseEvents(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        yield line.slice(5).trimStart();
      }
    }
  }
}
