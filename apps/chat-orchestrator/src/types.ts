import type { Product } from './config.js';

/** Chat message as exchanged with the browser and with OpenAI. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Neutral tool definition, mapped from an MCP tool listing. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the MCP schema declares a `confirm` argument, which marks every guarded write. */
  isWrite: boolean;
}

export interface ChatContext {
  product: Product;
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  propertyId?: string;
}

export interface ChatRequestBody {
  messages: { role: 'user' | 'assistant'; content: string }[];
  context?: ChatContext;
  conversationId?: string;
}

/** Events streamed to the browser over SSE. Mirrors the desktop app's chat event union. */
export type StreamEvent =
  | { type: 'ready'; product: Product; model: string; toolCount: number }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; reason: 'complete' | 'tool_budget' | 'time_budget' | 'aborted' };

export interface AuthedUser {
  id: string;
  email?: string;
}
