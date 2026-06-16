import { postJson } from './http';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn } from './types';

// Google Gemini (generativelanguage v1beta generateContent). Pure mappers
// exported for tests. Gemini has no tool-call ids and uses functionCall /
// functionResponse parts; function responses are matched by name.

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export function toGeminiContents(messages: LlmTurn[]): GeminiContent[] {
  return messages.map((turn): GeminiContent => {
    if (turn.role === 'user') return { role: 'user', parts: [{ text: turn.text }] };
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
// `additionalProperties`; strip it and omit `parameters` entirely for no-arg tools.
function geminiFunctionDecl(tool: { name: string; description: string; inputSchema: Record<string, unknown> }) {
  const { additionalProperties: _drop, ...params } = tool.inputSchema as Record<string, unknown>;
  const props = (params.properties ?? {}) as Record<string, unknown>;
  const hasProps = Object.keys(props).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    ...(hasProps ? { parameters: params } : {}),
  };
}

export const geminiClient: LlmClient = {
  async chat(input: LlmChatInput): Promise<LlmReply> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model
    )}:generateContent`;
    const data = await postJson(
      url,
      { 'x-goog-api-key': input.apiKey },
      {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: toGeminiContents(input.messages),
        ...(input.tools.length
          ? { tools: [{ functionDeclarations: input.tools.map(geminiFunctionDecl) }] }
          : {}),
      },
      'Gemini'
    );
    return parseGeminiReply(data);
  },
};
