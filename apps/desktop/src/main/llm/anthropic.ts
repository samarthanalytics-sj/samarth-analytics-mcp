import { postJson } from './http';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, LlmTurn } from './types';

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

export const anthropicClient: LlmClient = {
  async chat(input: LlmChatInput): Promise<LlmReply> {
    const data = await postJson(
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
      },
      'Anthropic'
    );
    return parseAnthropicReply(data);
  },
};
