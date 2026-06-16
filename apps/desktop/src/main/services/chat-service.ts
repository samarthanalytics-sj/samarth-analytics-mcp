import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import { buildToolRegistry } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import type { ChatReply, ChatToolCall, ChatTurn } from '../../shared/ipc';
import type { LlmTurn } from '../llm/types';

// Ties the active account (provider + model + vaulted key) to the LLM gateway and
// the read-only GTM/GA4 tool registry. The model can call tools, which run as the
// active account against Google, to answer questions about that account's setup.
export class ChatService {
  constructor(
    private readonly registry: RegistryService,
    private readonly data: GoogleDataService
  ) {}

  async chat(history: ChatTurn[], message: string): Promise<ChatReply> {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect and activate a Google account.');
    if (!active.hasGoogleToken) throw new Error('The active account is not signed in to Google.');
    if (!active.llm) throw new Error('Choose an LLM provider and model for this account first.');
    const apiKey = this.registry.getLlmApiKey(active.id);
    if (!apiKey) throw new Error('Save an API key for this account before chatting.');

    const client = createProvider(active.llm.provider);
    const tools = buildToolRegistry(this.data);

    const system =
      `You are an analytics assistant for the Google account ${active.email}. ` +
      'You have read-only tools to inspect this user\'s Google Tag Manager and GA4 setup ' +
      '(accounts, containers, properties). Call tools when the user asks about their ' +
      'accounts/containers/properties; never invent ids. Be concise and factual.';

    const messages: LlmTurn[] = [
      ...history.map((h): LlmTurn => ({ role: h.role, text: h.text })),
      { role: 'user', text: message },
    ];

    const toolCalls: ChatToolCall[] = [];
    const result = await runChat(
      client,
      { system, model: active.llm.model, apiKey, messages },
      tools,
      (call) => toolCalls.push({ name: call.name, args: call.args })
    );

    return { text: result.text, toolCalls };
  }
}
