import { sseEvents, startStream } from './sse';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn, StreamAccumulator } from './types';

// Anthropic Messages API. Pure mappers are exported for unit tests.

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export function toAnthropicMessages(messages: LlmTurn[]): AnthropicMessage[] {
  return messages.map((turn): AnthropicMessage => {
    if (turn.role === 'user') {
      return { role: 'user', content: [{ type: 'text', text: turn.text }] };
    }
    if (turn.role === 'assistant') {
      const content: AnthropicBlock[] = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const tc of turn.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: turn.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

export function parseAnthropicReply(data: unknown): LlmReply {
  const blocks = ((data as { content?: AnthropicBlock[] }).content ?? []) as AnthropicBlock[];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const toolCalls: LlmToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', args: b.input ?? {} }));
  return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
}

// Assembles a streamed message: text_delta → text; tool_use blocks arrive as
// content_block_start (id/name) then input_json_delta fragments (partial JSON).
export function anthropicStreamAccumulator(onDelta: (t: string) => void): StreamAccumulator {
  let text = '';
  const blocks = new Map<number, { type?: string; id?: string; name?: string; json: string }>();
  return {
    push(chunk: unknown): void {
      const ev = chunk as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      };
      if (ev.type === 'content_block_start' && typeof ev.index === 'number') {
        const b = ev.content_block ?? {};
        blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '' });
      } else if (ev.type === 'content_block_delta' && typeof ev.index === 'number') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          text += ev.delta.text;
          onDelta(ev.delta.text);
        } else if (ev.delta?.type === 'input_json_delta') {
          const b = blocks.get(ev.index);
          if (b) b.json += ev.delta.partial_json ?? '';
        }
      }
    },
    result(): LlmReply {
      const toolCalls: LlmToolCall[] = [...blocks.values()]
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          let args: Record<string, unknown> = {};
          try {
            args = b.json ? (JSON.parse(b.json) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          return { id: b.id ?? '', name: b.name ?? '', args };
        });
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
    },
  };
}

export const anthropicClient: LlmClient = {
  async chatStream(input: LlmChatInput, onDelta: (t: string) => void): Promise<LlmReply> {
    const res = await startStream(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: input.model,
        max_tokens: 4096,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools: input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        stream: true,
      },
      'Anthropic',
      input.signal
    );
    const acc = anthropicStreamAccumulator(onDelta);
    for await (const data of sseEvents(res)) {
      try {
        acc.push(JSON.parse(data));
      } catch {
        // ignore non-JSON lines
      }
    }
    return acc.result();
  },
};
