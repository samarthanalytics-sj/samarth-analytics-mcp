// Pure SPLIT logic for the tag-review panel: turn ONE tag that covers several pages through a
// {{Page Path}} RegEx alternation (^(/demo|/get-started|...)/?$) into one tag PER page. It is the
// exact inverse of tag-merge.ts (which replaces N rows with 1), and the renderer drives it through
// the same setSuggestions path, so selection migrates and stale inline edits drop.
//
// Why this is a POST-SCAN, per-row choice and not a scan option: the crawl is the expensive part and
// everything a split needs is already in the row, and "common versus separate" is a per-form
// decision. A footer newsletter on 40 pages should stay one tag; a demo form on 7 landing pages
// usually should not.
//
// Framework free (imports only the view type), so the renderer uses it and tsx unit-tests it.

import type { SuggestedTagView } from './ipc';

/** Only a form-shaped trigger is split. A pageview/click trigger's page RegEx is part of how it
 *  identifies the thing it tracks, not a "which pages does this form live on" list. */
const SPLITTABLE_KINDS = new Set(['form_submit', 'custom_event']);

/** Below 2 there is nothing to split. Above 25 the user is looking at a site-wide form (a footer
 *  newsletter), where 26+ near-identical tags is a worse container than one common tag. */
export const MIN_SPLIT_PAGES = 2;
export const MAX_SPLIT_PAGES = 25;

/** The engine writes exactly this shape: ^(<escaped path>|<escaped path>|...)/?$ */
const ANCHORED_ALTERNATION = /^\^\((.+)\)\/\?\$$/;
/** Regex metacharacters that, unescaped inside a member, mean the member is a PATTERN and not a
 *  literal page path. `-` and `/` are deliberately absent: both are literal in this position. */
const RE_META = '.*+?^${}()[]';

/** Unicode dashes folded out of every string this module emits: the repo forbids an em dash at every
 *  output boundary (chat, UI, PDF/CSV/MD/XLSX/DOC), and a tag name is one. A plain hyphen-minus is
 *  untouched, so the " - " separators in GTM names survive. */
const noDashes = (v: string): string => v.replace(/\s*[\u2010-\u2015\u2212]\s*/g, ', ');

const cap = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** Dedup key mirroring shared/tag-template.ts suggestionDedupKey's name normalization (alphanumeric
 *  runs collapsed to single spaces). Re-implemented rather than imported so this module keeps its
 *  single ./ipc dependency; the tests assert the two agree by running the real dedupe. */
const nameKey = (v: string): string => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Escapes a literal path for display inside a suggested RegEx in the note. */
const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The alternation body split on UNESCAPED "|", each member unescaped back to its literal text.
 * Returns null when any member carries an unescaped regex metacharacter: a wildcard member such as
 * `/blog/.*` is a pattern, not a page, and an "equals" row built from it could never fire.
 */
function literalAlternationMembers(body: string): string[] | null {
  const members: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === undefined) return null; // trailing backslash: not something to reason about
      cur += next;
      i += 1;
      continue;
    }
    if (ch === '|') {
      members.push(cur);
      cur = '';
      continue;
    }
    if (RE_META.includes(ch)) return null;
    cur += ch;
  }
  members.push(cur);
  return members;
}

/**
 * The page paths a row can be split across, in their regex order, or [] when the row is not a
 * multi-page form tag. Empty means "offer nothing": a row that cannot be split cleanly keeps the
 * scope it already has, because a trigger that fires too widely is recoverable and one that never
 * fires is not.
 */
export function splittableFormPages(s: SuggestedTagView): string[] {
  const t = s.trigger;
  if (!SPLITTABLE_KINDS.has(t.kind)) return [];
  if (t.pagePathOperator !== 'matchRegex') return [];
  if (!t.pagePathValue) return [];
  // A site-search suggestion scopes on {{Page URL}} (e.g. contains "?s="). Its identity is the query
  // string, not the page list, so never restructure a {{Page URL}}-scoped row.
  if (t.pageUrlValue) return [];
  const m = ANCHORED_ALTERNATION.exec(t.pagePathValue);
  if (!m) return [];
  const raw = literalAlternationMembers(m[1]);
  if (!raw) return [];
  const pages: string[] = [];
  for (const p of raw) {
    // Anything that is not a plain absolute path means this RegEx was not built by the page-list
    // path: leave it alone rather than guess.
    if (!p.startsWith('/') || /\s/.test(p)) return [];
    if (!pages.includes(p)) pages.push(p);
  }
  if (pages.length < MIN_SPLIT_PAGES || pages.length > MAX_SPLIT_PAGES) return [];
  return pages;
}

/**
 * A page path as a readable name fragment: "/get-started" gives "Get Started", "/" gives "Home",
 * "/demo/request-a-demo" gives "Demo Request A Demo". Deterministic for the same path.
 */
export function pageTagLabel(page: string): string {
  const words = noDashes(page)
    .replace(/[/\-_+.,]+/g, ' ')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(cap);
  return words.length ? words.join(' ') : 'Home';
}

/**
 * One readable label per page, guaranteed distinct under the review table's dedup normalization
 * (which folds every non-alphanumeric run to a space, so "/get-started" and "/get_started" would
 * otherwise collapse onto one row). A collision gets a numeric suffix. Stable for the same input
 * list in the same order.
 */
function distinctPageLabels(pages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  pages.forEach((p, i) => {
    const base = pageTagLabel(p);
    let candidate = base;
    let n = i + 1;
    while (seen.has(nameKey(candidate))) {
      candidate = `${base} ${n}`;
      n += 1;
    }
    seen.add(nameKey(candidate));
    out.push(candidate);
  });
  return out;
}

/** A page path as an id fragment. The row index is carried alongside it, so two paths that slug the
 *  same still get distinct ids. */
const slugOf = (page: string): string =>
  page.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._~-]+/g, '-').toLowerCase() || 'home';

/**
 * One row per page: the same tag, each scoped to a SINGLE page via {{Page Path}} equals, with a
 * distinct id, a distinct GTM tag name, and a distinct trigger name.
 *
 * The names must all differ: GTM tag names are unique per container, the review table dedupes on
 * platform + event + normalized tag name, and the create flow reuses TRIGGERS by name, so a shared
 * trigger name would wire all N tags to whichever page's trigger was created first.
 *
 * Returns [the original row] unchanged when there is nothing to split, so a caller replacing rows
 * can never drop a suggestion.
 */
export function splitFormByPage(s: SuggestedTagView, pages: string[]): SuggestedTagView[] {
  const clean = pages.filter((p, i) => !!p && pages.indexOf(p) === i);
  if (clean.length < MIN_SPLIT_PAGES) return [s];
  const labels = distinctPageLabels(clean);
  const baseTag = noDashes(s.tagName).replace(/\s*\bTag\s*$/i, '').trim() || noDashes(s.tagName).trim();
  const baseTrigger =
    noDashes(s.trigger.name).replace(/\s*\bTrigger\s*$/i, '').trim() || noDashes(s.trigger.name).trim();
  // The row's own label usually announces the page count ("... (7 pages)"), which stops being true
  // the moment it is split.
  const baseLabel = noDashes(s.label).replace(/\s*\(\s*\d+\s+pages?\s*\)/i, '').trim();
  const carried = s.note ? ` Original note: ${noDashes(s.note)}` : '';
  return clean.map((page, i) => {
    const label = labels[i];
    const row: SuggestedTagView = {
      ...s,
      id: `${s.id}:split:${i}:${slugOf(page)}`,
      page,
      label: noDashes(`${baseLabel} (${page})`).trim(),
      evidence: noDashes(
        `split from one tag covering ${clean.length} pages: this row fires only on ${page} ({{Page Path}} equals "${page}")`,
      ),
      note: noDashes(
        `Scoped to ${page} alone. If the site also serves this path with a trailing slash or a locale prefix, an "equals" test will not match it: change this row's condition to "matches RegEx" with ^${escRe(page)}/?$ before creating.${carried}`,
      ),
      tagName: `${baseTag} - ${label} Tag`,
      trigger: {
        ...s.trigger,
        name: `${baseTrigger} - ${label} Trigger`,
        pagePathValue: page,
        pagePathOperator: 'equals',
      },
    };
    // The proof screenshot belongs to ONE page. Carrying it onto every split row would show the user
    // evidence from a different page than the row claims to track.
    if (row.screenshot && s.page !== page) delete row.screenshot;
    return row;
  });
}
