import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import type { SecretStore } from './secret-store';
import type { LlmProvider, ProviderStatus } from '../../shared/ipc';

interface AppSettingsFile {
  version: 1;
  providers: Partial<Record<LlmProvider, { apiKeyRef?: string }>>;
}

const EMPTY: AppSettingsFile = { version: 1, providers: {} };
const ALL_PROVIDERS: LlmProvider[] = ['openai', 'anthropic', 'gemini'];

/**
 * App-level LLM API keys — one per provider, shared by every account (entered
 * once, not per Google account). Key bytes live in the encrypted SecretStore
 * (DPAPI); only the opaque ref is persisted in app-settings.json.
 */
export class ProviderKeyStore {
  private data: AppSettingsFile;

  constructor(
    private readonly filePath: string,
    private readonly secrets: SecretStore
  ) {
    const loaded = readJsonFile<AppSettingsFile>(filePath, structuredClone(EMPTY));
    this.data = loaded && loaded.providers ? loaded : structuredClone(EMPTY);
  }

  private persist(): void {
    writeJsonFileAtomic(this.filePath, this.data);
  }

  hasKey(provider: LlmProvider): boolean {
    const ref = this.data.providers[provider]?.apiKeyRef;
    return Boolean(ref && this.secrets.has(ref));
  }

  getKey(provider: LlmProvider): string | null {
    const ref = this.data.providers[provider]?.apiKeyRef;
    return ref ? this.secrets.get(ref) : null;
  }

  setKey(provider: LlmProvider, key: string): void {
    const ref = this.data.providers[provider]?.apiKeyRef ?? `prov_${provider}_${randomUUID()}`;
    this.secrets.set(ref, key);
    this.data.providers[provider] = { apiKeyRef: ref };
    this.persist();
  }

  clearKey(provider: LlmProvider): void {
    const ref = this.data.providers[provider]?.apiKeyRef;
    if (ref) this.secrets.delete(ref);
    delete this.data.providers[provider];
    this.persist();
  }

  status(): ProviderStatus {
    return ALL_PROVIDERS.reduce((acc, p) => {
      acc[p] = this.hasKey(p);
      return acc;
    }, {} as ProviderStatus);
  }
}
