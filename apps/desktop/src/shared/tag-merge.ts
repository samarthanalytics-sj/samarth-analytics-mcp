// Pure merge logic for the tag-review panel: detect suggestions that send the SAME GA4 event from
// distinct "{{Click Text}} equals <text>" triggers (e.g. "Learn More" vs "LEARN MORE"), and merge a
// confirmed group into ONE tag with a common name whose single trigger matches every variant via
// {{Click Text}} matchRegex "^(A|B|C)$" with GTM's condition-level ignore_case parameter ("matches
// RegEx (ignore case)" — the mechanism real containers use; gtm.js evaluates web matchRegex with the
// browser's JS RegExp, which CANNOT parse an inline (?i) flag). A Lookup Table variable is the other
// classic grouping route, but the regex needs no extra variable and stays editable in GTM.
// Framework-free so the renderer uses it and tsx unit-tests it.

import type { SuggestedTagView } from './ipc';

export interface MergeGroup {
  /** The shared GA4 event every member sends. */
  eventName: string;
  /** The trigger kind shared by the group (all_clicks / link_click). */
  kind: string;
  /** The member suggestions (>=2), in list order. */
  tags: SuggestedTagView[];
  /** The distinct click texts, verbatim. */
  texts: string[];
}

const CLICK_KINDS = new Set(['all_clicks', 'link_click']);

/** Only a PURE "{{Click Text}} equals <text>" click tag is mergeable — any other trigger scope
 *  (a URL/element/form/page condition) means the tags don't fire on the same shape of click. */
function isMergeable(s: SuggestedTagView): boolean {
  const t = s.trigger;
  return (
    s.platform === 'ga4_event' &&
    CLICK_KINDS.has(t.kind) &&
    !!t.clickTextValue &&
    (t.clickTextOperator ?? 'equals') === 'equals' &&
    !t.clickUrlValue &&
    !t.clickElementValue &&
    !t.formIdValue &&
    !t.formClassesValue &&
    !t.pagePathValue &&
    !t.pageUrlValue
  );
}

/** Groups of >=2 mergeable tags sending the same event from different click texts. */
export function findMergeGroups(suggestions: SuggestedTagView[]): MergeGroup[] {
  const byKey = new Map<string, SuggestedTagView[]>();
  for (const s of suggestions) {
    if (!isMergeable(s)) continue;
    const key = `${s.eventName}|${s.trigger.kind}`;
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  const groups: MergeGroup[] = [];
  for (const [key, tags] of byKey) {
    const texts = [...new Set(tags.map((s) => s.trigger.clickTextValue as string))];
    if (texts.length < 2) continue; // one distinct text — nothing to merge
    const sep = key.lastIndexOf('|');
    groups.push({ eventName: key.slice(0, sep), kind: key.slice(sep + 1), tags, texts });
  }
  return groups;
}

const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** The group's common human label, from the shared event: learn_more_click → "Learn More";
 *  file_download → "File Download". */
export function mergeLabel(eventName: string): string {
  return eventName.replace(/_click$/, '').split('_').filter(Boolean).map(cap).join(' ') || 'Merged';
}

/** One tag replacing the whole group: the common name + a single {{Click Text}} matchRegex trigger
 *  with ignore_case ON, so pure case variants fold to ONE alternative and any casing still fires;
 *  genuinely different texts stay as ^(A|B)$ alternatives, regex-escaped. The trigger is named
 *  "<Label> Variants Click Trigger" — deliberately DISTINCT from the per-variant "<Label> Click
 *  Trigger" convention, because the create flow reuses triggers by NAME and must never silently wire
 *  this tag to a pre-existing one-variant equals trigger. */
export function mergeGroup(g: MergeGroup): SuggestedTagView {
  const first = g.tags[0];
  const seen = new Set<string>();
  const folded: string[] = [];
  for (const t of g.texts) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      folded.push(t);
    }
  }
  const pattern = folded.length === 1 ? `^${esc(folded[0])}$` : `^(${folded.map(esc).join('|')})$`;
  const label = mergeLabel(g.eventName);
  const pages = new Set(g.tags.map((s) => s.page));
  return {
    ...first,
    id: `merged:${g.eventName}:${g.kind}`,
    page: pages.size === 1 ? first.page : 'site-wide',
    label: `"${label}" (${g.texts.length} variants) → GA4 "${g.eventName}"`,
    evidence: `merged ${g.texts.length} same-event tags: ${g.texts.map((t) => `"${t}"`).join(', ')}`,
    note: 'One tag for every variant — the trigger RegEx matches each listed text in any casing. Edit it to add or drop variants.',
    confidence: g.tags.some((s) => s.confidence === 'high') ? 'high' : g.tags.some((s) => s.confidence === 'medium') ? 'medium' : 'low',
    enhancedMeasurementOverlap: g.tags.some((s) => s.enhancedMeasurementOverlap),
    tagName: `GA4 - Event - ${label} Click Tag`,
    eventName: g.eventName,
    trigger: {
      name: `${label} Variants Click Trigger`,
      kind: first.trigger.kind,
      clickTextValue: pattern,
      clickTextOperator: 'matchRegex',
      clickTextIgnoreCase: true,
    },
  };
}
