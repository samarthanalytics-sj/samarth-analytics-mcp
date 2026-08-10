import type { Product } from './config.js';

/**
 * A multi-part user message. Only used when an image is attached: OpenAI takes images as content
 * parts, and a plain string cannot carry one.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Chat message as exchanged with the browser and with OpenAI. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Where a write actually lands, which is the only thing that decides whether it can be undone.
 *
 * `gtm_draft` is workspace-scoped: tags, triggers, variables, folders. The change sits in a draft
 * that is never published by this app, the previous state is still live, and discarding the
 * workspace throws the change away. This is the tier that can safely apply without a prompt.
 *
 * `gtm_live` is container, account, version, environment, or permission scope. There is no draft
 * step, so it takes effect the moment it succeeds.
 *
 * `ga4_live` is every GA4 Admin write. GA4 has no draft concept at all.
 */
export type WriteSurface = 'gtm_draft' | 'gtm_live' | 'ga4_live';

/** Neutral tool definition, mapped from an MCP tool listing. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the MCP schema declares a `confirm` argument, which marks every guarded write. */
  isWrite: boolean;
  /**
   * True for publishes, reauthorizations, and GA4 deletes and archives. These are never shown to the
   * model, whatever the write setting: publishing makes a draft live, which is a category change
   * rather than an edit, and a GA4 archive is described by the MCP itself as effectively permanent.
   */
  isDestructive: boolean;
  /**
   * A delete. Always behind a typed confirmation, because nothing in this toolset reverts one and
   * undo is a manual rebuild.
   */
  isDelete: boolean;
  /** Undefined on reads. Set for every write, and drives what the user is told about reversibility. */
  surface?: WriteSurface;
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
  /** Files attached to the LAST user message. Base64, extracted server-side; see attachments.ts. */
  attachments?: { name: string; dataBase64: string }[];
}

/** Events streamed to the browser over SSE. Mirrors the desktop app's chat event union. */
export type StreamEvent =
  | { type: 'ready'; product: Product; model: string; toolCount: number }
  /** The conversation this turn was recorded under, so the client can continue it next time. */
  | { type: 'conversation'; conversationId: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | {
      type: 'approval_required';
      approvalId: string;
      toolName: string;
      summary: string;
      args: Record<string, unknown>;
      /** When set, the user must type this word before the change can be approved. */
      confirmWord?: string;
      /** Lets the card state what is actually at stake instead of assuming a draft workspace. */
      surface: WriteSurface;
    }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; reason: 'complete' | 'tool_budget' | 'time_budget' | 'aborted' };

export interface AuthedUser {
  id: string;
  email?: string;
}
