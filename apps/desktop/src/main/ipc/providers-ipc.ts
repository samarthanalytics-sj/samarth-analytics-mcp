import { ipcMain } from 'electron';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { LlmProvider } from '../../shared/ipc';

const VALID: LlmProvider[] = ['openai', 'anthropic', 'gemini'];

// App-level LLM API keys (one per provider, shared by all accounts).
export function registerProvidersIpc(store: ProviderKeyStore): void {
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
}
