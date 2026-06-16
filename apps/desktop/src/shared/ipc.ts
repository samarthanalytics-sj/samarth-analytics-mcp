// Shared IPC DTOs — imported (type-only) by main, preload, and renderer.
//
// IMPORTANT: these are the ONLY account shapes the renderer ever sees. They
// carry no secret bytes and no secret refs — `hasGoogleToken` / `hasApiKey` are
// booleans derived in the main process. Keeping secrets out of these types is
// the type-level guarantee behind "the renderer never receives tokens or keys".

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';
export type GoogleProduct = 'gtm' | 'ga4';

export interface LlmConfigView {
  provider: LlmProvider;
  model: string;
  /** Whether an API key is stored (encrypted) for this account. Never the key. */
  hasApiKey: boolean;
}

export interface AccountView {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  isActive: boolean;
  /** Whether a Google OAuth token is vaulted for this account (set in Phase 2). */
  hasGoogleToken: boolean;
  lastProduct?: GoogleProduct;
  llm?: LlmConfigView;
}

export interface AddAccountInput {
  email: string;
  displayName?: string;
}

/** Which app-level LLM providers have an API key stored. */
export type ProviderStatus = Record<LlmProvider, boolean>;

export interface SecretSelfTest {
  ok: boolean;
  detail: string;
  encryptionAvailable: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatReply {
  text: string;
  /** Tools the model invoked while answering (for display). */
  toolCalls: ChatToolCall[];
}

/** Incremental events pushed during a streaming chat. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | {
      type: 'confirm';
      confirmId: string;
      tool: string;
      summary: string;
      details: Record<string, unknown>;
      destructive?: boolean;
    };

export interface GtmAccountView {
  accountId: string;
  name: string;
  path: string;
}

export interface Ga4AccountView {
  account: string;
  displayName: string;
  propertyCount: number;
}

export interface GoogleClientStatus {
  /** Whether a Google OAuth client (id + secret) is configured. */
  configured: boolean;
  /** Where to drop the oauth-client.json if it isn't (shown to the user). */
  configPath: string;
  /** Where the client was loaded from. */
  source: 'env' | 'file' | 'none';
  /** The loaded client_id (public — appears in the auth URL). For diagnostics. */
  clientId?: string;
  /** Whether the client_id has the expected …apps.googleusercontent.com shape. */
  clientIdLooksValid?: boolean;
}
