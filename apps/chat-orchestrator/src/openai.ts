/**
 * OpenAI Chat Completions streaming client.
 *
 * Hand-rolled over fetch, matching the desktop app: no SDK to vendor, and full control over retry
 * classification and the wall-clock budget.
 */
import type { OrchestratorConfig } from './config.js';
import type { ChatMessage, OpenAiToolCall } from './types.js';
import type { OpenAiTool } from './tools.js';

export interface StreamCallbacks {
  onDelta(text: string): void;
  onUsage?(usage: { promptTokens: number; completionTokens: number; cachedTokens: number }): void;
}

export interface StreamResult {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string;
}

export class OpenAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** The account's tokens-per-minute ceiling, when the response reported one. */
    readonly limitTokens?: number,
  ) {
    super(message);
  }
}

/** The `error.code` (or `error.type`) OpenAI puts in the body, which the status alone does not say. */
function parseUpstreamCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } };
    return parsed.error?.code ?? parsed.error?.type ?? null;
  } catch {
    return null;
  }
}

const MAX_RETRIES = 3;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A 429 that retrying cannot fix. OpenAI returns the same status for "you are going too fast" and
 * "your balance is spent"; only the second is permanent, and backing off three times before
 * reporting it just makes the user wait longer for the same answer.
 */
const NEVER_RETRY = new Set(['insufficient_quota', 'billing_hard_limit_reached']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Honors Retry-After when present, otherwise exponential backoff with full jitter. */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return Math.min(Math.max(asDate - Date.now(), 0), 60_000);
  }
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(base * (0.5 + Math.random()));
}

export class OpenAiClient {
  constructor(
    private readonly cfg: OrchestratorConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async streamChat(
    messages: ChatMessage[],
    tools: OpenAiTool[],
    cbs: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const started = Date.now();
    let lastError: OpenAiError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new OpenAiError('Aborted', 499, 'aborted');
      // Do not start an attempt we cannot afford to finish.
      if (Date.now() - started > this.cfg.openai.requestTimeoutMs) break;

      try {
        return await this.attempt(messages, tools, cbs, signal);
      } catch (err) {
        if (!(err instanceof OpenAiError) || !RETRYABLE.has(err.status)) throw err;
        if (NEVER_RETRY.has(err.code)) throw err;
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        await sleep(retryDelayMs(attempt, err.message.match(/retry-after:(\S+)/)?.[1] ?? null));
      }
    }
    throw lastError ?? new OpenAiError('Request failed', 500, 'unknown');
  }

  private async attempt(
    messages: ChatMessage[],
    tools: OpenAiTool[],
    cbs: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.openai.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: this.cfg.openai.maxOutputTokens,
    };
    // An empty tools array is a 400; omit the key entirely when nothing is in scope.
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await this.fetchImpl(`${this.cfg.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      const retryAfter = res.headers.get('retry-after');
      const suffix = retryAfter ? ` retry-after:${retryAfter}` : '';

      // The upstream code is the only thing that separates causes a 429 lumps together: a
      // per-minute limit that clears on its own, and an exhausted balance that never will. It used
      // to be thrown away, so the log said nothing and the user was told to retry either way.
      const upstream = parseUpstreamCode(text);

      // What the account is actually allowed, straight from the response. A turn that cannot fit
      // inside the per-minute token budget will fail identically forever, and this is the number
      // that says so.
      const limitTokens = res.headers.get('x-ratelimit-limit-tokens');
      const remainingTokens = res.headers.get('x-ratelimit-remaining-tokens');
      const budget =
        res.status === 429 && limitTokens
          ? ` tokens-per-minute:${remainingTokens ?? '?'}/${limitTokens}`
          : '';

      console.error(
        `[openai] ${res.status} ${upstream ?? 'unknown'}${budget} :: ${text.slice(0, 300).replace(/\s+/g, ' ')}`,
      );

      throw new OpenAiError(
        `OpenAI returned ${res.status}: ${text.slice(0, 500)}${suffix}`,
        res.status,
        res.status === 404 ? 'model_not_found' : (upstream ?? 'upstream_error'),
        limitTokens ? Number(limitTokens) : undefined,
      );
    }

    return this.readStream(res.body, cbs);
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    cbs: StreamCallbacks,
  ): Promise<StreamResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = 'stop';
    // Tool-call fragments arrive keyed by index, with the argument JSON split across chunks.
    const partials = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let parsed: {
          choices?: {
            delta?: { content?: string; tool_calls?: RawToolCallDelta[] };
            finish_reason?: string;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.usage && cbs.onUsage) {
          cbs.onUsage({
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
          });
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          cbs.onDelta(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const existing = partials.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          partials.set(idx, existing);
        }
      }
    }

    const toolCalls: OpenAiToolCall[] = [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, p]) => ({
        id: p.id || `call_${idx}`,
        type: 'function' as const,
        function: { name: p.name, arguments: p.args || '{}' },
      }))
      .filter((c) => c.function.name);

    return { content, toolCalls, finishReason };
  }
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
