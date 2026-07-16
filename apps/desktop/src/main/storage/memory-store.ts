import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import { normalizeMemoryText, memoryDedupeKey, MEMORY_KINDS, type Memory, type MemoryInput, type MemoryKind, type MemoryScope, type AddMemoryResult, type MemoryPatch } from '../../shared/chat-memory';

export type { AddMemoryResult } from '../../shared/chat-memory';

// Local, per-account store of chat memories (the "remember what I told you" notes). Plain config metadata
// with NO secrets — every write runs through normalizeMemoryText, which redacts credentials before they can
// land on disk. Persisted atomically next to registry.json (same pattern as audit-history / manifests).

interface MemoryFile {
  version: 1;
  /** accountId -> that account's memories. */
  byAccount: Record<string, Memory[]>;
}

const EMPTY: MemoryFile = { version: 1, byAccount: {} };

function cleanScope(scope?: MemoryScope): MemoryScope {
  const s = scope ?? {};
  const out: MemoryScope = {};
  if (s.containerId && String(s.containerId).trim()) out.containerId = String(s.containerId).trim();
  if (s.property && String(s.property).trim()) out.property = String(s.property).trim();
  // The label is display text but still runs through redaction (defense in depth — never persist a secret,
  // even in a scope label passed via IPC).
  if (s.label) {
    const { text } = normalizeMemoryText(String(s.label));
    if (text) out.label = text.slice(0, 80);
  }
  return out;
}

export class MemoryStore {
  private data: MemoryFile;

  constructor(
    private readonly filePath: string,
    /** Max memories retained per account (oldest non-pinned evicted first). */
    private readonly maxPerAccount = 500,
    /** Injectable clock so tests are deterministic. */
    private readonly clock: () => number = () => Date.now(),
  ) {
    const fileExisted = existsSync(filePath);
    const loaded = readJsonFile<MemoryFile>(filePath, structuredClone(EMPTY));
    if (loaded && loaded.version === 1 && loaded.byAccount && typeof loaded.byAccount === 'object') {
      this.data = loaded;
    } else {
      if (fileExisted) console.warn(`[samarth-desktop] memory-store unreadable or incompatible — resetting: ${filePath}`);
      this.data = structuredClone(EMPTY);
    }
  }

  private persist(): void {
    writeJsonFileAtomic(this.filePath, this.data);
  }

  private bucket(accountId: string): Memory[] {
    return this.data.byAccount[accountId] ?? [];
  }

  /** All memories for an account, newest-updated first (a stable order for the UI). */
  list(accountId: string): Memory[] {
    return [...this.bucket(accountId)].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Create (or refresh a duplicate of) a memory. Text is normalized + secret-redacted before storage. */
  add(accountId: string, input: MemoryInput): AddMemoryResult {
    const kind: MemoryKind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'fact';
    const { text, redacted } = normalizeMemoryText(input.text ?? '');
    if (!text) throw new Error('A memory needs some text.');
    const scope = cleanScope(input.scope);
    const now = this.clock();

    const list = this.data.byAccount[accountId] ?? (this.data.byAccount[accountId] = []);
    // Dedupe: same kind + scope + text refreshes the existing entry rather than duplicating.
    const key = memoryDedupeKey({ kind, text, scope });
    const existing = list.find((m) => memoryDedupeKey(m) === key);
    if (existing) {
      existing.updatedAt = now;
      if (input.pinned) existing.pinned = true;
      existing.enabled = true;
      this.persist();
      return { memory: existing, redacted, deduped: true };
    }

    const memory: Memory = {
      id: randomUUID(),
      kind,
      text,
      scope,
      source: input.source ?? 'manual',
      pinned: Boolean(input.pinned),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    // Make room BEFORE pushing so the just-added memory can never be the one evicted (a silent add failure).
    this.evict(list, 1);
    list.push(memory);
    this.persist();
    return { memory, redacted, deduped: false };
  }

  /** Patch a memory. Editing the text re-normalizes + re-redacts it. Returns the updated memory or null. */
  update(accountId: string, id: string, patch: MemoryPatch): Memory | null {
    const m = this.bucket(accountId).find((x) => x.id === id);
    if (!m) return null;
    if (patch.kind && MEMORY_KINDS.includes(patch.kind)) m.kind = patch.kind;
    if (typeof patch.text === 'string') {
      const { text } = normalizeMemoryText(patch.text);
      if (text) m.text = text;
    }
    if (patch.scope) m.scope = cleanScope(patch.scope);
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    if (typeof patch.enabled === 'boolean') m.enabled = patch.enabled;
    m.updatedAt = this.clock();
    this.persist();
    return m;
  }

  /** Delete one memory. Returns true if it existed. */
  remove(accountId: string, id: string): boolean {
    const list = this.bucket(accountId);
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    this.data.byAccount[accountId] = next;
    this.persist();
    return true;
  }

  /** Delete every memory for an account. Returns how many were removed. */
  clear(accountId: string): number {
    const n = this.bucket(accountId).length;
    if (n) {
      delete this.data.byAccount[accountId];
      this.persist();
    }
    return n;
  }

  // Trim the per-account list so it has room for `incoming` more, evicting the oldest-updated NON-pinned
  // memories first (only pinned ones once every unpinned is gone). Called on the EXISTING list before a
  // push, so a fresh add is never its own victim.
  private evict(list: Memory[], incoming = 0): void {
    const overflow = list.length + incoming - this.maxPerAccount;
    if (overflow <= 0) return;
    const byAge = [...list].sort((a, b) => Number(a.pinned) - Number(b.pinned) || a.updatedAt - b.updatedAt);
    const victims = new Set(byAge.slice(0, overflow).map((m) => m.id));
    for (let i = list.length - 1; i >= 0; i--) if (victims.has(list[i].id)) list.splice(i, 1);
  }
}
