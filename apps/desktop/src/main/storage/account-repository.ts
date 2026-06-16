import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import type { GoogleProduct, LlmProvider } from '../../shared/ipc';

// The persisted, INTERNAL account shape. Unlike AccountView (the renderer DTO),
// this holds opaque secret refs (googleTokenRef / llm.apiKeyRef) that point into
// the SecretStore. These refs never leave the main process.
export interface StoredAccount {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  /** Opaque ref into SecretStore for the vaulted Google OAuth token (Phase 2). */
  googleTokenRef?: string;
  llm?: {
    provider: LlmProvider;
    model: string;
    /** Opaque ref into SecretStore for the LLM API key. */
    apiKeyRef?: string;
  };
  lastProduct?: GoogleProduct;
}

interface RegistryFile {
  version: 1;
  activeAccountId: string | null;
  accounts: StoredAccount[];
}

const EMPTY: RegistryFile = { version: 1, activeAccountId: null, accounts: [] };

/**
 * JSON-backed account registry. A thin, swappable persistence layer — the shape
 * is a small keyed collection, so a later move to SQLite is a drop-in behind
 * these methods. All returned objects are shallow copies so callers can't mutate
 * the in-memory cache without going through a method that persists.
 */
export class AccountRepository {
  private readonly filePath: string;
  private data: RegistryFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    const loaded = readJsonFile<RegistryFile>(filePath, structuredClone(EMPTY));
    this.data = Array.isArray(loaded.accounts) ? loaded : structuredClone(EMPTY);
  }

  private persist(): void {
    writeJsonFileAtomic(this.filePath, this.data);
  }

  list(): StoredAccount[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  get(id: string): StoredAccount | null {
    const a = this.data.accounts.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  getByEmail(email: string): StoredAccount | null {
    const a = this.data.accounts.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return a ? { ...a } : null;
  }

  activeId(): string | null {
    return this.data.activeAccountId;
  }

  /** Add an account (idempotent by email). First account becomes active. */
  add(input: { email: string; displayName?: string }): StoredAccount {
    const existing = this.data.accounts.find(
      (x) => x.email.toLowerCase() === input.email.toLowerCase()
    );
    if (existing) return { ...existing };

    const account: StoredAccount = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      createdAt: Date.now(),
    };
    this.data.accounts.push(account);
    if (this.data.activeAccountId === null) this.data.activeAccountId = account.id;
    this.persist();
    return { ...account };
  }

  update(id: string, patch: Partial<Omit<StoredAccount, 'id' | 'createdAt'>>): StoredAccount {
    const a = this.data.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`account not found: ${id}`);
    Object.assign(a, patch);
    this.persist();
    return { ...a };
  }

  /** Remove an account; if it was active, hand active to the first remaining (or null). */
  remove(id: string): void {
    const idx = this.data.accounts.findIndex((x) => x.id === id);
    if (idx === -1) return;
    this.data.accounts.splice(idx, 1);
    if (this.data.activeAccountId === id) {
      this.data.activeAccountId = this.data.accounts[0]?.id ?? null;
    }
    this.persist();
  }

  setActive(id: string): void {
    if (!this.data.accounts.some((x) => x.id === id)) {
      throw new Error(`account not found: ${id}`);
    }
    this.data.activeAccountId = id;
    this.persist();
  }
}
