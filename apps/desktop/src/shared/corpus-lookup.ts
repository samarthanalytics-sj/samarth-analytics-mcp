// Retrieval over the mined GTM pattern library — the "R" in RAG for corpus knowledge.
//
// The library (shared/corpus/gtm-pattern-library.json, built by scripts/mine-corpus.ts) is an
// ANONYMIZED, k-anonymity-filtered digest of real GTM containers. It SHIPS with the app, so this
// retrieval works on every machine — the raw exports never leave the machine that mined them.
//
// This module is PURE: it takes a library + a query and ranks patterns. No I/O, no JSON import, no
// Node APIs, so it typechecks under both the main and renderer programs and tests run anywhere.
//
// Honesty rules baked into the output shape:
//   - Every hit carries the RAW counts it was mined with (containers / occurrences). Percentages are
//     derived from containersScanned and rounded — never invented, never extrapolated to "the industry".
//   - `source` states exactly what the numbers describe: the user's own historical containers.
//   - Frequency is NOT correctness. The caller-facing description says so; nothing here ranks a
//     pattern as "recommended".
import { gtmTypeLabel, type TagBrand } from './tag-brand';
import type { PatternLibrary, TagPattern, TriggerPattern, VariablePattern } from './corpus-patterns';

export type CorpusKind = 'tag' | 'trigger' | 'variable';
/** What to search. 'vendor' returns adoption stats instead of patterns. */
export type CorpusLookupKind = CorpusKind | 'vendor' | 'all';

export interface CorpusHit {
  kind: CorpusKind;
  /** Plain-English one-liner describing the pattern (no em dashes — house style). */
  pattern: string;
  /** Distinct containers this exact shape appears in. */
  containers: number;
  /** Total occurrences across the corpus (a container can hold several). */
  occurrences: number;
  /** containers as a whole percent of containersScanned. Derived, not fabricated. */
  containerShare: number;
  type: string;
  brand?: TagBrand;
  eventName?: string;
  consent?: string | null;
  triggerKinds?: string[];
  conditions?: string[];
  keyPath?: string;
  paramKeys?: string[];
}

export interface CorpusVendorHit {
  brand: TagBrand;
  containers: number;
  containerShare: number;
}

export interface CorpusLookupResult {
  /** Exactly what the counts describe, so the model can attribute them correctly. */
  source: string;
  minedAt: string;
  containersScanned: number;
  minContainers: number;
  query: string;
  kind: CorpusLookupKind;
  /** Total patterns that matched before the limit was applied. */
  matched: number;
  hits: CorpusHit[];
  vendors?: CorpusVendorHit[];
  note?: string;
}

export const LOOKUP_DEFAULT_LIMIT = 12;
export const LOOKUP_MAX_LIMIT = 50;

/** Split any identifier style into lowercase terms: "form_submit", "formSubmit", "Form Submit" → [form, submit]. */
export function lookupTerms(s: string): string[] {
  return String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// A term matches a token exactly, or is a >= 4-char prefix of it (purchase/purchases, form/forms).
const termHits = (term: string, tokens: Set<string>): boolean => {
  if (tokens.has(term)) return true;
  if (term.length < 4) return false;
  for (const tok of tokens) if (tok.length > term.length && tok.startsWith(term)) return true;
  return false;
};

const tokenSet = (parts: Array<string | undefined>): Set<string> => {
  const out = new Set<string>();
  for (const p of parts) for (const t of lookupTerms(p ?? '')) out.add(t);
  return out;
};

/** Locale-independent tiebreak so results are identical on every machine. */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pct = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 100) : 0);

// Strip em/en dashes: house style forbids them on every output surface, and GTM_TYPE_LABELS has some
// ("Click — Just Links").
const plain = (s: string): string => s.replace(/[—–]/g, '-');

/** Readable one-liner for a tag pattern. */
export function describeTag(p: TagPattern): string {
  const fires = p.triggerKinds.length ? `fired by ${p.triggerKinds.join(' + ')}` : 'no firing trigger';
  const ev = p.eventName ? ` sending "${p.eventName}"` : '';
  const consent = p.consent ? `, consent ${p.consent}` : '';
  return plain(`${gtmTypeLabel(p.type)} tag${ev}, ${fires}${consent}`);
}

/** Readable one-liner for a trigger pattern. */
export function describeTrigger(p: TriggerPattern): string {
  const ev = p.event ? ` on "${p.event}"` : '';
  const cond = p.conditions.length ? ` where ${p.conditions.join(' AND ')}` : ' (no conditions)';
  return plain(`${gtmTypeLabel(p.type)} trigger${ev}${cond}`);
}

/** Readable one-liner for a variable pattern. */
export function describeVariable(p: VariablePattern): string {
  const kp = p.keyPath ? ` "${p.keyPath}"` : '';
  return plain(`${gtmTypeLabel(p.type)} variable${kp}`);
}

interface Scored { hit: CorpusHit; score: number; key: string }

function scoreOf(terms: string[], weighted: Array<{ tokens: Set<string>; weight: number }>): number {
  if (!terms.length) return 1; // no query = browse mode, everything qualifies
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const g of weighted) if (termHits(term, g.tokens)) best = Math.max(best, g.weight);
    score += best;
  }
  return score;
}

/**
 * Rank the library's patterns against a free-text query.
 *
 * Matching is token-based, so "form submit" finds `form_submit` and `formSubmission`. Terms that hit
 * the pattern's NAME (event name / key path) outrank terms that only hit its type, and those outrank
 * terms that only hit its parameter keys. Ties break on container count, so the most widely practiced
 * shape surfaces first; the final tiebreak is codepoint order for machine-independent determinism.
 *
 * An empty query returns the most common patterns of the requested kind ("what do we usually do?").
 */
export function lookupCorpusPatterns(
  lib: PatternLibrary,
  opts: { query?: string; kind?: CorpusLookupKind; brand?: string; limit?: number } = {},
): CorpusLookupResult {
  const query = String(opts.query ?? '').trim();
  const kind: CorpusLookupKind = opts.kind ?? 'all';
  const brand = String(opts.brand ?? '').trim().toLowerCase();
  const limit = Math.min(LOOKUP_MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || LOOKUP_DEFAULT_LIMIT)));
  const terms = lookupTerms(query);
  const total = lib.containersScanned;

  const scored: Scored[] = [];
  const want = (k: CorpusKind): boolean => kind === 'all' || kind === k;

  if (want('tag')) {
    for (const p of lib.tagPatterns) {
      if (brand && p.brand !== brand) continue;
      const score = scoreOf(terms, [
        { tokens: tokenSet([p.eventName]), weight: 6 },
        { tokens: tokenSet([p.type, gtmTypeLabel(p.type), p.brand]), weight: 4 },
        { tokens: tokenSet([...p.triggerKinds, p.consent ?? '']), weight: 2 },
        { tokens: tokenSet(p.paramKeys), weight: 1 },
      ]);
      if (score <= 0) continue;
      scored.push({
        score,
        key: `tag|${p.type}|${p.eventName ?? ''}`,
        hit: {
          kind: 'tag',
          pattern: describeTag(p),
          containers: p.containers,
          occurrences: p.occurrences,
          containerShare: pct(p.containers, total),
          type: p.type,
          brand: p.brand,
          ...(p.eventName ? { eventName: p.eventName } : {}),
          consent: p.consent,
          triggerKinds: p.triggerKinds,
          paramKeys: p.paramKeys,
        },
      });
    }
  }
  if (want('trigger') && !brand) {
    for (const p of lib.triggerPatterns) {
      const score = scoreOf(terms, [
        { tokens: tokenSet([p.event]), weight: 6 },
        { tokens: tokenSet([p.type, gtmTypeLabel(p.type)]), weight: 4 },
        { tokens: tokenSet(p.conditions), weight: 2 },
      ]);
      if (score <= 0) continue;
      scored.push({
        score,
        key: `trigger|${p.type}|${p.event ?? ''}`,
        hit: {
          kind: 'trigger',
          pattern: describeTrigger(p),
          containers: p.containers,
          occurrences: p.occurrences,
          containerShare: pct(p.containers, total),
          type: p.type,
          ...(p.event ? { eventName: p.event } : {}),
          conditions: p.conditions,
        },
      });
    }
  }
  if (want('variable') && !brand) {
    for (const p of lib.variablePatterns) {
      const score = scoreOf(terms, [
        { tokens: tokenSet([p.keyPath]), weight: 6 },
        { tokens: tokenSet([p.type, gtmTypeLabel(p.type)]), weight: 4 },
        { tokens: tokenSet(p.paramKeys), weight: 1 },
      ]);
      if (score <= 0) continue;
      scored.push({
        score,
        key: `variable|${p.type}|${p.keyPath ?? ''}`,
        hit: {
          kind: 'variable',
          pattern: describeVariable(p),
          containers: p.containers,
          occurrences: p.occurrences,
          containerShare: pct(p.containers, total),
          type: p.type,
          ...(p.keyPath ? { keyPath: p.keyPath } : {}),
          paramKeys: p.paramKeys,
        },
      });
    }
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    b.hit.containers - a.hit.containers ||
    b.hit.occurrences - a.hit.occurrences ||
    byCodepoint(a.key, b.key) ||
    byCodepoint(a.hit.pattern, b.hit.pattern));

  // Vendor adoption: always for kind 'vendor', and in 'all' mode only when the query names a vendor
  // (otherwise every answer would drag along a 12-row table nobody asked for).
  let vendors: CorpusVendorHit[] | undefined;
  if (kind === 'vendor' || (kind === 'all' && terms.length > 0)) {
    const rows = lib.vendorStats
      .filter((v) => kind === 'vendor'
        ? (!brand || v.brand === brand)
        : terms.some((t) => termHits(t, tokenSet([v.brand]))))
      .map((v) => ({ brand: v.brand, containers: v.containers, containerShare: pct(v.containers, total) }));
    if (rows.length) vendors = rows;
  }

  const hits = scored.slice(0, limit).map((s) => s.hit);
  return {
    source: `${total} of your own historical GTM containers (anonymized pattern library, mined ${lib.minedAt}). ` +
      'These are frequency counts of how YOUR containers were built, not industry benchmarks and not a correctness signal.',
    minedAt: lib.minedAt,
    containersScanned: total,
    minContainers: lib.minContainers,
    query,
    kind,
    matched: scored.length,
    hits,
    ...(vendors ? { vendors } : {}),
    ...(scored.length === 0 && !vendors
      ? { note: 'No pattern in the library matched. Say so plainly instead of guessing a frequency.' }
      : scored.length > hits.length
        ? { note: `${scored.length} patterns matched; the ${hits.length} most common are returned.` }
        : {}),
  };
}
