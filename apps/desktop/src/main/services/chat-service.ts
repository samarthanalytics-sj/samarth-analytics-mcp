import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import { buildToolRegistry } from '../tools/registry';
import type { ConfirmFn } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import type { ChatReply, ChatStreamEvent, ChatToolCall, ChatTurn } from '../../shared/ipc';
import type { LlmTurn } from '../llm/types';

// Ties the active account (provider + model + vaulted key) to the LLM gateway and
// the read-only GTM/GA4 tool registry. The model can call tools, which run as the
// active account against Google, to answer questions about that account's setup.
export class ChatService {
  constructor(
    private readonly registry: RegistryService,
    private readonly data: GoogleDataService
  ) {}

  /** Non-streaming: returns the final reply only. */
  chat(history: ChatTurn[], message: string): Promise<ChatReply> {
    return this.run(history, message);
  }

  /**
   * Streaming: `emit` fires for text chunks + tool calls; resolves with the final
   * reply. When `confirm` is provided, write tools (create/edit GTM in a draft
   * workspace) become available and each one calls `confirm` before applying.
   */
  chatStream(
    history: ChatTurn[],
    message: string,
    emit: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn
  ): Promise<ChatReply> {
    return this.run(history, message, emit, confirm);
  }

  private async run(
    history: ChatTurn[],
    message: string,
    emit?: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn
  ): Promise<ChatReply> {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect and activate a Google account.');
    if (!active.hasGoogleToken) throw new Error('The active account is not signed in to Google.');
    if (!active.llm) throw new Error('Choose an LLM provider and model for this account first.');
    const apiKey = this.registry.getLlmApiKey(active.id);
    if (!apiKey) throw new Error('Save an API key for this account before chatting.');

    const client = createProvider(active.llm.provider);
    const tools = buildToolRegistry(this.data, confirm);

    const system =
      `You are an analytics assistant for the Google account ${active.email}. ` +
      "You have read tools to inspect this user's Google Tag Manager and GA4 setup " +
      '(accounts, containers, workspaces, tags, properties, data streams, GA4 reports)' +
      (confirm
        ? ', plus write tools to create/edit GTM tags, triggers, and variables in a DRAFT ' +
          'workspace. Writes are never published — they stay in the workspace until the user ' +
          'publishes in GTM. Always work in a workspace (create one if needed), and the user ' +
          'must approve each change before it is applied. '
        : '. ') +
      'Call tools when the user asks; never invent ids. Be concise and factual.';

    const messages: LlmTurn[] = [
      ...history.map((h): LlmTurn => ({ role: h.role, text: h.text })),
      { role: 'user', text: message },
    ];

    const toolCalls: ChatToolCall[] = [];
    const result = await runChat(client, { system, model: active.llm.model, apiKey, messages }, tools, {
      onDelta: emit ? (delta) => emit({ type: 'text', delta }) : undefined,
      onToolCall: (call) => {
        toolCalls.push({ name: call.name, args: call.args });
        emit?.({ type: 'tool', name: call.name });
      },
    });

    return { text: result.text, toolCalls };
  }
}
