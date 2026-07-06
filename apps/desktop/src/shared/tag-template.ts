// Render/export the suggested GA4 tags in the "Template 1 - GTM Structure - GA4
// Events" layout: one BLOCK per tag — tag + trigger fields on the block's first
// row, then one row per event parameter (and per trigger condition). Pure, so the
// renderer table view and the CSV download share exactly one source of truth.

import type { SuggestedTagView } from './ipc';

/** The template's columns, in order. */
export const TEMPLATE_HEADERS = [
  'Tag Type',
  'GTM Tag Name',
  'GA4 Event Name',
  'Parameters',
  'Parameter Variable',
  'Trigger Name',
  'Trigger Type',
  'Trigger when - Variable',
  'Trigger when - Condition',
  'Trigger when - Value',
] as const;

// Our trigger.kind → the template's "Trigger Type" wording.
const TRIGGER_TYPE: Record<string, string> = {
  link_click: 'Click - Just Links',
  all_clicks: 'Click - All Elements',
  form_submit: 'Form Submission',
  custom_event: 'Custom Event',
  pageview: 'Page View',
  youtube_video: 'YouTube Video',
};

// Our filter-operator TOKEN → the exact GTM UI "Condition" label (so the review-table dropdown reads
// identically to GTM's trigger-condition menu). Negated operators are distinct tokens; the two
// "(ignore case)" RegEx variants are the base label + a suffix that triggerWhens appends when ignoreCase.
const CONDITION: Record<string, string> = {
  equals: 'equals',
  notEquals: 'does not equal',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  notStartsWith: 'does not start with',
  endsWith: 'ends with',
  notEndsWith: 'does not end with',
  cssSelector: 'matches CSS selector',
  notCssSelector: 'does not match CSS selector',
  matchRegex: 'matches RegEx',
  notMatchRegex: 'does not match RegEx',
  less: 'less than',
  lessOrEquals: 'less than or equal to',
  greater: 'greater than',
  greaterOrEquals: 'greater than or equal to',
};

export interface TriggerWhen {
  variable: string;
  condition: string;
  value: string;
}

/** The trigger's filter, as 0..n "fires when …" conditions (one per row). A
 *  built-in trigger with no filter (e.g. YouTube Video) yields none. */
export function triggerWhens(s: SuggestedTagView): TriggerWhen[] {
  const t = s.trigger;
  const cond = (op: string | undefined, fallback: string): string => CONDITION[op ?? fallback] ?? op ?? fallback;
  const out: TriggerWhen[] = [];
  if (t.clickUrlValue) out.push({ variable: '{{Click URL}}', condition: cond(t.clickUrlOperator, 'contains') + (t.clickUrlIgnoreCase ? ' (ignore case)' : ''), value: t.clickUrlValue });
  if (t.clickTextValue) out.push({ variable: '{{Click Text}}', condition: cond(t.clickTextOperator, 'contains') + (t.clickTextIgnoreCase ? ' (ignore case)' : ''), value: t.clickTextValue });
  if (t.clickElementValue) out.push({ variable: '{{Click Element}}', condition: cond(t.clickElementOperator, 'cssSelector'), value: t.clickElementValue });
  // Lookup-table grouping: the trigger reads the companion smm variable ({{Click Text}} → true rows).
  if (t.lookupTable?.name) out.push({ variable: `{{${t.lookupTable.name}}}`, condition: 'equals', value: 'true' });
  if (t.formIdValue) out.push({ variable: '{{Form ID}}', condition: cond(t.formIdOperator, 'equals'), value: t.formIdValue });
  if (t.formClassesValue) out.push({ variable: '{{Form Classes}}', condition: cond(t.formClassesOperator, 'contains'), value: t.formClassesValue });
  if (t.pagePathValue) out.push({ variable: '{{Page Path}}', condition: cond(t.pagePathOperator, 'equals'), value: t.pagePathValue });
  if (t.pageUrlValue) out.push({ variable: '{{Page URL}}', condition: cond(t.pageUrlOperator, 'contains'), value: t.pageUrlValue });
  return out;
}

export interface TemplateGroup {
  tagType: string;
  tagName: string;
  eventName: string;
  triggerName: string;
  triggerType: string;
  params: Array<{ name: string; variable: string }>;
  whens: TriggerWhen[];
  /** Rows this block spans = max(params, conditions, 1). */
  rowCount: number;
}

// Our platform → the template's "Tag Type" wording. meta_pixel shows its Meta event + pixel id like a
// GA4 event tag (eventName column = the Meta event, params = Object Properties).
const TAG_TYPE: Record<string, string> = {
  google_tag: 'Google Tag',
  meta_pixel: 'Meta Pixel Tag',
  ga4_event: 'GA4 Event Tag',
  tiktok_pixel: 'TikTok Pixel Tag',
  linkedin_insight: 'LinkedIn Insight Tag',
  reddit_pixel: 'Reddit Pixel Tag',
  pinterest_tag: 'Pinterest Tag',
  google_ads_conversion: 'Google Ads Conversion',
  conversion_linker: 'Conversion Linker',
  google_ads_remarketing: 'Google Ads Remarketing',
};

/** One suggestion → its template block (the structure both the table + CSV use). */
export function suggestionToGroup(s: SuggestedTagView): TemplateGroup {
  const params = s.platform === 'google_tag'
    ? (s.configSettings ?? []).map((p) => ({ name: p.name, variable: p.value }))
    : (s.eventParameters ?? []).map((p) => ({ name: p.name, variable: p.value }));
  const whens = triggerWhens(s);
  return {
    tagType: TAG_TYPE[s.platform] ?? 'GA4 Event Tag',
    tagName: s.tagName,
    eventName: s.eventName,
    triggerName: s.trigger.name,
    triggerType: TRIGGER_TYPE[s.trigger.kind] ?? s.trigger.kind,
    params,
    whens,
    rowCount: Math.max(params.length, whens.length, 1),
  };
}

/* ─────────────── Inline editing (the review table writes edits through here) ─────────────── */

/** An inline edit overlaid on a suggestion. Every field the review table can edit lives here; a missing
 *  field means "unchanged". `params` / `whens` are FULL overrides of their projected rows (so a single
 *  edited cell stores the whole array). applyTagEdit merges this back into a real SuggestedTagView. */
export interface TagEdit {
  tagName?: string;
  eventName?: string;
  measurementId?: string;
  page?: string;
  platform?: SuggestedTagView['platform'];
  triggerName?: string;
  triggerKind?: string;
  /** Full override of the Parameters/Parameter-Variable rows ({name, variable}). */
  params?: Array<{ name: string; variable: string }>;
  /** Full override of the projected trigger "when" rows. Only for STANDARD-variable triggers — a
   *  lookup-table trigger can't be reversed losslessly, so the review table leaves its whens read-only. */
  whens?: TriggerWhen[];
}

/** The trigger variables the review table can reverse-map a "when" row onto (lookup tables excluded). */
export const STANDARD_TRIGGER_VARIABLES = [
  '{{Click URL}}', '{{Click Text}}', '{{Click Element}}', '{{Form ID}}', '{{Form Classes}}', '{{Page Path}}', '{{Page URL}}',
] as const;
/** The trigger-condition operators GTM offers, in its exact dropdown ORDER (the display side of the
 *  operator map, plus the two "(ignore case)" RegEx variants). Offered by the review table's Condition
 *  select so it reads identically to GTM's own menu. */
export const CONDITION_LABELS: string[] = [
  'equals', 'contains', 'starts with', 'ends with',
  'matches CSS selector', 'matches RegEx', 'matches RegEx (ignore case)',
  'does not equal', 'does not contain', 'does not start with', 'does not end with',
  'does not match CSS selector', 'does not match RegEx', 'does not match RegEx (ignore case)',
  'less than', 'less than or equal to', 'greater than', 'greater than or equal to',
];
/** {value, label} options for the editable Tag Type / Trigger Type selects. */
export const TAG_TYPE_OPTIONS = Object.entries(TAG_TYPE).map(([value, label]) => ({ value, label }));
export const TRIGGER_TYPE_OPTIONS = Object.entries(TRIGGER_TYPE).map(([value, label]) => ({ value, label }));

/** A projected condition label → our filter operator + whether it carried the "(ignore case)" suffix.
 *  The inverse of triggerWhens' CONDITION map; unknown labels fall back to 'equals' (never crashes). */
export function conditionToOperator(label: string): { op: string; ignoreCase: boolean } {
  const ignoreCase = /\(ignore case\)/i.test(label ?? '');
  const base = (label ?? '').replace(/\s*\(ignore case\)\s*/i, '').trim().toLowerCase();
  const map: Record<string, string> = {
    equals: 'equals', 'does not equal': 'notEquals',
    contains: 'contains', 'does not contain': 'notContains',
    'starts with': 'startsWith', 'does not start with': 'notStartsWith',
    'ends with': 'endsWith', 'does not end with': 'notEndsWith',
    'matches css selector': 'cssSelector', 'does not match css selector': 'notCssSelector',
    'matches regex': 'matchRegex', 'does not match regex': 'notMatchRegex',
    'less than': 'less', 'less than or equal to': 'lessOrEquals',
    'greater than': 'greater', 'greater than or equal to': 'greaterOrEquals',
    'equals to': 'equals', // legacy label (older exports) still maps correctly
  };
  return { op: map[base] ?? 'equals', ignoreCase };
}

/** Rebuild a trigger's STANDARD filter fields from edited "when" rows (the inverse of triggerWhens). All
 *  standard value/operator fields are cleared first, then each row is written to the field its variable
 *  names, so reordering / re-pointing a row moves its value with it. lookupTable is left untouched (the
 *  table never produces `whens` edits for a lookup-based trigger). PURE. */
export function applyWhensToTrigger(trigger: SuggestedTagView['trigger'], whens: TriggerWhen[]): SuggestedTagView['trigger'] {
  const t: SuggestedTagView['trigger'] = { ...trigger };
  t.clickUrlValue = undefined; t.clickUrlOperator = undefined; t.clickUrlIgnoreCase = undefined;
  t.clickTextValue = undefined; t.clickTextOperator = undefined; t.clickTextIgnoreCase = undefined;
  t.clickElementValue = undefined; t.clickElementOperator = undefined;
  t.formIdValue = undefined; t.formIdOperator = undefined;
  t.formClassesValue = undefined; t.formClassesOperator = undefined;
  t.pagePathValue = undefined; t.pagePathOperator = undefined;
  t.pageUrlValue = undefined; t.pageUrlOperator = undefined;
  for (const w of whens) {
    if (!w || w.value == null || String(w.value).trim() === '') continue; // a blank value drops the row
    const { op, ignoreCase } = conditionToOperator(w.condition);
    switch ((w.variable ?? '').trim()) {
      case '{{Click URL}}': t.clickUrlValue = w.value; t.clickUrlOperator = op; t.clickUrlIgnoreCase = ignoreCase; break;
      case '{{Click Text}}': t.clickTextValue = w.value; t.clickTextOperator = op; t.clickTextIgnoreCase = ignoreCase; break;
      case '{{Click Element}}': t.clickElementValue = w.value; t.clickElementOperator = op; break;
      case '{{Form ID}}': t.formIdValue = w.value; t.formIdOperator = op; break;
      case '{{Form Classes}}': t.formClassesValue = w.value; t.formClassesOperator = op; break;
      case '{{Page Path}}': t.pagePathValue = w.value; t.pagePathOperator = op; break;
      case '{{Page URL}}': t.pageUrlValue = w.value; t.pageUrlOperator = op; break;
      default: break; // unknown/lookup variable — ignore (lookup triggers aren't edited through here)
    }
  }
  return t;
}

/** Merge an inline edit back into a real SuggestedTagView (the effective tag the table shows + the create
 *  flow sends). Missing edit fields fall through to the original. PURE + used by the renderer's
 *  `effective()`. */
export function applyTagEdit(s: SuggestedTagView, e: TagEdit | undefined): SuggestedTagView {
  if (!e) return s;
  const platform = e.platform ?? s.platform;
  const platformChanged = e.platform !== undefined && e.platform !== s.platform;
  const next: SuggestedTagView = {
    ...s,
    tagName: e.tagName ?? s.tagName,
    eventName: e.eventName ?? s.eventName,
    measurementId: e.measurementId ?? s.measurementId,
    page: e.page ?? s.page,
    platform,
  };
  const t: SuggestedTagView['trigger'] = { ...s.trigger };
  if (e.triggerName !== undefined) t.name = e.triggerName;
  // A trigger KIND change strands the old kind's filter fields (a click trigger's builder ignores a
  // formId, etc.), which would silently create a fires-on-everything trigger — so clear the standard
  // filter fields when the kind changes and no explicit whens were given.
  const kindChanged = e.triggerKind !== undefined && e.triggerKind !== s.trigger.kind;
  if (e.triggerKind !== undefined) t.kind = e.triggerKind;
  next.trigger = e.whens !== undefined ? applyWhensToTrigger(t, e.whens) : kindChanged ? applyWhensToTrigger(t, []) : t;
  // Params follow the platform: an explicit edit wins; otherwise, on a platform switch, the existing rows
  // migrate to the NEW platform's field so they aren't orphaned. Blank-name rows are dropped HERE (create
  // correctness) — the editable table reads the raw overlay, so a mid-edit blank name never collapses its row.
  if (e.params !== undefined || platformChanged) {
    const src: Array<{ name: string; variable: string }> = e.params
      ?? (s.platform === 'google_tag' ? (s.configSettings ?? []) : (s.eventParameters ?? [])).map((r) => ({ name: r.name, variable: r.value }));
    const rows = src.filter((p) => p.name && p.name.trim() !== '').map((p) => ({ name: p.name, value: p.variable }));
    if (platform === 'google_tag') { next.configSettings = rows; next.eventParameters = []; }
    else { next.eventParameters = rows; next.configSettings = []; }
  }
  return next;
}

/** Collapse suggestions that would create the SAME GTM tag, keeping the FIRST. Identity is
 *  platform + tag NAME (trimmed, case-insensitive): GTM tag names must be unique, so two rows sharing
 *  a name can never both be created — showing the second is always noise, even if a trigger detail
 *  differs. The scan pipeline already dedups its FINAL result (scan-core dedupSuggestions), but the
 *  live-streamed running list is only key-deduped; applying the same name-dedup at every point the
 *  review list is set guarantees the table, the CSV export, and the create flow never show a visual
 *  duplicate — including mid-scan. Pure + idempotent. */
export function dedupeViewsByGtmName(list: SuggestedTagView[]): SuggestedTagView[] {
  const seen = new Set<string>();
  const out: SuggestedTagView[] = [];
  for (const s of list) {
    const k = `${s.platform}|${s.tagName.trim().toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

const escapeCsv = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The suggestions as a CSV string in the template's exact column + block layout
 *  (CRLF line endings + RFC-4180 quoting, so Excel/Sheets open it cleanly). */
export function suggestionsToTemplateCsv(suggestions: SuggestedTagView[]): string {
  const lines: string[] = [TEMPLATE_HEADERS.join(',')];
  for (const s of suggestions) {
    const g = suggestionToGroup(s);
    for (let i = 0; i < g.rowCount; i++) {
      const p = g.params[i];
      const w = g.whens[i];
      const first = i === 0;
      lines.push(
        [
          first ? g.tagType : '',
          first ? g.tagName : '',
          first ? g.eventName : '',
          p?.name ?? '',
          p?.variable ?? '',
          first ? g.triggerName : '',
          first ? g.triggerType : '',
          w?.variable ?? '',
          w?.condition ?? '',
          w?.value ?? '',
        ]
          .map(escapeCsv)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
