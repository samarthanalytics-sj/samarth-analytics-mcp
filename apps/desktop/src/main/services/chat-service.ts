import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import type { ProviderKeyStore } from '../storage/provider-keys';
import { buildToolRegistry } from '../tools/registry';
import type { ConfirmFn } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import type { ChatReply, ChatStreamEvent, ChatToolCall, ChatTurn, GoogleProduct } from '../../shared/ipc';
import type { LlmTurn } from '../llm/types';

// Ties the active account (provider + model + vaulted key) to the LLM gateway and
// the read-only GTM/GA4 tool registry. The model can call tools, which run as the
// active account against Google, to answer questions about that account's setup.
export class ChatService {
  constructor(
    private readonly registry: RegistryService,
    private readonly data: GoogleDataService,
    private readonly providerKeys: ProviderKeyStore
  ) {}

  /** Non-streaming: returns the final reply only. */
  chat(history: ChatTurn[], message: string, product: GoogleProduct): Promise<ChatReply> {
    return this.run(history, message, product);
  }

  /**
   * Streaming: `emit` fires for text chunks + tool calls; resolves with the final
   * reply. `product` scopes the available tools to GTM or GA4. When `confirm` is
   * provided (GTM only), write tools become available and each calls `confirm`.
   */
  chatStream(
    history: ChatTurn[],
    message: string,
    product: GoogleProduct,
    emit: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn
  ): Promise<ChatReply> {
    return this.run(history, message, product, emit, confirm);
  }

  private async run(
    history: ChatTurn[],
    message: string,
    product: GoogleProduct,
    emit?: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn
  ): Promise<ChatReply> {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect and activate a Google account.');
    if (!active.hasGoogleToken) throw new Error('The active account is not signed in to Google.');
    if (!active.llm) throw new Error('Choose an LLM provider and model in Settings first.');
    const apiKey = this.providerKeys.getKey(active.llm.provider);
    if (!apiKey) {
      throw new Error(`Add an API key for ${active.llm.provider} in Settings → Providers.`);
    }

    const client = createProvider(active.llm.provider);
    // GA4 is read-only; only GTM gets write tools (and thus the confirm flow).
    const tools = buildToolRegistry(this.data, product === 'gtm' ? confirm : undefined, product);

    const productLabel = product === 'gtm' ? 'Google Tag Manager (GTM)' : 'Google Analytics 4 (GA4)';
    const system =
      `You are a ${productLabel} assistant for the Google account ${active.email}. ` +
      `Only help with ${productLabel}; if asked about the other product, say to switch the ` +
      'GTM/GA4 selector. ' +
      (product === 'gtm' && confirm
        ? 'You can read the GTM setup and create/edit/delete tags, triggers, and variables in a ' +
          'DRAFT workspace (never published — the user publishes manually in GTM). Always work in a ' +
          'workspace (create one if needed). When the user wants a tag that fires on some event, ' +
          'use the ONE-SHOT create_gtm_tag_with_trigger tool (it enables needed built-in variables, ' +
          'reuses an existing trigger of the same name instead of duplicating, then creates the tag ' +
          'linked to it) so the user approves the whole thing ONCE — do not split it into separate ' +
          'create_gtm_trigger then create_gtm_tag calls. Include builtInVariables like ["clickUrl"] ' +
          'when the trigger needs them. The user must approve each change. '
        : product === 'gtm'
          ? 'You can read the GTM setup (accounts, containers, workspaces, tags). '
          : 'You can read GA4 (accounts, properties, data streams) and run GA4 reports. ') +
      (product === 'gtm' && active.gtmContext?.containerId
        ? `The user is working in GTM account ${active.gtmContext.accountId} ` +
          `(${active.gtmContext.accountName ?? ''}), container ${active.gtmContext.containerId} ` +
          `(${active.gtmContext.containerName ?? ''})` +
          (active.gtmContext.workspaceId
            ? `, workspace ${active.gtmContext.workspaceId} (${active.gtmContext.workspaceName ?? ''})`
            : '') +
          '. Use THESE ids for all GTM operations — do not ask which account/container/workspace and ' +
          'do not re-list them unless the user asks to switch. '
        : '') +
      'Call tools when asked; never invent ids. Be concise and factual.';

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
