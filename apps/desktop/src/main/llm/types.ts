import type { LlmProvider } from '../../shared/ipc';

export type { LlmProvider };

// Neutral, provider-agnostic LLM types. Each provider client maps these to/from
// its own wire format, so the gateway + tool loop never know which provider is
// in use.

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type LlmTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; results: LlmToolResult[] };

export interface LlmChatInput {
  system: string;
  model: string;
  apiKey: string;
  tools: LlmToolDef[];
  messages: LlmTurn[];
}

export interface LlmReply {
  text?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmClient {
  chat(input: LlmChatInput): Promise<LlmReply>;
}

export interface ToolExecutor {
  list(): LlmToolDef[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}
