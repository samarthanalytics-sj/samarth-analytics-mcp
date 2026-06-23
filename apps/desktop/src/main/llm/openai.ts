import { sseEvents, startStream } from './sse';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn, StreamAccumulator } from './types';

// OpenAI Chat Completions API. Pure mappers exported for unit tests.

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export function toOpenAiMessages(system: string, messages: LlmTurn[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const turn of messages) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.text });
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
  const tools = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(chunk: unknown): void {
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
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
    },
  };
}

export const openaiClient: LlmClient = {
  async chatStream(input: LlmChatInput, onDelta: (t: string) => void): Promise<LlmReply> {
    const res = await startStream(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${input.apiKey}` },
      {
        model: input.model,
        messages: toOpenAiMessages(input.system, input.messages),
        tools: input.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: 'auto',
        stream: true,
      },
      'OpenAI',
      input.signal
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
  },
};
