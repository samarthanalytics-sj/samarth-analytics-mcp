import { randomUUID } from 'node:crypto';
import { resolveAdsToken, type AdsTokenChoice, type AdsTokenSource } from '../../shared/ads-token-scope';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import type { SecretStore } from './secret-store';
import type { LlmProvider, ProviderStatus } from '../../shared/ipc';

interface AppSettingsFile {
  version: 1;
  providers: Partial<Record<LlmProvider, { apiKeyRef?: string }>>;
  /** Opt-in semantic corpus search. OFF by default: it is the one feature that sends corpus
   *  vocabulary to an embeddings endpoint, and everything else in this stack stays local. */
  semanticCorpus?: boolean;
  /** Opaque SecretStore ref for the Google Ads API developer token (never the token itself). */
  adsDeveloperTokenRef?: string;
  /** Per-app-account developer token overrides, keyed by account id. Used when an account reaches
   *  Google Ads through a DIFFERENT manager account's API access than the shared token's. */
  adsDeveloperTokenRefs?: Record<string, string>;
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

  /** Is opt-in semantic corpus search on? Off unless the user turned it on. */
  semanticCorpusEnabled(): boolean {
    return this.data.semanticCorpus === true;
  }

  setSemanticCorpus(on: boolean): void {
    this.data.semanticCorpus = !!on;
    this.persist();
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
  /** Which ref this account resolves to: its own override, else the shared one. */
  private adsTokenChoice(accountId?: string): AdsTokenChoice {
    return resolveAdsToken({
      ...(accountId ? { accountId } : {}),
      ...(this.data.adsDeveloperTokenRefs ? { perAccount: this.data.adsDeveloperTokenRefs } : {}),
      ...(this.data.adsDeveloperTokenRef ? { shared: this.data.adsDeveloperTokenRef } : {}),
    });
  }

  /** Whether THIS account can reach Google Ads. Called with no account it answers for the shared
   *  token alone, which is what every pre-existing caller means. */
  hasAdsDeveloperToken(accountId?: string): boolean {
    const { ref } = this.adsTokenChoice(accountId);
    return Boolean(ref && this.secrets.has(ref));
  }

  getAdsDeveloperToken(accountId?: string): string | null {
    const { ref } = this.adsTokenChoice(accountId);
    return ref ? this.secrets.get(ref) : null;
  }

  /** Where this account's token comes from, for the UI. Never returns the token itself. */
  adsDeveloperTokenSource(accountId?: string): AdsTokenSource {
    const choice = this.adsTokenChoice(accountId);
    // A ref that no longer resolves to a stored secret is not a usable token.
    if (choice.ref && !this.secrets.has(choice.ref)) return 'none';
    return choice.source;
  }

  /** Set the SHARED token (the default for every account without its own). */
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

  /** Set an override for ONE app account. Its own ref, so clearing it cannot disturb the shared
   *  token or another account's. */
  setAccountAdsDeveloperToken(accountId: string, token: string): void {
    if (!accountId) throw new Error('An account id is required to set an account developer token.');
    const map = this.data.adsDeveloperTokenRefs ?? {};
    const ref = map[accountId] ?? `ads_devtoken_acct_${randomUUID()}`;
    this.secrets.set(ref, token.trim());
    map[accountId] = ref;
    this.data.adsDeveloperTokenRefs = map;
    this.persist();
  }

  /** Drop one account's override; it falls back to the shared token. */
  clearAccountAdsDeveloperToken(accountId: string): void {
    const map = this.data.adsDeveloperTokenRefs;
    const ref = map?.[accountId];
    if (ref) this.secrets.delete(ref);
    if (map) delete map[accountId];
    this.persist();
  }

  /** Which accounts carry their own token. Ids only, never the tokens. */
  accountsWithOwnAdsToken(): string[] {
    return Object.keys(this.data.adsDeveloperTokenRefs ?? {});
  }
}
