// Chat-memory auto-suggest (Phase 2b) — the PURE parts of "read the conversation and propose durable
// notes worth remembering." The LLM call itself lives in chat-service (it needs the account's model + key);
// this module owns the extraction PROMPT and the response PARSER/validator, so both are unit-testable and
// the impure surface stays tiny. Proposals are ALWAYS reviewed by the user before anything is saved.

import { MEMORY_KINDS, normalizeMemoryText, memoryDedupeKey, type MemoryKind, type Memory } from './chat-memory';

/** One proposed memory awaiting the user's approval. Deliberately scope-less: the user picks the scope
 *  (account-wide vs the current client) at approval time, in the review UI. */
export interface MemoryCandidate {
  kind: MemoryKind;
  text: string;
}

/** Max notes the extractor may propose in one pass (keeps the review list short + the call cheap). */
export const MEMORY_SUGGEST_LIMIT = 6;

/** The extractor's system prompt. Conservative + safety-first: durable knowledge only, never secrets/PII,
 *  strict JSON out. Kept free of em dashes to match the project's output rule. */
export const MEMORY_EXTRACT_SYSTEM =
  'You extract DURABLE MEMORIES from a GTM/GA4 consultant chat: short notes worth remembering for FUTURE ' +
  'conversations about this account or client. ' +
  'Return ONLY a JSON array (no prose, no code fence) of objects {"kind": "fact"|"preference"|"rule"|"decision"|"glossary", "text": string}. ' +
  'INCLUDE only durable, reusable knowledge: the client stack/setup, naming conventions, a correction the ' +
  'user made (kind "rule"), a stated preference (e.g. server-side vs web, consent defaults), a decision, or ' +
  'a client-specific term/event mapping (kind "glossary"). ' +
  'EXCLUDE: transient values and one-off report numbers; anything already obvious from the container/GA4 ' +
  'config; questions; task requests; pleasantries; and NEVER include secrets, API keys, tokens, passwords, ' +
  'or personal data (emails, names, phone numbers). ' +
  'Be CONSERVATIVE: 0 to ' + MEMORY_SUGGEST_LIMIT + ' items, each a standalone note under 200 characters (not "the user said..."). ' +
  'Prefer the USER statements and corrections over the assistant output. If nothing is worth remembering, return [].';

/** Build the extraction transcript from the chat history (most recent kept within a char budget so the
 *  call stays bounded on a long thread). Returns the single user message text for the LLM. */
export function buildExtractionTranscript(history: Array<{ role: 'user' | 'assistant'; text?: string }>, budget = 8000): string {
  const lines: string[] = [];
  let used = 0;
  // Walk newest → oldest, prepend, stop at the budget — so we keep the most recent exchange.
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const t = (h.text ?? '').trim();
    if (!t) continue;
    const line = `${h.role === 'user' ? 'User' : 'Assistant'}: ${t}`;
    if (used + line.length > budget && lines.length) break;
    lines.unshift(line);
    used += line.length + 2;
  }
  return lines.join('\n\n');
}

/** Pull the first JSON array out of an LLM reply (tolerates ```json fences and surrounding prose, including
 *  prose that itself contains brackets like "[details]" or a markdown "[1]"). Scans from the first '[' to
 *  its MATCHING ']', tracking nesting and string literals so a bracket inside a value or the trailing text
 *  never mis-sets the boundary. */
function extractJsonArray(raw: string): unknown {
  let s = String(raw ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Parse + validate the extractor's reply into clean candidates: normalize+redact each note, drop empties,
 *  drop anything already saved (deduped against `existing` by kind+text, scope-agnostic), de-dupe the batch,
 *  and cap. PURE + deterministic. Never throws on a malformed reply — returns []. */
export function parseMemoryCandidates(raw: string, existing: Memory[] = [], limit = MEMORY_SUGGEST_LIMIT): MemoryCandidate[] {
  const arr = extractJsonArray(raw);
  if (!Array.isArray(arr)) return [];
  // Existing notes, keyed scope-agnostically so we never re-propose something the user already kept.
  const seen = new Set<string>(existing.map((m) => memoryDedupeKey({ kind: m.kind, text: m.text })));
  const out: MemoryCandidate[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { kind?: unknown; text?: unknown };
    const kind: MemoryKind = MEMORY_KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : 'fact';
    const { text } = normalizeMemoryText(typeof o.text === 'string' ? o.text : '');
    if (!text) continue;
    const key = memoryDedupeKey({ kind, text });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, text });
    if (out.length >= limit) break;
  }
  return out;
}
