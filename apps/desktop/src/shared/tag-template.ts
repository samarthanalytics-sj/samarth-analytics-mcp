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

/** A SuggestedTagView field a projected param row writes straight back to, instead of into the
 *  generic `params` overlay. Used by the Google Ads platforms, whose "parameters" ARE the tag's
 *  identity fields (buildGoogleAdsConversionTag emits exactly conversionId + conversionLabel). */
export type IdentityField = 'measurementId' | 'conversionLabel';

export interface TemplateGroup {
  tagType: string;
  tagName: string;
  eventName: string;
  triggerName: string;
  triggerType: string;
  /** `field` set = an identity row: its VALUE edits that SuggestedTagView field and its NAME is fixed. */
  params: Array<{ name: string; variable: string; field?: IdentityField }>;
  whens: TriggerWhen[];
  /** Rows this block spans = max(params, conditions, 1). */
  rowCount: number;
}

/** The Google Ads platforms carry their ids in dedicated fields rather than in eventParameters, so
 *  they project one identity row per field. Without this the review table shows them nowhere and the
 *  Conversion Label can only be typed through the chat approval card. conversion_linker has no ids. */
const ADS_IDENTITY: Partial<Record<SuggestedTagView['platform'], Array<{ name: string; field: IdentityField }>>> = {
  google_ads_conversion: [
    { name: 'Conversion ID', field: 'measurementId' },
    { name: 'Conversion Label', field: 'conversionLabel' },
  ],
  google_ads_remarketing: [{ name: 'Conversion ID', field: 'measurementId' }],
};

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
  const identity = ADS_IDENTITY[s.platform];
  const params: TemplateGroup['params'] = identity
    ? identity.map((r) => ({ name: r.name, variable: (r.field === 'conversionLabel' ? s.conversionLabel : s.measurementId) ?? '', field: r.field }))
    : s.platform === 'google_tag'
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
  /** Google Ads Conversion Label (platform 'google_ads_conversion'). Edited as an identity row. */
  conversionLabel?: string;
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
    conversionLabel: e.conversionLabel ?? s.conversionLabel,
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

/** The placeholder ids the suggestion engine seeds Google Ads rows with. NOTHING in the app ever
 *  creates them as GTM variables (planGoogleTagVars only provisions 'google_tag' rows), so a row still
 *  carrying one builds an awct tag that references a variable that does not exist. A user's OWN
 *  {{variable}} is left alone: it may be a real Constant they created in the container. */
const ADS_PLACEHOLDER_IDS = new Set(['{{Google Ads Conversion ID}}', '{{Google Ads Conversion Label}}']);

/** Variables the suggestion engine seeds on OTHER platforms. They ride across a Tag Type change
 *  (applyTagEdit carries measurementId over), so switching a GA4 row to "Google Ads Remarketing" would
 *  otherwise hand a G- measurement id to the Ads conversionId field with nothing objecting. */
const FOREIGN_ID_VARS = new Set([
  '{{GA4 Measurement ID}}', '{{Meta Pixel ID}}', '{{TikTok Pixel ID}}',
  '{{LinkedIn Partner ID}}', '{{Reddit Pixel ID}}', '{{Pinterest Tag ID}}',
]);

/** Is this value EXACTLY one {{variable}} reference? Anchored, and the name may not contain braces:
 *  a lazy `.+?` backtracks across the inner "}}" and so accepts "{{A}} {{B}}" as a single reference.
 *  A plain substring test is looser still, waving through "AW-{{suffix}}", "G-ABC123 {{x}}" and the
 *  whole "AW-123456789/{{Label}}" send_to string, all of which reach the awct template verbatim
 *  because normalizeAdsConversionId passes any braced value through untouched. */
const isVarRef = (v: string): boolean => /^\s*\{\{[^{}]+\}\}\s*$/.test(v);

/** Why an approved Google Ads row cannot be created yet, or null when it is ready. Blocks the two
 *  failures that otherwise reach GTM silently and report ok: an unresolved engine placeholder, and an
 *  empty Conversion Label (createSuggestedTags coerces a missing label to ''). Both produce a tag that
 *  can never fire, and the container audit's A8 rule does not catch them because it ORs id and label.
 *  PURE, so the review table and the create path share one definition of "ready". */
export function adsIdentityIssue(s: SuggestedTagView): string | null {
  if (s.platform !== 'google_ads_conversion' && s.platform !== 'google_ads_remarketing') return null;
  const id = (s.measurementId ?? '').trim();
  if (!id) return 'Conversion ID is empty. Copy it from Google Ads (Goals > Conversions > your action > Tag setup).';
  if (ADS_PLACEHOLDER_IDS.has(id)) return `Conversion ID is still the ${id} placeholder, and that variable does not exist. Paste the real Conversion ID.`;
  // Carried over from another platform by a Tag Type change: a GA4/Meta/TikTok id is not an Ads id.
  if (FOREIGN_ID_VARS.has(id)) return `Conversion ID is still ${id}, which belongs to a different platform. Use "Get from Google Ads", or paste the Conversion ID.`;
  // A user's OWN {{Constant}} is allowed through (it may genuinely hold the id), but ONLY when the value
  // is exactly one reference. Anything else must satisfy the literal format: a substring test here would
  // wave through "AW-{{suffix}}" and "G-ABC123 {{x}}", which reach the awct template verbatim.
  if (!isVarRef(id) && !/^(AW-)?\d{6,}$/i.test(id)) return `Conversion ID "${id}" is not a Google Ads conversion id (expected AW-123456789 or 123456789).`;
  if (s.platform === 'google_ads_remarketing') return null;
  const label = (s.conversionLabel ?? '').trim();
  if (!label) return 'Conversion Label is empty. Copy it from the same Tag setup panel in Google Ads.';
  if (ADS_PLACEHOLDER_IDS.has(label)) return `Conversion Label is still the ${label} placeholder, and that variable does not exist. Paste the real Conversion Label.`;
  if (!isVarRef(label) && /[\s/]/.test(label)) return `Conversion Label "${label}" looks wrong: paste only the label, not the whole AW-123456789/label string.`;
  return null;
}

/** Collapse suggestions that would create the SAME GTM tag, keeping the FIRST. Identity is
 *  platform + tag NAME (trimmed, case-insensitive): GTM tag names must be unique, so two rows sharing
 *  a name can never both be created — showing the second is always noise, even if a trigger detail
 *  differs. The scan pipeline already dedups its FINAL result (scan-core dedupSuggestions), but the
 *  live-streamed running list is only key-deduped; applying the same name-dedup at every point the
 *  review list is set guarantees the table, the CSV export, and the create flow never show a visual
 *  duplicate — including mid-scan. Pure + idempotent. */
/** Collapse-key for "show each GTM tag once". The tag NAME is normalized to alphanumeric words, so
 *  punctuation/whitespace variants of the SAME CTA — "Free Audit" / "Free-Audit" / "Free  Audit" /
 *  "Free—Audit" — collapse to ONE row (their names differ only by separators, but `.toLowerCase()`
 *  alone left those distinct). platform + eventName stay in the key so genuinely-different tags keep
 *  their own row ("Get a Free Audit" get_a_free_audit_click vs "Get Free Audit" get_free_audit_click).
 *  Used by BOTH the renderer net (below) and the main-process net (scan-core `dedupSuggestions`) — the
 *  two MUST agree or the mid-scan streamed list and the final list disagree and rows flicker. */
// The house tag-name shape is "<Vendor> - <Kind> - <Name> Tag" (e.g. "Google Ads - Conversion - Get A
// Free Consultation Form Tag"). Both ends are GTM bookkeeping; the middle is what a human would call
// the thing, which is exactly what a Google Ads conversion ACTION should be named.
const TAG_NAME_PREFIX = /^\s*(?:google\s*ads|ga4|meta|facebook|tiktok|linkedin|reddit|pinterest|snap|microsoft\s*ads|bing)\s*-\s*(?:conversion|remarketing|event|pixel|tag)\s*-\s*/i;
const TAG_NAME_SUFFIX = /\s*\bTag\s*$/i;

/**
 * The conversion-action name to suggest for a Google Ads row, derived from its GTM tag name.
 *
 * "Google Ads - Conversion - Get A Free Consultation Form Tag" -> "Get A Free Consultation Form".
 *
 * Only the vendor/kind prefix and the trailing "Tag" are removed: the kind word a human relies on
 * ("Form", "Click") is part of the name, and an internal " - " is preserved, so
 * "... - Book A Demo - EU Tag" keeps "Book A Demo - EU". Returns '' when nothing meaningful is left,
 * so the caller can fall back to its placeholder instead of proposing an empty name.
 */
export function conversionActionNameFromTag(tagName: string | undefined): string {
  return String(tagName ?? '')
    .replace(TAG_NAME_PREFIX, '')
    .replace(TAG_NAME_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function suggestionDedupKey(s: { platform: string; eventName?: string; tagName: string }): string {
  const alnum = (v: string): string => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${s.platform}|${(s.eventName ?? '').trim().toLowerCase()}|${alnum(s.tagName)}`;
}

export function dedupeViewsByGtmName(list: SuggestedTagView[]): SuggestedTagView[] {
  const seen = new Set<string>();
  const out: SuggestedTagView[] = [];
  for (const s of list) {
    const k = suggestionDedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

const escapeCsv = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The suggestions as a CSV string in the template's exact column + block layout
 *  (CRLF line endings + RFC-4180 quoting, so Excel/Sheets open it cleanly). */
/** Headers for the Excel export: the CSV's template columns with a leading "Page" so each tag's
 *  source page is visible in the sheet (the CSV omits it to stay a clean GTM-import template). */
export const TEMPLATE_HEADERS_XLSX = ['Page', ...TEMPLATE_HEADERS] as const;

/** The SAME rows the CSV builds (one tag → several rows for its params/whens), as a 2D string array
 *  with a leading Page cell on each tag's first row. Pure; used by the native .xlsx export so Excel and
 *  CSV never drift. */
export function suggestionsToTemplateRows(suggestions: SuggestedTagView[]): string[][] {
  const rows: string[][] = [];
  for (const s of suggestions) {
    const g = suggestionToGroup(s);
    for (let i = 0; i < g.rowCount; i++) {
      const p = g.params[i];
      const w = g.whens[i];
      const first = i === 0;
      rows.push([
        first ? (s.page ?? '') : '',
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
      ]);
    }
  }
  return rows;
}

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

/* ─────────────── Install runbook (client-ready Markdown of the whole scan) ─────────────── */

/** One "when" row as a human trigger-condition fragment, matching App.tsx's triggerCondition wording
 *  (`{{Variable}} <op> "value"`). Kept here so the runbook builder stays a pure, self-contained fn. */
const whenToText = (w: TriggerWhen): string => `${w.variable} ${w.condition} "${w.value}"`;

/** The full human trigger condition for a suggestion (mirrors App.tsx triggerCondition): the standard
 *  filter rows joined with " AND ", the shared-form dataLayer conditions as `{{dlv - <key>}} equals
 *  "<value>"`, and the built-in-trigger fallbacks ("fires on every click" / "…form submit" / YouTube).
 *  PURE — no DOM. */
export function triggerConditionText(s: SuggestedTagView): string {
  const t = s.trigger;
  const parts = triggerWhens(s).map(whenToText);
  // A custom_event's own event name is part of its condition (the CSV shows it via the trigger kind, but
  // the runbook spells it out so the developer sees the exact dataLayer event that must fire the tag).
  if (t.eventName) parts.push(`event = "${t.eventName}"`);
  // Shared form_submission tags key off extra dataLayer data — surface each as a {{dlv - key}} condition.
  for (const [k, v] of Object.entries(t.customEventData ?? {})) parts.push(`{{dlv - ${k}}} equals "${v}"`);
  if (parts.length === 0) {
    return t.kind === 'all_clicks' ? 'fires on every click'
      : t.kind === 'form_submit' ? 'fires on every form submit'
      : t.kind === 'youtube_video' ? 'fires on YouTube video start / progress (25/50/75/90%) / complete'
      : 'fires on its built-in trigger';
  }
  return parts.join(' AND ');
}

/** A fenced code block (```lang … ```), guaranteeing its own surrounding blank lines. */
const fence = (code: string, lang = ''): string => '```' + lang + '\n' + code.trim() + '\n```';

/** Render ONE install requirement as Markdown lines (the per-tag "Install:" body). */
function requirementMarkdown(r: NonNullable<SuggestedTagView['install']>['requires'][number]): string[] {
  switch (r.kind) {
    case 'native':
      return [`- Nothing to install: ${r.detail}`];
    case 'provider-native':
      return [`- Nothing to install (${r.provider}): ${r.detail}`];
    case 'listener-tag': {
      const scope = r.dlvScope ? ` (scopes via \`{{dlv - ${r.dlvScope.key}}}\` = "${r.dlvScope.value}")` : '';
      return [
        `- Create a Custom HTML tag "${r.tag.name}" on ${r.tag.fires}${scope}:`,
        '',
        fence(r.tag.html, 'html'),
        '',
        `  ${r.detail}`,
      ];
    }
    case 'html-attribute':
      return [`- Add \`${r.attribute}="${r.value}"\` to \`${r.selector}\`: ${r.detail}`];
    case 'site-code':
      return [
        `- Add to your site (${r.where}):`,
        '',
        fence(r.snippet),
        '',
        `  ${r.detail}`,
      ];
    default:
      return [];
  }
}

/** The one-glance status of an install plan, driving the review table's status chip.
 *  - `ready`     : nothing to install (all native / provider-native).
 *  - `ready-tip` : fires natively, but has ONE-OR-MORE optional improvements (an html-attribute, e.g.
 *                  "add a form id for precise scoping"). The tag still fires without them.
 *  - `listener`  : needs at least one Custom HTML listener tag created (1-click).
 *  - `code`      : needs site code the user's developer must add.
 *  Precedence for a mixed plan: code > listener > ready-tip > ready (the most-demanding ask wins the
 *  chip; the panel still lists every requirement). Counts let the chip say "2 listener tags", etc. */
export type InstallStatusKind = 'ready' | 'ready-tip' | 'listener' | 'code';
export interface InstallStatus {
  kind: InstallStatusKind;
  listenerCount: number;
  siteCodeCount: number;
  /** html-attribute requirements — always optional (the tag fires without them). */
  optionalCount: number;
}
export function installPlanStatus(install: SuggestedTagView['install'] | undefined): InstallStatus {
  let listenerCount = 0;
  let siteCodeCount = 0;
  let optionalCount = 0;
  for (const r of install?.requires ?? []) {
    if (r.kind === 'listener-tag') listenerCount += 1;
    else if (r.kind === 'site-code') siteCodeCount += 1;
    else if (r.kind === 'html-attribute') optionalCount += 1;
  }
  const kind: InstallStatusKind =
    siteCodeCount > 0 ? 'code' : listenerCount > 0 ? 'listener' : optionalCount > 0 ? 'ready-tip' : 'ready';
  return { kind, listenerCount, siteCodeCount, optionalCount };
}

/** Does this install plan ask the user to actually add or create something on their SITE?
 *  True for every status except `ready` (all native / provider-native → nothing to install).
 *  Single source of truth shared by the runbook's native-only categorisation and the desktop review
 *  table, which hides its "How to install" affordance when this is false. */
export function installPlanNeedsAction(install: SuggestedTagView['install'] | undefined): boolean {
  return installPlanStatus(install).kind !== 'ready';
}

/** Progress of an install plan against a per-requirement "done" set (keyed by the requirement's index in
 *  `requires`). A listener-tag is marked done when it is created/exists; site-code + optional (html-
 *  attribute) steps are checked off by the user. `required` = listener-tag + site-code (the steps that
 *  gate "done"); `optional` = html-attribute (nice-to-have, never blocks). Drives the review table's
 *  chip: it flips to a green "✓ Done" once every required step is done (and every optional too). Pure. */
export interface InstallProgress {
  kind: InstallStatusKind;
  requiredTotal: number;
  requiredDone: number;
  optionalTotal: number;
  optionalDone: number;
  /** requiredDone >= requiredTotal (vacuously true when there are no required steps). */
  allRequiredDone: boolean;
  /** every actionable step — required AND optional — is done. */
  fullyDone: boolean;
}
export function installPlanProgress(
  install: SuggestedTagView['install'] | undefined,
  done?: Record<number, boolean>,
): InstallProgress {
  let requiredTotal = 0;
  let requiredDone = 0;
  let optionalTotal = 0;
  let optionalDone = 0;
  (install?.requires ?? []).forEach((r, i) => {
    const isDone = done?.[i] === true;
    if (r.kind === 'listener-tag' || r.kind === 'site-code') {
      requiredTotal += 1;
      if (isDone) requiredDone += 1;
    } else if (r.kind === 'html-attribute') {
      optionalTotal += 1;
      if (isDone) optionalDone += 1;
    }
  });
  const allRequiredDone = requiredDone >= requiredTotal;
  return {
    kind: installPlanStatus(install).kind,
    requiredTotal,
    requiredDone,
    optionalTotal,
    optionalDone,
    allRequiredDone,
    fullyDone: allRequiredDone && optionalDone >= optionalTotal,
  };
}

/**
 * The WHOLE scan's measurement plan as a client-ready, GitHub-flavored Markdown "install runbook":
 * per tag the GTM tag/trigger/params to create PLUS the site-side install steps, and a consolidated
 * "what your developer must do" section (deduped listener tags / dataLayer events / HTML attributes).
 * PURE — no I/O, no Date (meta.scannedAt is passed in). The same suggestions the CSV export uses.
 */
export function suggestionsToInstallRunbookMarkdown(
  suggestions: SuggestedTagView[],
  meta?: { site?: string; scannedAt?: string },
): string {
  // Categorise each tag for the header counts + the "all native" shortcut.
  const reqsOf = (s: SuggestedTagView): NonNullable<SuggestedTagView['install']>['requires'] => s.install?.requires ?? [];
  // "Native-only" = no install plan, or every requirement is a "nothing to install" native/
  // provider-native one. The inverse of installPlanNeedsAction, kept as one shared rule.
  const isNativeOnly = (s: SuggestedTagView): boolean => !installPlanNeedsAction(s.install);
  const needsListener = (s: SuggestedTagView): boolean => reqsOf(s).some((r) => r.kind === 'listener-tag');
  const needsSiteCode = (s: SuggestedTagView): boolean => reqsOf(s).some((r) => r.kind === 'site-code');

  const total = suggestions.length;
  const nativeOnly = suggestions.filter(isNativeOnly).length;
  const withListener = suggestions.filter(needsListener).length;
  const withSiteCode = suggestions.filter(needsSiteCode).length;

  const out: string[] = [];

  // ── Title + subtitle ──────────────────────────────────────────────────────
  out.push('# Measurement Installation Runbook');
  const subParts: string[] = [];
  if (meta?.site) subParts.push(meta.site);
  if (meta?.scannedAt) subParts.push(`scanned ${meta.scannedAt}`);
  subParts.push(`${total} tag${total === 1 ? '' : 's'}`);
  subParts.push(`${nativeOnly} native-only`);
  subParts.push(`${withListener} need a listener tag`);
  subParts.push(`${withSiteCode} need site code`);
  out.push('');
  out.push(subParts.join(' · '));

  // ── Summary ───────────────────────────────────────────────────────────────
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`- Total tags to create: ${total}`);
  out.push(`- Native-only (no site work): ${nativeOnly}`);
  out.push(`- Need a listener tag in GTM: ${withListener}`);
  out.push(`- Need site-side code: ${withSiteCode}`);
  out.push('- Create these in GTM (draft), then complete the site-side steps, then Publish and Verify.');

  // ── Tags ──────────────────────────────────────────────────────────────────
  out.push('');
  out.push('## Tags');
  suggestions.forEach((s, i) => {
    const g = suggestionToGroup(s);
    out.push('');
    out.push(`### ${i + 1}. ${s.tagName || s.label}`);
    out.push('');
    out.push(`- Page: ${s.page}`);
    out.push(`- Platform: ${g.tagType}`);
    const keyParams = g.params.filter((p) => p.name).map((p) => `${p.name} = ${p.variable}`);
    const ev = g.eventName ? `GA4 event: ${g.eventName}` : 'GA4 event: (none)';
    out.push(`- ${ev}${keyParams.length ? ` (params: ${keyParams.join('; ')})` : ''}`);
    out.push(`- **Trigger:** ${g.triggerName} - ${g.triggerType} - ${triggerConditionText(s)}`);
    out.push('');
    out.push('**Install:**');
    out.push('');
    const reqs = reqsOf(s);
    if (reqs.length === 0) {
      out.push('- Install: native (nothing to install)');
    } else {
      for (const r of reqs) out.push(...requirementMarkdown(r));
    }
  });

  // ── Site-side work (consolidated, deduped) ────────────────────────────────
  // Deduped listener tags (by tag name), dataLayer events the site must push (by event name, from
  // site-code requirements), and HTML attributes (by selector|attribute|value).
  const listeners = new Map<string, { name: string; html: string }>();
  const events = new Map<string, { event: string; snippet: string }>();
  const attributes = new Map<string, string>();
  for (const s of suggestions) {
    for (const r of reqsOf(s)) {
      if (r.kind === 'listener-tag') {
        if (!listeners.has(r.tag.name)) listeners.set(r.tag.name, { name: r.tag.name, html: r.tag.html });
      } else if (r.kind === 'site-code') {
        // The dataLayer event a site-code snippet pushes is the tag's own custom_event trigger event
        // (or its GA4 event name) — that's the key the developer must emit. Fall back to the snippet
        // itself as the dedup key when no event name is knowable.
        const key = s.trigger.eventName?.trim() || s.eventName?.trim() || r.snippet;
        if (!events.has(key)) events.set(key, { event: key, snippet: r.snippet });
      } else if (r.kind === 'html-attribute') {
        const key = `${r.selector}|${r.attribute}|${r.value}`;
        if (!attributes.has(key)) attributes.set(key, `Add \`${r.attribute}="${r.value}"\` to \`${r.selector}\``);
      }
    }
  }

  out.push('');
  out.push('## Site-side work (for your developer)');
  if (listeners.size === 0 && events.size === 0 && attributes.size === 0) {
    out.push('');
    out.push("No site-side code needed - every tag fires on GTM's built-in triggers.");
    return out.join('\n') + '\n';
  }
  if (listeners.size > 0) {
    out.push('');
    out.push('### Listener tags to create in GTM');
    for (const l of listeners.values()) {
      out.push('');
      out.push(`- ${l.name}`);
      out.push('');
      out.push(fence(l.html, 'html'));
    }
  }
  if (events.size > 0) {
    out.push('');
    out.push('### dataLayer events your site must push');
    for (const e of events.values()) {
      out.push('');
      out.push(`- ${e.event}`);
      out.push('');
      out.push(fence(e.snippet));
    }
  }
  if (attributes.size > 0) {
    out.push('');
    out.push('### HTML attributes to add');
    for (const a of attributes.values()) out.push(`- ${a}`);
  }
  return out.join('\n') + '\n';
}
