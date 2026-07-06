import { useEffect, useMemo, useRef, useState } from 'react';
import { applyTheme, loadTheme, saveTheme, type Theme } from './theme';
import type { AppInfo } from '../../preload';
import type {
  AccountView,
  AuditFindingView,
  AuditReportView,
  ChatTurn,
  CreateTagOutcome,
  DiscoverResult,
  Ga4MonitorRun,
  Ga4PropertyAuditResult,
  Ga4PropertyListItem,
  GoogleClientStatus,
  GtmAccountView,
  GtmContainerView,
  GtmContext,
  GtmWorkspaceView,
  LlmProvider,
  ProviderStatus,
  ScanProgressView,
  SecretSelfTest,
  ServerContainerResultView,
  SuggestPlatform,
  SuggestedTagView,
  TagScanResult,
} from '../../shared/ipc';
import { suggestionToGroup, suggestionsToTemplateCsv, dedupeViewsByGtmName, TEMPLATE_HEADERS, applyTagEdit, TAG_TYPE_OPTIONS, STANDARD_TRIGGER_VARIABLES, CONDITION_LABELS, type TagEdit, type TriggerWhen } from '../../shared/tag-template';
import { findMergeGroups, mergeGroup, mergeLabel, type MergeGroup } from '../../shared/tag-merge';
import { parseCsvUrls, parseCsvUrlStats, CSV_URL_CAP } from '../../shared/csv-urls';
import { execSummaryHtml } from '../../shared/ga4-exec-html';
import { stripDuplicateCharts } from '../../shared/ga4-visuals-html';
import { ga4SectionsHtml } from '../../shared/ga4-sections-html';
import { Ga4Charts } from './Ga4Charts';
import { Ga4MonitoringPanel } from './Ga4MonitoringPanel';
import { TagTypeIcon } from './TagTypeIcon';
import { gtmTypeLabel } from '../../shared/tag-brand';
import { auditToCsv, auditToMarkdown } from './audit-export';

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

// Sentinel value for the "Custom…" option in the model picker.
const CUSTOM_MODEL = '__custom__';

/** Curated model choices per provider for the Settings picker. The FIRST entry doubles as the sensible
 *  default. This list only saves users from typing exact ids — any model the provider accepts still
 *  works via "Custom…", so it never restricts what can run. Keep DEFAULT_MODEL pointing at a listed id. */
const MODEL_OPTIONS: Record<LlmProvider, Array<{ id: string; label: string }>> = {
  anthropic: [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (most capable)' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (balanced)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (cheaper)' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'o3', label: 'o3 (reasoning)' },
    { id: 'o4-mini', label: 'o4-mini (reasoning, cheaper)' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
};

type View = 'chat' | 'gtm' | 'ga4audit' | 'ga4monitoring' | 'prompts' | 'settings';
type GtmTab = 'suggestions' | 'audit' | 'server';

// GTM type labels + gtmTypeLabel now live in shared/tag-brand.ts (imported above) so the PDF export
// and this panel can't drift.

const OP_LABELS: Record<string, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matchRegex: 'matches regex',
  cssSelector: 'matches CSS selector',
  greater: '>',
  less: '<',
};

function gtmParam(node: Record<string, unknown> | undefined, key: string): string | undefined {
  const arr = (node?.parameter ?? []) as Array<{ key?: string; value?: string }>;
  return arr.find((p) => p.key === key)?.value;
}

function describeCondition(filter: unknown): string {
  const arr = Array.isArray(filter) ? filter : [];
  return arr
    .map((f: { type?: string; parameter?: Array<{ key?: string; value?: string }> }) => {
      const left = (f.parameter?.find((p) => p.key === 'arg0')?.value ?? '').replace(/^\{\{|\}\}$/g, '');
      const right = f.parameter?.find((p) => p.key === 'arg1')?.value ?? '';
      const op = OP_LABELS[f.type ?? ''] ?? f.type ?? '';
      return `${left} ${op} ${right}`.trim();
    })
    .filter(Boolean)
    .join(' AND ');
}

/* ── Editable approval fields ── */
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

function setParam(node: Record<string, unknown>, key: string, value: string): void {
  const arr = Array.isArray(node.parameter)
    ? (node.parameter as Array<Record<string, unknown>>)
    : ((node.parameter = []) as Array<Record<string, unknown>>);
  const existing = arr.find((p) => p.key === key);
  if (existing) existing.value = value;
  else arr.push({ type: 'template', key, value });
}

interface EditField {
  key: string;
  label: string;
  initial: string;
  apply: (d: Record<string, unknown>, v: string) => void;
}

/* Friendly labels for common tag parameter keys across platforms. */
const PARAM_LABELS: Record<string, string> = {
  eventName: 'Event name',
  measurementId: 'Measurement ID',
  measurementIdOverride: 'Measurement ID',
  conversionId: 'Conversion ID',
  conversionLabel: 'Conversion Label',
  conversionValue: 'Conversion value',
  currencyCode: 'Currency',
  orderId: 'Order ID',
  html: 'Custom HTML',
  trackingId: 'Tracking ID',
  pixelId: 'Pixel ID',
  partnerId: 'Partner ID',
};
function prettyParamLabel(key: string): string {
  return (
    PARAM_LABELS[key] ??
    key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()
  );
}

/* Editable fields for a proposed write — names, types, key config. Each apply()
   writes back into a (cloned) copy of the proposal args before it's sent. */
function buildEditFields(tool: string, details: Record<string, unknown>): EditField[] {
  const fields: EditField[] = [];
  if (tool === 'delete_gtm_tag') return fields; // delete isn't editable

  // Structured composite tag (flat fields + a nested trigger).
  if (tool === 'create_gtm_tracking_tag') {
    const flat = (key: string, label: string): void => {
      if (details[key] !== undefined) {
        fields.push({ key, label, initial: String(details[key] ?? ''), apply: (d, v) => { d[key] = v; } });
      }
    };
    flat('tagName', 'Tag name');
    flat('measurementId', 'Measurement ID');
    flat('eventName', 'Event name');
    flat('conversionId', 'Conversion ID');
    flat('conversionLabel', 'Conversion Label');
    flat('html', 'Custom HTML');
    const trig = asObj(details.trigger);
    if (trig.name !== undefined) fields.push({ key: 'trigName', label: 'Trigger name', initial: String(trig.name ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.name = v; d.trigger = t; } });
    if (trig.clickUrlValue !== undefined) fields.push({ key: 'trigCond', label: 'Click URL value', initial: String(trig.clickUrlValue ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.clickUrlValue = v; d.trigger = t; } });
    if (trig.clickElementValue !== undefined) fields.push({ key: 'trigCond', label: 'Click Element CSS selector', initial: String(trig.clickElementValue ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.clickElementValue = v; d.trigger = t; } });
    if (trig.eventName !== undefined) fields.push({ key: 'trigEvent', label: 'Trigger event name', initial: String(trig.eventName ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.eventName = v; d.trigger = t; } });
    return fields;
  }

  // Structured typed variable (flat fields).
  if (tool === 'create_gtm_variable_typed') {
    const flat = (key: string, label: string): void => {
      if (details[key] !== undefined) {
        fields.push({ key, label, initial: String(details[key] ?? ''), apply: (d, v) => { d[key] = v; } });
      }
    };
    flat('name', 'Variable name');
    flat('value', 'Value');
    flat('dataLayerName', 'Data layer name');
    flat('javascript', 'JavaScript');
    return fields;
  }

  const tag = asObj(details.tag);
  const trigger = asObj(details.trigger);
  const variable = asObj(details.variable);

  if (details.tag) {
    // Only surface fields the args actually carry. A partial update (e.g. just a
    // parameter change) has no name/type — showing a blank box and applying it would
    // BLANK the tag's real name on save. Guarded like the audit-fix path above.
    if (tag.name !== undefined) fields.push({ key: 'tagName', label: 'Tag name', initial: String(tag.name ?? ''), apply: (d, v) => { const t = asObj(d.tag); t.name = v; d.tag = t; } });
    if (tag.type !== undefined) fields.push({ key: 'tagType', label: 'Tag type (code)', initial: String(tag.type ?? ''), apply: (d, v) => { const t = asObj(d.tag); t.type = v; d.tag = t; } });
    // Surface every top-level template parameter, so each platform's config shows:
    // Google Ads (conversionId/conversionLabel), Facebook/LinkedIn (Custom HTML),
    // GA4 (eventName/measurementId), etc. List/map params (e.g. GA4 eventParameters)
    // are preserved untouched on the cloned args.
    const params = Array.isArray(tag.parameter) ? (tag.parameter as Array<Record<string, unknown>>) : [];
    for (const p of params) {
      if (p.type === 'template' && typeof p.key === 'string') {
        const key = p.key;
        fields.push({
          key: `tagParam_${key}`,
          label: prettyParamLabel(key),
          initial: String(p.value ?? ''),
          apply: (d, v) => { const t = asObj(d.tag); setParam(t, key, v); d.tag = t; },
        });
      }
    }
  }
  if (details.trigger) {
    if (trigger.name !== undefined) fields.push({ key: 'trigName', label: 'Trigger name', initial: String(trigger.name ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.name = v; d.trigger = t; } });
    if (trigger.type !== undefined) fields.push({ key: 'trigType', label: 'Trigger type (code)', initial: String(trigger.type ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.type = v; d.trigger = t; } });
    const filter = Array.isArray(trigger.filter) ? (trigger.filter as Array<Record<string, unknown>>) : [];
    const p0 = Array.isArray(filter[0]?.parameter) ? (filter[0].parameter as Array<Record<string, unknown>>) : [];
    if (p0.find((p) => p.key === 'arg1')) {
      fields.push({
        key: 'condValue',
        label: 'Condition value',
        initial: String(p0.find((p) => p.key === 'arg1')?.value ?? ''),
        apply: (d, v) => {
          const f = (asObj(d.trigger).filter as Array<Record<string, unknown>>)?.[0];
          const a1 = (f?.parameter as Array<Record<string, unknown>>)?.find((p) => p.key === 'arg1');
          if (a1) a1.value = v;
        },
      });
    }
  }
  if (details.variable) {
    if (variable.name !== undefined) fields.push({ key: 'varName', label: 'Variable name', initial: String(variable.name ?? ''), apply: (d, v) => { const t = asObj(d.variable); t.name = v; d.variable = t; } });
    if (variable.type !== undefined) fields.push({ key: 'varType', label: 'Variable type (code)', initial: String(variable.type ?? ''), apply: (d, v) => { const t = asObj(d.variable); t.type = v; d.variable = t; } });
  }
  if (tool.includes('workspace') && details.name !== undefined) {
    fields.push({ key: 'wsName', label: 'Workspace name', initial: String(details.name ?? ''), apply: (d, v) => { d.name = v; } });
  }
  return fields;
}

/* Turn a proposed write's raw args into labeled, human-readable rows. */
function summarizeProposal(tool: string, details: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

  if (tool === 'delete_gtm_tag') {
    rows.push({ label: 'Action', value: 'Delete tag' });
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    return rows;
  }
  // Audit auto-fixes: identify the exact action + the affected resource by name.
  if (tool === 'set_gtm_tag_paused') {
    const pause = details.paused === true || String(details.paused) === 'true';
    rows.push({ label: 'Action', value: pause ? 'Pause tag' : 'Unpause tag (enable)' });
    if (details.name) rows.push({ label: 'Tag', value: String(details.name) });
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    return rows;
  }
  if (tool === 'delete_gtm_trigger') {
    rows.push({ label: 'Action', value: 'Delete trigger' });
    if (details.name) rows.push({ label: 'Trigger', value: String(details.name) });
    if (details.triggerId) rows.push({ label: 'Trigger ID', value: String(details.triggerId) });
    return rows;
  }
  if (tool === 'delete_gtm_variable') {
    rows.push({ label: 'Action', value: 'Delete variable' });
    if (details.name) rows.push({ label: 'Variable', value: String(details.name) });
    if (details.variableId) rows.push({ label: 'Variable ID', value: String(details.variableId) });
    return rows;
  }
  if (tool === 'set_ga4_measurement_id' || tool === 'set_ga4_measurement_id_on_all_tags') {
    const all = tool === 'set_ga4_measurement_id_on_all_tags';
    rows.push({ label: 'Action', value: all ? 'Set Measurement ID on ALL GA4 tags' : 'Set Measurement ID' });
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    if (details.measurementId) rows.push({ label: 'Measurement ID', value: String(details.measurementId) });
    return rows;
  }
  if (tool === 'add_ga4_event_parameters' || tool === 'add_ga4_event_parameters_to_all_tags') {
    const all = tool === 'add_ga4_event_parameters_to_all_tags';
    rows.push({ label: 'Action', value: all ? 'Add event parameters to ALL GA4 event tags' : 'Add GA4 event parameters' });
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    const ps = Array.isArray(details.parameters) ? (details.parameters as Array<Record<string, unknown>>) : [];
    if (ps.length) rows.push({ label: 'Parameters', value: ps.map((p) => `${String(p.name)} = ${String(p.value)}`).join(', ') });
    return rows;
  }
  if (tool.includes('tag')) {
    const tag = obj(details.tag);
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    if (tag.name) rows.push({ label: 'Tag name', value: String(tag.name) });
    if (tag.type) rows.push({ label: 'Tag type', value: gtmTypeLabel(String(tag.type)) });
    const ev = gtmParam(tag, 'eventName');
    if (ev) rows.push({ label: 'Event name', value: ev });
    const mid = gtmParam(tag, 'measurementId') ?? gtmParam(tag, 'measurementIdOverride');
    if (mid) rows.push({ label: 'Measurement ID', value: mid });
    return rows;
  }
  if (tool.includes('trigger')) {
    const t = obj(details.trigger);
    if (t.name) rows.push({ label: 'Trigger name', value: String(t.name) });
    if (t.type) rows.push({ label: 'Trigger type', value: gtmTypeLabel(String(t.type)) });
    const cond = describeCondition(t.filter);
    if (cond) rows.push({ label: 'Condition', value: cond });
    return rows;
  }
  if (tool.includes('variable')) {
    const v = obj(details.variable);
    if (v.name) rows.push({ label: 'Variable name', value: String(v.name) });
    if (v.type) rows.push({ label: 'Variable type', value: gtmTypeLabel(String(v.type)) });
    return rows;
  }
  if (tool.includes('workspace')) {
    if (details.name) rows.push({ label: 'Workspace name', value: String(details.name) });
    return rows;
  }
  return rows;
}

/* ───────── Minimal Markdown renderer (dependency-free, XSS-safe) ─────────
   Renders what the assistant emits — GFM tables, headings, bold/italic, inline
   code, fenced code blocks, and bullet/ordered lists — as real elements so
   tables show as proper bordered tables instead of raw `|` text. All text is
   placed via React children (escaped), so there is no raw-HTML injection. */
const mdStyles: Record<string, React.CSSProperties> = {
  tableWrap: { overflowX: 'auto', margin: '8px 0' },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
  th: { border: '1px solid var(--border)', padding: '6px 10px', textAlign: 'left', verticalAlign: 'top', background: 'var(--surface-3)', fontWeight: 600 },
  td: { border: '1px solid var(--border)', padding: '6px 10px', textAlign: 'left', verticalAlign: 'top' },
  code: { background: 'var(--surface-3)', borderRadius: 4, padding: '1px 5px', fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  pre: { background: 'var(--surface-alt)', borderRadius: 6, padding: 10, paddingTop: 28, overflowX: 'auto', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  codeWrap: { position: 'relative', margin: '8px 0' },
  copyBtn: {
    position: 'absolute', top: 6, right: 6, zIndex: 1, padding: '2px 9px', fontSize: 11,
    background: 'var(--surface-3)', color: 'var(--text-dim)', border: '1px solid var(--border)',
    borderRadius: 6, cursor: 'pointer',
  },
  h: { margin: '10px 0 4px', fontWeight: 600, lineHeight: 1.3 },
  p: { margin: '4px 0', whiteSpace: 'pre-wrap' },
  list: { margin: '4px 0', paddingLeft: 20 },
  li: { margin: '2px 0' },
};

function renderInline(text: string, kp: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  // **bold** | `code` | *italic* | [label](url) — bold is tried before italic.
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={`${kp}b${k}`}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<code key={`${kp}c${k}`} style={mdStyles.code}>{m[2]}</code>);
    else if (m[3] != null) out.push(<em key={`${kp}i${k}`}>{m[3]}</em>);
    else if (m[4] != null) out.push(<span key={`${kp}l${k}`}>{m[4]}</span>); // link label only — no in-app navigation
    last = re.lastIndex;
    k++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
function isTableSeparator(line: string): boolean {
  const s = line.trim();
  // Accept the ASCII `---|---` separator AND the unicode-dash variants some models emit
  // (U+2010-U+2015: hyphen, figure/en/em dash, horizontal bar) so the table renders
  // instead of falling through to raw `|` text.
  return s.length > 0 && /^[|\s:\u2010-\u2015\-]+$/.test(s) && /[\u2010-\u2015\-]/.test(s);
}
function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}
function isListItem(line: string): boolean {
  return /^\s*([-*]|\d+\.)\s+/.test(line);
}

/** A fenced code block rendered as a boxed snippet with a Copy button. */
function CodeBlock({ code }: { code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const done = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(done).catch(() => {});
    else done();
  };
  return (
    <div style={mdStyles.codeWrap}>
      <button style={mdStyles.copyBtn} onClick={copy} title="Copy to clipboard">
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <pre style={mdStyles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Markdown({ text }: { text?: string | null }): JSX.Element {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // Fenced code block.
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // closing fence (if present)
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} />);
      continue;
    }

    // GFM table: a header row followed by a |---|---| separator.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const tk = key++;
      blocks.push(
        <div key={tk} style={mdStyles.tableWrap}>
          <table style={mdStyles.table}>
            <thead>
              <tr>{header.map((c, j) => <th key={j} style={mdStyles.th}>{renderInline(c, `t${tk}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{header.map((_, j) => <td key={j} style={mdStyles.td}>{renderInline(r[j] ?? '', `t${tk}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const size = [20, 18, 16, 15, 14, 13][h[1].length - 1];
      blocks.push(<div key={key++} style={{ ...mdStyles.h, fontSize: size }}>{renderInline(h[2], `h${key}`)}</div>);
      i++;
      continue;
    }

    // List (consecutive items).
    if (isListItem(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && isListItem(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const ListTag: 'ol' | 'ul' = ordered ? 'ol' : 'ul';
      const lk = key++;
      blocks.push(
        <ListTag key={lk} style={mdStyles.list}>
          {items.map((it, li) => <li key={li} style={mdStyles.li}>{renderInline(it, `l${lk}i${li}`)}</li>)}
        </ListTag>
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !isHeading(lines[i]) &&
      !isListItem(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<div key={key++} style={mdStyles.p}>{renderInline(para.join('\n'), `p${key}`)}</div>);
  }

  return <div>{blocks}</div>;
}

interface PendingConfirm {
  confirmId: string;
  tool: string;
  summary: string;
  details: Record<string, unknown>;
  destructive?: boolean;
  requireTextConfirm?: string;
}

function ConfirmCard({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: PendingConfirm;
  onApprove: (details: Record<string, unknown>) => void;
  onReject: () => void;
}): JSX.Element {
  const fields = useMemo(() => buildEditFields(proposal.tool, proposal.details), [proposal]);
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial]))
  );
  const [typed, setTyped] = useState('');
  const needType = proposal.requireTextConfirm;
  const typeOk = !needType || typed.trim().toLowerCase() === needType.toLowerCase();

  function approve(): void {
    if (!typeOk) return;
    const edited = structuredClone(proposal.details);
    for (const f of fields) f.apply(edited, vals[f.key] ?? f.initial);
    onApprove(edited);
  }

  const rows = summarizeProposal(proposal.tool, proposal.details);

  return (
    <div style={proposal.destructive ? styles.confirmDanger : styles.confirm}>
      <div style={styles.confirmHead}>
        {proposal.destructive ? '🗑 Delete — approve this action?' : '⚠ Approve this change to your GTM?'}
      </div>

      {fields.length > 0 ? (
        <div style={styles.proposalRows}>
          {fields.map((f) => (
            <div key={f.key} style={styles.editRow}>
              <span style={styles.proposalLabel}>{f.label}</span>
              <input
                style={styles.editInput}
                value={vals[f.key] ?? ''}
                onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      ) : (
        <div style={styles.proposalRows}>
          {rows.map((r) => (
            <div key={r.label} style={styles.proposalRow}>
              <span style={styles.proposalLabel}>{r.label}</span>
              <span style={styles.proposalValue}>{r.value}</span>
            </div>
          ))}
          {rows.length === 0 && <div style={{ color: 'var(--text-muted)' }}>{proposal.summary}</div>}
        </div>
      )}

      {needType && (
        <div style={styles.editRow}>
          <span style={styles.proposalLabel}>Type “{needType}” to confirm</span>
          <input
            style={{ ...styles.editInput, borderColor: typeOk ? 'var(--c-red-border)' : 'var(--border-2)' }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={needType}
            autoFocus
            spellCheck={false}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          style={{
            ...(proposal.destructive ? styles.dangerSolid : styles.primaryBtn),
            ...(typeOk ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
          }}
          onClick={approve}
          disabled={!typeOk}
        >
          {proposal.destructive ? 'Yes, delete' : 'Approve & apply'}
        </button>
        <button style={styles.ghostBtn} onClick={onReject}>
          Cancel
        </button>
      </div>
      <div style={styles.confirmNote}>
        {needType
          ? `Type “${needType}” above to enable this — the final confirmation. Applies to a draft workspace — not published.`
          : proposal.destructive
            ? 'Delete needs two approvals. Applies to a draft workspace — not published.'
            : 'Edit any field above if needed. Applies to a draft workspace only — not published.'}
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [google, setGoogle] = useState<GoogleClientStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [selfTest, setSelfTest] = useState<SecretSelfTest | null>(null);
  const [view, setView] = useState<View>('chat');
  // A prompt picked from the Prompts tab to drop into the chat input (nonce so re-picks fire).
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number; product?: 'gtm' | 'ga4' } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  // Cross-tab GA4 monitoring banner: a background run with NEW issues surfaces here on any tab.
  const [monitorAlert, setMonitorAlert] = useState<Ga4MonitorRun | null>(null);
  // Inline rename of an account's sidebar label (pencil → input; Enter saves, Escape cancels).
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const active = accounts.find((a) => a.isActive);

  async function refresh(): Promise<void> {
    setAccounts(await window.desktop.accounts.list());
  }

  useEffect(() => {
    window.desktop.getInfo().then(setInfo).catch((e) => setError(String(e)));
    window.desktop.google.status().then(setGoogle).catch((e) => setError(String(e)));
    window.desktop.secrets.selfTest().then(setSelfTest).catch((e) => setError(String(e)));
    refresh().catch((e) => setError(String(e)));
    // The chat can switch the active workspace/container — re-fetch so the GTM bar follows.
    const off = window.desktop.accounts.onChanged(() => {
      refresh().catch((e) => setError(String(e)));
    });
    // Background GA4 monitoring runs push here: raise the cross-tab banner only when a run has NEW
    // issues (so an already-seen ongoing problem, or a clean run, doesn't nag).
    const offRun = window.desktop.ga4monitoring.onRun((run) => {
      if (run.newAlertIds.length > 0 && run.health !== 'healthy') setMonitorAlert(run);
    });
    return () => { off(); offRun(); };
  }, []);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function connect(): Promise<void> {
    setError('');
    setConnecting(true);
    try {
      await window.desktop.google.connect();
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A user-initiated cancel isn't an error — don't surface it as one.
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setConnecting(false);
    }
  }

  async function cancelConnect(): Promise<void> {
    // Aborts the in-flight loopback flow; the pending connect() above then rejects
    // with "cancelled" (swallowed there) and resets the connecting state.
    try {
      await window.desktop.google.cancelConnect();
    } catch {
      /* nothing in flight, or it already settled */
    }
  }

  return (
    <div style={styles.app}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <div style={styles.logo}>S</div>
          <div>
            <div style={styles.brandName}>Samarth</div>
            <div style={styles.brandSub}>GTM / GA4 Desktop</div>
          </div>
        </div>

        <div style={styles.sideLabel}>Accounts</div>
        <div style={styles.accountList}>
          {accounts.length === 0 && <div style={styles.sideMuted}>No accounts yet</div>}
          {accounts.map((a) => (
            <div
              key={a.id}
              style={{ ...styles.acctBtn, ...(a.isActive ? styles.acctBtnActive : {}) }}
              onClick={() => { if (renaming?.id !== a.id) void run(() => window.desktop.accounts.setActive(a.id)); }}
              title={a.email}
            >
              <span style={{ ...styles.dot, background: a.hasGoogleToken ? 'var(--c-green)' : 'var(--text-faint)' }} />
              {renaming?.id === a.id ? (
                <input
                  autoFocus
                  style={styles.acctRenameInput}
                  value={renaming.value}
                  placeholder={a.email}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ id: a.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    // Enter saves; Escape cancels; an empty name restores the Google name/email.
                    if (e.key === 'Enter') { const v = renaming.value; setRenaming(null); void run(() => window.desktop.accounts.rename(a.id, v)); }
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => { const v = renaming.value; setRenaming(null); void run(() => window.desktop.accounts.rename(a.id, v)); }}
                />
              ) : (
                <>
                  <span style={styles.acctEmail}>{a.displayName || a.email}</span>
                  <span
                    role="button"
                    aria-label="Rename account"
                    title="Rename this account"
                    style={styles.acctEditBtn}
                    onClick={(e) => { e.stopPropagation(); setRenaming({ id: a.id, value: a.displayName ?? '' }); }}
                  >
                    ✏
                  </span>
                </>
              )}
            </div>
          ))}
        </div>

        {connecting ? (
          <div style={styles.connectRow}>
            <button style={{ ...styles.connectBtn, flex: 1, marginTop: 0 }} disabled>
              Signing in…
            </button>
            <button style={styles.cancelBtn} onClick={cancelConnect} title="Cancel sign-in">
              Cancel
            </button>
          </div>
        ) : (
          <button style={styles.connectBtn} onClick={connect} disabled={!google?.configured}>
            + Connect account
          </button>
        )}
        {google && !google.configured && (
          <div style={styles.sideWarn}>OAuth client not set — see Settings.</div>
        )}

        <div style={styles.sideNav}>
          <button
            style={{ ...styles.navItem, ...(view === 'chat' ? styles.navActive : {}) }}
            onClick={() => setView('chat')}
          >
            💬 Chat
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'gtm' ? styles.navActive : {}) }}
            onClick={() => setView('gtm')}
          >
            🗂 GTM Tools
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'ga4audit' ? styles.navActive : {}) }}
            onClick={() => setView('ga4audit')}
          >
            📊 GA4 Audit
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'ga4monitoring' ? styles.navActive : {}) }}
            onClick={() => setView('ga4monitoring')}
          >
            🔔 GA4 Monitor
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'prompts' ? styles.navActive : {}) }}
            onClick={() => setView('prompts')}
          >
            📖 Prompts
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'settings' ? styles.navActive : {}) }}
            onClick={() => setView('settings')}
          >
            ⚙ Settings
          </button>
        </div>
        <div style={styles.sideVersion}>v{info?.version ?? '0.0.0'}</div>
      </aside>

      <main style={styles.main}>
        {error && (
          <div style={styles.errorBar}>
            <span>{error}</span>
            <button style={styles.errorClose} onClick={() => setError('')}>
              ✕
            </button>
          </div>
        )}

        {monitorAlert && (
          <div style={monitorAlert.health === 'critical' ? styles.monitorBarCrit : styles.monitorBarWarn}>
            <span style={{ flex: 1 }}>
              {monitorAlert.health === 'critical' ? '🔴' : '🟠'} GA4 Monitor · <b>{monitorAlert.propertyLabel}</b>: {monitorAlert.newAlertIds.length} new issue{monitorAlert.newAlertIds.length === 1 ? '' : 's'} — {monitorAlert.alerts.find((a) => monitorAlert.newAlertIds.includes(a.id))?.title ?? monitorAlert.summary}
            </span>
            <button style={styles.monitorBarBtn} onClick={() => { setView('ga4monitoring'); setMonitorAlert(null); }}>View</button>
            <button style={styles.errorClose} onClick={() => setMonitorAlert(null)}>✕</button>
          </div>
        )}

        {/* ChatView stays MOUNTED across tab switches (hidden, not unmounted) so an in-flight
            response keeps streaming and the conversation isn't lost when you pop into GTM Tools. */}
        <div style={{ display: view === 'chat' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ChatView key={active?.id ?? 'none'} active={active} onError={setError} refresh={refresh} seed={chatSeed} />
        </div>
        {view === 'gtm' ? (
          <GtmToolsView key={active?.id ?? 'none'} active={active} onError={setError} refresh={refresh} />
        ) : view === 'ga4audit' ? (
          <Ga4AuditPanel key={active?.id ?? 'none'} active={active} onError={setError} />
        ) : view === 'ga4monitoring' ? (
          <Ga4MonitoringPanel key={active?.id ?? 'none'} active={active} onError={setError} />
        ) : view === 'prompts' ? (
          <PromptsView
            onUse={(text, product) => {
              setChatSeed((s) => ({ text, product, nonce: (s?.nonce ?? 0) + 1 }));
              setView('chat');
            }}
          />
        ) : view === 'settings' ? (
          <SettingsView
            active={active}
            google={google}
            info={info}
            selfTest={selfTest}
            onError={setError}
            run={run}
            refresh={refresh}
          />
        ) : null}
      </main>
    </div>
  );
}

/* ───────────────────────────── Chat ───────────────────────────── */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
  /** Tool failures surfaced in the UI even if the model doesn't mention them. */
  toolErrors?: Array<{ name: string; error: string }>;
  /** Epoch ms when the message was created (a query's send time / a reply's start time).
   *  Optional — messages stored before this field existed simply render without a timestamp. */
  ts?: number;
}

/** Short timestamp shown under a chat bubble: just the time for today's messages, date + time
 *  for older ones (the full date/time is on the element's hover title). */
function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// Per-account + per-container chat persistence (survives tab switches AND app restarts).
const CHAT_THREADS_KEY = 'samarth.chatThreads.v1';
/** Thread id: one conversation per account + product + (for GTM) container. */
function chatThreadKey(accountId: string | undefined, product: 'gtm' | 'ga4', containerId: string | undefined): string {
  return `${accountId ?? 'none'}|${product}|${product === 'gtm' ? containerId ?? 'na' : 'na'}`;
}
function loadChatThread(key: string): ChatMessage[] {
  try {
    const all = JSON.parse(localStorage.getItem(CHAT_THREADS_KEY) || '{}') as Record<string, ChatMessage[]>;
    return Array.isArray(all[key]) ? all[key] : [];
  } catch {
    return [];
  }
}
function saveChatThread(key: string, messages: ChatMessage[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(CHAT_THREADS_KEY) || '{}') as Record<string, ChatMessage[]>;
    if (messages.length) all[key] = messages;
    else delete all[key];
    localStorage.setItem(CHAT_THREADS_KEY, JSON.stringify(all));
  } catch {
    /* storage full/unavailable — non-fatal */
  }
}

function ChatView({
  active,
  onError,
  refresh,
  seed,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
  refresh: () => Promise<void>;
  seed?: { text: string; nonce: number; product?: 'gtm' | 'ga4' } | null;
}): JSX.Element {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<'gtm' | 'ga4'>('gtm');
  // One stored conversation per account + product + container; survives tab switches + restarts.
  const threadKey = chatThreadKey(active?.id, product, active?.gtmContext?.containerId);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatThread(threadKey));
  const threadKeyRef = useRef(threadKey);
  // Load the right thread whenever the account / product / container changes.
  useEffect(() => {
    threadKeyRef.current = threadKey;
    setMessages(loadChatThread(threadKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);
  // Persist (debounced so streaming tokens don't thrash localStorage).
  useEffect(() => {
    const id = setTimeout(() => saveChatThread(threadKeyRef.current, messages), 400);
    return () => clearTimeout(id);
  }, [messages]);
  const [pendingConfirm, setPendingConfirm] = useState<
    {
      confirmId: string;
      tool: string;
      summary: string;
      details: Record<string, unknown>;
      destructive?: boolean;
      requireTextConfirm?: string;
    } | null
  >(null);
  // What the previous query changed in GTM (for the Revert button).
  const [revertable, setRevertable] = useState<{ count: number; labels: string[] } | null>(null);
  const [reverting, setReverting] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [input]);

  // A prompt picked from the Prompts tab seeds the input (nonce makes re-picks re-apply). A GA4
  // prompt also flips the chat to its GA4 toggle so it runs against the GA4 API, not GTM.
  useEffect(() => {
    if (seed?.text) {
      setInput(seed.text);
      if (seed.product) setProduct(seed.product);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  const ready = Boolean(active?.hasGoogleToken && active?.llm?.hasApiKey);
  const hint = !active
    ? 'Connect a Google account to start.'
    : !active.hasGoogleToken
      ? 'Sign this account into Google (Settings).'
      : !active.llm
        ? 'Pick an LLM provider + model (Settings).'
        : !active.llm.hasApiKey
          ? 'Add an API key for this account (Settings).'
          : '';

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    onError('');
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    const now = Date.now();
    setMessages((m) => [...m, { role: 'user', text, ts: now }, { role: 'assistant', text: '', tools: [], ts: now }]);
    setInput('');
    setBusy(true);
    setRevertable(null);
    try {
      await window.desktop.llm.chatStream(history, text, product, (ev) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, text: last.text + ev.delta };
          else if (ev.type === 'tool')
            copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), ev.name] };
          else if (ev.type === 'tool_result' && !ev.ok)
            copy[copy.length - 1] = { ...last, toolErrors: [...(last.toolErrors ?? []), { name: ev.name, error: ev.error ?? 'failed' }] };
          return copy;
        });
        if (ev.type === 'confirm') {
          setPendingConfirm({
            confirmId: ev.confirmId,
            tool: ev.tool,
            summary: ev.summary,
            details: ev.details,
            destructive: ev.destructive,
            requireTextConfirm: ev.requireTextConfirm,
          });
        }
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setMessages((m) => (m[m.length - 1]?.role === 'assistant' && !m[m.length - 1].text ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
      if (product === 'gtm') {
        try {
          const change = await window.desktop.data.peekLastChange();
          setRevertable(change.count > 0 ? change : null);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function revertLast(): Promise<void> {
    if (!revertable || reverting) return;
    if (!window.confirm(`Revert ${revertable.count} item(s) to their last published version?\n\n${revertable.labels.join('\n')}`)) return;
    setReverting(true);
    onError('');
    try {
      const res = await window.desktop.data.revertLastChange();
      const parts = [`Reverted ${res.reverted.length} item(s)`];
      if (res.failed.length) parts.push(`${res.failed.length} failed: ${res.failed.map((f) => f.label).join(', ')}`);
      setMessages((m) => [...m, { role: 'assistant', text: `↩︎ ${parts.join(' · ')}.`, tools: [], ts: Date.now() }]);
      setRevertable(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setReverting(false);
    }
  }

  return (
    <div style={styles.chatWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>{active ? active.email : 'No account'}</div>
          <div style={styles.chatSub}>
            {active?.llm ? `${active.llm.provider} · ${active.llm.model}` : 'No model configured'}
            {active?.hasGoogleToken ? ' · Google ✓' : ' · not signed in'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={styles.toggle}>
            <button
              style={product === 'gtm' ? styles.toggleActive : styles.toggleBtn}
              onClick={() => setProduct('gtm')}
            >
              GTM
            </button>
            <button
              style={product === 'ga4' ? styles.toggleActive : styles.toggleBtn}
              onClick={() => setProduct('ga4')}
            >
              GA4
            </button>
          </div>
          {messages.length > 0 && (
            <button style={styles.ghostBtn} onClick={() => setMessages([])}>
              Clear
            </button>
          )}
        </div>
      </div>

      {product === 'gtm' && active && <GtmContextBar active={active} refresh={refresh} onError={onError} />}

      <div style={styles.chatLog}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
            Ask about your GTM &amp; GA4 — “list my GTM accounts”, “run a GA4 report for last 28
            days”, or “create an email-click event tag”.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              maxWidth: '75%',
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{ ...(m.role === 'user' ? styles.userMsg : styles.asstMsg), maxWidth: '100%' }}>
              {m.role === 'assistant' ? (
                <>
                  {m.text ? <Markdown text={m.text} /> : m.toolErrors?.length ? null : <span style={{ opacity: 0.6 }}>…</span>}
                  {m.toolErrors?.length ? (
                    <div style={styles.toolErrors}>
                      {m.toolErrors.map((te, j) => (
                        <div key={j} style={styles.toolErrorLine}>
                          ⚠️ <strong>{te.name}</strong> failed — {te.error}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || '…'}</div>
              )}
            </div>
            {m.ts != null && (
              <div style={styles.msgTime} title={new Date(m.ts).toLocaleString()}>
                {formatMsgTime(m.ts)}
              </div>
            )}
          </div>
        ))}
        {busy && !pendingConfirm && <div style={styles.asstMsg}>Thinking…</div>}
      </div>

      {pendingConfirm && (
        <ConfirmCard
          key={pendingConfirm.confirmId}
          proposal={pendingConfirm}
          onApprove={async (details) => {
            const id = pendingConfirm.confirmId;
            setPendingConfirm(null);
            await window.desktop.llm.confirm(id, details);
          }}
          onReject={async () => {
            const id = pendingConfirm.confirmId;
            setPendingConfirm(null);
            await window.desktop.llm.confirm(id, null);
          }}
        />
      )}

      {revertable && !busy && (
        <div style={styles.revertBar}>
          <span style={styles.revertText}>↩︎ The last query changed {revertable.count} item(s).</span>
          <button style={styles.revertBtn} disabled={reverting} onClick={() => void revertLast()}>
            {reverting ? 'Reverting…' : 'Revert last changes'}
          </button>
        </div>
      )}

      <div style={styles.composer}>
        <textarea
          ref={taRef}
          style={styles.composerInput}
          placeholder={ready ? 'Message…  (Enter to send, Shift+Enter for a new line)' : hint}
          value={input}
          disabled={!ready || busy}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button
            style={styles.stopBtn}
            onClick={() => {
              void window.desktop.llm.stop();
              setPendingConfirm(null);
            }}
            title="Stop the running query"
          >
            Stop
          </button>
        ) : (
          <button style={styles.sendBtn} onClick={send} disabled={!ready}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function GtmContextBar({
  active,
  refresh,
  onError,
}: {
  active: AccountView;
  refresh: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const ctx = active.gtmContext;
  const [editing, setEditing] = useState(!ctx?.containerId);
  const [accounts, setAccounts] = useState<GtmAccountView[]>([]);
  const [containers, setContainers] = useState<GtmContainerView[]>([]);
  const [workspaces, setWorkspaces] = useState<GtmWorkspaceView[]>([]);
  const [sel, setSel] = useState<GtmContext>(ctx ?? {});
  const [loading, setLoading] = useState('');

  useEffect(() => {
    if (editing && accounts.length === 0) {
      window.desktop.data.listGtmAccounts().then(setAccounts).catch((e) => onError(String(e)));
    }
  }, [editing]);

  async function pickAccount(accountId: string): Promise<void> {
    const acc = accounts.find((a) => a.accountId === accountId);
    setSel({ accountId, accountName: acc?.name });
    setContainers([]);
    setWorkspaces([]);
    if (!accountId) return;
    setLoading('containers');
    try {
      setContainers(await window.desktop.data.listGtmContainers(accountId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }

  async function pickContainer(containerId: string): Promise<void> {
    const c = containers.find((x) => x.containerId === containerId);
    setSel((s) => ({ ...s, containerId, containerName: c?.name, containerPublicId: c?.publicId, workspaceId: undefined, workspaceName: undefined }));
    setWorkspaces([]);
    if (!containerId || !sel.accountId) return;
    setLoading('workspaces');
    try {
      setWorkspaces(await window.desktop.data.listGtmWorkspaces(sel.accountId, containerId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }

  function pickWorkspace(workspaceId: string): void {
    const w = workspaces.find((x) => x.workspaceId === workspaceId);
    setSel((s) => ({ ...s, workspaceId, workspaceName: w?.name }));
  }

  async function save(): Promise<void> {
    try {
      await window.desktop.accounts.setGtmContext(active.id, sel);
      await refresh();
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!editing && ctx?.containerId) {
    return (
      <div style={styles.ctxBar}>
        <span>
          <span style={{ color: 'var(--text-muted)' }}>Working in: </span>
          📁 {ctx.accountName} › <b style={{ color: 'var(--text)' }}>{ctx.containerName}</b>
          {ctx.containerPublicId ? <span style={{ color: 'var(--text-faint)' }}> ({ctx.containerPublicId})</span> : null} ›{' '}
          <b style={{ color: 'var(--c-blue)' }}>{ctx.workspaceName ?? 'workspace?'}</b>
        </span>
        <button style={styles.linkBtn} onClick={() => { setSel(ctx); setEditing(true); }}>
          change
        </button>
      </div>
    );
  }

  return (
    <div style={styles.ctxBarEdit}>
      <span style={styles.muted}>Working in:</span>
      <select style={styles.ctxSelect} value={sel.accountId ?? ''} onChange={(e) => void pickAccount(e.target.value)}>
        <option value="">Account…</option>
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId}>{a.name}</option>
        ))}
      </select>
      <select style={styles.ctxSelect} value={sel.containerId ?? ''} disabled={!sel.accountId || loading === 'containers'} onChange={(e) => void pickContainer(e.target.value)}>
        <option value="">{loading === 'containers' ? 'Loading…' : 'Container…'}</option>
        {containers.map((c) => (
          <option key={c.containerId} value={c.containerId}>{c.name}{c.publicId ? ` (${c.publicId})` : ''}</option>
        ))}
      </select>
      <select style={styles.ctxSelect} value={sel.workspaceId ?? ''} disabled={!sel.containerId || loading === 'workspaces'} onChange={(e) => pickWorkspace(e.target.value)}>
        <option value="">{loading === 'workspaces' ? 'Loading…' : 'Workspace…'}</option>
        {workspaces.map((w) => (
          <option key={w.workspaceId} value={w.workspaceId}>{w.name}</option>
        ))}
      </select>
      <button style={styles.ghostBtn} onClick={save} disabled={!sel.containerId}>
        Use
      </button>
      {ctx?.containerId && (
        <button style={styles.linkBtn} onClick={() => setEditing(false)}>cancel</button>
      )}
    </div>
  );
}

/* ───────────────────── Tag suggestions (review & approve) ───────────────────── */

type RowStatus = { state: 'idle' | 'creating' | 'ok' | 'err' | 'exists'; msg?: string };
/** Human-readable trigger condition (the filter GTM will apply). */
function triggerCondition(s: SuggestedTagView): string {
  const t = s.trigger;
  const parts: string[] = [];
  if (t.clickUrlValue) parts.push(`{{Click URL}} ${t.clickUrlOperator ?? 'contains'}${t.clickUrlIgnoreCase ? ' (ignore case)' : ''} "${t.clickUrlValue}"`);
  if (t.clickTextValue) parts.push(`{{Click Text}} ${t.clickTextOperator ?? 'contains'}${t.clickTextIgnoreCase ? ' (ignore case)' : ''} "${t.clickTextValue}"`);
  if (t.clickElementValue) parts.push(`{{Click Element}} matches CSS "${t.clickElementValue}"`);
  if (t.lookupTable?.name) parts.push(`{{${t.lookupTable.name}}} equals "true" (${t.lookupTable.texts.map((x) => `"${x}"`).join(', ')} → true)`);
  if (t.formIdValue) parts.push(`{{Form ID}} ${t.formIdOperator ?? 'equals'} "${t.formIdValue}"`);
  if (t.formClassesValue) parts.push(`{{Form Classes}} ${t.formClassesOperator ?? 'contains'} "${t.formClassesValue}"`);
  if (t.pagePathValue) parts.push(`{{Page Path}} ${t.pagePathOperator ?? 'equals'} "${t.pagePathValue}"`);
  if (t.pageUrlValue) parts.push(`{{Page URL}} ${t.pageUrlOperator ?? 'contains'} "${t.pageUrlValue}"`);
  if (t.eventName) parts.push(`event = "${t.eventName}"`);
  if (parts.length === 0)
    return t.kind === 'all_clicks' ? 'fires on every click'
      : t.kind === 'form_submit' ? 'fires on every form submit'
      : t.kind === 'youtube_video' ? 'fires on YouTube video start / progress (25/50/75/90%) / complete'
      : '—';
  return parts.join(' AND ');
}

// The suggested tags rendered in the "GTM Structure - GA4 Events" template layout:
// one block per tag (tag + trigger on the first row; one row per event parameter /
// trigger condition). Same data the CSV download writes — via suggestionToGroup.
const tplStyles: Record<string, React.CSSProperties> = {
  // flexShrink:0 + maxWidth:100% so the table keeps its full height inside the scrolling flex column
  // (otherwise it gets compressed and rows are clipped) and scrolls horizontally instead of overflowing.
  wrap: { overflowX: 'auto', maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 12, flexShrink: 0 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12, color: 'var(--text-dim)' },
  th: { textAlign: 'left', padding: '8px 10px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  td: { padding: '6px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', whiteSpace: 'normal', wordBreak: 'break-word' },
  tdTag: { padding: '6px 10px', borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--c-blue-bg)', verticalAlign: 'top', background: 'var(--surface-2)' },
  selTh: { width: 56, textAlign: 'center', padding: '8px 8px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' },
  selTd: { padding: '6px 8px', textAlign: 'center', verticalAlign: 'top', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', whiteSpace: 'nowrap' },
  // Editable cells are auto-growing WRAPPING textareas (see GrowCell) so a long tag name / regex
  // value wraps to multiple lines and stays fully visible instead of being clipped in a 1-line input.
  cellInput: { width: '100%', minWidth: 150, boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 6px', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.35, resize: 'none', overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'block' },
  cellSelect: { width: '100%', minWidth: 120, boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 4px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  pager: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--text-muted)' },
  pagerBtn: { background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 7, padding: '4px 12px', fontSize: 13, cursor: 'pointer' },
};

// Fixed option lists for the editable Trigger-when Variable / Condition selects.
const VARIABLE_OPTIONS = STANDARD_TRIGGER_VARIABLES.map((v) => ({ value: v, label: v }));
const CONDITION_OPTIONS = CONDITION_LABELS.map((l) => ({ value: l, label: l }));

/** A styled inline <select> for the editable Table cells (Tag Type / Trigger Type / Trigger-when
 *  Variable + Condition). If the current value isn't one of the options (e.g. a condition that still
 *  carries "(ignore case)"), it is shown as a leading option so the controlled select never blanks. */
function CellSelect({ value, options, disabled, onChange, ariaLabel }: { value: string; options: Array<{ value: string; label: string }>; disabled?: boolean; onChange: (v: string) => void; ariaLabel: string }): JSX.Element {
  const known = options.some((o) => o.value === value);
  return (
    <select style={tplStyles.cellSelect} value={value} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Auto-growing, wrapping textarea for the editable Table cells: long values (a full tag name, a
 *  regex trigger value) WRAP and stay fully visible instead of being clipped in a single-line input.
 *  Resizes to its content height whenever the value changes. */
function GrowCell({ value, disabled, onChange, ariaLabel }: { value: string; disabled?: boolean; onChange: (v: string) => void; ariaLabel: string }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      style={tplStyles.cellInput}
      value={value}
      disabled={disabled}
      rows={1}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    />
  );
}
// The template table is interactive (parity with the Cards view): a leading checkbox selects a tag
// to create in GTM, and the Tag name / GA4 event / trigger-Value cells are inline-editable (writing
// into the same `edits`/`selected` state the Cards view + the create flow use). Rows already in the
// container (or just created) lock — no checkbox, no edit — so a tag can't be re-created.
function SuggestionTemplateTable({
  suggestions,
  edits,
  selected,
  statuses,
  creating,
  alreadyExists,
  onToggle,
  onEdit,
}: {
  suggestions: SuggestedTagView[];
  /** Raw inline-edit overlay (keyed by suggestion id). The editable Parameter/When ROWS render from these
   *  raw arrays (not the re-projected effective view) so a transiently-blank name/value keeps its row
   *  mounted instead of collapsing mid-keystroke; applyTagEdit sanitizes blanks only for create. */
  edits: Record<string, TagEdit>;
  selected: Record<string, boolean>;
  statuses: Record<string, RowStatus>;
  creating: boolean;
  alreadyExists: (s: SuggestedTagView) => boolean;
  onToggle: (id: string, v: boolean) => void;
  onEdit: (id: string, patch: TagEdit) => void;
}): JSX.Element {
  return (
    <div style={tplStyles.wrap}>
      <table style={tplStyles.table}>
        <thead>
          <tr>
            <th style={tplStyles.selTh} title="Tick to create this tag in GTM">✓</th>
            <th style={tplStyles.th} title="The page this suggestion was found on">Page</th>
            {TEMPLATE_HEADERS.map((h) => <th key={h} style={tplStyles.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {suggestions.flatMap((s) => {
            const g = suggestionToGroup(s);
            const exists = alreadyExists(s);
            const st = statuses[s.id];
            const created = st?.state === 'ok';
            // Inputs stay editable unless the tag was just created (or a create is running) — NOT gated
            // on `exists`, so typing a name that happens to match a container tag doesn't yank the input
            // out from under the cursor mid-keystroke. Renaming an "exists" row to a unique name re-shows
            // its checkbox. Selection itself still respects `exists` (shows "✓ exists", no checkbox).
            const editable = !created;
            // A lookup-table trigger's "when" rows can't be reversed losslessly (the texts→true map is
            // lost), so those three cells stay read-only; every other field is editable.
            const whensEditable = editable && !s.trigger.lookupTable?.name;
            // Editable ROWS come from the raw edit overlay when present, so a transiently-blank param name
            // or when value keeps its row mounted instead of collapsing mid-keystroke; untouched rows fall
            // back to the projected group. rowCount + the create-time blank-drop follow from these.
            const ed = edits[s.id];
            const paramRows = ed?.params ?? g.params;
            const whenRows = ed?.whens ?? g.whens;
            const rowCount = Math.max(paramRows.length, whenRows.length, 1);
            const editParam = (idx: number, patch: Partial<{ name: string; variable: string }>): void =>
              onEdit(s.id, { params: paramRows.map((row, j) => (j === idx ? { ...row, ...patch } : row)) });
            const editWhen = (idx: number, patch: Partial<TriggerWhen>): void =>
              onEdit(s.id, { whens: whenRows.map((row, j) => (j === idx ? { ...row, ...patch } : row)) });
            return Array.from({ length: rowCount }, (_, i) => {
              const first = i === 0;
              const p = paramRows[i];
              const w = whenRows[i];
              // Offer only variables not already claimed by ANOTHER when-row (plus this row's own value), so
              // two rows can't collide on one trigger field (the model stores one value per variable).
              const varOptions = w ? VARIABLE_OPTIONS.filter((o) => o.value === w.variable || !whenRows.some((r, j) => j !== i && r.variable === o.value)) : VARIABLE_OPTIONS;
              return (
                <tr key={s.id + ':' + i}>
                  {first && (
                    <td rowSpan={rowCount} style={tplStyles.selTd}>
                      {exists ? (
                        <span style={styles.existsChip} title="A tag with this name already exists in the container">✓ exists</span>
                      ) : created ? (
                        <span style={{ color: 'var(--c-green)', fontSize: 11 }} title={st?.msg}>✓ created</span>
                      ) : (
                        <>
                          <input
                            type="checkbox"
                            style={{ accentColor: 'var(--c-blue)', cursor: 'pointer' }}
                            checked={!!selected[s.id]}
                            disabled={creating || st?.state === 'creating'}
                            onChange={(e) => onToggle(s.id, e.target.checked)}
                            aria-label={`Select ${g.tagName} to create in GTM`}
                          />
                          {st?.state === 'creating' && <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 2 }}>…</div>}
                          {st?.state === 'err' && <div style={{ color: 'var(--c-red)', fontSize: 10, marginTop: 2 }} title={st?.msg}>✗ failed</div>}
                        </>
                      )}
                    </td>
                  )}
                  {first && (
                    <td rowSpan={rowCount} style={{ ...tplStyles.td, whiteSpace: 'nowrap' }}>
                      {editable ? <GrowCell value={s.page} disabled={creating} onChange={(v) => onEdit(s.id, { page: v })} ariaLabel="Page" /> : <span style={{ color: 'var(--text-dim)' }}>{s.page}</span>}
                    </td>
                  )}
                  {first && (
                    <td rowSpan={rowCount} style={tplStyles.tdTag}>
                      {editable ? <CellSelect value={s.platform} options={TAG_TYPE_OPTIONS} disabled={creating} onChange={(v) => onEdit(s.id, { platform: v as SuggestedTagView['platform'] })} ariaLabel="Tag type" /> : g.tagType}
                    </td>
                  )}
                  {first && (
                    <td rowSpan={rowCount} style={{ ...tplStyles.td, color: 'var(--text)', fontWeight: 600 }}>
                      {editable ? <GrowCell value={g.tagName} disabled={creating} onChange={(v) => onEdit(s.id, { tagName: v })} ariaLabel="Tag name" /> : g.tagName}
                    </td>
                  )}
                  {first && (
                    <td rowSpan={rowCount} style={tplStyles.td}>
                      {editable ? <GrowCell value={g.eventName} disabled={creating} onChange={(v) => onEdit(s.id, { eventName: v })} ariaLabel="Event name" />
                        : g.eventName ? <code style={mdStyles.code}>{g.eventName}</code> : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                  )}
                  <td style={tplStyles.td}>{p ? (editable ? <GrowCell value={p.name} disabled={creating} onChange={(v) => editParam(i, { name: v })} ariaLabel="Parameter name" /> : p.name) : ''}</td>
                  <td style={tplStyles.td}>{p ? (editable ? <GrowCell value={p.variable} disabled={creating} onChange={(v) => editParam(i, { variable: v })} ariaLabel="Parameter variable" /> : <code style={mdStyles.code}>{p.variable}</code>) : ''}</td>
                  {first && (
                    <td rowSpan={rowCount} style={tplStyles.td}>
                      {editable ? <GrowCell value={g.triggerName} disabled={creating} onChange={(v) => onEdit(s.id, { triggerName: v })} ariaLabel="Trigger name" /> : g.triggerName}
                    </td>
                  )}
                  {/* Trigger Type (the trigger KIND) is read-only: changing the kind strands the old
                      kind's filter fields (which the new kind's builder ignores → fires on everything) and
                      the conditions can't be re-specified in this table. Edit the kind in GTM instead. */}
                  {first && <td rowSpan={rowCount} style={tplStyles.td} title="Trigger type is structural — change it in GTM, or pick a suggestion of the right type">{g.triggerType}</td>}
                  <td style={tplStyles.td}>{w ? (whensEditable ? <CellSelect value={w.variable} options={varOptions} disabled={creating} onChange={(v) => editWhen(i, { variable: v })} ariaLabel="Trigger when variable" /> : <code style={mdStyles.code}>{w.variable}</code>) : ''}</td>
                  <td style={tplStyles.td}>{w ? (whensEditable ? <CellSelect value={w.condition} options={CONDITION_OPTIONS} disabled={creating} onChange={(v) => editWhen(i, { condition: v })} ariaLabel="Trigger when condition" /> : w.condition) : ''}</td>
                  <td style={tplStyles.td}>{w ? (whensEditable ? <GrowCell value={w.value} disabled={creating} onChange={(v) => editWhen(i, { value: v })} ariaLabel="Trigger when value" /> : w.value) : ''}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A discovered URL → a short, readable label (its path, "/" for the homepage). */
function pagePathLabel(u: string): string {
  try {
    const x = new URL(u);
    return (x.pathname || '/') + (x.search || '');
  } catch {
    return u;
  }
}

// Blog / editorial URL matcher for the optional "skip blog pages" crawl filter. Matches a /blog,
// /blogs, /news or /article(s) path SEGMENT (incl. under a locale prefix like /en/blog/…), so it also
// catches individual posts (/blog/my-post). Opt-in only.
const BLOG_RE = /\/(blogs?|news|articles?)(\/|$)/i;
function isBlogUrl(u: string): boolean {
  try {
    return BLOG_RE.test(new URL(u).pathname);
  } catch {
    return BLOG_RE.test(u);
  }
}

/** "outbound 40 · cta 30 · download 25 · phone 2 · email 1" for the inventory header. */
function kindCountsLabel(elements: Array<{ kind: string }>): string {
  const counts: Record<string, number> = {};
  for (const e of elements) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
}

// The grouped "GTM" workspace: one shared account/container/workspace picker
// (GtmContextBar) over two sub-tabs — Tag suggestions and Container audit — so both
// GTM-container tools share the same target instead of each finding it on its own.
function GtmToolsView({
  active,
  onError,
  refresh,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [tab, setTab] = useState<GtmTab>('suggestions');
  return (
    <div style={styles.gtmWorkspace}>
      {active ? (
        <GtmContextBar active={active} refresh={refresh} onError={onError} />
      ) : (
        <div style={{ ...styles.sideWarn, margin: '12px 20px' }}>Connect a Google account to choose a GTM container & workspace.</div>
      )}
      <div style={styles.subTabs} role="tablist">
        <button style={tab === 'suggestions' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('suggestions')} role="tab" aria-selected={tab === 'suggestions'}>
          🏷 Tag suggestions
          <span style={styles.betaBadge}>Beta</span>
        </button>
        <button style={tab === 'audit' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('audit')} role="tab" aria-selected={tab === 'audit'}>
          🔍 Container audit
        </button>
        <button style={tab === 'server' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('server')} role="tab" aria-selected={tab === 'server'}>
          🖥 Server container
          <span style={styles.betaBadge}>Beta</span>
        </button>
      </div>
      {tab === 'suggestions' ? (
        <TagReviewPanel key={(active?.id ?? 'none') + ':sug'} active={active} onError={onError} />
      ) : tab === 'audit' ? (
        <ContainerAuditPanel key={(active?.id ?? 'none') + ':aud'} active={active} onError={onError} />
      ) : (
        <ServerContainerPanel key={(active?.id ?? 'none') + ':srv'} active={active} onError={onError} />
      )}
    </div>
  );
}

// Sample prompts grouped by task — a quick reference + launcher for the chat. Replace the
// placeholder ids/names/URLs (G-…, container names, https URLs) with the user's own.
const PROMPT_GROUPS: Array<{ title: string; icon: string; product?: 'gtm' | 'ga4'; prompts: string[] }> = [
  {
    title: 'Audit & health',
    icon: '🔍',
    prompts: [
      'Audit my GTM container and list the findings by severity, worst first.',
      'What changed in my container since the last audit — any regressions?',
      'Give me a scorecard for this container.',
      'Diff my draft workspace against the live published version.',
      'Compare my last two container versions.',
      'Cross-check the GA4 measurement IDs in my container against my GA4 properties.',
      'Audit my server container.',
      'Verify my tagging server https://sgtm.example.com',
    ],
  },
  {
    title: 'Scope, filter & batch fixes',
    icon: '🎯',
    prompts: [
      'List all tags that fire on the purchase event.',
      'Show only the GA4 event tags in my container.',
      'List every tag that has no firing trigger.',
      'List the tags that are paused right now.',
      'Which tags fire on add_to_cart but have no Consent Mode v2 settings?',
      'Require Consent Mode v2 on all GA4 event tags that fire on ecommerce events (purchase, add_to_cart, begin_checkout).',
      'Apply all the fixes from the last container audit.',
      'Pause every Custom HTML tag.',
      'Unpause all paused tags.',
    ],
  },
  {
    title: 'GA4 ecommerce tags',
    icon: '🛒',
    prompts: [
      'Create a GA4 event tag for add_to_cart with items, value and currency, firing on the add_to_cart custom event.',
      'Create a GA4 purchase tag with items, transaction_id, value, tax, shipping, currency and coupon.',
      'Create a GA4 view_item tag with the ecommerce items, value and currency.',
      'Create a GA4 begin_checkout tag firing on the begin_checkout custom event.',
      'Create GA4 tags for the whole funnel: view_item, add_to_cart, begin_checkout, purchase.',
      'Add session_id and user_id event parameters to all my GA4 event tags.',
      'Set the Measurement ID G-XXXXXXX on all GA4 tags.',
    ],
  },
  {
    title: 'GA4 engagement events',
    icon: '📈',
    prompts: [
      'Create a GA4 generate_lead tag firing on form submissions.',
      'Create a GA4 scroll event tag firing at 90% scroll depth.',
      'Create a GA4 video_start tag.',
      'Create a GA4 outbound click event tag.',
      'Create a GA4 file_download event tag for PDF/zip links.',
    ],
  },
  {
    title: 'Triggers & variables',
    icon: '⚡',
    prompts: [
      'Create a Custom Event trigger for purchase.',
      'Create a timer trigger that fires every 30 seconds.',
      'Create a scroll depth trigger at 90%.',
      'Create a click trigger for outbound links.',
      'Create a form submission trigger.',
      'Create a Data Layer variable for ecommerce.value.',
      'Create a Constant variable named GA4 ID with value G-XXXXXXX.',
      'Create a Custom JavaScript variable that returns the page title.',
      'List all variables in my container.',
    ],
  },
  {
    title: 'Consent Mode v2',
    icon: '🛡',
    prompts: [
      'Set Consent Mode v2 on all ad/analytics tags (ad_storage, analytics_storage, ad_user_data, ad_personalization).',
      'Which tags are missing Consent Mode v2 settings?',
      'Show the consent status of each ad/analytics tag.',
      'Set no additional consent on all non-ad tags.',
    ],
  },
  {
    title: 'Tag management',
    icon: '🏷',
    prompts: [
      'Pause the GA4 - Config tag.',
      'Unpause the GA4 - Purchase tag.',
      'Update the GA4 - Config tag to use the {{GA4 Variable}} for its Measurement ID.',
      'Reuse the existing trigger and variable if they already exist — do not create duplicates.',
    ],
  },
  {
    title: 'Folders, environments & workspaces',
    icon: '🗂',
    prompts: [
      'Create a folder called Ecommerce and move all GA4 event tags into it.',
      'Organize my container: make a folder per platform and move the tags in.',
      'List my folders.',
      'Create a Test environment and give me the install snippet.',
      'List my environments with their install snippets.',
      'Create a new draft workspace called QA.',
      'Copy all tags, triggers and variables from MCP-E2E-TEST to Default Workspace.',
    ],
  },
  {
    title: 'Server-side GTM',
    icon: '🖥',
    prompts: [
      'Set up a server container for this web container.',
      'Create a GA4 server tag forwarding to G-XXXXXXX, firing on all events.',
      'Create a server trigger scoped to Client Name = GA4 and point the GA4 server tag at it.',
      'Create a Google Ads conversion server tag with conversion id AW-XXXXXX and label YYYY.',
      'Add an event_data variable in the server container reading the items field.',
      'Create an allow-params transformation keeping only transaction_id, currency and value.',
      'List the clients and transformations in my server container.',
      'Set the tagging server URL on my server container to https://sgtm.example.com',
      'Point my web container Google tag at the server URL https://sgtm.example.com',
      'Create the Meta CAPI EMQ event data variables in my server container.',
    ],
  },
  {
    title: 'Community templates (Meta / TikTok / LinkedIn / Pinterest / Snap)',
    icon: '🧩',
    prompts: [
      'Import the Meta Pixel community template and create a Meta pixel tag with my Pixel ID.',
      'Import the TikTok Pixel template and create the tag.',
      'Import the LinkedIn Insight Tag template.',
      'Import the Pinterest Tag template (pinterest / ws-gtm-template) and create the tag with my Tag ID.',
      'Import the Snap Pixel template and create the tag.',
      'Import the Pinterest Conversions API server template (pinterest / ss-gtm-template) into my server container.',
      'List the community templates imported into my container.',
      'Detect Meta/Facebook pixel tags in my web container.',
    ],
  },
  {
    title: 'Meta — Pixel, CAPI & advanced matching',
    icon: '📘',
    prompts: [
      'Import the Meta Pixel community template and create a Meta pixel base tag with my Pixel ID.',
      'Create a Meta Purchase event tag with value, currency and content_ids.',
      'Create a Meta AddToCart event tag firing on add_to_cart.',
      'Create a Meta ViewContent event tag for product pages.',
      'Create a Meta InitiateCheckout event tag firing on begin_checkout.',
      'Create a Meta Lead event tag firing on form submissions.',
      'Create the Meta CAPI EMQ event data variables in my server container (email_address, phone_number, first_name, last_name, fbp, fbc, event_id, value, currency).',
      'Set up Meta advanced matching: feed raw email and phone into the Meta tag user_data so it hashes them for match quality.',
      'Import the Meta Conversions API server template (stape-io / facebook-tag) into my server container.',
      'Map email, phone, value, currency and event_id into my Meta CAPI tag for higher Event Match Quality.',
      'Detect Meta/Facebook pixel tags in my web container and which ecommerce events they fire on.',
      'How do I confirm my Meta CAPI events and Event Match Quality in Meta Events Manager?',
    ],
  },
  {
    title: 'Test & verify a new tag',
    icon: '🧪',
    prompts: [
      "List the community templates imported into my container and show each one's tag type.",
      'Audit my container and confirm the new tag has a firing trigger and Consent Mode v2 settings.',
      'Cross-check my GA4 measurement IDs against my accessible GA4 properties.',
      'Diff my draft workspace against the live version so I can see what is pending to publish.',
      'Detect Meta/Facebook pixel tags in my web container and which ecommerce events they fire on.',
      'Audit my server container to confirm the client, trigger and tag are wired correctly.',
      'Verify my tagging server https://sgtm.example.com responds (GET /healthy).',
      'Run a realtime GA4 report of active users by page to confirm hits are arriving.',
      'How do I test my Pinterest / Meta pixel tag in GTM Preview before publishing?',
      'Walk me through verifying server-side events in GTM Preview and GA4 DebugView.',
      'How do I confirm my Meta CAPI events in Meta Events Manager (Test Events)?',
    ],
  },
  {
    title: 'GA4 property audit (read-only)',
    icon: '🔬',
    product: 'ga4', // runs the evidence-based GA4 audit framework via the read-only GA4 tools
    prompts: [
      'Run a full GA4 property audit of this property. Gather the real config + last-90-days data via the GA4 tools, then output the templated audit: area-status table (Pass / Partial / Fail / Not Verified), property baseline, decision readiness, parameter-coverage bars, and findings sorted by severity with evidence, business risk and the exact fix.',
      "Audit this GA4 property's data quality for the last 28 days — (not set) / Unassigned / (direct) bloat and any anomalies — with real values and a Pass / Partial / Fail / Not Verified status, worst first.",
      'Decision readiness: can this GA4 property answer which campaigns generate revenue, CAC by channel, abandonment, lead quality, LTV, refund rate, and repeat/churn within 90 days? Mark each Answerable / Partial / Not answerable, and list what it cannot measure and the missing input.',
      'Audit the ecommerce setup: which funnel steps fire (view_item → add_to_cart → begin_checkout → purchase), purchase parameter coverage (value, transaction_id, currency, items) as bars, plus any duplicate-transaction or revenue-gap risk.',
      'Score this GA4 property 0–100 with a letter grade, the reasons behind the score, and the top 3 fixes.',
    ],
  },
  {
    title: 'GA4 reporting & settings (read-only)',
    icon: '📊',
    product: 'ga4', // these query the GA4 Admin/Data API → open the chat's GA4 toggle, not GTM
    prompts: [
      'Run a GA4 report of sessions by default channel group for the last 28 days.',
      'Run a realtime GA4 report of active users by page.',
      'List my GA4 key events (conversions).',
      'List my GA4 custom dimensions and custom metrics.',
      'Show my GA4 data streams.',
      'Audit my GA4 property for data-quality issues.',
      'Show my GA4 property data retention and Google Signals settings.',
      'Score my GA4 property setup.',
    ],
  },
];

// Short chip label for a group's filter button (drop the parenthetical / "& …" tail).
function shortLabel(title: string): string {
  return title.split(/ \(| & |, /)[0];
}

function PromptsView({ onUse }: { onUse: (text: string, product: 'gtm' | 'ga4') => void }): JSX.Element {
  const [copied, setCopied] = useState('');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all'); // group title, or 'all'

  function copy(text: string): void {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(text);
          setTimeout(() => setCopied(''), 1200);
        })
        .catch(() => {});
    }
  }

  const q = query.trim().toLowerCase();
  const groups = PROMPT_GROUPS.filter((g) => cat === 'all' || g.title === cat)
    .map((g) => ({ ...g, prompts: q ? g.prompts.filter((p) => p.toLowerCase().includes(q)) : g.prompts }))
    .filter((g) => g.prompts.length > 0);
  const total = groups.reduce((n, g) => n + g.prompts.length, 0);

  return (
    <div style={styles.promptsWrap}>
      <div style={styles.promptsHead}>
        <div style={styles.chatTitle}>Sample prompts</div>
        <div style={styles.chatSub}>
          “Use in chat” drops a prompt into the chat box; “Copy” copies it. Replace placeholders (G-…, IDs, names, https URLs) with yours.
        </div>
        <input
          style={styles.promptSearch}
          placeholder="Search prompts…  (e.g. meta, email, purchase, consent, server)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={styles.promptFilters}>
          <button style={cat === 'all' ? styles.promptChipOn : styles.promptChip} onClick={() => setCat('all')}>
            All
          </button>
          {PROMPT_GROUPS.map((g) => (
            <button
              key={g.title}
              title={g.title}
              style={cat === g.title ? styles.promptChipOn : styles.promptChip}
              onClick={() => setCat(g.title)}
            >
              {g.icon} {shortLabel(g.title)}
            </button>
          ))}
        </div>
      </div>
      <div style={styles.promptsBody}>
        {total === 0 ? (
          <div style={styles.sideMuted}>No prompts match “{query}”. Try a different word or clear the filter.</div>
        ) : (
          groups.map((g) => (
            <div key={g.title}>
              <div style={styles.promptGroupTitle}>
                {g.icon} {g.title}
              </div>
              <div style={styles.promptList}>
                {g.prompts.map((p) => (
                  <div key={p} style={styles.promptCard}>
                    <div style={styles.promptText}>{p}</div>
                    <div style={styles.promptActions}>
                      <button style={styles.promptUse} onClick={() => onUse(p, g.product ?? 'gtm')}>
                        Use in chat
                      </button>
                      <button style={styles.promptCopy} onClick={() => copy(p)}>
                        {copied === p ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TagReviewPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  // Live crawl progress — suggestions stream in one-by-one as each page is scanned.
  const [scanProgress, setScanProgress] = useState<{ scanned: number; found: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestedTagView[]>([]);
  const [meta, setMeta] = useState<TagScanResult['summary'] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, TagEdit>>({});
  // Suggestion-list filters (search text + type). Display-only: they narrow which rows are SHOWN,
  // never which ids are selected/created.
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'click' | 'form' | 'other'>('all');
  // Filter the suggestion list by ad PLATFORM (GA4 / Meta / Google Ads / TikTok / …) — only shown when a
  // scan produced more than one platform (e.g. a "Both" or multi-select scan). 'all' = no platform filter.
  const [platformFilter, setPlatformFilter] = useState<SuggestPlatform | 'all'>('all');
  // Review table is paginated at 10 tags/page. Reset to the first page whenever a filter narrows the list
  // so the user is never stranded on a now-empty page.
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [search, typeFilter, platformFilter]);
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<{ created: number; existing: number; failed: number; total: number } | null>(null);
  // Live create progress (attempted / total) so a big batch shows "7/40" while it runs.
  const [createProgress, setCreateProgress] = useState<{ done: number; total: number } | null>(null);
  const [settleMs, setSettleMs] = useState('2500');
  const [settleAuto, setSettleAuto] = useState(true);
  const effSettleMs = (): number | undefined => (settleAuto ? undefined : Number(settleMs) || undefined);
  // Pre-scan platform choice: a MULTI-SELECT of ad platforms to generate tags for. GA4 is the default;
  // any subset of the others may be toggled. Each non-GA4 platform's tags are derived from the GA4 ones
  // so every platform's tag shares one trigger per detection. Never send an empty array — a scan with
  // no platform makes no sense — so deselecting the last one falls back to ['ga4'] (see togglePlatform).
  const [platforms, setPlatforms] = useState<SuggestPlatform[]>(['ga4']);
  const togglePlatform = (p: SuggestPlatform): void =>
    setPlatforms((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      return next.length ? next : ['ga4'];
    });
  const [scanLog, setScanLog] = useState<{ pages: TagScanResult['pages']; notScanned: TagScanResult['notScanned']; inventory: TagScanResult['inventory']; installed: TagScanResult['installed'] } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const [discoverMode, setDiscoverMode] = useState<'site' | 'single' | 'ai' | 'csv'>('site');
  // CSV mode: paste / load a list of landing-page URLs and scan them all directly (no discovery).
  const [csvText, setCsvText] = useState('');
  const csvFileRef = useRef<HTMLInputElement>(null);
  // OpenAI key presence — gates the experimental AI (screenshot + vision) mode.
  const [hasOpenAi, setHasOpenAi] = useState(false);
  useEffect(() => {
    window.desktop.providers.status().then((s) => setHasOpenAi(!!s.openai)).catch(() => setHasOpenAi(false));
  }, []);
  const [selectedPages, setSelectedPages] = useState<Record<string, boolean>>({});
  // Optional crawl filter (opt-in): hide /blog|/news|/article pages from the discovered list and skip
  // them in the scan. Off by default.
  const [skipBlog, setSkipBlog] = useState(false);
  const [exportNote, setExportNote] = useState('');
  // The container's existing tags — so suggestions already present are marked
  // "already exists" and skipped (no duplicate-name failure, no wasted API quota).
  const [existing, setExisting] = useState<{ names: Set<string>; hasGa4Base: boolean }>({ names: new Set(), hasGa4Base: false });

  const ctx = active?.gtmContext;
  const targetReady = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);

  // Resolve a detected GTM-XXXX container id → its friendly name, when it's one of
  // this account's containers, so "Live on this site" shows the name not the raw id.
  const [containerNames, setContainerNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const accountId = ctx?.accountId;
    if (!active?.hasGoogleToken || !accountId) {
      setContainerNames({});
      return;
    }
    let cancelled = false;
    window.desktop.data.listGtmContainers(accountId).then(
      (list) => {
        if (!cancelled) setContainerNames(Object.fromEntries(list.map((c) => [c.publicId.toUpperCase(), c.name])));
      },
      () => {
        if (!cancelled) setContainerNames({});
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active?.hasGoogleToken, ctx?.accountId]);
  const containerLabel = (id: string): string => containerNames[id.toUpperCase()] ?? id;

  function loadSuggestions(rawList: SuggestedTagView[]): void {
    // Guarantee "each GTM tag shown once": collapse any same-name duplicates before they reach the
    // list, the selection map, the CSV, or the create flow (belt-and-suspenders over the pipeline dedup).
    const list = dedupeViewsByGtmName(rawList);
    setSuggestions(list);
    // Default-select the real gaps; leave unticked what GA4 Enhanced Measurement already tracks AND
    // low-confidence guesses (e.g. generic "any prominent button" CTAs) so the user opts in deliberately
    // and isn't nudged into creating dozens of speculative tags.
    setSelected(Object.fromEntries(list.map((s) => [s.id, !s.enhancedMeasurementOverlap && s.confidence !== 'low'])));
    setEdits({});
    setStatuses({});
    setConfirming(false);
    setDone(null);
  }

  function applyScanResult(res: TagScanResult): void {
    setMeta(res.summary);
    setWarnings(res.warnings);
    setScanLog({ pages: res.pages, notScanned: res.notScanned, inventory: res.inventory, installed: res.installed });
    loadSuggestions(res.suggestions);
  }

  // "Single page" mode: scan ONLY the entered URL directly — no discovery, no page
  // list, straight to the tag results.
  // Suggestions stream in as each page is scanned, so the list fills one-by-one.
  const onScanProgress = (p: ScanProgressView): void => {
    // Same name-dedup on the LIVE streamed list, so a transient same-name pair never flashes mid-scan.
    const streamed = dedupeViewsByGtmName(p.suggestions);
    setSuggestions(streamed);
    setScanProgress({ scanned: p.scanned, found: streamed.length });
  };

  async function doSinglePageScan(): Promise<void> {
    const target = url.trim();
    if (!target || scanning || discovering) return;
    onError('');
    setScanning(true);
    setScanProgress(null);
    setDiscovered(null);
    loadSuggestions([]); // clear any prior scan's rows so streamed state is never stale
    try {
      applyScanResult(await window.desktop.tags.scanUrlsStream([target], { settleMs: effSettleMs(), platforms }, onScanProgress));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  // Step 1 (Main website mode): enumerate the site's pages (sitemap/crawl), then
  // the user picks which to scan. In Single-page mode, scan the one URL directly.
  // EXPERIMENTAL: screenshot the single page + let OpenAI vision pick the tags,
  // wired to the real scraped elements. Non-streaming (one page, one LLM call).
  async function doAiScan(): Promise<void> {
    const target = url.trim();
    if (!target || scanning || discovering) return;
    onError('');
    setScanning(true);
    setScanProgress(null);
    setDiscovered(null);
    loadSuggestions([]);
    try {
      applyScanResult(await window.desktop.tags.aiScan(target, { settleMs: effSettleMs(), platforms }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function doDiscover(): Promise<void> {
    const target = url.trim();
    if (!target || discovering || scanning) return;
    if (discoverMode === 'single') {
      await doSinglePageScan();
      return;
    }
    if (discoverMode === 'ai') {
      await doAiScan();
      return;
    }
    onError('');
    setDiscovering(true);
    setDiscovered(null);
    try {
      const res = await window.desktop.tags.discover(target);
      setDiscovered(res);
      // Pre-select the first 25 so a click-to-scan is immediate but bounded.
      setSelectedPages(Object.fromEntries(res.urls.map((u, i) => [u, i < 25])));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }

  // Step 2: deep-scan the selected pages with the merged engines.
  async function doScanSelected(): Promise<void> {
    const urls = (discovered?.urls ?? []).filter((u) => selectedPages[u] && !(skipBlog && isBlogUrl(u)));
    if (urls.length === 0 || scanning) return;
    onError('');
    setScanning(true);
    setScanProgress(null);
    loadSuggestions([]); // clear any prior scan's rows so streamed state is never stale
    try {
      applyScanResult(await window.desktop.tags.scanUrlsStream(urls, { settleMs: effSettleMs(), platforms }, onScanProgress));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  // Quick path: crawl + scan up to ~25 pages without the discover step.
  async function doQuickScan(): Promise<void> {
    const target = url.trim();
    if (!target || scanning) return;
    onError('');
    setScanning(true);
    setScanProgress(null);
    loadSuggestions([]); // clear any prior scan's rows so streamed state is never stale
    try {
      applyScanResult(await window.desktop.tags.scanStream(target, { maxPages: 25, maxDepth: 2, settleMs: effSettleMs(), platforms }, onScanProgress));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  async function doLoadPaste(): Promise<void> {
    onError('');
    try {
      const res = await window.desktop.tags.fromJson(pasteText);
      setMeta(null);
      setWarnings(res.warnings);
      setScanLog(null);
      loadSuggestions(res.suggestions);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  // CSV mode: read a chosen .csv file into the textarea (parsed on scan). Read locally in the renderer.
  function onCsvFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-chosen later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.onerror = () => onError('Could not read that CSV file.');
    reader.readAsText(file);
  }

  // Scan every landing-page URL in the CSV directly (no discovery), streaming suggestions as they land.
  async function doCsvScan(): Promise<void> {
    if (scanning || discovering) return;
    const urls = parseCsvUrls(csvText);
    if (!urls.length) {
      onError('No valid URLs found. Put one landing-page URL per line (or "url,label" per row).');
      return;
    }
    const capped = urls.slice(0, CSV_URL_CAP);
    onError('');
    setScanning(true);
    setScanProgress(null);
    setDiscovered(null);
    loadSuggestions([]); // clear any prior scan's rows so streamed state is never stale
    try {
      applyScanResult(await window.desktop.tags.scanUrlsStream(capped, { settleMs: effSettleMs(), platforms }, onScanProgress));
      if (capped.length < urls.length) setWarnings((w) => [`Only the first ${CSV_URL_CAP} of ${urls.length} URLs were scanned (CSV cap).`, ...w]);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  const selectedIds = suggestions.filter((s) => selected[s.id]).map((s) => s.id);
  // Live de-dup stats for the CSV box (drives the "Scan N pages" button + the unique/skipped hint).
  const csvStats = useMemo(() => parseCsvUrlStats(csvText), [csvText]);
  const csvUrlCount = discoverMode === 'csv' ? csvStats.urls.length : 0;
  // Search + type filter → the VISIBLE subset of suggestions (a view; selection is keyed by id and
  // persists across filter changes). Clicks = link/all clicks; Form = form submit; Other = everything
  // else (Google tag / pageview / video / custom event). (effective is a hoisted fn; safe to use here.)
  const kindCategory = (s: SuggestedTagView): 'click' | 'form' | 'other' =>
    s.trigger.kind === 'form_submit' ? 'form'
      : s.trigger.kind === 'all_clicks' || s.trigger.kind === 'link_click' ? 'click'
      : 'other';
  const filterQuery = search.trim().toLowerCase();
  const searchMatches = suggestions.filter((s) => {
    if (!filterQuery) return true;
    // Match on the RAW suggestion, not the effective (edited) one — otherwise renaming a tag so its new
    // text stops matching the query would drop the row and unmount the input mid-keystroke.
    return `${s.tagName} ${s.eventName} ${s.page} ${s.label} ${triggerCondition(s)} ${s.note ?? ''}`
      .toLowerCase()
      .includes(filterQuery);
  });
  const typeCounts = {
    all: searchMatches.length,
    click: searchMatches.filter((s) => kindCategory(s) === 'click').length,
    form: searchMatches.filter((s) => kindCategory(s) === 'form').length,
    other: searchMatches.filter((s) => kindCategory(s) === 'other').length,
  };
  // The ad-platform group a suggestion belongs to (GA4 covers the GA4 event tags + the GA4 Configuration;
  // Google Ads covers the conversion / remarketing / conversion-linker tags). Drives the platform filter.
  const platformGroupOf = (s: SuggestedTagView): SuggestPlatform => {
    switch (s.platform) {
      case 'meta_pixel': return 'meta';
      case 'tiktok_pixel': return 'tiktok';
      case 'linkedin_insight': return 'linkedin';
      case 'reddit_pixel': return 'reddit';
      case 'pinterest_tag': return 'pinterest';
      case 'google_ads_conversion':
      case 'google_ads_remarketing':
      case 'conversion_linker': return 'google_ads';
      default: return 'ga4'; // ga4_event, google_tag
    }
  };
  const PLATFORM_LABEL: Record<SuggestPlatform, string> = { ga4: 'GA4', meta: 'Meta', google_ads: 'Google Ads', tiktok: 'TikTok', linkedin: 'LinkedIn', reddit: 'Reddit', pinterest: 'Pinterest' };
  const PLATFORM_ORDER: SuggestPlatform[] = ['ga4', 'meta', 'google_ads', 'tiktok', 'linkedin', 'reddit', 'pinterest'];
  const platformCounts = new Map<SuggestPlatform, number>();
  for (const s of searchMatches) platformCounts.set(platformGroupOf(s), (platformCounts.get(platformGroupOf(s)) ?? 0) + 1);
  const platformsPresent = PLATFORM_ORDER.filter((g) => (platformCounts.get(g) ?? 0) > 0);
  // Ignore a stale platform filter whose platform a later scan no longer produced (else the list would
  // be stuck empty with the dropdown hidden). The dropdown binds to this too, so it never shows a phantom.
  const activePlatformFilter: SuggestPlatform | 'all' = platformFilter !== 'all' && platformsPresent.includes(platformFilter) ? platformFilter : 'all';
  const filtered = searchMatches.filter(
    (s) => (typeFilter === 'all' || kindCategory(s) === typeFilter) && (activePlatformFilter === 'all' || platformGroupOf(s) === activePlatformFilter),
  );
  // Natural order (no selection-float sort): with pagination, re-sorting selected rows to the top would
  // make ticking a checkbox on a later page relocate that row to page 1 mid-interaction. Rows stay put;
  // the checkbox column + the "N selected" count surface the picks instead.
  const visible = filtered;
  // Show 10 tags per page (m/n pager). curPage is clamped so a shrinking list can't strand an empty page.
  const PAGE_SIZE = 10;
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageItems = visible.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE);
  // "Select all / new" never selects a tag that already exists; it operates on the VISIBLE rows (so it
  // respects the active filter) and merges over prior selections so hidden rows keep their state.
  const setAll = (pred: (s: SuggestedTagView) => boolean): void =>
    setSelected((prev) => ({ ...prev, ...Object.fromEntries(visible.map((s) => [s.id, pred(s) && !alreadyExists(s)])) }));

  // Every inline edit (all table cells) is merged back into the effective tag by the shared, unit-tested
  // applyTagEdit — the create flow, dedup, and merge grouping all read this effective view.
  const effective = (s: SuggestedTagView): SuggestedTagView => applyTagEdit(s, edits[s.id]);

  // A suggestion already exists in the container if a tag of its (effective) name is
  // there, or — for the GA4 Configuration — if any GA4 base tag is already present.
  const alreadyExists = (s: SuggestedTagView): boolean =>
    existing.names.has(effective(s).tagName.trim().toLowerCase()) || (s.platform === 'google_tag' && existing.hasGa4Base);

  // Mergeable groups: >=2 click tags sending the SAME event from different {{Click Text}} equals
  // triggers (e.g. "Learn More" vs "LEARN MORE"). Offered as an opt-in merge — rows already in the
  // container (or already created this session) are excluded, since their tags can't be rewritten.
  // Grouping runs on the EFFECTIVE view (inline edits applied), so an edited event/trigger text moves
  // a row between groups instead of being silently reverted by the merge.
  const mergeGroups = findMergeGroups(
    suggestions
      .filter((s) => !alreadyExists(s) && statuses[s.id]?.state !== 'ok' && statuses[s.id]?.state !== 'exists' && statuses[s.id]?.state !== 'creating')
      .map(effective)
  );
  function doMergeGroup(g: MergeGroup): void {
    const merged = mergeGroup(g);
    // If a DIFFERENT suggestion (outside the group) already carries the derived common name, pick the
    // distinct "Variants" name — the create flow matches existing tags/triggers by name, so a collision
    // would dead-end at "already exists" or cross-wire.
    const memberIds = new Set(g.tags.map((t) => t.id));
    if (suggestions.some((s) => !memberIds.has(s.id) && effective(s).tagName.trim().toLowerCase() === merged.tagName.trim().toLowerCase())) {
      merged.tagName = `GA4 - Event - ${mergeLabel(g.eventName)} Variants Click Tag`;
    }
    const ids = new Set(g.tags.map((t) => t.id));
    const wasSelected = g.tags.some((t) => selected[t.id]);
    // The merged tag takes the FIRST member's slot so the list doesn't jump.
    setSuggestions((list) => {
      const at = Math.max(0, list.findIndex((s) => ids.has(s.id)));
      const rest = list.filter((s) => !ids.has(s.id));
      return [...rest.slice(0, Math.min(at, rest.length)), merged, ...rest.slice(Math.min(at, rest.length))];
    });
    setSelected((sel) => {
      const n = { ...sel };
      for (const id of ids) delete n[id];
      n[merged.id] = wasSelected;
      return n;
    });
    setEdits((e) => {
      const n = { ...e };
      for (const id of ids) delete n[id];
      return n;
    });
  }

  // Load the container's existing tags whenever the target is ready, then deselect
  // any suggestion that already exists (so a "create" never re-creates a duplicate).
  useEffect(() => {
    if (!targetReady || !ctx?.accountId || !ctx.containerId || !ctx.workspaceId) {
      setExisting({ names: new Set(), hasGa4Base: false });
      return;
    }
    let cancelled = false;
    window.desktop.tags.existing(ctx.accountId, ctx.containerId, ctx.workspaceId).then(
      (r) => { if (!cancelled) setExisting({ names: new Set(r.names.map((n) => n.trim().toLowerCase())), hasGa4Base: r.hasGa4Base }); },
      () => { if (!cancelled) setExisting({ names: new Set(), hasGa4Base: false }); },
    );
    return () => { cancelled = true; };
  }, [targetReady, ctx?.accountId, ctx?.containerId, ctx?.workspaceId]);

  useEffect(() => {
    if (!existing.names.size && !existing.hasGa4Base) return;
    setSelected((sel) => {
      const n = { ...sel };
      for (const s of suggestions) if (alreadyExists(s)) n[s.id] = false;
      return n;
    });
  }, [existing, suggestions]);

  // Download the suggestions as the "GTM Structure - GA4 Events" template CSV. If
  // any are selected, export those; otherwise export all. Uses effective() so the
  // exported structure reflects any inline edits.
  async function downloadStructureCsv(): Promise<void> {
    const picked = suggestions.filter((s) => selected[s.id]);
    const list = (picked.length ? picked : suggestions).map(effective);
    if (!list.length) return;
    setExportNote('');
    try {
      const csv = suggestionsToTemplateCsv(list);
      const saved = await window.desktop.tags.exportCsv('GTM Structure - GA4 Events.csv', csv);
      setExportNote(saved ? `✓ Saved ${list.length} tag(s) to ${saved}` : 'Export cancelled');
    } catch (e) {
      onError(String(e));
    }
  }

  async function confirmCreate(): Promise<void> {
    if (!targetReady || !ctx) return;
    setCreating(true);
    onError('');
    const chosen = suggestions.filter((s) => selected[s.id] && !alreadyExists(s)).map(effective);
    setStatuses((st) => {
      const n = { ...st };
      for (const s of chosen) n[s.id] = { state: 'creating' };
      return n;
    });
    setDone(null);
    setCreateProgress({ done: 0, total: chosen.length });
    try {
      const outcomes: CreateTagOutcome[] = await window.desktop.tags.createTags(
        ctx.accountId!,
        ctx.containerId!,
        ctx.workspaceId!,
        chosen,
        (p) => setCreateProgress(p),
      );
      const byId = new Map(outcomes.map((o) => [o.id, o]));
      setStatuses((st) => {
        const n = { ...st };
        for (const s of chosen) {
          const o = byId.get(s.id);
          if (!o) n[s.id] = { state: 'err', msg: 'no result' };
          else if (o.ok) n[s.id] = { state: 'ok', msg: o.triggerReused ? 'created · trigger reused' : 'created · trigger created' };
          else if (o.existing) n[s.id] = { state: 'exists', msg: 'already exists in the container' };
          else n[s.id] = { state: 'err', msg: o.error ?? 'failed' };
        }
        return n;
      });
      const created = outcomes.filter((o) => o.ok).length;
      const existing = outcomes.filter((o) => o.existing).length;
      setDone({ created, existing, failed: outcomes.length - created - existing, total: chosen.length });
      // Succeeded + already-existing rows: deselect (read-only). Failures stay selected to retry.
      setSelected((sel) => {
        const n = { ...sel };
        for (const o of outcomes) if (o.ok || o.existing) n[o.id] = false;
        return n;
      });
      // Fold the just-created tag names into the container inventory, so alreadyExists() stays
      // accurate for rows produced later in the session (e.g. a merged tag reusing a created name).
      const okNames = chosen.filter((s) => byId.get(s.id)?.ok).map((s) => s.tagName.trim().toLowerCase());
      if (okNames.length) {
        setExisting((ex) => ({
          names: new Set([...ex.names, ...okNames]),
          hasGa4Base: ex.hasGa4Base || chosen.some((s) => byId.get(s.id)?.ok && s.platform === 'google_tag'),
        }));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setStatuses((st) => {
        const n = { ...st };
        for (const s of chosen) if (n[s.id]?.state === 'creating') n[s.id] = { state: 'err', msg: 'failed' };
        return n;
      });
    } finally {
      setCreating(false);
      setConfirming(false);
      setCreateProgress(null);
    }
  }

  // "Skip blog pages" filter → the discovered pages actually shown + scannable (blog pages hidden when
  // the toggle is on). Select-all / First-N and the selected count operate on the shown set.
  const shownPages = (discovered?.urls ?? []).filter((u) => !(skipBlog && isBlogUrl(u)));
  const blogCount = (discovered?.urls ?? []).filter(isBlogUrl).length;
  const selectedPageCount = shownPages.filter((u) => selectedPages[u]).length;
  const setAllPages = (pred: (u: string, i: number) => boolean): void =>
    setSelectedPages((prev) => ({ ...prev, ...Object.fromEntries(shownPages.map((u, i) => [u, pred(u, i)])) }));

  const newCount = suggestions.filter((s) => !s.enhancedMeasurementOverlap).length;
  const emCount = suggestions.length - newCount;
  const selectedHasEmOverlap = suggestions.some((s) => selected[s.id] && s.enhancedMeasurementOverlap);
  const selectedUsesVar = suggestions.some((s) => selected[s.id] && effective(s).measurementId.includes('{{'));

  return (
    <div style={styles.reviewWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>Tag suggestions</div>
          <div style={styles.chatSub}>Scan a site for GA4 tags worth creating, review, then create them as drafts.</div>
        </div>
      </div>

      <div style={styles.reviewBody}>
        {/* Source */}
        <div style={styles.card}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            {(['site', 'single', 'ai', 'csv'] as const).map((m) => (
              <button
                key={m}
                style={discoverMode === m ? styles.toggleOn : styles.toggleOff}
                onClick={() => setDiscoverMode(m)}
                disabled={scanning || discovering || (m === 'ai' && !hasOpenAi)}
                title={m === 'ai' && !hasOpenAi ? 'Add an OpenAI API key in Settings → Providers to use this' : undefined}
              >
                {m === 'site' ? 'Main website' : m === 'single' ? 'Single page' : m === 'ai' ? '🤖 AI (single page)' : '📄 Landing pages (CSV)'}
              </button>
            ))}
            {discoverMode === 'ai' && <span style={styles.muted}>experimental · screenshots the page + reads it with OpenAI vision</span>}
            {discoverMode === 'csv' && <span style={styles.muted}>scan a list of landing-page URLs directly (no crawl)</span>}
          </div>
          {/* Pre-scan platform choice: a MULTI-SELECT — toggle any subset of ad platforms. Each selected
              platform generates its own tags from the same detected elements, sharing one trigger. */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={styles.muted}>Create tags for:</span>
            {([
              ['ga4', 'GA4'],
              ['meta', 'Meta (Facebook)'],
              ['google_ads', 'Google Ads'],
              ['tiktok', 'TikTok'],
              ['linkedin', 'LinkedIn'],
              ['reddit', 'Reddit'],
              ['pinterest', 'Pinterest'],
            ] as const).map(([p, label]) => (
              <button
                key={p}
                style={platforms.includes(p) ? styles.toggleOn : styles.toggleOff}
                onClick={() => togglePlatform(p)}
                disabled={scanning || discovering}
                aria-pressed={platforms.includes(p)}
              >
                {label}
              </button>
            ))}
          </div>
          {discoverMode === 'csv' ? (
            <>
              <textarea
                style={styles.pasteArea}
                placeholder={'Paste landing-page URLs — one per line (or "url,label" per row):\nhttps://example.com/pricing\nhttps://example.com/demo, Demo page\nexample.com/contact'}
                value={csvText}
                disabled={scanning}
                onChange={(e) => setCsvText(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <input ref={csvFileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} onChange={onCsvFile} />
                <button style={styles.ghostBtn} onClick={() => csvFileRef.current?.click()} disabled={scanning}>
                  Load .csv file
                </button>
                <label style={styles.scanNum} title="Auto = wait until each page's network goes quiet. Untick to force a fixed wait in ms.">
                  <input type="checkbox" checked={settleAuto} disabled={scanning} onChange={(e) => setSettleAuto(e.target.checked)} />
                  settle: auto
                  {!settleAuto && (
                    <input style={styles.scanNumInput} type="number" min={0} max={10000} step={500} value={settleMs} disabled={scanning} onChange={(e) => setSettleMs(e.target.value)} title="Fixed wait after load (ms)" />
                  )}
                </label>
                <button style={styles.primaryBtn} onClick={doCsvScan} disabled={scanning || csvUrlCount === 0}>
                  {scanning ? 'Scanning…' : `Scan ${Math.min(csvUrlCount, CSV_URL_CAP)} page${Math.min(csvUrlCount, CSV_URL_CAP) === 1 ? '' : 's'}`}
                </button>
                {csvText.trim() !== '' && (
                  <span style={styles.muted}>
                    {csvStats.urls.length} unique page{csvStats.urls.length === 1 ? '' : 's'} detected
                    {csvStats.duplicates > 0 ? ` (${csvStats.duplicates} duplicate${csvStats.duplicates === 1 ? '' : 's'} skipped)` : ''}
                    {csvStats.urls.length > CSV_URL_CAP ? ` · first ${CSV_URL_CAP} scanned` : ''}
                  </span>
                )}
              </div>
              <div style={{ ...styles.muted, marginTop: 8 }}>
                Scans each listed landing page directly (no crawl), merging Electron’s browser <i>and</i> a static parse
                (Cheerio) — up to {CSV_URL_CAP} pages per scan. Read-only; nothing is created until you approve.
              </div>
            </>
          ) : (
            <>
              <div style={styles.formRow}>
                <input
                  style={styles.input}
                  placeholder={discoverMode === 'single' ? 'https://example.com/pricing' : 'https://example.com'}
                  value={url}
                  disabled={scanning || discovering}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doDiscover();
                  }}
                />
                <label style={styles.scanNum} title="Auto = wait until the page's network goes quiet (adapts per page). Untick to force a fixed wait in ms.">
                  <input type="checkbox" checked={settleAuto} disabled={scanning} onChange={(e) => setSettleAuto(e.target.checked)} />
                  settle: auto
                  {!settleAuto && (
                    <input style={styles.scanNumInput} type="number" min={0} max={10000} step={500} value={settleMs} disabled={scanning} onChange={(e) => setSettleMs(e.target.value)} title="Fixed wait after load (ms)" />
                  )}
                </label>
                <button style={styles.primaryBtn} onClick={doDiscover} disabled={!url.trim() || discovering || scanning}>
                  {discoverMode === 'ai'
                    ? scanning
                      ? 'Analyzing…'
                      : '🤖 Analyze with AI'
                    : discoverMode === 'single'
                      ? scanning
                        ? 'Scanning…'
                        : 'Scan page'
                      : discovering
                        ? 'Discovering…'
                        : 'Discover pages'}
                </button>
              </div>
              <div style={styles.muted}>
                {discoverMode === 'ai'
                  ? 'Screenshots this page and asks OpenAI vision which tags to create, wired to the page’s real elements (the screenshot is sent to OpenAI). Experimental.'
                  : discoverMode === 'single'
                    ? 'Scans ONLY this page (no crawl, no sitemap) and shows its tags directly'
                    : 'First lists every page (sitemap if available, else a quick link-crawl) so you can pick which to deep-scan (up to 50 pages per scan)'}
                {' '}— merging Electron's browser <i>and</i> a static parse (Cheerio). Read-only; nothing is created until you
                approve.{' '}
                <button style={styles.linkBtn} onClick={doQuickScan} disabled={!url.trim() || scanning || discovering}>
                  quick scan (~25 pages)
                </button>{' '}
                ·{' '}
                <button style={styles.linkBtn} onClick={() => setPasteOpen((o) => !o)}>
                  {pasteOpen ? 'hide paste' : 'paste a report'}
                </button>
              </div>
            </>
          )}
          {pasteOpen && (
            <div style={{ marginTop: 8 }}>
              <textarea
                style={styles.pasteArea}
                placeholder={'Paste the JSON output of the web-audit "gtm_tag_suggestions" tool…'}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <button style={styles.ghostBtn} onClick={doLoadPaste} disabled={!pasteText.trim()}>
                Load suggestions
              </button>
            </div>
          )}
        </div>

        {/* Discovered pages → pick which to deep-scan */}
        {discovered && (
          <div style={styles.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={styles.muted}>
                Found <b style={{ color: 'var(--text)' }}>{discovered.total}</b> page(s){' '}
                {discovered.viaSitemap ? 'via sitemap' : 'via link-crawl'} · {selectedPageCount} selected
                {skipBlog && blogCount > 0 ? ` · ${blogCount} blog page${blogCount === 1 ? '' : 's'} hidden` : ''}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {blogCount > 0 && (
                  <label style={{ ...styles.muted, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }} title="Hide and skip /blog, /news and /article pages">
                    <input type="checkbox" checked={skipBlog} disabled={scanning} onChange={(e) => setSkipBlog(e.target.checked)} />
                    Skip blog pages ({blogCount})
                  </label>
                )}
                <button style={styles.linkBtn} onClick={() => setAllPages(() => false)}>Select none</button>
                <button style={styles.linkBtn} onClick={() => setAllPages((_u, i) => i < 25)}>First 25</button>
                <button style={styles.linkBtn} onClick={() => setAllPages((_u, i) => i < 50)}>First 50</button>
              </div>
            </div>
            {discovered.note && <div style={{ ...styles.muted, marginTop: 4 }}>{discovered.note}</div>}
            <div style={{ ...styles.muted, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>Existing container on this site:</span>
              {discovered.installed.containers.length > 0 || discovered.installed.measurementIds.length > 0 ? (
                <>
                  {discovered.installed.containers.map((id) => (
                    <span key={id} style={styles.typeChip} title={id}>{containerLabel(id)}</span>
                  ))}
                  {discovered.installed.measurementIds.map((id) => (
                    <span key={id} style={styles.typeChip}>{id}</span>
                  ))}
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>none detected</span>
              )}
            </div>
            {shownPages.length > 0 ? (
              <div style={styles.pageListScroll}>
                {shownPages.map((u, i) => (
                  <label key={i} style={styles.pageRow} title={u}>
                    <input
                      type="checkbox"
                      checked={!!selectedPages[u]}
                      disabled={scanning}
                      onChange={(e) => setSelectedPages((s) => ({ ...s, [u]: e.target.checked }))}
                    />
                    <span style={styles.pagePath}>{pagePathLabel(u)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div style={{ ...styles.muted, marginTop: 6 }}>
                {skipBlog && blogCount > 0
                  ? `All ${blogCount} discovered page${blogCount === 1 ? ' is a blog page' : 's are blog pages'} — untick "Skip blog pages" to include them.`
                  : 'No pages found — try the quick scan above, or check the URL.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <button style={styles.primaryBtn} onClick={doScanSelected} disabled={selectedPageCount === 0 || scanning}>
                {scanning ? 'Scanning…' : `Scan selected (${selectedPageCount})`}
              </button>
              <span style={{ color: selectedPageCount > CSV_URL_CAP ? 'var(--c-amber)' : 'var(--text-muted)', fontSize: 13 }}>
                {selectedPageCount > CSV_URL_CAP ? `Up to ${CSV_URL_CAP} pages are scanned per run — the first ${CSV_URL_CAP} of your ${selectedPageCount} selected.` : `Up to ${CSV_URL_CAP} pages per scan.`}
              </span>
            </div>
          </div>
        )}

        {/* Target */}
        <div style={styles.card}>
          <div style={styles.h2}>Create into</div>
          {targetReady && ctx ? (
            <div style={styles.muted}>
              📁 {ctx.accountName} › {ctx.containerName} › <b style={{ color: 'var(--text)' }}>{ctx.workspaceName}</b>
              &nbsp;·&nbsp; {active?.email}
            </div>
          ) : (
            <div style={{ color: 'var(--c-amber)', fontSize: 13 }}>
              Pick a GTM account, container and draft workspace in <b>Chat</b> (the bar above the messages) first, then
              return here.
            </div>
          )}
          <div style={{ ...styles.muted, marginTop: 6 }}>
            measurementId defaults to the <code style={mdStyles.code}>{'{{GA4 Measurement ID}}'}</code> variable — make
            sure it exists in this container, or edit a row to a real G-XXXX id.
          </div>
          {platforms.includes('meta') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Meta tags use the <code style={mdStyles.code}>{'{{Meta Pixel ID}}'}</code> variable — set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('pinterest') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Pinterest tags use the <code style={mdStyles.code}>{'{{Pinterest Tag ID}}'}</code> variable — set it in
              the container (or edit the Tag ID per row).
            </div>
          )}
          {platforms.includes('tiktok') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              TikTok tags use the <code style={mdStyles.code}>{'{{TikTok Pixel ID}}'}</code> variable — set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('linkedin') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              LinkedIn tags use the <code style={mdStyles.code}>{'{{LinkedIn Partner ID}}'}</code> variable — set it in
              the container (or edit the Partner ID per row).
            </div>
          )}
          {platforms.includes('reddit') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Reddit tags use the <code style={mdStyles.code}>{'{{Reddit Pixel ID}}'}</code> variable — set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('google_ads') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Google Ads conversions use the <code style={mdStyles.code}>{'{{Google Ads Conversion ID}}'}</code> and{' '}
              <code style={mdStyles.code}>{'{{Google Ads Conversion Label}}'}</code> variables — set them in the
              container (or edit each row).
            </div>
          )}
        </div>

        {/* Warnings (scan or paste) */}
        {warnings.map((w, i) => (
          <div key={i} style={{ ...styles.muted, color: 'var(--c-amber)' }}>
            ⚠ {w}
          </div>
        ))}

        {/* Scan log: what was scanned + what wasn't, so coverage is visible */}
        {scanLog && (
          <div style={styles.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={styles.muted}>
                {meta
                  ? `Scanned ${meta.pagesScanned} of ${meta.pagesCrawled} page(s) · found ${meta.formsFound} form(s), ${meta.trackableElements} trackable element(s) → ${meta.suggestions} suggestion(s)`
                  : ''}
              </div>
              <button style={styles.linkBtn} onClick={() => setShowLog((o) => !o)}>
                {showLog ? 'hide scan log' : 'show scan log'}
              </button>
            </div>
            {(scanLog.installed.containers.length > 0 || scanLog.installed.measurementIds.length > 0) && (
              <div style={{ ...styles.muted, marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>Live on this site:</span>
                {scanLog.installed.containers.map((id) => (
                  <span key={id} style={styles.typeChip} title={id}>{containerLabel(id)}</span>
                ))}
                {scanLog.installed.measurementIds.map((id) => (
                  <span key={id} style={styles.typeChip}>{id}</span>
                ))}
              </div>
            )}
            {showLog && (
              <div style={{ marginTop: 10 }}>
                {/* Forms detected (before dedup) */}
                <div style={styles.h2}>Forms detected ({scanLog.inventory.forms.length})</div>
                <table style={styles.invTable}>
                  <thead>
                    <tr>
                      <th style={styles.invTh}>Page</th>
                      <th style={styles.invTh}>Purpose</th>
                      <th style={styles.invTh}>Provider</th>
                      <th style={styles.invTh}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanLog.inventory.forms.map((f, i) => (
                      <tr key={i}>
                        <td style={styles.invTd}>{f.page}</td>
                        <td style={styles.invTd}>{f.purpose}</td>
                        <td style={styles.invTd}>{f.provider}</td>
                        <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{f.action || '—'}</td>
                      </tr>
                    ))}
                    {scanLog.inventory.forms.length === 0 && (
                      <tr>
                        <td style={styles.invTd} colSpan={4}>
                          none
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Every trackable element (before dedup into suggestions) */}
                <div style={{ ...styles.h2, marginTop: 14 }}>
                  All trackable elements ({scanLog.inventory.elements.length})
                  {scanLog.inventory.elements.length > 0 && (
                    <span style={{ textTransform: 'none', color: 'var(--text-faint)', fontWeight: 400, letterSpacing: 0 }}>
                      {' '}— {kindCountsLabel(scanLog.inventory.elements)}
                    </span>
                  )}
                </div>
                <div style={styles.invScroll}>
                  <table style={styles.invTable}>
                    <thead>
                      <tr>
                        <th style={styles.invTh}>Page</th>
                        <th style={styles.invTh}>Kind</th>
                        <th style={styles.invTh}>Text</th>
                        <th style={styles.invTh}>Href</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanLog.inventory.elements.map((e, i) => (
                        <tr key={i}>
                          <td style={styles.invTd}>{e.page}</td>
                          <td style={styles.invTd}>{e.kind}</td>
                          <td style={styles.invTd}>{(e.text || '—').slice(0, 80)}</td>
                          <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{e.href || '—'}</td>
                        </tr>
                      ))}
                      {scanLog.inventory.elements.length === 0 && (
                        <tr>
                          <td style={styles.invTd} colSpan={4}>
                            none
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ ...styles.h2, marginTop: 14 }}>Pages scanned ({scanLog.pages.length})</div>
                <ul style={styles.resultList}>
                  {scanLog.pages.map((p, i) => (
                    <li key={i} style={styles.resultRow}>
                      {p.page} — {p.forms} form(s), {p.elements} element(s)
                    </li>
                  ))}
                  {scanLog.pages.length === 0 && <li style={styles.resultRow}>none</li>}
                </ul>
                {scanLog.notScanned.length > 0 && (
                  <>
                    <div style={{ ...styles.h2, marginTop: 12 }}>Not scanned ({scanLog.notScanned.length})</div>
                    <ul style={styles.resultList}>
                      {scanLog.notScanned.slice(0, 40).map((n, i) => (
                        <li key={i} style={styles.resultRow}>
                          {n.url} — {n.reason}
                        </li>
                      ))}
                      {scanLog.notScanned.length > 40 && <li style={styles.resultRow}>…and {scanLog.notScanned.length - 40} more</li>}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Live crawl progress — the list below fills in as each page is read. */}
        {scanning && scanProgress && (
          <div style={styles.scanBanner}>
            ⏳ Scanning… {scanProgress.scanned} page(s) read · {scanProgress.found} tag(s) so far — they stream in below as each page is scanned.
          </div>
        )}

        {/* Results */}
        {suggestions.length === 0 ? (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏷</div>
            {scanning
              ? 'Reading the first page…'
              : scanLog
              ? 'No trackable forms or clicks were found on the scanned pages. Try increasing pages/depth, or open the scan log above to see what was covered.'
              : 'Scan a website to see the GA4 event tags worth creating — form submissions (with the form provider), email & phone clicks, file downloads, outbound links and CTAs.'}
          </div>
        ) : (
          <>
            <div style={styles.reviewToolbar}>
              <div style={styles.muted}>
                {meta ? `${meta.pagesScanned} page(s) scanned · ` : ''}
                {suggestions.length} suggestion(s) · {newCount} new, {emCount} already auto-tracked · {selectedIds.length}{' '}
                selected
                {meta?.websiteType === 'ecommerce' && (
                  <span
                    style={styles.ecomBadge}
                    title={meta.ecommerceEvidence?.length ? `Detected from: ${meta.ecommerceEvidence.join(', ')}` : 'Detected as an online store'}
                  >
                    🛒 eCommerce site
                  </span>
                )}
                {meta?.websiteType === 'non_ecommerce' && (
                  <span style={styles.nonEcomBadge} title="No online-store signals detected">Non-eCommerce site</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {/* Selection controls apply to both Cards and Table views (shared `selected` state). */}
                <button style={styles.linkBtn} onClick={() => setAll(() => true)}>
                  Select all
                </button>
                <button style={styles.linkBtn} onClick={() => setAll(() => false)}>
                  Select none
                </button>
                <button style={styles.linkBtn} onClick={() => setAll((s) => !s.enhancedMeasurementOverlap)}>
                  Select new only
                </button>
                <button style={styles.linkBtn} onClick={() => void downloadStructureCsv()}>
                  ⬇ Download CSV
                </button>
              </div>
            </div>
            {exportNote && <div style={{ ...styles.muted, marginTop: -4 }}>{exportNote}</div>}

            {suggestions.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                <input
                  style={{ ...styles.input, flex: 'unset', minWidth: 200, maxWidth: 320 }}
                  placeholder="Search tags by name, event, page…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span style={styles.viewToggle}>
                  {([['all', 'All'], ['click', 'Click'], ['form', 'Form'], ['other', 'Other']] as const).map(([k, label]) => (
                    <button
                      key={k}
                      style={typeFilter === k ? styles.viewToggleOn : styles.viewToggleOff}
                      onClick={() => setTypeFilter(k)}
                    >
                      {label} ({typeCounts[k]})
                    </button>
                  ))}
                </span>
                {/* Platform filter — only when a scan produced more than one ad platform. */}
                {platformsPresent.length > 1 && (
                  <select
                    value={activePlatformFilter}
                    onChange={(e) => setPlatformFilter(e.target.value as SuggestPlatform | 'all')}
                    style={styles.select}
                    title="Filter suggestions by ad platform (GA4, Meta, Google Ads, …)"
                  >
                    <option value="all">All platforms ({searchMatches.length})</option>
                    {platformsPresent.map((g) => (
                      <option key={g} value={g}>{PLATFORM_LABEL[g]} ({platformCounts.get(g)})</option>
                    ))}
                  </select>
                )}
                {(search || typeFilter !== 'all' || activePlatformFilter !== 'all') && (
                  <button style={styles.linkBtn} onClick={() => { setSearch(''); setTypeFilter('all'); setPlatformFilter('all'); }}>
                    Clear filters
                  </button>
                )}
                {visible.length !== suggestions.length && (
                  <span style={styles.muted}>Showing {visible.length} of {suggestions.length}</span>
                )}
              </div>
            )}
            {suggestions.length > 0 && visible.length === 0 && (
              <div style={styles.muted}>No tags match your search / filter.</div>
            )}

            {/* Same-event tags (e.g. "Learn More" vs "LEARN MORE") → offer an opt-in merge into ONE
                tag whose single trigger RegEx (ignore case) matches every variant. Hidden while a scan
                streams (each progress tick replaces the list, which would silently undo a merge), and
                a group is only offered while at least one member row is visible under the filters. */}
            {!scanning && mergeGroups
              .filter((g) => g.tags.some((t) => visible.some((v) => v.id === t.id)))
              .map((g) => (
                <div key={`${g.eventName}|${g.kind}`} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <span style={styles.muted}>
                    {g.texts.length} tags fire the same event <b style={{ color: 'var(--text)' }}>{g.eventName}</b>:{' '}
                    {g.texts.map((t) => `"${t}"`).join(' · ')}
                  </span>
                  <button style={styles.ghostBtn} onClick={() => doMergeGroup(g)} disabled={creating}>
                    Merge into one tag
                  </button>
                </div>
              ))}

            {visible.length === 0 ? null : (
              <>
                <div style={{ ...styles.muted, marginTop: -4 }}>
                  Tick a row to create it in GTM; edit fields inline (trigger type is fixed). Showing {curPage * PAGE_SIZE + 1}–{Math.min(visible.length, curPage * PAGE_SIZE + PAGE_SIZE)} of {visible.length} ({PAGE_SIZE} per page).
                </div>
                <SuggestionTemplateTable
                  suggestions={pageItems.map(effective)}
                  edits={edits}
                  selected={selected}
                  statuses={statuses}
                  creating={creating}
                  alreadyExists={alreadyExists}
                  onToggle={(id, v) => setSelected((sel) => ({ ...sel, [id]: v }))}
                  onEdit={(id, patch) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }))}
                />
                {pageCount > 1 && (
                  <div style={tplStyles.pager}>
                    <button style={tplStyles.pagerBtn} disabled={curPage <= 0} onClick={() => setPage(Math.max(0, curPage - 1))} aria-label="Previous page">‹ Prev</button>
                    <span style={{ minWidth: 64, textAlign: 'center' }} aria-label={`Page ${curPage + 1} of ${pageCount}`}>{curPage + 1}/{pageCount}</span>
                    <button style={tplStyles.pagerBtn} disabled={curPage >= pageCount - 1} onClick={() => setPage(Math.min(pageCount - 1, curPage + 1))} aria-label="Next page">Next ›</button>
                  </div>
                )}
              </>
            )}

            {confirming ? (
              <div style={styles.confirm}>
                <div style={styles.confirmHead}>Create {selectedIds.length} draft tag(s)?</div>
                <div style={{ ...styles.muted, margin: '6px 0', color: 'var(--c-amber)' }}>
                  Into {ctx?.containerName} › {ctx?.workspaceName}. Applies to a DRAFT workspace only — not published. You
                  publish in GTM yourself.
                  {selectedHasEmOverlap && ' Some selected tags duplicate GA4 Enhanced Measurement auto-tracking.'}
                  {selectedUsesVar && ' Some tags use the {{GA4 Measurement ID}} variable — verify it exists in this container.'}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={styles.primaryBtn} onClick={confirmCreate} disabled={creating}>
                    {creating ? 'Creating…' : `Create ${selectedIds.length} tag(s)`}
                  </button>
                  <button style={styles.ghostBtn} onClick={() => setConfirming(false)} disabled={creating}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <button
                  style={styles.primaryBtn}
                  disabled={!targetReady || scanning || selectedIds.length === 0}
                  onClick={() => setConfirming(true)}
                >
                  Approve &amp; create selected ({selectedIds.length})
                </button>
                {!targetReady && <span style={{ color: 'var(--c-amber)', fontSize: 13 }}>Pick a draft workspace first.</span>}
                {creating && createProgress && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    Creating… {createProgress.done}/{createProgress.total}
                  </span>
                )}
                {!creating && done && (
                  <span style={{ color: done.failed ? 'var(--c-amber)' : 'var(--c-green)', fontSize: 13 }}>
                    {done.created} of {done.total} created
                    {done.existing ? ` · ${done.existing} already existed` : ''}
                    {done.failed ? ` · ${done.failed} failed` : ''} — open GTM to review &amp; publish.
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────── Container audit (existing tags) ───────────────────── */

// Audit findings-filter values. Tag types use the bare GTM type string; everything else uses a
// sentinel/prefix so the dropdown can span severity, issue type, auto-fixability, and the
// trigger/variable cross-cuts without colliding with any GTM type.
const UNUSED_TRIGGER_FILTER = '__unused_triggers__';
const UNUSED_VAR_FILTER = '__unused_variables__';
const FIXABLE_FILTER = '__fixable__';
// Issue-type (finding.category) → friendly label, in display order. The "unused" category is split
// into the granular Unused-triggers / Unused-variables quick filters instead of a generic entry.
const AUDIT_CATEGORY_LABELS: Array<[string, string]> = [
  ['consent', 'Consent Mode'],
  ['security', 'Security'],
  ['firing', 'No firing trigger'],
  ['paused', 'Paused tags'],
  ['ga4', 'GA4 config'],
  ['performance', 'Performance'],
  ['deprecated', 'Deprecated'],
  ['variable', 'Broken variables'],
  ['naming', 'Naming'],
];
const AUDIT_SEVERITIES: Array<[string, string]> = [
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
  ['info', 'Info'],
];

/** Human label for the active audit filter value — used in the "nothing matches" empty state. */
function auditFilterLabel(v: string): string {
  if (v === UNUSED_TRIGGER_FILTER) return 'unused trigger';
  if (v === UNUSED_VAR_FILTER) return 'unused variable';
  if (v === FIXABLE_FILTER) return 'auto-fixable';
  if (v.startsWith('sev:')) return v.slice(4);
  if (v.startsWith('cat:')) return (AUDIT_CATEGORY_LABELS.find(([k]) => k === v.slice(4))?.[1] ?? v.slice(4)).toLowerCase();
  return gtmTypeLabel(v);
}

const SEV_BADGE: Record<string, React.CSSProperties> = {
  critical: { background: 'var(--c-red-bg)', color: 'var(--c-red)', border: '1px solid var(--c-red-border)', fontWeight: 800 },
  high: { background: 'var(--c-red-bg)', color: 'var(--c-red)', border: '1px solid var(--c-red-border)' },
  medium: { background: 'var(--c-amber-bg)', color: 'var(--c-amber)', border: '1px solid var(--c-amber-border)' },
  low: { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-2)' },
  info: { background: 'var(--c-blue-bg)', color: 'var(--c-blue)', border: '1px solid var(--c-blue-bg)' },
};
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function ContainerAuditPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [report, setReport] = useState<AuditReportView | null>(null);
  const [running, setRunning] = useState(false);
  const [fix, setFix] = useState<Record<number, { state: 'idle' | 'confirm' | 'fixing' | 'done' | 'err'; msg?: string }>>({});
  const [applyingAll, setApplyingAll] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const cancelRef = useRef(false); // set by Cancel; the batch loop checks it between fixes
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  // Bulk-delete selection (unused triggers + unused variables), keyed by finding index, plus the
  // one-shot confirmation that gates a bulk delete (the captured index list to remove).
  const [selectedDel, setSelectedDel] = useState<Record<number, boolean>>({});
  const [delConfirm, setDelConfirm] = useState<{ indices: number[] } | null>(null);

  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);

  async function runAudit(): Promise<void> {
    if (!ready || !ctx || running) return;
    onError('');
    setRunning(true);
    setFix({});
    setTypeFilter('all');
    setSearch('');
    setSelectedDel({});
    setDelConfirm(null);
    try {
      setReport(await window.desktop.gtm.audit(ctx.accountId!, ctx.containerId!, ctx.workspaceId!));
      setExportNote('');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // Download the FULL audit (all findings, worst-first) to a file the user picks — CSV
  // (a findings spreadsheet), Markdown (a shareable report), or a styled PDF (the Markdown
  // rendered through the same print pipeline as the GA4 report). Read-only; no GTM access.
  async function downloadAudit(format: 'csv' | 'md' | 'pdf'): Promise<void> {
    if (!report || exporting) return;
    setExporting(true);
    setExportNote('');
    try {
      const md = (): string =>
        auditToMarkdown(report, {
          account: ctx?.accountName,
          container: ctx?.containerName,
          workspace: ctx?.workspaceName ?? undefined,
          generatedAt: new Date().toLocaleString(),
        });
      const label = (ctx?.containerName ?? 'container').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'container';
      const saved =
        format === 'pdf'
          ? await window.desktop.gtm.exportAuditPdf(`GTM audit - ${label}`, report, {
              account: ctx?.accountName,
              container: ctx?.containerName,
              workspace: ctx?.workspaceName ?? undefined,
              generatedAt: new Date().toLocaleString(),
            })
          : await window.desktop.gtm.exportAudit(`GTM audit - ${label}.${format}`, format === 'csv' ? auditToCsv(report) : md());
      setExportNote(saved ? `✓ Saved to ${saved}` : 'Export cancelled');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  async function applyFix(
    i: number,
    f: AuditFindingView,
    override?: { tool: string; args: Record<string, unknown> },
    opts?: { skipConfirm?: boolean }
  ): Promise<void> {
    if (fix[i]?.state === 'fixing') return; // already in flight — never double-issue a write
    const toRun = override ?? f.fix;
    if (!toRun) return;
    const destructive = toRun.tool.startsWith('delete');
    // A single delete needs its two-click per-row confirm; a bulk delete is confirmed once for the
    // whole batch up front, so it passes skipConfirm to run each one straight away.
    if (destructive && !opts?.skipConfirm && fix[i]?.state !== 'confirm') {
      setFix((s) => ({ ...s, [i]: { state: 'confirm' } }));
      return;
    }
    setFix((s) => ({ ...s, [i]: { state: 'fixing' } }));
    try {
      await window.desktop.gtm.applyFix(toRun);
      setFix((s) => ({ ...s, [i]: { state: 'done' } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFix((s) => ({ ...s, [i]: { state: 'err', msg } }));
      onError(msg);
    }
  }

  const findings = [...(report?.findings ?? [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const fixable = (report?.findings ?? []).filter((f) => f.autoFixable).length;

  // Findings filter. The dropdown lists every tag type present in the findings (with counts), plus an
  // "Unused triggers" entry for the unused-trigger findings (which are about triggers, not a tag
  // type). When one is picked, both the list and the batch buttons scope to it.
  const typeCounts = new Map<string, number>();
  for (const f of findings) {
    if (f.resource?.kind === 'tag' && f.resource.type) typeCounts.set(f.resource.type, (typeCounts.get(f.resource.type) ?? 0) + 1);
  }
  const tagTypes = [...typeCounts.keys()].sort((a, b) => gtmTypeLabel(a).localeCompare(gtmTypeLabel(b)));
  const isUnusedTrigger = (f: AuditFindingView): boolean => f.category === 'unused' && f.resource?.kind === 'trigger';
  const isUnusedVariable = (f: AuditFindingView): boolean => f.category === 'unused' && f.resource?.kind === 'variable';
  const unusedTriggerCount = findings.filter(isUnusedTrigger).length;
  const unusedVarCount = findings.filter(isUnusedVariable).length;
  // Counts per severity + per issue-type (category) so each dropdown option shows how many it covers.
  const sevCounts = new Map<string, number>();
  const catCounts = new Map<string, number>();
  for (const f of findings) {
    sevCounts.set(f.severity, (sevCounts.get(f.severity) ?? 0) + 1);
    catCounts.set(f.category, (catCounts.get(f.category) ?? 0) + 1);
  }
  const sevOptions = AUDIT_SEVERITIES.filter(([k]) => (sevCounts.get(k) ?? 0) > 0);
  const catOptions = AUDIT_CATEGORY_LABELS.filter(([k]) => (catCounts.get(k) ?? 0) > 0);
  // A finding is shown when it passes BOTH the free-text search and the dropdown filter. Folding the
  // search in here means the list AND the batch fixes (which all call this) scope to it for free.
  const q = search.trim().toLowerCase();
  const typeMatches = (f: AuditFindingView): boolean => {
    if (
      q &&
      !(
        (f.resource?.name ?? '').toLowerCase().includes(q) ||
        f.message.toLowerCase().includes(q) ||
        (f.resource?.type ? gtmTypeLabel(f.resource.type).toLowerCase().includes(q) : false)
      )
    ) {
      return false;
    }
    if (typeFilter === 'all') return true;
    if (typeFilter === UNUSED_TRIGGER_FILTER) return isUnusedTrigger(f);
    if (typeFilter === UNUSED_VAR_FILTER) return isUnusedVariable(f);
    if (typeFilter === FIXABLE_FILTER) return f.autoFixable;
    if (typeFilter.startsWith('sev:')) return f.severity === typeFilter.slice(4);
    if (typeFilter.startsWith('cat:')) return f.category === typeFilter.slice(4);
    return f.resource?.type === typeFilter; // bare GTM tag type
  };

  // Bulk apply: every non-destructive auto-fix not already applied (and matching the active
  // type filter). Deletes are EXCLUDED from THIS batch — they have their own confirmed bulk path
  // (applyDeleteBatch / the "Bulk delete" toolbar) plus a per-row two-click confirm. Consent fixes
  // apply their default ("require consent" — conservative, reversible); use a row's "No extra
  // consent" for the exceptions.
  const bulkFixable = findings.filter(
    (f, i) => typeMatches(f) && f.autoFixable && f.fix && !f.fix.tool.startsWith('delete') && fix[i]?.state !== 'done'
  ).length;
  const isConsentFix = (f: AuditFindingView): boolean => f.fix?.tool === 'set_gtm_tag_consent';
  // "Require consent" batch includes ad pixels (gating a pixel is the safe direction).
  const consentFixable = findings.filter((f, i) => typeMatches(f) && f.autoFixable && isConsentFix(f) && fix[i]?.state !== 'done').length;
  // "No extra consent" batch EXCLUDES B6 ad pixels — one-click un-gating an ad pixel is a
  // compliance regression, so those keep their per-row choice.
  const noExtraFixable = findings.filter(
    (f, i) => typeMatches(f) && f.autoFixable && isConsentFix(f) && f.checkId !== 'B6-ad-pixel-consent' && fix[i]?.state !== 'done'
  ).length;
  // Unpausing a paused tag is non-destructive (set_gtm_tag_paused → paused:false), so it
  // applies with NO confirmation — offered as its own one-click batch.
  const isUnpauseFix = (f: AuditFindingView): boolean => f.fix?.tool === 'set_gtm_tag_paused';
  const pausedFixable = findings.filter((f, i) => typeMatches(f) && f.autoFixable && isUnpauseFix(f) && fix[i]?.state !== 'done').length;
  // Rows to render — keep each finding's ORIGINAL index so the per-row fix state still aligns.
  const visible = findings.map((f, i) => ({ f, i })).filter(({ f }) => typeMatches(f));

  // ── Bulk delete (unused triggers + unused variables) ──────────────────────
  // The audit's two destructive fixes — delete_gtm_trigger (unused triggers) and
  // delete_gtm_variable (unused variables) — get selection checkboxes plus "Delete selected" /
  // "Delete all" buttons. Both scope to the current filter + search via `visible`, exactly like the
  // non-destructive batches. Single deletes keep their per-row two-click confirm; a bulk delete
  // asks ONE combined confirmation instead.
  const isDeletable = (f: AuditFindingView): boolean =>
    Boolean(f.autoFixable && f.fix && f.fix.tool.startsWith('delete'));
  const deletableTargets = visible
    .filter(({ f, i }) => isDeletable(f) && fix[i]?.state !== 'done' && fix[i]?.state !== 'fixing')
    .map(({ i }) => i);
  const selectedDelTargets = deletableTargets.filter((i) => selectedDel[i]);
  // True while any per-row delete is mid-flight — used to disable the bulk entry points so a single
  // in-flight delete can't be re-issued by a bulk run (applyDeleteBatch also re-validates at run time).
  const anyFixing = Object.values(fix).some((s) => s?.state === 'fixing');
  const delTriggerCount = (idxs: number[]): number => idxs.filter((i) => findings[i].fix?.tool === 'delete_gtm_trigger').length;
  const delVariableCount = (idxs: number[]): number => idxs.filter((i) => findings[i].fix?.tool === 'delete_gtm_variable').length;
  // "X unused trigger(s) · Y unused variable(s)" — the kind breakdown for a set of delete targets.
  const delBreakdown = (idxs: number[]): string =>
    [
      delTriggerCount(idxs) > 0 ? `${delTriggerCount(idxs)} unused trigger(s)` : '',
      delVariableCount(idxs) > 0 ? `${delVariableCount(idxs)} unused variable(s)` : '',
    ]
      .filter(Boolean)
      .join(' · ');

  // Apply every non-destructive fix matching `pred`, sequentially, with per-row status and a
  // live m/n counter. Deletes are always excluded (per-row confirm only). A small pace
  // between writes keeps a big batch under GTM's per-minute quota (the IPC also retries on a
  // 429). `override` builds an alternate fix per finding (consent → notNeeded for "No extra").
  async function applyBatch(
    pred: (f: AuditFindingView, i: number) => boolean,
    override?: (f: AuditFindingView) => { tool: string; args: Record<string, unknown> }
  ): Promise<void> {
    if (applyingAll) return;
    // Resolve the work-list up front so the m/n total is exact and stable.
    const targets: number[] = [];
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (!typeMatches(f)) continue; // respect the active tag-type filter
      if (!f.autoFixable || !f.fix || f.fix.tool.startsWith('delete')) continue;
      if (fix[i]?.state === 'done' || fix[i]?.state === 'fixing') continue;
      if (!pred(f, i)) continue;
      targets.push(i);
    }
    if (targets.length === 0) return;
    cancelRef.current = false;
    setCanceling(false);
    setApplyingAll(true);
    setBatchProgress({ done: 0, total: targets.length });
    try {
      let done = 0;
      for (const i of targets) {
        if (cancelRef.current) break; // Cancel stops launching further fixes
        if (done > 0) await new Promise((r) => setTimeout(r, 400)); // pace under the per-minute quota
        await applyFix(i, findings[i], override?.(findings[i])); // one workspace write at a time
        done += 1;
        setBatchProgress({ done, total: targets.length });
      }
    } finally {
      setApplyingAll(false);
      setCanceling(false);
      cancelRef.current = false;
      setBatchProgress(null);
    }
  }

  function cancelBatch(): void {
    cancelRef.current = true;
    setCanceling(true);
  }

  // Delete every finding in `indices` (already resolved from the visible set + user-confirmed),
  // sequentially, reusing applyBatch's pacing / m-of-n counter / Cancel. This is the ONLY path that
  // runs destructive fixes in bulk, so it never auto-includes anything — the caller passes an
  // explicit list and each delete runs with skipConfirm (the batch was confirmed once already).
  async function applyDeleteBatch(indices: number[]): Promise<void> {
    // Re-validate at execution time (mirrors applyBatch): drop any captured index already deleted or
    // in flight, so a row removed via a single per-row delete while the confirm banner was open is
    // never re-issued against an already-gone resource (and the m/n total stays honest).
    const live = indices.filter((i) => fix[i]?.state !== 'done' && fix[i]?.state !== 'fixing');
    if (applyingAll || live.length === 0) return;
    cancelRef.current = false;
    setCanceling(false);
    setApplyingAll(true);
    setBatchProgress({ done: 0, total: live.length });
    try {
      let done = 0;
      for (const i of live) {
        if (cancelRef.current) break; // Cancel stops launching further deletes
        if (done > 0) await new Promise((r) => setTimeout(r, 400)); // pace under the per-minute quota
        await applyFix(i, findings[i], undefined, { skipConfirm: true });
        done += 1;
        setBatchProgress({ done, total: live.length });
      }
    } finally {
      setApplyingAll(false);
      setCanceling(false);
      cancelRef.current = false;
      setBatchProgress(null);
      setSelectedDel((s) => { const n = { ...s }; for (const i of live) delete n[i]; return n; }); // clear handled selection
    }
  }

  // A disabled button keeps its inline background, so Chromium won't auto-fade it — apply this when
  // a control is disabled so destructive buttons never look armed when they're inert.
  const disabledStyle = (d: boolean): React.CSSProperties => (d ? { opacity: 0.5, cursor: 'not-allowed' } : {});

  return (
    <div style={styles.reviewWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>Container audit</div>
          <div style={styles.chatSub}>Check the existing tags/triggers in your GTM container and fix issues (draft-only).</div>
        </div>
      </div>

      <div style={styles.reviewBody}>
        <div style={styles.card}>
          <div style={styles.muted}>
            Container:{' '}
            {ctx?.containerId ? (
              <b style={{ color: 'var(--text)' }}>
                {ctx.accountName} › {ctx.containerName} › {ctx.workspaceName ?? 'workspace?'}
              </b>
            ) : (
              <b style={{ color: 'var(--c-amber)' }}>none</b>
            )}
            {active?.email ? ` · ${active.email}` : ''}
          </div>
          {!ready && (
            <div style={{ color: 'var(--c-amber)', fontSize: 13, marginTop: 4 }}>
              {!active?.hasGoogleToken
                ? 'Sign this account into Google first.'
                : 'Pick a GTM account, container and draft workspace in the Chat tab (the GTM bar), then return here.'}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button style={styles.primaryBtn} onClick={runAudit} disabled={!ready || running}>
              {running ? 'Auditing…' : report ? 'Re-run audit' : 'Run audit'}
            </button>
          </div>
        </div>

        {report && (
          <div style={styles.card}>
            <div style={styles.muted}>
              {report.counts.tags} tag(s) · {report.counts.triggers} trigger(s) · {report.counts.variables} variable(s) ·{' '}
              <b style={{ color: report.summary.critical ? 'var(--c-red)' : report.counts.findings ? 'var(--c-amber)' : 'var(--c-green)' }}>
                {report.counts.findings} issue(s)
              </b>{' '}
              ({report.summary.critical} critical · {report.summary.high} high · {report.summary.medium} medium · {report.summary.low} low ·{' '}
              {report.summary.info} info){fixable > 0 ? ` · ${fixable} auto-fixable` : ''}
            </div>
            {report.counts.findings > 0 && (
              <div style={styles.downloadBar}>
                <span style={{ color: 'var(--text)', fontSize: 13.5, fontWeight: 600 }}>Download the full audit</span>
                <button style={{ ...styles.downloadBtn, ...disabledStyle(exporting) }} onClick={() => void downloadAudit('csv')} disabled={exporting} title="Download every finding as a CSV spreadsheet">
                  ⬇ CSV
                </button>
                <button style={{ ...styles.downloadBtn, ...disabledStyle(exporting) }} onClick={() => void downloadAudit('md')} disabled={exporting} title="Download the audit as a shareable Markdown report">
                  ⬇ Markdown
                </button>
                <button style={{ ...styles.downloadBtn, ...disabledStyle(exporting) }} onClick={() => void downloadAudit('pdf')} disabled={exporting} title="Download the audit as a styled PDF report">
                  ⬇ PDF
                </button>
                {exporting && <span style={styles.muted}>Saving…</span>}
                {exportNote && <span style={styles.muted}>{exportNote}</span>}
              </div>
            )}
            {findings.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Filter:</span>
                <select
                  value={typeFilter}
                  onChange={(e) => { setTypeFilter(e.target.value); setDelConfirm(null); }}
                  style={styles.select}
                  title="Filter findings — and scope the batch fixes — by severity, issue type, tag type, or fixability"
                >
                  <option value="all">All findings ({findings.length})</option>
                  {sevOptions.map(([k, label]) => (
                    <option key={`sev:${k}`} value={`sev:${k}`}>
                      {label} ({sevCounts.get(k)})
                    </option>
                  ))}
                  {catOptions.map(([k, label]) => (
                    <option key={`cat:${k}`} value={`cat:${k}`}>
                      {label} ({catCounts.get(k)})
                    </option>
                  ))}
                  {fixable > 0 && <option value={FIXABLE_FILTER}>Auto-fixable ({fixable})</option>}
                  {unusedTriggerCount > 0 && <option value={UNUSED_TRIGGER_FILTER}>Unused triggers ({unusedTriggerCount})</option>}
                  {unusedVarCount > 0 && <option value={UNUSED_VAR_FILTER}>Unused variables ({unusedVarCount})</option>}
                  {tagTypes.map((t) => (
                    <option key={t} value={t}>
                      {gtmTypeLabel(t)} ({typeCounts.get(t)})
                    </option>
                  ))}
                </select>
                {typeFilter !== 'all' && (
                  <button style={styles.ghostBtn} onClick={() => setTypeFilter('all')} title="Clear the filter">
                    Clear filter
                  </button>
                )}
                <input
                  type="search"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setDelConfirm(null); }}
                  placeholder="Search tags, triggers, variables…"
                  aria-label="Search audit findings by name or keyword"
                  style={{ ...styles.input, flex: '0 1 240px' }}
                />
              </div>
            )}
            {(bulkFixable > 0 || consentFixable > 0 || pausedFixable > 0 || applyingAll) && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {bulkFixable > 0 && (
                  <button
                    style={styles.primaryBtn}
                    onClick={() => applyBatch(() => true)}
                    disabled={applyingAll}
                    title="Apply every non-destructive fix at once (consent → require consent; unpause). Deletes must be confirmed per row. Re-run the audit afterwards to confirm."
                  >
                    {applyingAll ? 'Applying…' : `Apply all fixes (${bulkFixable})`}
                  </button>
                )}
                {consentFixable > 0 && (
                  <button
                    style={styles.ghostBtn}
                    onClick={() => applyBatch(isConsentFix)}
                    disabled={applyingAll}
                    title="Set 'require consent' on every consent finding at once (the ad/analytics types each tag needs)."
                  >
                    {applyingAll ? 'Applying…' : `Require consent on all (${consentFixable})`}
                  </button>
                )}
                {noExtraFixable > 0 && (
                  <button
                    style={styles.ghostBtn}
                    onClick={() =>
                      applyBatch(
                        (f) => isConsentFix(f) && f.checkId !== 'B6-ad-pixel-consent',
                        (f) => ({ tool: 'set_gtm_tag_consent', args: { ...f.fix!.args, consentStatus: 'notNeeded', consentTypes: [] } })
                      )
                    }
                    disabled={applyingAll}
                    title="Declare 'no additional consent required' on every consent finding at once — for tags that rely on Consent Mode at the Google-tag level. Advertising pixels are EXCLUDED (un-gating them is a compliance risk); use a pixel's own buttons."
                  >
                    {applyingAll ? 'Applying…' : `No extra consent on all (${noExtraFixable})`}
                  </button>
                )}
                {pausedFixable > 0 && (
                  <button
                    style={styles.ghostBtn}
                    onClick={() => applyBatch(isUnpauseFix)}
                    disabled={applyingAll}
                    title="Unpause every paused tag at once (set it live). No confirmation — unpausing is non-destructive."
                  >
                    {applyingAll ? 'Applying…' : `Unpause all paused (${pausedFixable})`}
                  </button>
                )}
                {applyingAll && (
                  <button
                    style={styles.dangerGhost}
                    onClick={cancelBatch}
                    disabled={canceling}
                    title="Stop the batch — the fix in progress finishes, then no more are applied. Already-applied fixes stay."
                  >
                    {canceling ? 'Stopping…' : 'Cancel'}
                  </button>
                )}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {applyingAll
                    ? canceling
                      ? `Stopping after the current fix… (${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0})`
                      : `Applying ${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0}… click Cancel to stop after the current fix.`
                    : 'Non-destructive fixes only — bulk delete for unused triggers / variables is below; “No extra consent” skips ad pixels.'}
                </span>
              </div>
            )}
            {deletableTargets.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Bulk delete:</span>
                <button
                  style={{ ...styles.dangerSolid, ...disabledStyle(applyingAll || anyFixing || selectedDelTargets.length === 0) }}
                  disabled={applyingAll || anyFixing || selectedDelTargets.length === 0}
                  onClick={() => setDelConfirm({ indices: selectedDelTargets })}
                  title="Delete the checked unused triggers / variables — one confirmation, then each is removed from the draft workspace."
                >
                  Delete selected ({selectedDelTargets.length})
                </button>
                <button
                  style={{ ...styles.dangerGhost, ...disabledStyle(applyingAll || anyFixing) }}
                  disabled={applyingAll || anyFixing}
                  onClick={() => setDelConfirm({ indices: deletableTargets })}
                  title="Delete every unused trigger / variable matching the current filter + search (the rows shown below)."
                >
                  Delete all in view ({deletableTargets.length})
                </button>
                {selectedDelTargets.length < deletableTargets.length ? (
                  <button
                    style={{ ...styles.linkBtn, ...disabledStyle(applyingAll || anyFixing) }}
                    disabled={applyingAll || anyFixing}
                    onClick={() => setSelectedDel((s) => { const n = { ...s }; for (const i of deletableTargets) n[i] = true; return n; })}
                  >
                    Select all
                  </button>
                ) : (
                  <button style={{ ...styles.linkBtn, ...disabledStyle(applyingAll || anyFixing) }} disabled={applyingAll || anyFixing} onClick={() => setSelectedDel({})}>
                    Select none
                  </button>
                )}
                {delBreakdown(deletableTargets) && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{delBreakdown(deletableTargets)} in view</span>
                )}
              </div>
            )}
            {delConfirm && (
              <div style={{ ...styles.confirmDanger, marginTop: 10, marginLeft: 0, marginRight: 0 }}>
                <div style={styles.confirmHead}>🗑 Delete {delConfirm.indices.length} item(s)?</div>
                <div style={{ fontSize: 13, margin: '6px 0', lineHeight: 1.5 }}>
                  {delBreakdown(delConfirm.indices) ? `${delBreakdown(delConfirm.indices)} ` : ''}
                  will be removed from the <b>draft</b> workspace (nothing is published until you publish in GTM).
                  {delVariableCount(delConfirm.indices) > 0 && (
                    <>
                      {' '}<b>Note on variables:</b> GTM refuses to delete a trigger still referenced by a tag, but it does{' '}
                      <b>not</b> refuse a referenced variable — one used only in a published version or a field the audit
                      can't read will look unused. Review before deleting.
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    style={{ ...styles.dangerSolid, ...disabledStyle(applyingAll) }}
                    disabled={applyingAll}
                    onClick={() => {
                      const idxs = delConfirm.indices;
                      setDelConfirm(null);
                      void applyDeleteBatch(idxs);
                    }}
                  >
                    Yes, delete {delConfirm.indices.length}
                  </button>
                  <button style={styles.ghostBtn} onClick={() => setDelConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {report && findings.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            No issues found — every tag has a trigger, nothing's mis-paused, nothing unused. Looks clean.
          </div>
        )}

        {findings.length > 0 && visible.length === 0 && (
          <div style={styles.empty}>
            {q ? `No findings match “${search.trim()}”.` : `No ${auditFilterLabel(typeFilter)} findings.`} Clear the filter or search to see the rest.
          </div>
        )}

        {visible.length > 0 && (
          <div style={styles.reviewList}>
            {visible.map(({ f, i }) => {
              const st = fix[i];
              const done = st?.state === 'done';
              return (
                <div key={i} style={{ ...styles.reviewRow, ...(done ? styles.reviewRowOk : {}) }}>
                  <span style={{ ...styles.badge, ...(SEV_BADGE[f.severity] ?? SEV_BADGE.info), marginTop: 2 }}>{f.severity}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {f.resource?.kind === 'tag' && (
                        <span style={{ marginRight: 6, display: 'inline-block', verticalAlign: '-2px' }} title={f.resource.type ? gtmTypeLabel(f.resource.type) : 'Tag'}>
                          <TagTypeIcon type={f.resource.type} name={f.resource.name} />
                        </span>
                      )}
                      {f.resource ? `${f.resource.name} ` : ''}
                      <span style={{ fontWeight: 700, color: 'var(--c-blue)', fontSize: 12 }}>
                        {f.resource ? `(${f.resource.kind === 'tag' && f.resource.type ? gtmTypeLabel(f.resource.type) : f.resource.kind})` : f.category}
                      </span>
                      {f.category === 'paused' && (
                        <span style={{ fontWeight: 700, color: 'var(--c-amber)', fontSize: 14, marginLeft: 6 }}>(Paused)</span>
                      )}
                    </div>
                    <div style={{ ...styles.reviewMetaLine, color: 'var(--text-dim)' }}>{f.message}</div>
                    <div style={{ ...styles.reviewEvidence, fontSize: 13, color: 'var(--text-dim)', fontStyle: 'normal', lineHeight: 1.55, background: 'var(--surface-2)', padding: '6px 9px', borderRadius: 6, marginTop: 6 }}>{f.recommendation}</div>
                    {st && st.state !== 'idle' && st.state !== 'confirm' && (
                      <div style={{ fontSize: 12, marginTop: 4, color: st.state === 'done' ? 'var(--c-green)' : st.state === 'err' ? 'var(--c-red)' : 'var(--text-muted)' }}>
                        {st.state === 'fixing' ? 'Applying…' : st.state === 'done' ? '✓ applied — re-run to confirm' : `✗ ${st.msg}`}
                      </div>
                    )}
                  </div>
                  {f.autoFixable && f.fix && !done && f.fix.tool === 'set_gtm_tag_consent' ? (
                    // Consent has two valid answers — let the user pick rather than
                    // silently forcing "require consent" (which would block GA4 under denial).
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        style={styles.ghostBtn}
                        disabled={st?.state === 'fixing'}
                        onClick={() => applyFix(i, f)}
                        title="Require these consent types before the tag fires"
                      >
                        {st?.state === 'fixing' ? '…' : 'Require consent'}
                      </button>
                      <button
                        style={styles.ghostBtn}
                        disabled={st?.state === 'fixing'}
                        onClick={() =>
                          applyFix(i, f, { tool: 'set_gtm_tag_consent', args: { ...f.fix!.args, consentStatus: 'notNeeded', consentTypes: [] } })
                        }
                        title="Declare the tag needs no additional consent (relies on Consent Mode at the Google-tag level)"
                      >
                        No extra consent
                      </button>
                    </div>
                  ) : f.autoFixable && f.fix && !done ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                      {f.fix.tool.startsWith('delete') && (
                        <input
                          type="checkbox"
                          style={{ accentColor: 'var(--c-red)', cursor: 'pointer' }}
                          checked={!!selectedDel[i]}
                          disabled={applyingAll || anyFixing}
                          onChange={(e) => setSelectedDel((s) => ({ ...s, [i]: e.target.checked }))}
                          title="Select for bulk delete"
                          aria-label={`Select ${f.resource?.name ?? 'item'} for bulk delete`}
                        />
                      )}
                      <button
                        style={f.fix.tool.startsWith('delete') ? styles.dangerGhost : styles.ghostBtn}
                        disabled={st?.state === 'fixing' || applyingAll}
                        onClick={() => applyFix(i, f)}
                      >
                        {st?.state === 'fixing'
                          ? '…'
                          : st?.state === 'confirm'
                            ? 'Confirm delete'
                            : f.fix.tool.startsWith('delete')
                              ? 'Delete'
                              : 'Apply fix'}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────── GA4 property audit (read-only) ───────────────────── */

// Area-status chip styling for the coverage row (Pass / Partial / Fail / Not Verified).
const GA4_AREA_STATUS: Record<string, { label: string; style: React.CSSProperties }> = {
  pass: { label: 'Pass', style: { background: 'var(--c-green-bg)', color: 'var(--c-green)', border: '1px solid var(--c-green-border)' } },
  partial: { label: 'Partial', style: { background: 'var(--c-amber-bg)', color: 'var(--c-amber)', border: '1px solid var(--c-amber-border)' } },
  fail: { label: 'Fail', style: { background: 'var(--c-red-bg)', color: 'var(--c-red)', border: '1px solid var(--c-red-border)' } },
  not_verified: { label: 'Not Verified', style: { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-2)' } },
};

// Create a complete SERVER-side (sGTM) container FROM the selected web container: the container +
// GA4 client + trigger + GA4 relay tag (relaying the web container's GA4 Measurement ID), and — when
// a tagging-server URL is given — records it on the server container and points the web Google tag at
// it. Draft-only, confirmation-gated; the host (Cloud Run / Stape) is deployed by the user separately.
function ServerContainerPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId);
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ServerContainerResultView | null>(null);

  // Default the new container's name from the web container ("<web> - Server"), once, when it loads.
  useEffect(() => {
    if (ctx?.containerName) setName((n) => n || `${ctx.containerName} - Server`);
  }, [ctx?.containerName]);

  async function create(): Promise<void> {
    if (!ready || !ctx || running || !name.trim()) return;
    onError('');
    setRunning(true);
    setConfirming(false);
    setResult(null);
    try {
      const r = await window.desktop.gtm.createServerContainer({
        accountId: ctx.accountId!,
        webContainerId: ctx.containerId!,
        name: name.trim(),
        serverUrl: serverUrl.trim() || undefined,
      });
      setResult(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };
  const row: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13 };

  return (
    <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Create a NEW server-side (sGTM) container from the web container above. It builds the container + GA4 client + firing trigger + GA4 relay tag (relaying this web container&apos;s GA4 Measurement ID). Paste your tagging-server URL (from Cloud Run, Stape, or your own host) to also record it on the server container and point this web container&apos;s Google tag at it. Draft-only &mdash; nothing is published, and GTM does not deploy the host.
      </div>
      {!ready && (
        <div style={{ color: 'var(--c-amber)', fontSize: 13 }}>
          {!active?.hasGoogleToken ? 'Sign this account into Google first.' : 'Pick a GTM account and the web container in the GTM bar above, then return here.'}
        </div>
      )}
      {ready && (
        <>
          <div style={{ fontSize: 13 }}>
            Base web container: <b style={{ color: 'var(--text)' }}>{ctx!.containerName}</b>
            {ctx!.containerPublicId ? <span style={{ color: 'var(--text-faint)' }}> ({ctx!.containerPublicId})</span> : null}
          </div>
          <label>
            <span style={lbl}>New server container name</span>
            <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. example.com - Server" />
          </label>
          <label>
            <span style={lbl}>Tagging server URL — optional (from Cloud Run / Stape / your host)</span>
            <input style={styles.input} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://sgtm.example.com" />
          </label>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            Leave the URL blank to create the container now and wire it later (after you deploy the host). You can set it any time from the chat with set_server_container_tagging_url.
          </div>
          {!confirming ? (
            <button style={styles.primaryBtn} disabled={running || !name.trim()} onClick={() => setConfirming(true)}>
              {running ? 'Creating…' : result ? 'Create another' : 'Create server container'}
            </button>
          ) : (
            <div style={{ ...styles.confirm }}>
              <div style={{ ...styles.muted, marginBottom: 8, color: 'var(--c-amber)' }}>
                Create a NEW server container “{name.trim()}” in this account
                {serverUrl.trim() ? ` and point ${ctx!.containerName} at ${serverUrl.trim()}` : ''}? Draft-only — not published.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={styles.primaryBtn} disabled={running} onClick={create}>{running ? 'Creating…' : 'Confirm & create'}</button>
                <button style={styles.ghostBtn} disabled={running} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )}
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <div style={{ ...row, borderColor: 'var(--c-green-border)', background: 'var(--c-green-bg)' }}>
                ✓ Created server container <b>{result.serverContainer.name}</b>{' '}
                <b style={{ color: 'var(--c-green)' }}>{result.serverContainer.publicId}</b>
              </div>
              <div style={row}>
                Built: GA4 client <b>{result.created.client}</b>, trigger <b>{result.created.trigger}</b>, GA4 relay tag <b>{result.created.serverTag}</b> → relaying <code style={mdStyles.code}>{result.measurementId}</code>.
              </div>
              <div style={row}>
                {result.serverUrlSet
                  ? <>Tagging server URL recorded on the server container{result.webWired ? <> and the web Google tag <b>{result.webWired.name}</b> now points at it.</> : <> (no Google tag found in the web container to point at it — set server_container_url on your web GA4 tag manually).</>}</>
                  : <>No server URL set yet — deploy your tagging-server host, then set its URL on the container (and point the web Google tag at it) to start sending.</>}
              </div>
              {result.webNonGa4.length > 0 && (
                <div style={{ ...row, borderColor: 'var(--c-amber-border)', background: 'var(--c-amber-bg)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--c-amber)' }}>Needs a server-side tag built by hand ({result.webNonGa4.length}):</div>
                  {result.webNonGa4.slice(0, 20).map((t, i) => (
                    <div key={i} style={{ fontSize: 12 }}>• {t.kind}: <b>{t.name}</b> <span style={{ color: 'var(--text-faint)' }}>({t.detail})</span></div>
                  ))}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Ask the chat to add these server-side (Google Ads → create_server_tag; Meta → create_meta_capi_server_tag; TikTok → create_tiktok_capi_server_tag).
                  </div>
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Open GTM to review &amp; publish the new server container. Deploy the tagging-server host (Cloud Run / Stape) if you haven&apos;t, then verify it answers before relying on it.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Pick a GA4 property (search across all accessible accounts), choose a data window,
// and run the read-only config + data-quality audit (the same ga4-audit / data-quality
// engines the chat tools use) — coverage + findings by severity. Mirrors ContainerAuditPanel,
// but GA4 has no auto-fixes (every finding is advisory).
function Ga4AuditPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [properties, setProperties] = useState<Ga4PropertyListItem[] | null>(null);
  const [loadingProps, setLoadingProps] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ property: string; displayName: string } | null>(null);
  const [days, setDays] = useState(28);
  // Custom date range (data-quality window) — used instead of `days` when `custom` is on.
  const [custom, setCustom] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Ga4PropertyAuditResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exportNote, setExportNote] = useState('');
  // Property picker is a dropdown/combobox: closed it shows the selection; open it shows search + list.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on an outside click or Escape (only while it's open).
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const signedIn = Boolean(active?.hasGoogleToken);
  // A custom range needs both bounds, start on/before end; a preset window is always valid.
  const windowValid = !custom || Boolean(startDate && endDate && startDate <= endDate);
  const todayIso = new Date().toISOString().slice(0, 10); // cap the pickers — GA4 has no future data

  async function loadProps(): Promise<void> {
    if (!signedIn) return;
    setLoadingProps(true);
    onError('');
    try {
      const next = await window.desktop.ga4.listProperties();
      setProperties(next);
      // Drop a selection that's no longer in the refreshed list (revoked/deleted) so Run audit
      // can't target a property the user can no longer see.
      setSelected((cur) => (cur && next.some((p) => p.property === cur.property) ? cur : null));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setProperties([]);
    } finally {
      setLoadingProps(false);
    }
  }
  useEffect(() => {
    void loadProps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  async function runAudit(): Promise<void> {
    if (!selected || running || !windowValid) return;
    setRunning(true);
    onError('');
    setResult(null);
    setExportNote('');
    try {
      const win = custom ? { startDate, endDate } : days;
      setResult(await window.desktop.ga4.audit(selected.property, win));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function downloadReport(format: 'pdf' | 'doc' | 'md'): Promise<void> {
    if (!result || !selected || downloading) return;
    setDownloading(true);
    setExportNote('');
    try {
      const safe = selected.displayName.replace(/[^\w .-]+/g, ' ').replace(/\s{2,}/g, ' ').trim() || 'GA4 property';
      const saved = await window.desktop.ga4.exportReport(format, `${safe} - GA4 audit`, result.markdown, result.exec ?? null, result.visuals ?? null, result.sections ?? null);
      setExportNote(saved ? `✓ Saved to ${saved}` : 'Save cancelled');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (properties ?? []).filter(
    (p) => !q || p.displayName.toLowerCase().includes(q) || p.accountName.toLowerCase().includes(q) || p.property.includes(q),
  );
  // Config + data-quality findings merged and sorted worst-first.
  const findings = result
    ? [
        ...(result.config.findings ?? []).map((f) => ({ ...f, area: 'Config' })),
        ...(result.dataQuality.findings ?? []).map((f) => ({ ...f, area: 'Data quality' })),
      ].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
    : [];
  const hasSerious = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  // Coverage = the config areas + a Data-quality area derived from its findings, so the result
  // shows WHAT was checked (Pass / Partial / Fail / Not Verified), not only the problems.
  const dqf = result?.dataQuality.findings ?? [];
  const dqStatus: 'pass' | 'partial' | 'fail' | 'not_verified' = dqf.some((f) => f.severity === 'critical' || f.severity === 'high')
    ? 'fail'
    : dqf.some((f) => f.severity === 'medium' || f.severity === 'low')
      ? 'partial'
      : 'pass';
  // `areas` is a newer field (PR #185); a stale Electron main can omit it, so default to [] rather
  // than crash on the spread (the ErrorBoundary is a backstop, but the panel should degrade in place).
  const coverage = result ? [...(result.config.areas ?? []), { area: 'Data quality', status: dqStatus }] : [];
  // The interactive visuals panel (React) + the report body (sections 2+). When the panel renders, the
  // body's duplicate Unicode Device split / Channel mix bars are stripped so the same data isn't shown twice.
  const hasVisuals = Boolean(result?.visuals && ((result.visuals.daily?.length ?? 0) > 0 || (result.visuals.devices?.length ?? 0) > 0 || (result.visuals.channels?.length ?? 0) > 0));
  // Sections 2-4 render as styled cards (result.sections); the markdown body then continues from
  // section 5. Without structured sections, fall back to the full body from section 2.
  const bodyMarker = result?.sections && result.markdown.includes('## 5 ·') ? '## 5 ·' : '## 2 ·';
  const ga4Body = result ? (result.exec && result.markdown.includes(bodyMarker) ? result.markdown.slice(result.markdown.indexOf(bodyMarker)) : result.markdown) : '';

  return (
    <div style={styles.reviewWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>GA4 property audit</div>
          <div style={styles.chatSub}>Pick a GA4 property, choose a data window, and run a read-only config + data-quality audit.</div>
        </div>
      </div>

      <div style={styles.reviewBody}>
        {!signedIn ? (
          <div style={{ color: 'var(--c-amber)', fontSize: 13 }}>Sign this account into Google first (Settings).</div>
        ) : (
          <>
            {/* Property picker — a dropdown/combobox: the trigger shows the current selection; opening
                it reveals the search box + the property list. */}
            <div style={styles.card}>
              <div style={styles.h2}>Property</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div ref={pickerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <button
                    type="button"
                    style={{ ...styles.ga4Combo, ...(pickerOpen ? styles.ga4ComboOpen : {}) }}
                    onClick={() => properties !== null && setPickerOpen((o) => !o)}
                    disabled={properties === null}
                    aria-haspopup="listbox"
                    aria-expanded={pickerOpen}
                  >
                    {selected ? (
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.displayName}</span>
                        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{selected.property.replace('properties/', '')}</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>
                        {properties === null ? (loadingProps ? 'Loading properties…' : 'No account') : 'Select a GA4 property…'}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', transition: 'transform .15s', transform: pickerOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
                  </button>
                  {pickerOpen && properties !== null && (
                    <div style={styles.ga4ComboPanel}>
                      <input
                        style={styles.input}
                        type="search"
                        autoFocus
                        placeholder="Search GA4 properties by name…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label="Search GA4 properties"
                      />
                      <div style={{ ...styles.ga4PropList, marginTop: 0, border: 'none', maxHeight: 240 }} role="listbox">
                        {filtered.length === 0 ? (
                          <div style={{ ...styles.muted, padding: '8px 12px' }}>
                            {q ? `No properties match “${query.trim()}”.` : 'No GA4 properties found for this account.'}
                          </div>
                        ) : (
                          filtered.map((p) => (
                            <button
                              key={p.property}
                              role="option"
                              aria-selected={selected?.property === p.property}
                              style={{ ...styles.ga4PropRow, ...(selected?.property === p.property ? styles.ga4PropRowOn : {}) }}
                              onClick={() => {
                                setSelected({ property: p.property, displayName: p.displayName });
                                setResult(null);
                                setPickerOpen(false);
                                setQuery('');
                              }}
                              title={p.property}
                            >
                              <span style={{ fontWeight: 600 }}>
                                {p.displayName}
                                {selected?.property === p.property ? ' ✓' : ''}
                              </span>
                              <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                                {p.accountName} · {p.property.replace('properties/', '')}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <button style={styles.ghostBtn} onClick={() => void loadProps()} disabled={loadingProps}>
                  {loadingProps ? 'Loading…' : 'Refresh'}
                </button>
              </div>
            </div>

            {/* Data window + run */}
            <div style={styles.card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Data window:</span>
                <select
                  style={styles.select}
                  value={custom ? 'custom' : String(days)}
                  onChange={(e) => {
                    setResult(null);
                    if (e.target.value === 'custom') {
                      setCustom(true);
                      // Prefill a sensible default range (the last 28 days) the first time.
                      if (!startDate || !endDate) {
                        const today = new Date();
                        const iso = (d: Date): string => d.toISOString().slice(0, 10);
                        setStartDate(iso(new Date(today.getTime() - 27 * 86400000)));
                        setEndDate(iso(today));
                      }
                    } else {
                      setCustom(false);
                      setDays(Number(e.target.value));
                    }
                  }}
                  aria-label="Data window for the audit"
                >
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="28">Last 28 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="180">Last 180 days</option>
                  <option value="365">Last 365 days</option>
                  <option value="custom">Custom range…</option>
                </select>
                {custom && (
                  <>
                    <input
                      type="date"
                      style={styles.ga4DateInput}
                      value={startDate}
                      max={endDate || todayIso}
                      onChange={(e) => { setStartDate(e.target.value); setResult(null); }}
                      aria-label="Start date"
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>to</span>
                    <input
                      type="date"
                      style={styles.ga4DateInput}
                      value={endDate}
                      min={startDate || undefined}
                      max={todayIso}
                      onChange={(e) => { setEndDate(e.target.value); setResult(null); }}
                      aria-label="End date"
                    />
                  </>
                )}
                <button style={styles.primaryBtn} onClick={() => void runAudit()} disabled={!selected || running || !windowValid}>
                  {running ? 'Auditing…' : 'Run audit'}
                </button>
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                  {custom && !windowValid
                    ? 'Pick a start and end date (start on or before end).'
                    : 'Config checks ignore the window; it scopes the data-quality pass.'}
                </span>
              </div>
            </div>

            {/* Results */}
            {result && (
              <>
                <div style={styles.card}>
                  <div style={styles.muted}>
                    {result.config.counts.dataStreams} stream(s) · {result.config.counts.keyEvents} key event(s) ·{' '}
                    {result.config.counts.customDimensions} dimension(s) · {result.config.counts.customMetrics} metric(s) ·{' '}
                    <b style={{ color: hasSerious ? 'var(--c-red)' : findings.length ? 'var(--c-amber)' : 'var(--c-green)' }}>
                      {findings.length} finding(s)
                    </b>
                  </div>
                  <div style={{ ...styles.muted, marginTop: 4 }}>
                    Data quality: {result.dataQuality.totalSessions.toLocaleString()} sessions over{' '}
                    {result.dataQuality.dateRange ?? `${result.dataQuality.windowDays} days`}.
                  </div>
                </div>

                {/* Coverage — what was checked + its status (Pass / Partial / Fail / Not Verified). */}
                <div style={styles.card}>
                  <div style={{ ...styles.muted, marginBottom: 8 }}>Coverage</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {coverage.map((a) => {
                      const st = GA4_AREA_STATUS[a.status] ?? GA4_AREA_STATUS.not_verified;
                      return (
                        <span key={a.area} style={{ ...styles.ga4AreaChip, ...st.style }}>
                          {a.area}: {st.label}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {/* Full templated report (doc format) + download as PDF / Word / Markdown. */}
                {result.markdown ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13, marginRight: 2 }}>Download report:</span>
                      <button style={styles.primaryBtn} onClick={() => void downloadReport('pdf')} disabled={downloading}>⬇ PDF</button>
                      {downloading && <span style={styles.muted}>Saving…</span>}
                      {exportNote && <span style={styles.muted}>{exportNote}</span>}
                    </div>
                    {result.exec && (
                      <div style={{ ...styles.card }} dangerouslySetInnerHTML={{ __html: execSummaryHtml(result.exec) }} />
                    )}
                    {result.visuals && hasVisuals && (
                      <div style={{ ...styles.card }}>
                        <Ga4Charts visuals={result.visuals} />
                      </div>
                    )}
                    {result.sections ? (
                      // Sections 2-9 render as styled cards; the markdown body is only a fallback.
                      <div style={{ ...styles.card }} dangerouslySetInnerHTML={{ __html: ga4SectionsHtml(result.sections) }} />
                    ) : (
                      <div style={{ ...styles.card, lineHeight: 1.5 }}>
                        <Markdown text={hasVisuals ? stripDuplicateCharts(ga4Body) : ga4Body} />
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ ...styles.card, ...styles.muted, lineHeight: 1.5 }}>
                    The full report document isn’t available from this audit run. Fully close the app and
                    restart <code>npm run dev</code> (the Electron main process doesn’t hot-reload after a
                    pull), then run the audit again to get the downloadable report.
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Settings ─────────────────────────── */

function SettingsView({
  active,
  google,
  info,
  selfTest,
  onError,
  run,
  refresh,
}: {
  active: AccountView | undefined;
  google: GoogleClientStatus | null;
  info: AppInfo | null;
  selfTest: SecretSelfTest | null;
  onError: (m: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(loadTheme());
  const setTheme = (t: Theme): void => {
    setThemeState(t);
    saveTheme(t);
    applyTheme(t);
  };
  // Single source of truth for app-level provider keys so the Language-model hint and the Providers editor
  // never disagree — a key change in one updates the other immediately, and a probe failure surfaces.
  const [provStatus, setProvStatus] = useState<ProviderStatus | null>(null);
  useEffect(() => {
    window.desktop.providers.status().then(setProvStatus).catch((e) => onError(String(e)));
  }, []);
  return (
    <div style={styles.settings}>
      <h1 style={styles.settingsTitle}>Settings</h1>

      <section style={styles.card}>
        <h2 style={styles.h2}>Appearance</h2>
        <div style={{ ...styles.kv, borderBottom: 'none' }}>
          <span>Theme</span>
          <div style={styles.toggle}>
            <button style={theme === 'dark' ? styles.toggleActive : styles.toggleBtn} onClick={() => setTheme('dark')}>
              🌙 Dark
            </button>
            <button style={theme === 'light' ? styles.toggleActive : styles.toggleBtn} onClick={() => setTheme('light')}>
              ☀️ Light
            </button>
          </div>
        </div>
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Google sign-in (OAuth client)</h2>
        <OAuthClientCard google={google} />
      </section>

      {active ? (
        <>
          <section style={styles.card}>
            <h2 style={styles.h2}>Active account</h2>
            <div style={styles.kv}><span>Email</span><b>{active.email}</b></div>
            <div style={styles.kv}>
              <span>Google</span>
              <b style={{ color: active.hasGoogleToken ? 'var(--c-green)' : 'var(--text-muted)' }}>
                {active.hasGoogleToken ? '✓ signed in' : 'not connected'}
              </b>
            </div>
            <div style={{ ...styles.kv, borderBottom: 'none' }}>
              <span>Added</span>
              <b style={{ fontWeight: 500, color: 'var(--text-dim)' }}>{new Date(active.createdAt).toLocaleDateString()}</b>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {active.hasGoogleToken && (
                <button style={styles.ghostBtn} onClick={() => run(() => window.desktop.google.disconnect(active.id))}>
                  Disconnect Google
                </button>
              )}
              <button style={styles.dangerGhost} onClick={() => run(() => window.desktop.accounts.remove(active.id))}>
                Remove account
              </button>
            </div>
          </section>

          <section style={styles.card}>
            <h2 style={styles.h2}>Language model</h2>
            <p style={styles.settingsSub}>The model this account uses for chat. Pick a preset or choose Custom to enter any model id.</p>
            {/* key by account id so switching accounts re-reads the newly active account's saved config. */}
            <LlmEditor key={active.id} account={active} provStatus={provStatus} onChange={refresh} onError={onError} />
          </section>
        </>
      ) : (
        <section style={styles.card}>
          <h2 style={styles.h2}>Active account</h2>
          <p style={styles.muted}>Connect a Google account from the sidebar to configure it.</p>
        </section>
      )}

      <section style={styles.card}>
        <h2 style={styles.h2}>Providers (API keys)</h2>
        <ProvidersEditor status={provStatus} onStatus={setProvStatus} onChange={refresh} onError={onError} />
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Diagnostics</h2>
        {selfTest && (
          <div style={styles.kv}>
            <span>Secret store (DPAPI)</span>
            <b style={{ color: selfTest.ok ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 500 }}>
              {selfTest.ok ? '✓ working' : `✗ ${selfTest.detail}`}
            </b>
          </div>
        )}
        {info && (
          <>
            <div style={styles.kv}><span>App</span><b>{info.name} {info.version}</b></div>
            <div style={{ ...styles.kv, borderBottom: 'none' }}>
              <span>Runtime</span>
              <b style={{ fontWeight: 500, color: 'var(--text-dim)', textAlign: 'right' }}>
                Electron {info.electron} · Chrome {info.chrome} · Node {info.node} · {info.platform}
              </b>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function LlmEditor({
  account,
  provStatus,
  onChange,
  onError,
}: {
  account: AccountView;
  /** Shared app-level key status (single source of truth from SettingsView) — null until loaded. */
  provStatus: ProviderStatus | null;
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const initialProvider = account.llm?.provider ?? 'openai';
  const initialModel = account.llm?.model ?? DEFAULT_MODEL[initialProvider];
  const [provider, setProvider] = useState<LlmProvider>(initialProvider);
  const [model, setModel] = useState(initialModel);
  // Custom-vs-preset is STICKY state, not derived — so typing a custom id that transiently equals a preset
  // (e.g. "gpt-4o" on the way to "gpt-4o-2024-11-20") never collapses the input mid-edit.
  const [customMode, setCustomMode] = useState(
    () => initialModel.trim() !== '' && !MODEL_OPTIONS[initialProvider].some((o) => o.id === initialModel)
  );
  const [saved, setSaved] = useState('');

  const presets = MODEL_OPTIONS[provider];
  // Live app-level key status for the SELECTED provider; fall back to the account's saved flag only for its
  // own provider (and only until the shared status loads).
  const hasKey = provStatus?.[provider] ?? (account.llm?.provider === provider ? Boolean(account.llm?.hasApiKey) : false);

  function changeProvider(p: LlmProvider): void {
    setProvider(p);
    setModel(DEFAULT_MODEL[p]); // a listed preset
    setCustomMode(false);
  }
  function changeModelSelect(value: string): void {
    if (value === CUSTOM_MODEL) {
      setCustomMode(true);
      setModel('');
    } else {
      setCustomMode(false);
      setModel(value);
    }
  }
  async function save(): Promise<void> {
    const m = model.trim();
    if (!m) {
      onError('Enter a model id (or pick a preset).');
      return;
    }
    try {
      await window.desktop.accounts.setLlmConfig(account.id, provider, m);
      await onChange();
      setSaved('Saved');
      setTimeout(() => setSaved(''), 1500);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={styles.formRow}>
        <select style={styles.select} value={provider} onChange={(e) => changeProvider(e.target.value as LlmProvider)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
        <select
          style={{ ...styles.select, flex: 1, minWidth: 180 }}
          value={customMode ? CUSTOM_MODEL : model}
          onChange={(e) => changeModelSelect(e.target.value)}
        >
          {presets.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          <option value={CUSTOM_MODEL}>Custom…</option>
        </select>
        <button style={styles.ghostBtn} onClick={save}>
          Save
        </button>
      </div>
      {customMode && (
        <div style={styles.formRow}>
          <input
            style={styles.input}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="exact model id (e.g. gpt-4.1-mini)"
            autoFocus
          />
        </div>
      )}
      <div style={styles.muted}>
        API key: {hasKey ? `✓ using the app-level ${provider} key` : `not set (add the ${provider} key under Providers below)`}
        {saved && <span style={{ color: 'var(--c-green)' }}> · {saved}</span>}
      </div>
    </div>
  );
}

function ProvidersEditor({
  status,
  onStatus,
  onChange,
  onError,
}: {
  /** Shared app-level key status from SettingsView (null until loaded). */
  status: ProviderStatus | null;
  /** Push the new status up so the Language-model hint updates immediately after a key change. */
  onStatus: (s: ProviderStatus) => void;
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const providers: LlmProvider[] = ['openai', 'anthropic', 'gemini'];
  const [keys, setKeys] = useState<Record<string, string>>({});
  const st = status ?? ({} as ProviderStatus);

  async function save(p: LlmProvider): Promise<void> {
    try {
      onStatus(await window.desktop.providers.setKey(p, keys[p] ?? ''));
      setKeys((k) => ({ ...k, [p]: '' }));
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear(p: LlmProvider): Promise<void> {
    try {
      onStatus(await window.desktop.providers.clearKey(p));
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <p style={styles.muted}>One key per provider, shared by all accounts. Stored encrypted (DPAPI).</p>
      {providers.map((p) => (
        <div key={p} style={styles.formRow}>
          <span style={{ width: 90, fontSize: 13, alignSelf: 'center', textTransform: 'capitalize' }}>
            {p} {st[p] ? '✓' : ''}
          </span>
          <input
            style={styles.input}
            type="password"
            value={keys[p] ?? ''}
            onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
            placeholder={st[p] ? 'key saved (enter to replace)' : 'API key'}
          />
          <button style={styles.ghostBtn} onClick={() => save(p)}>
            Save
          </button>
          {st[p] && (
            <button style={styles.dangerGhost} onClick={() => clear(p)}>
              Clear
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function OAuthClientCard({ google }: { google: GoogleClientStatus | null }): JSX.Element {
  if (!google) return <p style={styles.muted}>Checking…</p>;
  if (!google.configured) {
    return (
      <div style={styles.warn}>
        <strong>Not configured.</strong> Create a Google “Desktop app” OAuth client, then drop a file at:
        <pre style={styles.codeBlock}>{google.configPath}</pre>
        <code>{'{ "clientId": "…apps.googleusercontent.com", "clientSecret": "…" }'}</code>
      </div>
    );
  }
  const source = google.source === 'env' ? 'Environment variable' : google.source === 'file' ? 'Config file' : 'unknown';
  // The client id itself is intentionally not shown. When its shape looks off we still warn — without
  // rendering the value.
  const shapeOff = google.clientIdLooksValid === false;
  return (
    <>
      <div style={styles.kv}><span>Status</span><b style={{ color: 'var(--c-green)', fontWeight: 500 }}>✓ Configured</b></div>
      <div style={{ ...styles.kv, borderBottom: shapeOff ? '1px solid var(--border)' : 'none' }}>
        <span>Loaded from</span><b style={{ fontWeight: 500, color: 'var(--text-dim)' }}>{source}</b>
      </div>
      {shapeOff && (
        <div style={{ ...styles.kv, borderBottom: 'none' }}>
          <span>Client ID</span>
          <b style={{ color: 'var(--c-amber)', fontWeight: 500 }}>⚠ unexpected shape</b>
        </div>
      )}
    </>
  );
}

/* ─────────────────────────── Styles ─────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    margin: 0,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    color: 'var(--text)',
    background: 'var(--bg)',
  },
  sidebar: {
    width: 248,
    flexShrink: 0,
    background: 'var(--surface)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    boxSizing: 'border-box',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 },
  logo: { width: 34, height: 34, borderRadius: 9, background: '#2563eb', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 },
  brandName: { fontWeight: 700 },
  brandSub: { fontSize: 11, color: 'var(--text-faint)' },
  sideLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-faint)', margin: '4px 0 8px' },
  accountList: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 },
  sideMuted: { color: 'var(--text-faint)', fontSize: 13, padding: '6px 4px' },
  acctBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid transparent', borderRadius: 8, padding: '8px 10px', color: 'var(--text-dim)', cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  acctBtnActive: { background: 'var(--surface-3)', border: '1px solid var(--border-2)', color: 'var(--text)' },
  acctEmail: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  acctEditBtn: { flexShrink: 0, fontSize: 12, color: 'var(--text-faint)', padding: '0 2px', cursor: 'pointer', lineHeight: 1 },
  acctRenameInput: { flex: 1, minWidth: 0, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '3px 7px', fontSize: 13, fontFamily: 'inherit' },
  connectBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer', marginTop: 8 },
  connectRow: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'stretch' },
  cancelBtn: { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer' },
  sideWarn: { color: 'var(--c-amber)', fontSize: 11, marginTop: 8 },
  sideNav: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 },
  navItem: { background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 10px', color: 'var(--text-dim)', cursor: 'pointer', textAlign: 'left', fontSize: 14 },
  navActive: { background: 'var(--surface-3)', color: 'var(--text)' },
  sideVersion: { color: 'var(--text-faint)', fontSize: 11, marginTop: 10 },

  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  gtmWorkspace: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  subTabs: { display: 'flex', gap: 8, padding: '10px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  subTabOn: { background: 'var(--c-blue-bg)', color: 'var(--text)', border: '1px solid var(--c-blue-bg)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  subTabOff: { background: 'transparent', color: 'var(--c-blue)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13 },
  betaBadge: { marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--c-amber)', background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 6, padding: '1px 5px', verticalAlign: 'middle' },

  promptsWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  promptsHead: { padding: '14px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  promptSearch: { width: '100%', boxSizing: 'border-box', marginTop: 10, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit' },
  promptFilters: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  promptChip: { background: 'transparent', color: 'var(--c-blue)', border: '1px solid var(--border-2)', borderRadius: 999, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  promptChipOn: { background: 'var(--c-blue-bg)', color: 'var(--text)', border: '1px solid var(--c-blue-bg)', borderRadius: 999, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 },
  promptsBody: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 },
  promptGroupTitle: { fontSize: 12, fontWeight: 700, color: 'var(--c-blue)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  promptList: { display: 'flex', flexDirection: 'column', gap: 8 },
  promptCard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' },
  promptText: { fontSize: 13, color: 'var(--text)', lineHeight: 1.45 },
  promptActions: { display: 'flex', gap: 6, flexShrink: 0 },
  promptUse: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
  promptCopy: { background: 'transparent', color: 'var(--c-blue)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' },
  errorBar: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  errorClose: { background: 'transparent', border: 'none', color: 'var(--c-red)', cursor: 'pointer' },
  monitorBarCrit: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarWarn: { background: 'var(--c-amber-bg)', borderBottom: '1px solid var(--c-amber-border)', color: 'var(--c-amber)', padding: '9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarBtn: { background: 'transparent', border: '1px solid currentColor', color: 'inherit', borderRadius: 7, padding: '3px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },

  chatWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  chatHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' },
  // Segmented control (chat GTM/GA4 switch + Settings theme): inner padding + gap so the active
  // option reads as a distinct blue pill inside the track — the selected side is unmistakable.
  toggle: { display: 'inline-flex', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 9, overflow: 'hidden', padding: 2, gap: 2 },
  toggleBtn: { background: 'transparent', color: 'var(--text-dim)', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 7 },
  toggleActive: { background: '#2563eb', color: '#fff', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', borderRadius: 7, boxShadow: '0 1px 3px rgba(37,99,235,0.45)' },
  chatTitle: { fontWeight: 600 },
  chatSub: { fontSize: 12, color: 'var(--text-faint)', marginTop: 2 },
  ctxBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 20px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-dim)' },
  ctxBarEdit: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  ctxSelect: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '6px 8px', fontSize: 13, maxWidth: 200 },
  chatLog: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: 'var(--text-faint)', textAlign: 'center', maxWidth: 420, margin: '60px auto', lineHeight: 1.6, flexShrink: 0 },
  userMsg: { alignSelf: 'flex-end', background: '#2563eb', color: '#fff', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14 },
  asstMsg: { alignSelf: 'flex-start', background: 'var(--surface-2)', color: 'var(--text)', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14, border: '1px solid var(--border)' },
  msgTime: { fontSize: 11, color: 'var(--text-faint)', margin: '3px 4px 0', userSelect: 'none' },
  toolTrace: { color: 'var(--c-blue)', fontSize: 11, marginBottom: 4 },
  toolErrors: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  toolErrorLine: { background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)', color: 'var(--c-red)', borderRadius: 8, padding: '6px 9px', fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' },
  composer: { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid var(--border)', alignItems: 'flex-end' },
  composerInput: {
    flex: 1,
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border-2)',
    borderRadius: 12,
    padding: '11px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    lineHeight: 1.45,
    resize: 'none',
    overflowY: 'auto',
    maxHeight: 160,
    boxSizing: 'border-box',
  },
  sendBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 12, padding: '11px 18px', fontSize: 14, cursor: 'pointer', height: 44 },
  stopBtn: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 12, padding: '11px 18px', fontSize: 14, cursor: 'pointer', height: 44 },
  revertBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', margin: '0 0 8px', background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 10 },
  revertText: { fontSize: 13, color: 'var(--text-dim)' },
  revertBtn: { background: 'transparent', color: 'var(--c-amber)', border: '1px solid var(--c-amber)', borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },

  confirm: { background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: 'var(--c-amber)' },
  confirmDanger: { background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: 'var(--c-red)' },
  confirmHead: { fontWeight: 700 },
  proposalRows: { background: 'var(--bg)', borderRadius: 8, padding: '4px 12px', margin: '6px 0 10px' },
  proposalRow: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 13 },
  proposalLabel: { color: 'var(--text-muted)' },
  proposalValue: { color: 'var(--text)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' },
  editRow: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  editInput: { flex: 1, maxWidth: 320, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '6px 9px', fontSize: 13 },
  confirmNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 8 },
  viewToggle: { display: 'inline-flex', border: '1px solid var(--border-2)', borderRadius: 7, overflow: 'hidden' },
  viewToggleOn: { background: 'var(--c-blue-bg)', color: 'var(--text)', border: 'none', cursor: 'pointer', fontSize: 12, padding: '3px 10px' },
  viewToggleOff: { background: 'transparent', color: 'var(--c-blue)', border: 'none', cursor: 'pointer', fontSize: 12, padding: '3px 10px' },

  settings: { flex: 1, overflowY: 'auto', padding: 24, maxWidth: 720 },
  settingsTitle: { fontSize: 22, fontWeight: 700, margin: '0 0 16px' },
  settingsSub: { color: 'var(--text-muted)', fontSize: 12.5, margin: '-4px 0 12px', lineHeight: 1.5 },
  card: { background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 16, flexShrink: 0 },
  h2: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '0 0 12px' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 14 },
  warn: { background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 10, padding: 14, marginBottom: 16, color: 'var(--c-amber)', lineHeight: 1.5 },
  diag: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: 'var(--text-muted)', fontSize: 12 },
  codeBlock: { background: 'var(--bg)', padding: '6px 8px', borderRadius: 6, color: 'var(--text)', overflowX: 'auto' },
  formRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  select: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  input: { flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  ghostBtn: { background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  toggleOn: { background: '#1d4ed8', color: '#fff', border: '1px solid #2563eb', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
  toggleOff: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
  dangerGhost: { background: 'transparent', color: 'var(--c-red)', border: '1px solid var(--c-red-border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  dangerSolid: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  resultList: { listStyle: 'none', margin: '12px 0 0', padding: 0 },
  resultRow: { padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13, fontFamily: 'ui-monospace, monospace' },
  muted: { color: 'var(--text-faint)', fontSize: 13 },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },
  // "Download the full audit" bar — a tinted, bordered strip so the export is an obvious call to
  // action rather than a faint text link. Its buttons are solid but a touch smaller than primaryBtn
  // so the "Apply all fixes" CTA still reads as the primary action.
  downloadBar: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 14px', background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.55)', borderRadius: 10 },
  downloadBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 },

  // Tag-suggestion review panel.
  reviewWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  reviewBody: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  pasteArea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 120,
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border-2)',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    resize: 'vertical',
    marginBottom: 8,
  },
  scanNum: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', flex: '0 0 auto' },
  scanNumInput: { width: 52, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 8px', fontSize: 13 },
  scanSelect: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 8px', fontSize: 13 },
  scanBanner: { fontSize: 13, color: 'var(--c-cyan)', background: 'var(--c-cyan-bg)', border: '1px solid var(--c-cyan-border)', borderRadius: 8, padding: '8px 12px', flexShrink: 0 },
  reviewToolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 },
  reviewList: { display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', flexShrink: 0 },
  reviewRow: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' },
  reviewRowOk: { borderLeft: '3px solid var(--c-green)', background: 'var(--c-green-bg)' },
  reviewRowHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  reviewMetaLine: { color: 'var(--text-muted)', fontSize: 13, marginTop: 3, lineHeight: 1.5 },
  reviewEvidence: { color: 'var(--text-faint)', fontSize: 12, marginTop: 3, fontStyle: 'italic' },
  badge: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, borderRadius: 6, padding: '1px 7px' },
  typeChip: { fontSize: 11, color: 'var(--c-blue)', background: 'var(--c-blue-bg)', border: '1px solid var(--c-blue-bg)', borderRadius: 6, padding: '1px 7px' },
  emChip: { fontSize: 11, color: 'var(--c-amber)', background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 6, padding: '1px 7px' },
  existsChip: { fontSize: 11, color: 'var(--c-cyan)', background: 'var(--c-cyan-bg)', border: '1px solid var(--c-cyan-border)', borderRadius: 6, padding: '1px 7px' },
  ecomBadge: { fontSize: 11, fontWeight: 600, color: 'var(--c-green)', background: 'var(--c-green-bg)', border: '1px solid var(--c-green-border)', borderRadius: 6, padding: '1px 7px', marginLeft: 8, whiteSpace: 'nowrap' },
  nonEcomBadge: { fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 7px', marginLeft: 8, whiteSpace: 'nowrap' },
  editGrid: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8, background: 'var(--bg)', borderRadius: 8, padding: '4px 12px' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 12, rowGap: 3, marginTop: 5, fontSize: 12.5, color: 'var(--text-dim)', alignItems: 'start' },
  detailKey: { color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, paddingTop: 1 },
  invScroll: { maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 },
  invTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' },
  invTh: { textAlign: 'left', padding: '5px 8px', color: 'var(--text-faint)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface-alt)' },
  invTd: { padding: '4px 8px', borderBottom: '1px solid var(--surface-2)', color: 'var(--text-dim)', verticalAlign: 'top', overflow: 'hidden', textOverflow: 'ellipsis' },
  pageListScroll: { maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 8, padding: '4px 0' },
  pageRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12.5, cursor: 'pointer' },
  pagePath: { fontFamily: 'ui-monospace, monospace', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  // GA4 Audit panel — property picker list.
  ga4PropList: { maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 8, display: 'flex', flexDirection: 'column' },
  ga4PropRow: { display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 12px', cursor: 'pointer', color: 'var(--text)', fontSize: 13 },
  ga4PropRowOn: { background: 'var(--c-blue-bg)' },
  // Combobox trigger + dropdown panel for the property picker.
  ga4Combo: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, textAlign: 'left', fontFamily: 'inherit' },
  ga4ComboOpen: { borderColor: 'var(--c-blue)', boxShadow: '0 0 0 2px var(--c-blue-bg)' },
  ga4ComboPanel: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 },
  ga4DateInput: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', colorScheme: 'light dark' },
  ga4AreaChip: { fontSize: 11.5, borderRadius: 7, padding: '3px 9px', fontWeight: 600, whiteSpace: 'nowrap' },
};
