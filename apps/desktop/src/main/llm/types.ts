import type { LlmProvider, ChatMediaPart } from '../../shared/ipc';

export type { ChatMediaPart };

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
  | { role: 'user'; text: string; media?: ChatMediaPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; results: LlmToolResult[] };

export interface LlmChatInput {
  system: string;
  model: string;
  apiKey: string;
  tools: LlmToolDef[];
  messages: LlmTurn[];
  /** Aborts the in-flight provider request when the user stops the chat. */
  signal?: AbortSignal;
}

export interface LlmReply {
  text?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmClient {
  /**
   * Stream a model turn. `onDelta` fires for each text chunk as it arrives; the
   * resolved LlmReply has the full accumulated text plus any tool calls.
   */
  chatStream(input: LlmChatInput, onDelta: (text: string) => void): Promise<LlmReply>;
}

/** A streaming accumulator: fed parsed SSE chunks, yields the final reply. */
export interface StreamAccumulator {
  push(chunk: unknown): void;
  result(): LlmReply;
}

export interface ToolExecutor {
  list(): LlmToolDef[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}
