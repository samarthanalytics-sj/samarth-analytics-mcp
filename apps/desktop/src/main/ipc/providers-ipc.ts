import { ipcMain } from 'electron';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { LlmProvider, SemanticCorpusStatus } from '../../shared/ipc';
import type { CorpusSemanticIndex } from '../corpus/semantic-index';
import type { EmbeddingStore } from '../storage/embedding-store';
import type { RegistryService } from '../services/registry-service';
import { getPatternLibrary } from '../corpus/pattern-library';
import { semanticUnavailableReason } from '../../shared/embeddings';

const VALID: LlmProvider[] = ['openai', 'anthropic', 'gemini'];

// App-level LLM API keys (one per provider, shared by all accounts).
export function registerProvidersIpc(
  store: ProviderKeyStore,
  semantic?: { index: CorpusSemanticIndex; cache: EmbeddingStore; registry: RegistryService },
): void {
  ipcMain.handle('providers:status', () => store.status());

  ipcMain.handle('providers:setKey', (_event, provider: LlmProvider, key: string) => {
    if (!VALID.includes(provider)) throw new Error(`unknown provider: ${provider}`);
    if (typeof key !== 'string' || key.trim().length === 0) throw new Error('API key required');
    store.setKey(provider, key.trim());
    return store.status();
  });

  ipcMain.handle('providers:clearKey', (_event, provider: LlmProvider) => {
    if (!VALID.includes(provider)) throw new Error(`unknown provider: ${provider}`);
    store.clearKey(provider);
    return store.status();
  });

  // ---- Opt-in semantic corpus search -----------------------------------------------------------
  // The ONE feature that sends corpus vocabulary to an embeddings endpoint, so the switch, what it
  // sends, whether the current provider can do it at all, and the cache it fills are all reported
  // here rather than hidden. Everything degrades to keyword search, so none of this can fail a chat.
  const activeProvider = (): LlmProvider | undefined => semantic?.registry.getActiveView()?.llm?.provider;

  const semanticStatus = (): SemanticCorpusStatus => {
    const provider = activeProvider();
    const enabled = store.semanticCorpusEnabled();
    const index = semantic?.index.status() ?? { state: 'idle' as const, terms: 0 };
    const lib = getPatternLibrary();
    return {
      enabled,
      provider: provider ?? '',
      // Vocabulary size is what a first build actually costs, so the UI can state it up front.
      vocabulary: lib ? new Set([
        ...lib.tagPatterns.map((t) => t.eventName).filter(Boolean),
        ...lib.triggerPatterns.map((t) => t.event).filter(Boolean),
        ...lib.variablePatterns.map((v) => v.keyPath).filter(Boolean),
      ] as string[]).size : 0,
      state: index.state,
      terms: index.terms,
      ...(index.error ? { error: index.error } : {}),
      cached: semantic?.cache.size() ?? 0,
      unavailable: semanticUnavailableReason({
        enabled,
        provider: provider ?? '',
        hasKey: provider ? store.hasKey(provider) : false,
      }),
    };
  };

  ipcMain.handle('providers:semanticStatus', (): SemanticCorpusStatus => semanticStatus());

  ipcMain.handle('providers:setSemanticCorpus', (_event, on: unknown): SemanticCorpusStatus => {
    store.setSemanticCorpus(!!on);
    return semanticStatus();
  });

  // Build on demand, so the one-off cost is paid when the user chooses rather than silently inside
  // their next chat turn. Returns as soon as the build finishes; the UI shows progress from status.
  ipcMain.handle('providers:buildSemanticIndex', async (): Promise<SemanticCorpusStatus> => {
    const provider = activeProvider();
    const lib = getPatternLibrary();
    if (!semantic || !provider || !lib) return semanticStatus();
    const key = store.getKey(provider);
    if (!key) return semanticStatus();
    await semantic.index.build(lib, provider, key);
    return semanticStatus();
  });

  ipcMain.handle('providers:clearSemanticCache', (): SemanticCorpusStatus => {
    semantic?.cache.clear();
    return semanticStatus();
  });
}
