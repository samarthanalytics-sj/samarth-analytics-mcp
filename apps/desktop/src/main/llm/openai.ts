import { sseEvents, startStream, withRequestTimeout } from './sse';
import { openaiCacheUsage } from '../../shared/prompt-cache';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn, StreamAccumulator } from './types';

// OpenAI Chat Completions API. Pure mappers exported for unit tests.

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | OpenAiContentPart[];
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export function toOpenAiMessages(system: string, messages: LlmTurn[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const turn of messages) {
    if (turn.role === 'user') {
      // Images ride natively (vision models); PDFs have no slot in chat completions, so their
      // extracted fallback text is prepended - the model still reads the document's words.
      const images = (turn.media ?? []).filter((m) => m.kind === 'image');
      const docTexts = (turn.media ?? [])
        .filter((m) => m.kind === 'pdf')
        .map((m) => `[Attached file: ${m.name}]\n<file-content>\n${m.fallbackText ?? '(no extractable text)'}\n</file-content>`);
      const text = docTexts.length ? `${docTexts.join('\n\n')}\n\n${turn.text}` : turn.text;
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            ...images.map((m): OpenAiContentPart => ({ type: 'image_url', image_url: { url: `data:${m.mimeType};base64,${m.base64}` } })),
            { type: 'text', text },
          ],
        });
      } else {
        out.push({ role: 'user', content: text });
      }
    } else if (turn.role === 'assistant') {
      const msg: OpenAiMessage = { role: 'assistant', content: turn.text ?? null };
      if (turn.toolCalls?.length) {
        msg.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      out.push(msg);
    } else {
      for (const r of turn.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

export function parseOpenAiReply(data: unknown): LlmReply {
  const message = (data as { choices?: Array<{ message?: OpenAiMessage }> }).choices?.[0]?.message;
  const text = typeof message?.content === 'string' && message.content ? message.content : undefined;
  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined };
}

// Assembles a streamed completion: text deltas arrive incrementally; tool calls
// arrive in fragments keyed by index (id/name first, then argument string pieces).
export function openaiStreamAccumulator(onDelta: (t: string) => void): StreamAccumulator {
  let text = '';
  let usage: LlmReply['usage'];
  const tools = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(chunk: unknown): void {
      // The usage chunk arrives last and has no choices; cached_tokens is the automatic-cache hit.
      usage = openaiCacheUsage(chunk) ?? usage;
      const delta = (chunk as { choices?: Array<{ delta?: OpenAiMessage }> }).choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content;
        onDelta(delta.content);
      }
      for (const tc of (delta?.tool_calls ?? []) as Array<{ index?: number } & OpenAiToolCall>) {
        const idx = tc.index ?? 0;
        const cur = tools.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        tools.set(idx, cur);
      }
    },
    result(): LlmReply {
      const toolCalls: LlmToolCall[] = [...tools.values()].map((t) => {
        let args: Record<string, unknown> = {};
        try {
          args = t.args ? (JSON.parse(t.args) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        return { id: t.id, name: t.name, args };
      });
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, usage };
    },
  };
}

/** Build the /v1/chat/completions request body. Only sends tools/tool_choice when there ARE tools —
 *  OpenAI rejects an empty `tools: []` (and a `tool_choice` with no tools) with a non-retryable 400, which
 *  a plain completion (e.g. the chat-memory suggest pass) would otherwise hit. Mirrors the guard in
 *  gemini.ts. Exported for testing. */
export function openaiChatBody(input: LlmChatInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: toOpenAiMessages(input.system, input.messages),
    ...(input.tools.length
      ? {
          tools: input.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }
      : {}),
    stream: true,
    // OpenAI caches long prefixes automatically, but a STREAMED response carries no usage at all
    // unless this is set - so without it we could never tell whether caching was working, only
    // assume it. The extra final chunk has an empty `choices` array, which the accumulator ignores.
    stream_options: { include_usage: true },
  };
}

export const openaiClient: LlmClient = {
  async chatStream(input: LlmChatInput, onDelta: (t: string) => void): Promise<LlmReply> {
    // The budget covers the request AND the body stream AND any retry sleeps.
    return withRequestTimeout('OpenAI', input.signal, async ({ signal, deadlineAt }) => {
      const res = await startStream(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${input.apiKey}` },
        openaiChatBody(input),
        'OpenAI',
        signal,
        { onRetry: input.onRetry, deadlineAt }
      );
      const acc = openaiStreamAccumulator(onDelta);
      for await (const data of sseEvents(res)) {
        if (data === '[DONE]') break;
        try {
          acc.push(JSON.parse(data));
        } catch {
          // ignore keep-alive / non-JSON lines
        }
      }
      return acc.result();
    });
  },
};
