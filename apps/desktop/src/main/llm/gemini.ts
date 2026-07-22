import { sseEvents, startStream, withRequestTimeout } from './sse';
import { geminiCacheUsage } from '../../shared/prompt-cache';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn, StreamAccumulator } from './types';

// Google Gemini (generativelanguage v1beta generateContent). Pure mappers
// exported for tests. Gemini has no tool-call ids and uses functionCall /
// functionResponse parts; function responses are matched by name.

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export function toGeminiContents(messages: LlmTurn[]): GeminiContent[] {
  return messages.map((turn): GeminiContent => {
    if (turn.role === 'user') {
      // Native media first (Gemini reads PDFs and images from the bytes), then the text.
      const parts: GeminiPart[] = (turn.media ?? []).map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.base64 } }));
      parts.push({ text: turn.text });
      return { role: 'user', parts };
    }
    if (turn.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const tc of turn.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.args } });
      }
      return { role: 'model', parts };
    }
    // Tool results go back as a 'user' turn of functionResponse parts (matched by name).
    return {
      role: 'user',
      parts: turn.results.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.content } },
      })),
    };
  });
}

export function parseGeminiReply(data: unknown): LlmReply {
  const parts = ((data as { candidates?: Array<{ content?: GeminiContent }> }).candidates?.[0]
    ?.content?.parts ?? []) as GeminiPart[];
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const toolCalls: LlmToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({ id: `gem_${i}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
  return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
}

// Gemini's function parameters follow an OpenAPI subset that rejects
// `additionalProperties` ANYWHERE — not just at the top level. A tool whose schema has
// a nested `additionalProperties` (e.g. inside an array's `items`, like the GA4
// event-parameter tools) makes Gemini reject/ignore that function. Strip it RECURSIVELY.
export function stripGeminiUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripGeminiUnsupported);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'additionalProperties') continue;
      out[k] = stripGeminiUnsupported(v);
    }
    return out;
  }
  return node;
}

// Strip unsupported keywords, and omit `parameters` entirely for no-arg tools.
export function geminiFunctionDecl(tool: { name: string; description: string; inputSchema: Record<string, unknown> }) {
  const params = stripGeminiUnsupported(tool.inputSchema) as Record<string, unknown>;
  const props = (params.properties ?? {}) as Record<string, unknown>;
  const hasProps = Object.keys(props).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    ...(hasProps ? { parameters: params } : {}),
  };
}

// Each streamed Gemini chunk is a partial GenerateContentResponse with parts;
// text parts stream incrementally, functionCall parts arrive whole.
export function geminiStreamAccumulator(onDelta: (t: string) => void): StreamAccumulator {
  let text = '';
  let usage: LlmReply['usage'];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    push(chunk: unknown): void {
      // Gemini 2.5 caches implicitly; usageMetadata is how we see whether it hit.
      usage = geminiCacheUsage(chunk) ?? usage;
      const parts = ((chunk as { candidates?: Array<{ content?: GeminiContent }> }).candidates?.[0]
        ?.content?.parts ?? []) as GeminiPart[];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          text += p.text;
          onDelta(p.text);
        } else if (p.functionCall) {
          calls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {} });
        }
      }
    },
    result(): LlmReply {
      const toolCalls: LlmToolCall[] = calls.map((c, i) => ({ id: `gem_${i}`, name: c.name, args: c.args }));
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, usage };
    },
  };
}

export const geminiClient: LlmClient = {
  async chatStream(input: LlmChatInput, onDelta: (t: string) => void): Promise<LlmReply> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model
    )}:streamGenerateContent?alt=sse`;
    // The budget covers the request AND the body stream AND any retry sleeps.
    return withRequestTimeout('Gemini', input.signal, async ({ signal, deadlineAt }) => {
      const res = await startStream(
        url,
        { 'x-goog-api-key': input.apiKey },
        {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: toGeminiContents(input.messages),
          ...(input.tools.length
            ? { tools: [{ functionDeclarations: input.tools.map(geminiFunctionDecl) }] }
            : {}),
        },
        'Gemini',
        signal,
        { onRetry: input.onRetry, deadlineAt }
      );
      const acc = geminiStreamAccumulator(onDelta);
      for await (const data of sseEvents(res)) {
        try {
          acc.push(JSON.parse(data));
        } catch {
          // ignore non-JSON lines
        }
      }
      return acc.result();
    });
  },
};
