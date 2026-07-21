import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import type { SecretStore } from './secret-store';
import type { LlmProvider, ProviderStatus } from '../../shared/ipc';

interface AppSettingsFile {
  version: 1;
  providers: Partial<Record<LlmProvider, { apiKeyRef?: string }>>;
  /** Opaque SecretStore ref for the Google Ads API developer token (never the token itself). */
  adsDeveloperTokenRef?: string;
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

  /* ── Google Ads API developer token ────────────────────────────────────────
   * App-level, exactly like an LLM provider key: the token belongs to the operator's Google Ads
   * MANAGER account, not to any one signed-in Google account, and the same token is used for every
   * client account in the app. It rides in the `developer-token` header of every Google Ads request,
   * including read-only ones, so without it the whole Ads surface is unavailable.
   *
   * Stored the same way as every other secret here: ciphertext in the shared SecretStore (safeStorage,
   * DPAPI on Windows), only the opaque ref in app-settings.json, and only a BOOLEAN ever crosses into
   * the renderer. Never follow the oauth-client.json precedent, which keeps its secret in plaintext.
   *
   * Note this deliberately reuses the SAME store instance and file as the provider keys: SecretStore
   * reads the whole file into memory in its constructor and writes the whole cache back, so a second
   * store over the same path would clobber it. */
  hasAdsDeveloperToken(): boolean {
    const ref = this.data.adsDeveloperTokenRef;
    return Boolean(ref && this.secrets.has(ref));
  }

  getAdsDeveloperToken(): string | null {
    const ref = this.data.adsDeveloperTokenRef;
    return ref ? this.secrets.get(ref) : null;
  }

  setAdsDeveloperToken(token: string): void {
    const ref = this.data.adsDeveloperTokenRef ?? `ads_devtoken_${randomUUID()}`;
    this.secrets.set(ref, token.trim());
    this.data.adsDeveloperTokenRef = ref;
    this.persist();
  }

  clearAdsDeveloperToken(): void {
    const ref = this.data.adsDeveloperTokenRef;
    if (ref) this.secrets.delete(ref);
    delete this.data.adsDeveloperTokenRef;
    this.persist();
  }
}
