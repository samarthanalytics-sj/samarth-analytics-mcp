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

// Our filter operator → the template's "Condition" wording.
const CONDITION: Record<string, string> = {
  equals: 'equals to',
  contains: 'Contains',
  startsWith: 'Starts with',
  endsWith: 'Ends with',
  matchRegex: 'matches RegEx',
  cssSelector: 'matches CSS selector',
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
  if (t.clickUrlValue) out.push({ variable: '{{Click URL}}', condition: cond(t.clickUrlOperator, 'contains'), value: t.clickUrlValue });
  if (t.clickTextValue) out.push({ variable: '{{Click Text}}', condition: cond(t.clickTextOperator, 'contains') + (t.clickTextIgnoreCase ? ' (ignore case)' : ''), value: t.clickTextValue });
  if (t.clickElementValue) out.push({ variable: '{{Click Element}}', condition: cond(t.clickElementOperator, 'cssSelector'), value: t.clickElementValue });
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

/** One suggestion → its template block (the structure both the table + CSV use). */
export function suggestionToGroup(s: SuggestedTagView): TemplateGroup {
  const params = s.platform === 'google_tag'
    ? (s.configSettings ?? []).map((p) => ({ name: p.name, variable: p.value }))
    : (s.eventParameters ?? []).map((p) => ({ name: p.name, variable: p.value }));
  const whens = triggerWhens(s);
  return {
    tagType: s.platform === 'google_tag' ? 'Google Tag' : 'GA4 Event Tag',
    tagName: s.tagName,
    eventName: s.eventName,
    triggerName: s.trigger.name,
    triggerType: TRIGGER_TYPE[s.trigger.kind] ?? s.trigger.kind,
    params,
    whens,
    rowCount: Math.max(params.length, whens.length, 1),
  };
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
