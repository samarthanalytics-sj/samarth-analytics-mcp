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
  /** The vendor filter that was actually applied (normalized), so an empty result is attributable. */
  brand?: string;
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

// A term matches a token exactly, or by prefix in EITHER direction so inflections match both ways:
// "purchase" finds `purchases_completed` AND "purchases" finds `purchase`. One-directional matching
// silently returned zero for every plural query ("clicks", "conversions"), which the tool then reports
// as "nothing in the library" - a confident false absence. The >= 4 floor keeps short fragments
// ("ga", "id") from matching half the corpus.
export const termHits = (term: string, tokens: Set<string>): boolean => {
  if (tokens.has(term)) return true;
  for (const tok of tokens) {
    if (term.length >= 4 && tok.length > term.length && tok.startsWith(term)) return true;
    if (tok.length >= 4 && term.length > tok.length && term.startsWith(tok)) return true;
  }
  return false;
};

const tokenSet = (parts: Array<string | undefined>): Set<string> => {
  const out = new Set<string>();
  for (const p of parts) for (const t of lookupTerms(p ?? '')) out.add(t);
  return out;
};

/** Locale-independent tiebreak so results are identical on every machine. */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// One decimal: with k = 2 and a ~500-container corpus, whole percents round 42% of the library to "0%"
// next to a non-zero container count, which reads as "never used".
const pct = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

// Strip em/en dashes: house style forbids them on every output surface, and GTM_TYPE_LABELS has some
// ("Click — Just Links").
const plain = (s: string): string => s.replace(/[—–]/g, '-');

/** The attribution line on every result. `total` is DISTINCT containers, matching what each hit counts. */
const sourceLine = (total: number, minedAt: string): string =>
  `${total} of your own historical GTM containers (anonymized pattern library, mined ${minedAt}). ` +
  'These are frequency counts of how YOUR containers were built, not industry benchmarks and not a correctness signal.';

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

/** Relevance bands are scaled so a stronger field always beats a weaker one; see `blend`. */
const BAND = 10;
/**
 * Final rank = relevance band + a bounded frequency bonus.
 *
 * Frequency used to be a pure tiebreak, which let a 2-container coincidence outrank a 121-container
 * pattern forever whenever it scored one band higher (the query "meta pixel" returned twelve
 * `formMetaData` variables and zero Meta tags). The bonus is log-scaled and capped BELOW one band, so
 * relevance still decides across bands while widely practiced shapes win inside a band.
 */
const blend = (score: number, containers: number): number =>
  score * BAND + Math.min(BAND - 1, Math.log2(Math.max(1, containers) + 1));

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

/** Vendor names people actually type, mapped to the library's brand keys. Without this, "facebook"
 *  returns an empty result the model reports as "no such pattern" while `meta` has hundreds. */
const BRAND_ALIASES: Record<string, string> = {
  facebook: 'meta', fb: 'meta', 'facebook pixel': 'meta', metapixel: 'meta',
  'google ads': 'gads', googleads: 'gads', google_ads: 'gads', adwords: 'gads', gads: 'gads',
  'microsoft ads': 'msads', bing: 'msads', uet: 'msads',
  google: 'googtag', gtag: 'googtag',
  analytics: 'ga4', 'google analytics': 'ga4',
  snapchat: 'snap', x: 'x', twitter: 'x',
  dv360: 'floodlight', 'campaign manager': 'floodlight', cm360: 'floodlight',
};
/** Normalize a caller-supplied vendor to a library brand key. */
export const normalizeBrand = (raw: string): string => {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return '';
  return BRAND_ALIASES[v] ?? v.replace(/[\s_-]+/g, '');
};

/**
 * Rank the library's patterns against a free-text query.
 *
 * Matching is token-based, so "form submit" finds `form_submit` and `formSubmission`. Terms that hit
 * the pattern's NAME (event name, key path, vendor) outrank terms that only hit its type, and those
 * outrank terms that only hit its parameter keys. Within a band, the more widely practiced shape wins
 * (see `blend`); the final tiebreak is codepoint order for machine-independent determinism.
 *
 * An empty query returns the most common patterns of the requested kind ("what do we usually do?").
 */
export function lookupCorpusPatterns(
  lib: PatternLibrary,
  opts: { query?: string; kind?: CorpusLookupKind; brand?: string; limit?: number } = {},
): CorpusLookupResult {
  const query = String(opts.query ?? '').trim();
  const kind: CorpusLookupKind = opts.kind ?? 'all';
  const brand = normalizeBrand(opts.brand ?? '');
  const limit = Math.min(LOOKUP_MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || LOOKUP_DEFAULT_LIMIT)));
  const terms = lookupTerms(query);
  const total = lib.containersScanned;

  // A query that survives trimming but tokenizes to nothing (CJK, "A/B", punctuation) must NOT fall
  // through to browse mode: that returned the ENTIRE library as if it all matched.
  if (query && !terms.length) {
    return {
      source: sourceLine(total, lib.minedAt),
      minedAt: lib.minedAt, containersScanned: total, minContainers: lib.minContainers,
      query, kind, ...(brand ? { brand } : {}), matched: 0, hits: [],
      note: 'The query contained no searchable term (at least two letters or digits), so nothing was searched. Ask for the term in English or retry with a different word; do not report this as "no such pattern".',
    };
  }

  const scored: Scored[] = [];
  const want = (k: CorpusKind): boolean => kind === 'all' || kind === k;
  // A brand filter is a TAG concept. In 'all' mode it suppresses trigger/variable noise, but when the
  // caller explicitly asked for triggers or variables, honouring it would return a guaranteed zero.
  const brandBlocksOtherKinds = kind === 'all' && !!brand;

  if (want('tag')) {
    for (const p of lib.tagPatterns) {
      if (brand && p.brand !== brand) continue;
      const score = scoreOf(terms, [
        // Vendor sits in the NAME band: "meta pixel" is a request for Meta tags, and at type-strength
        // it lost to any variable whose camelCase key path happened to contain "meta".
        { tokens: tokenSet([p.eventName, p.brand]), weight: 6 },
        { tokens: tokenSet([p.type, gtmTypeLabel(p.type)]), weight: 4 },
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
  if (want('trigger') && !brandBlocksOtherKinds) {
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
  if (want('variable') && !brandBlocksOtherKinds) {
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
    blend(b.score, b.hit.containers) - blend(a.score, a.hit.containers) ||
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
  // An empty result has three very different causes, and the model must not report a filter artefact
  // as "your containers never do this".
  const knownBrands = new Set<string>([...lib.vendorStats.map((v) => String(v.brand)), ...lib.tagPatterns.map((p) => String(p.brand))]);
  const note = ((): string | undefined => {
    if (!scored.length && !vendors) {
      if (brand && !knownBrands.has(brand)) {
        return `"${brand}" is not a vendor key in this library, so nothing was searched. Known keys: ${[...knownBrands].sort().join(', ')}. Retry with one of those; do not report this as a pattern the containers never use.`;
      }
      return 'No pattern in the library matched. Say so plainly instead of guessing a frequency.';
    }
    if (scored.length > hits.length) {
      // Ranking is relevance-first, so the returned slice is NOT the most frequent slice: a more widely
      // used pattern can sit outside it. Saying "most common" here would be a fabricated superlative.
      return terms.length
        ? `${scored.length} patterns matched; the ${hits.length} closest to the query are returned, ranked by relevance and NOT purely by frequency. A more widely used pattern may sit outside this list, so cite each hit's own container count rather than calling any of them the most common.`
        : `${scored.length} patterns matched; the ${hits.length} most common are returned.`;
    }
    return undefined;
  })();

  return {
    source: sourceLine(total, lib.minedAt),
    minedAt: lib.minedAt,
    containersScanned: total,
    minContainers: lib.minContainers,
    query,
    kind,
    ...(brand ? { brand } : {}),
    matched: scored.length,
    hits,
    ...(vendors ? { vendors } : {}),
    ...(note ? { note } : {}),
  };
}
