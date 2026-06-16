import { randomUUID } from 'node:crypto';
import type { AccountRepository, StoredAccount } from '../storage/account-repository';
import type { SecretStore } from '../storage/secret-store';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { AccountView, GtmContext, LlmProvider, SecretSelfTest } from '../../shared/ipc';

// Facade the IPC layer talks to. Combines the account registry (metadata) with
// the secret store (encrypted bytes), and is the ONLY place that converts an
// internal StoredAccount into a renderer-safe AccountView — stripping secret
// refs and replacing them with has* booleans.
export class RegistryService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly secrets: SecretStore,
    private readonly providerKeys: ProviderKeyStore
  ) {}

  private toView(a: StoredAccount): AccountView {
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      createdAt: a.createdAt,
      isActive: this.repo.activeId() === a.id,
      hasGoogleToken: Boolean(a.googleTokenRef && this.secrets.has(a.googleTokenRef)),
      lastProduct: a.lastProduct,
      gtmContext: a.gtmContext,
      llm: a.llm
        ? {
            provider: a.llm.provider,
            model: a.llm.model,
            // App-level: the key belongs to the provider, shared across accounts.
            hasApiKey: this.providerKeys.hasKey(a.llm.provider),
          }
        : undefined,
    };
  }

  listViews(): AccountView[] {
    return this.repo.list().map((a) => this.toView(a));
  }

  getActiveView(): AccountView | null {
    const id = this.repo.activeId();
    if (!id) return null;
    const a = this.repo.get(id);
    return a ? this.toView(a) : null;
  }

  addAccount(input: { email: string; displayName?: string }): AccountView {
    return this.toView(this.repo.add(input));
  }

  /** Remove the account and any secrets it owns (token + LLM key). */
  removeAccount(id: string): void {
    const a = this.repo.get(id);
    if (a?.googleTokenRef) this.secrets.delete(a.googleTokenRef);
    if (a?.llm?.apiKeyRef) this.secrets.delete(a.llm.apiKeyRef);
    this.repo.remove(id);
  }

  setActive(id: string): void {
    this.repo.setActive(id);
  }

  /** Remember the GTM account/container/workspace the user is working in. */
  setGtmContext(id: string, gtmContext: GtmContext): AccountView {
    const a = this.repo.get(id);
    if (!a) throw new Error(`account not found: ${id}`);
    return this.toView(this.repo.update(id, { gtmContext }));
  }

  /** Set the account's LLM provider + model. The API key is app-level (per provider). */
  setLlmConfig(id: string, provider: LlmProvider, model: string): AccountView {
    const a = this.repo.get(id);
    if (!a) throw new Error(`account not found: ${id}`);
    return this.toView(this.repo.update(id, { llm: { provider, model } }));
  }

  /** Vault the Google OAuth token JSON for an account (used by Phase 2). */
  setGoogleToken(id: string, tokenJson: string): void {
    const a = this.repo.get(id);
    if (!a) throw new Error(`account not found: ${id}`);
    const ref = a.googleTokenRef ?? `goog_${randomUUID()}`;
    this.secrets.set(ref, tokenJson);
    this.repo.update(id, { googleTokenRef: ref });
  }

  /**
   * Create-or-find an account by email (from a completed Google sign-in), refresh
   * its display name, vault the token, and make it the active account. The single
   * entry point the Google OAuth flow calls on success.
   */
  upsertGoogleAccount(email: string, displayName: string | undefined, tokenJson: string): AccountView {
    const acct = this.repo.add({ email, displayName });
    if (displayName && acct.displayName !== displayName) {
      this.repo.update(acct.id, { displayName });
    }
    this.setGoogleToken(acct.id, tokenJson);
    this.repo.setActive(acct.id);
    return this.toView(this.repo.get(acct.id)!);
  }

  /** Remove the vaulted Google token for an account (disconnect, keep the record). */
  clearGoogleToken(id: string): void {
    const a = this.repo.get(id);
    if (!a?.googleTokenRef) return;
    this.secrets.delete(a.googleTokenRef);
    this.repo.update(id, { googleTokenRef: undefined });
  }

  /** Read the vaulted Google token JSON for an account (used by Phase 2/3). */
  getGoogleToken(id: string): string | null {
    const a = this.repo.get(id);
    if (!a?.googleTokenRef) return null;
    return this.secrets.get(a.googleTokenRef);
  }

  /**
   * Diagnostics: prove the OS encryption round-trips without exposing any real
   * secret. Stores a throwaway probe, reads it back, and deletes it.
   */
  secretSelfTest(): SecretSelfTest {
    if (!this.secrets.available()) {
      return {
        ok: false,
        detail: 'safeStorage encryption is not available on this OS / session.',
        encryptionAvailable: false,
      };
    }
    const ref = `selftest_${randomUUID()}`;
    const probe = `probe-${Date.now()}`;
    try {
      this.secrets.set(ref, probe);
      const ok = this.secrets.get(ref) === probe;
      return {
        ok,
        detail: ok
          ? 'Encrypted and decrypted a probe value successfully (DPAPI).'
          : 'Round-trip mismatch — encryption is misbehaving.',
        encryptionAvailable: true,
      };
    } finally {
      this.secrets.delete(ref);
    }
  }
}
