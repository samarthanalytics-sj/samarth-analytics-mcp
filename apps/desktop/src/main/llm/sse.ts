// Shared Server-Sent-Events plumbing for streaming LLM responses. Reads a fetch
// Response body and yields the payload of each `data:` line. Uses global fetch /
// web streams (Node 20 / Electron undici) — no dependencies.

/** Transient statuses worth retrying: rate limit (429) + upstream overload (500/503). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503;
}

/**
 * How long to wait before retrying, in ms. Prefers the server's own guidance — the `Retry-After`
 * header (seconds), else a "try again in N.Ns" hint in the error message — falling back to capped
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

const MAX_RETRIES = 4;

export async function startStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  signal?: AbortSignal
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
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

    // Transient rate-limit / overload: wait the server-suggested time and retry, so a burst
    // (e.g. an account's tokens-per-minute cap) self-heals instead of hard-failing the chat.
    if (isRetryableStatus(res.status) && attempt < MAX_RETRIES && !signal?.aborted) {
      await sleep(retryDelayMs(res.headers.get('retry-after'), msg, attempt), signal);
      continue;
    }
    if (res.status === 429) {
      throw new Error(
        `${providerLabel} rate limit reached (429) — this is your ${providerLabel} account's per-minute limit, not the app. ` +
          `${msg} Wait a moment and resend, use a smaller model, or raise your account's rate limit.`
      );
    }
    throw new Error(`${providerLabel} API error ${res.status}: ${msg}`);
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
