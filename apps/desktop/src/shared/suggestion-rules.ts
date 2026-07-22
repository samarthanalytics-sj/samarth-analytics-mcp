// Letting what the user told the CHAT change what the SCAN proposes.
//
// Saved memories were read by the chat and by nothing else, so a correction had to be repeated on
// every scan: "we use order_completed, not purchase" was honoured in conversation and then the tag
// suggestions proposed `purchase` again, forever.
//
// This turns the small, unambiguous subset of those notes into scan rules. The parsing posture is
// FAIL-CLOSED: only phrasings that state their direction outright are read, and anything else is
// ignored entirely. A note this cannot parse changes nothing, which is the right failure - guessing
// at "purchase = order_completed" (which side is which?) would silently rename the wrong event.
//
// Every rule that fires is REPORTED back with the tag it touched and the note it came from. A rule
// that quietly reshapes a scan would be worse than no rule at all: the operator would have no way to
// tell a missing suggestion from a suppressed one.
//
// PURE. The caller reads the memory store and applies the result.

/** The rules a scan can honour, distilled from saved notes. */
export interface SuggestionRules {
  /** Event-name replacements: propose `to` wherever the engine would have proposed `from`. */
  renames: Array<{ from: string; to: string; source: string }>;
  /** Topics never to propose again for this client. */
  suppress: Array<{ phrase: string; terms: string[]; source: string }>;
}

/** A saved note, reduced to what this needs. */
export interface RuleMemory {
  kind: string;
  text: string;
  enabled?: boolean;
}

/** An event name as GA4 spells one: lower snake_case, long enough not to be prose. */
const EVENT = '[a-z][a-z0-9_]{2,}';
const isEventName = (s: string): boolean => new RegExp(`^${EVENT}$`).test(s);

/**
 * Direction-explicit rename phrasings ONLY. Each capture pair is (to, from): the wanted name first,
 * the rejected one second, which is the order every one of these reads in English.
 *
 * Deliberately absent: "a = b" and "a -> b". Neither states which side wins, and a coin-flip here
 * renames the user's events the wrong way round.
 */
const RENAME_PATTERNS: RegExp[] = [
  new RegExp(`\\buse\\s+(${EVENT})\\s+(?:instead of|rather than|and not|not|never)\\s+(${EVENT})`, 'i'),
  new RegExp(`\\b(${EVENT})\\s*,\\s*(?:not|never|instead of)\\s+(${EVENT})`, 'i'),
  new RegExp(`\\buse\\s+(${EVENT})\\s+for\\s+(${EVENT})`, 'i'),
  new RegExp(`\\b(${EVENT})\\s+replaces\\s+(${EVENT})`, 'i'),
];

/** Words that carry no distinguishing meaning in "stop suggesting X". */
const GENERIC = new Set([
  'tag', 'tags', 'tagging', 'track', 'tracks', 'tracking', 'event', 'events', 'again', 'anymore',
  'any', 'more', 'this', 'that', 'these', 'those', 'client', 'site', 'website', 'page', 'pages',
  'for', 'the', 'a', 'an', 'and', 'or', 'please', 'ever', 'me', 'us', 'it', 'them', 'ga4', 'gtm',
  'than', 'then', 'with', 'without', 'from', 'into', 'than',
]);

/** Two shapes, both unambiguous. Unlike a rename there is no direction to get wrong here, so the
 *  bare-noun form ("no more video tracking tags") is safe to read as well as the verb form. */
const SUPPRESS_PATTERNS: RegExp[] = [
  /(?:do\s*n[o']?t|don't|never|stop|no more)\s+(?:suggest|suggesting|propose|proposing|recommend|recommending|create|creating|add|adding)\s+(.{3,80})/i,
  /\bno more\s+(.{3,80})/i,
];

/** Significant words of a phrase: 4+ chars and not generic filler. */
export function distinctiveTerms(phrase: string): string[] {
  return [...new Set(
    String(phrase ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !GENERIC.has(w)),
  )];
}

/**
 * Read scan rules out of saved notes.
 *
 * Only `rule`, `preference` and `glossary` notes are considered: `fact` and `decision` record what IS,
 * not what to do, and acting on them would turn an observation into an instruction. Muted notes are
 * skipped, exactly as the chat skips them.
 */
export function deriveSuggestionRules(memories: readonly RuleMemory[]): SuggestionRules {
  const renames: SuggestionRules['renames'] = [];
  const suppress: SuggestionRules['suppress'] = [];
  const seenRename = new Set<string>();
  const seenSuppress = new Set<string>();

  for (const m of memories ?? []) {
    if (!m || m.enabled === false) continue;
    if (!['rule', 'preference', 'glossary'].includes(String(m.kind))) continue;
    const text = String(m.text ?? '');

    for (const re of RENAME_PATTERNS) {
      const hit = re.exec(text);
      if (!hit) continue;
      const to = hit[1].toLowerCase();
      const from = hit[2].toLowerCase();
      if (!isEventName(to) || !isEventName(from) || to === from) break;
      if (seenRename.has(from)) break; // first note wins; a later contradiction must not flip it
      seenRename.add(from);
      renames.push({ from, to, source: text });
      break; // one rename per note
    }

    const sup = SUPPRESS_PATTERNS.map((re) => re.exec(text)).find(Boolean);
    if (sup) {
      const phrase = sup[1].replace(/[.!,;]+\s*$/, '').trim();
      const terms = distinctiveTerms(phrase);
      if (terms.length && !seenSuppress.has(terms.join('|'))) {
        seenSuppress.add(terms.join('|'));
        suppress.push({ phrase, terms, source: text });
      }
    }
  }
  return { renames, suppress };
}

/** The suggestion fields these rules read and write. */
export interface RuleSuggestion {
  id: string;
  tagName: string;
  eventName?: string;
  label?: string;
}

export interface AppliedRules<T> {
  suggestions: T[];
  renamed: Array<{ id: string; tagName: string; from: string; to: string; source: string }>;
  dropped: Array<{ id: string; tagName: string; phrase: string; source: string }>;
}

/** "order_completed" -> "Order Completed", so a renamed event can be reflected in the tag name. */
const humanize = (event: string): string =>
  event.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Apply the rules to a scan's suggestions.
 *
 * A rename rewrites the event name AND the matching words in the tag name, so a row never ends up
 * named for one event while sending another. Suppression drops the row entirely. Both are returned in
 * full so the caller can tell the operator exactly what changed and which note caused it.
 */
export function applySuggestionRules<T extends RuleSuggestion>(
  suggestions: readonly T[],
  rules: SuggestionRules,
): AppliedRules<T> {
  const renamed: AppliedRules<T>['renamed'] = [];
  const dropped: AppliedRules<T>['dropped'] = [];
  const out: T[] = [];

  for (const s of suggestions ?? []) {
    if (!s) continue;
    const hay = `${s.eventName ?? ''} ${s.tagName ?? ''} ${s.label ?? ''}`.toLowerCase();
    const hit = (rules.suppress ?? []).find((r) => r.terms.some((t) => hay.includes(t)));
    if (hit) {
      dropped.push({ id: s.id, tagName: s.tagName, phrase: hit.phrase, source: hit.source });
      continue;
    }

    const ren = (rules.renames ?? []).find((r) => (s.eventName ?? '').toLowerCase() === r.from);
    if (!ren) { out.push(s); continue; }
    // Keep the tag name honest about what the tag now sends.
    const tagName = String(s.tagName ?? '').replace(new RegExp(escapeRe(humanize(ren.from)), 'gi'), humanize(ren.to));
    out.push({ ...s, eventName: ren.to, tagName });
    renamed.push({ id: s.id, tagName, from: ren.from, to: ren.to, source: ren.source });
  }
  return { suggestions: out, renamed, dropped };
}

/** One line per rule that fired, for the scan's warnings list. Empty when nothing changed. */
export function describeAppliedRules(applied: AppliedRules<RuleSuggestion>): string[] {
  const out: string[] = [];
  for (const r of applied.renamed) {
    out.push(`Saved rule applied: "${r.tagName}" now sends ${r.to} instead of ${r.from} (from your note: "${trim(r.source)}").`);
  }
  const byPhrase = new Map<string, { phrase: string; source: string; tags: string[] }>();
  for (const d of applied.dropped) {
    const e = byPhrase.get(d.phrase) ?? { phrase: d.phrase, source: d.source, tags: [] };
    e.tags.push(d.tagName);
    byPhrase.set(d.phrase, e);
  }
  for (const e of byPhrase.values()) {
    out.push(
      `Saved rule applied: ${e.tags.length} suggestion(s) hidden because you asked not to suggest "${e.phrase}" `
      + `(${e.tags.slice(0, 3).join(', ')}${e.tags.length > 3 ? `, +${e.tags.length - 3} more` : ''}). `
      + 'Remove that note in Settings > Memory to see them again.',
    );
  }
  return out;
}

const trim = (s: string): string => (s.length > 90 ? `${s.slice(0, 90)}...` : s);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
