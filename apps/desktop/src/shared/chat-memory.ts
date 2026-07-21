// Chat memory — the pure core of the "remember what the user told me" layer (Phase 1). A Memory is a
// short, durable note about an account or a specific client (GTM container / GA4 property): a fact, a
// preference, a rule (a correction that should outrank defaults), a decision, or a glossary entry. The
// desktop chat loads the relevant ones each turn and injects them into the system prompt, so the assistant
// stays client-aware across sessions WITHOUT any model training.
//
// This module is PURE + framework-free (no I/O, no DOM): the store persists, the chat service injects, the
// renderer manages — all through these helpers. Everything here is unit-tested.

export type MemoryKind = 'fact' | 'preference' | 'rule' | 'decision' | 'glossary';
export type MemorySource = 'manual' | 'chat' | 'auto';

/** Where a memory applies. Empty (no container + no property) = account-wide (used in every chat for this
 *  account). A containerId scopes it to that GTM container; a property scopes it to that GA4 property. */
export interface MemoryScope {
  containerId?: string;
  property?: string;
  /** A human label for the client/container/property, shown in the UI (never used for matching). */
  label?: string;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** The note itself (already secret-redacted before it ever reaches here). */
  text: string;
  scope: MemoryScope;
  source: MemorySource;
  pinned: boolean;
  /** Disabled memories are kept but never injected — a soft "mute" without deleting. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Provenance/usage: when this memory was last injected into a chat turn (epoch ms). */
  lastUsedAt?: number;
  /** Provenance/usage: how many chat turns this memory has been injected into. */
  useCount?: number;
}

/** What the caller supplies to create a memory (the store fills id/timestamps/defaults). */
export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  scope?: MemoryScope;
  source?: MemorySource;
  pinned?: boolean;
}

/** Result of adding a memory: the stored entry + whether a secret was scrubbed + whether it deduped. */
export interface AddMemoryResult {
  memory: Memory;
  redacted: boolean;
  deduped: boolean;
}

/** The fields a memory update may patch. */
export type MemoryPatch = Partial<Pick<Memory, 'kind' | 'text' | 'pinned' | 'enabled' | 'scope'>>;

export const MEMORY_KINDS: MemoryKind[] = ['fact', 'preference', 'rule', 'decision', 'glossary'];
export const MEMORY_MAX_LEN = 500;
/** Cap how many memories get injected into one prompt (keeps the system prompt bounded). */
export const MEMORY_INJECT_LIMIT = 16;

// ── Secret redaction ────────────────────────────────────────────────────────────────────────────────
// A memory must NEVER persist a credential, even if one is pasted into a "remember this". These patterns
// mirror the kinds of secrets that show up in GTM/GA4 chats: OAuth tokens, Google API keys, provider LLM
// keys, GTM preview auth, private-key blocks, and secret-ish key=value pairs. Matches are replaced with
// [redacted]; the boolean says whether anything was scrubbed (so the UI can warn).
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM private key
  /ya29\.[0-9A-Za-z._\-]{20,}/g, // Google OAuth access token
  /1\/\/[0-9A-Za-z._\-]{20,}/g, // Google OAuth refresh token
  /AIza[0-9A-Za-z_\-]{35}/g, // Google API key
  /\bsk-[A-Za-z0-9_\-]{20,}/g, // provider LLM keys: OpenAI sk- / sk-proj- / sk-svcacct- / sk-admin-, Anthropic sk-ant- (hyphens/underscores included)
  /\bgtm_auth=[0-9A-Za-z_\-]{10,}/g, // GTM preview auth token
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, // bearer token
  /"private_key"\s*:\s*"[^"]+"/g, // service-account JSON field
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"',;]{6,}/gi, // secret-ish key=value
];

/** Strip any credential-looking substrings. Returns the cleaned text + whether anything was removed. */
export function redactSecrets(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const re of SECRET_PATTERNS) {
    text = text.replace(re, (m) => {
      redacted = true;
      // Preserve a leading "key:" / "key=" so the note still reads sensibly.
      const kv = /^([A-Za-z_\-]+\s*[:=]\s*)/.exec(m);
      return kv ? `${kv[1]}[redacted]` : '[redacted]';
    });
  }
  return { text, redacted };
}

/** Normalize a memory's text: strip control chars, collapse whitespace, redact secrets, clamp length. */
export function normalizeMemoryText(raw: string): { text: string; redacted: boolean } {
  const collapsed = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const { text, redacted } = redactSecrets(collapsed);
  return { text: text.slice(0, MEMORY_MAX_LEN).trim(), redacted };
}

/** A stable key for de-duplicating a memory within an account (same kind + scope + text). */
export function memoryDedupeKey(m: { kind: MemoryKind; text: string; scope?: MemoryScope }): string {
  const s = m.scope ?? {};
  return `${m.kind}|${s.containerId ?? ''}|${s.property ?? ''}|${m.text.toLowerCase()}`;
}

/** Memories matching a free-text "forget X" query — text contains the whole query, OR contains every
 *  significant term (>= 3 chars) of it. Used by the chat `forget` tool to find what to remove. PURE.
 *  A query with NO term of >= 3 chars (e.g. "a", "it", "forget it") is too vague to match safely and
 *  returns nothing — this is the guard against a short query mass-deleting the account's memories. */
export function findMemoriesMatching(memories: Memory[], query: string): Memory[] {
  const q = String(query ?? '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length >= 3);
  if (!q || terms.length === 0) return [];
  return memories.filter((m) => {
    const t = m.text.toLowerCase();
    return t.includes(q) || terms.every((term) => t.includes(term));
  });
}

/** One entry of a turn's provenance ledger: which memory shaped the answer, as the UI shows it. */
export interface MemoryProvenance {
  id: string;
  kind: MemoryKind;
  /** Snapshot of the text AT USE TIME, so the record stays truthful if the memory is edited later. */
  text: string;
}

/** Clamp + house-style a memory's text for the provenance record (no em dashes, bounded length). */
export function snapshotMemoryText(text: string, max = 200): string {
  const s = String(text ?? '').replace(/[—–]/g, '-');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Fold memories into a turn's provenance ledger, keyed by id.
 *
 * A memory that is BOTH injected at turn start and recalled mid-turn by the memory tool must be
 * credited exactly once: the UI would otherwise double-count it, and the persisted useCount (documented
 * as "turns used") would drift. Returns the ids newly added, so the caller writes the usage log for
 * those and only those. Mutates `ledger` in place; PURE otherwise.
 */
export function creditMemoryUse(ledger: Map<string, MemoryProvenance>, memories: Memory[]): string[] {
  const added: string[] = [];
  for (const m of memories) {
    if (!m || ledger.has(m.id)) continue;
    ledger.set(m.id, { id: m.id, kind: m.kind, text: snapshotMemoryText(m.text) });
    added.push(m.id);
  }
  return added;
}

/** Where a recall search may look. 'context' = what this turn would inject anyway (account-wide + the
 *  active client); 'account' = account-wide notes only; 'all' = every note saved under this Google
 *  account, including other clients (for "what did I tell you about the other site?"). */
export type MemorySearchScope = 'context' | 'account' | 'all';

/** One ranked recall result: the memory plus why it surfaced (how many query terms it matched). */
export interface MemorySearchHit {
  memory: Memory;
  matchedTerms: number;
}

/**
 * RANKED recall over saved memories — the retrieval half of the memory system, used by the chat
 * `recall_memories` tool to look past the handful auto-injected each turn.
 *
 * Deliberately different from `findMemoriesMatching` (the `forget` matcher): that one demands EVERY
 * term so a vague query can never mass-delete. Recall is read-only, so partial matches are useful and
 * ranked instead of excluded. Disabled memories stay excluded everywhere: muted means muted.
 * PURE + deterministic.
 */
export function searchMemories(
  memories: Memory[],
  query: string,
  opts: { scope?: MemorySearchScope; ctx?: { containerId?: string; property?: string }; limit?: number } = {},
): MemorySearchHit[] {
  const scope = opts.scope ?? 'all';
  const ctx = opts.ctx ?? {};
  const limit = Math.max(0, Math.floor(opts.limit ?? 10));
  // Browse mode keys on a BLANK query, not on an empty token set: a query of "购买" or "A/B" tokenizes
  // to nothing, and treating that as "no query" returned (and credited as used) every memory in the
  // account for a search that matched none of them.
  const blank = String(query ?? '').trim() === '';
  const q = tokens(String(query ?? ''));
  const inScope = (m: Memory): boolean => {
    if (scope === 'context') return memoryApplies(m, ctx);
    if (scope === 'account') return !m.scope?.containerId && !m.scope?.property;
    return true;
  };
  const scored = memories
    .filter((m) => m.enabled && inScope(m))
    .map((m) => {
      const mt = tokens(m.text);
      let matchedTerms = 0;
      for (const t of q) if (mt.has(t)) matchedTerms += 1;
      return { memory: m, matchedTerms };
    })
    // With a query, only real matches; with an empty query, browse the most relevant notes.
    .filter((h) => (blank ? true : h.matchedTerms > 0));
  scored.sort((a, b) =>
    b.matchedTerms - a.matchedTerms ||
    Number(b.memory.pinned) - Number(a.memory.pinned) ||
    b.memory.updatedAt - a.memory.updatedAt ||
    (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0));
  return scored.slice(0, limit);
}

/** Does a memory's scope apply to the current chat context? Account-wide always applies. */
export function memoryApplies(m: Memory, ctx: { containerId?: string; property?: string }): boolean {
  const s = m.scope ?? {};
  const accountWide = !s.containerId && !s.property;
  if (accountWide) return true;
  if (s.containerId && ctx.containerId && s.containerId === ctx.containerId) return true;
  if (s.property && ctx.property && s.property === ctx.property) return true;
  return false;
}

// Tokenize for keyword overlap (lowercased words >= 3 chars). Identifiers are indexed BOTH whole and
// split, because analytics notes are full of them: "form_submit" and "formSubmission" each yield
// {form_submit | formsubmission, form, submit | submission}. Without the split, a note whose only
// mention of a concept is inside an identifier could not be found by typing that concept in words -
// which for `searchMemories` (a hard filter) meant reporting a saved note as nonexistent.
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const whole of s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) {
    out.add(whole);
    for (const part of whole.replace(/([a-z])([0-9])/g, '$1 $2').split(/[^a-z0-9]+/)) {
      if (part.length >= 3) out.add(part);
    }
  }
  // camelCase lives in the ORIGINAL casing, which the match above has already flattened.
  for (const part of s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    out.add(part);
  }
  return out;
}

/** Pick the memories to inject for this turn: enabled + in-scope, ranked (pinned → keyword overlap with the
 *  message → recency), capped at `limit`. Pure + deterministic for a given input. */
export function selectRelevantMemories(
  memories: Memory[],
  ctx: { containerId?: string; property?: string },
  query: string,
  limit = MEMORY_INJECT_LIMIT,
): Memory[] {
  const q = tokens(query);
  const scored = memories
    .filter((m) => m.enabled && memoryApplies(m, ctx))
    .map((m) => {
      const mt = tokens(m.text);
      let overlap = 0;
      for (const t of q) if (mt.has(t)) overlap += 1;
      return { m, overlap };
    });
  scored.sort((a, b) =>
    Number(b.m.pinned) - Number(a.m.pinned) ||
    b.overlap - a.overlap ||
    b.m.updatedAt - a.m.updatedAt);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.m);
}

const KIND_LABEL: Record<MemoryKind, string> = {
  rule: 'rule', preference: 'preference', decision: 'decision', fact: 'fact', glossary: 'glossary',
};

/** Render the chosen memories as a system-prompt block. Rules/preferences are framed as authoritative
 *  instructions; facts are framed as user-provided context to verify against live data — never fabricated. */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (!memories.length) return '';
  // Rules + preferences first (they steer behavior), then the rest.
  const order: Record<MemoryKind, number> = { rule: 0, preference: 1, decision: 2, fact: 3, glossary: 4 };
  const lines = [...memories]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((m) => `- [${KIND_LABEL[m.kind]}] ${m.text}`)
    .join('\n');
  return (
    'REMEMBERED CONTEXT: notes the user has saved about this account/client. ' +
    'Treat RULES and PREFERENCES as authoritative instructions that OVERRIDE your defaults. ' +
    'Treat FACTS/DECISIONS/GLOSSARY as user-provided context: use them, but VERIFY anything factual against ' +
    'the live GTM/GA4 data via tools before you rely on it, and never present a remembered note as if you ' +
    'confirmed it this session. These notes are private context, not something to repeat back verbatim unless asked.\n' +
    lines +
    '\n'
  );
}
