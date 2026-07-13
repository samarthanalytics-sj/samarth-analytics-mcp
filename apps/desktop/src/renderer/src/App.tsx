import { useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle, useTheme } from './ThemeToggle';
import { ShortcutsOverlay, EmptyState } from './ui';
import { ChatIcon, GtmLogo, Ga4Logo, PromptsIcon, SettingsIcon } from './NavIcons';
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
  VerifyTagInput,
  VerifyTagsResult,
  VerifyTagsOptions,
  VerifyProgressView,
  FormTagVerifyPlanResult,
  SubmitFormVerifyResult,
} from '../../shared/ipc';
import { suggestionToGroup, suggestionsToTemplateCsv, suggestionsToInstallRunbookMarkdown, installPlanNeedsAction, installPlanProgress, dedupeViewsByGtmName, TEMPLATE_HEADERS, applyTagEdit, TAG_TYPE_OPTIONS, STANDARD_TRIGGER_VARIABLES, CONDITION_LABELS, type TagEdit, type TriggerWhen, type InstallProgress } from '../../shared/tag-template';
import { findMergeGroups, mergeGroup, mergeLabel, type MergeGroup } from '../../shared/tag-merge';
import { parseCsvUrls, parseCsvUrlStats, CSV_URL_CAP } from '../../shared/csv-urls';
import { resolveChatInput, slashMenuMatches, type SlashCommand } from '../../shared/chat-commands';
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

type View = 'chat' | 'gtm' | 'ga4' | 'prompts' | 'settings';
type GtmTab = 'suggestions' | 'audit' | 'verify' | 'server';
type Ga4Tab = 'audit' | 'monitoring';

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

/** A fenced code block rendered as a boxed snippet with a Copy button. An optional
 *  `ariaLabel` describes the block for screen readers (used by the install panel). */
function CodeBlock({ code, ariaLabel }: { code: string; ariaLabel?: string }): JSX.Element {
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
      <button style={mdStyles.copyBtn} onClick={copy} title="Copy to clipboard" aria-label={ariaLabel ? `Copy ${ariaLabel}` : 'Copy to clipboard'}>
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <pre style={mdStyles.pre} role="group" aria-label={ariaLabel}>
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
  // Keyboard-shortcuts help overlay (opened with ?).
  const [showShortcuts, setShowShortcuts] = useState(false);
  // GA4 Tools sub-tab is lifted to App (unlike GTM Tools' local state) so the cross-tab monitor
  // alert banner can deep-link straight to the Monitoring sub-tab.
  const [ga4Tab, setGa4Tab] = useState<Ga4Tab>('audit');
  // A prompt picked from the Prompts tab to drop into the chat input (nonce so re-picks fire).
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number; product?: 'gtm' | 'ga4' } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  // Cross-tab GA4 monitoring banner: a background run with NEW issues surfaces here on any tab.
  const [monitorAlert, setMonitorAlert] = useState<Ga4MonitorRun | null>(null);
  // Accounts whose Google token expired/was revoked this session (backend cleared them) — one
  // dismissible "Re-connect" banner each. Rendering filters to accounts still disconnected, so a
  // successful reconnect auto-hides its banner and a cancelled one keeps it (no premature clear).
  const [reauthIds, setReauthIds] = useState<string[]>([]);
  // Inline rename of an account's sidebar label (pencil → input; Enter saves, Escape cancels).

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
    // A dead Google token (invalid_grant) was just cleared by the backend — surface a
    // reconnect prompt for that account (refresh() already ran via accounts:changed).
    const offReauth = window.desktop.accounts.onAuthExpired(({ id }) => setReauthIds((prev) => (prev.includes(id) ? prev : [...prev, id])));
    return () => { off(); offRun(); offReauth(); };
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

  // Global keyboard shortcuts: Ctrl/Cmd+1..5 switch the primary view (even while typing); "?" toggles
  // the shortcuts overlay (ignored while typing so "?" still types into inputs).
  useEffect(() => {
    const VIEWS: View[] = ['chat', 'gtm', 'ga4', 'prompts', 'settings'];
    const isTyping = (el: EventTarget | null): boolean => {
      const t = el as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key >= '1' && e.key <= '5') {
        const v = VIEWS[Number(e.key) - 1];
        if (v) { e.preventDefault(); setView(v); }
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === '?') { e.preventDefault(); setShowShortcuts((s) => !s); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={styles.app}>
      <ThemeToggle />
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <div style={styles.logo}>S</div>
          <div>
            <div style={styles.brandName}>Samarth</div>
            <div style={styles.brandSub}>GTM / GA4 Desktop</div>
          </div>
        </div>

        {/* Active account (read-only). Switching, connect, rename and remove all live in Settings →
            Accounts now, so the sidebar stays a clean shell. Clicking the chip jumps to Settings. */}
        <button
          style={styles.activeAcct}
          onClick={() => setView('settings')}
          title={active ? `${active.email} — manage accounts in Settings` : 'Add an account in Settings'}
        >
          {active ? (
            <>
              <span style={{ ...styles.dot, background: active.hasGoogleToken ? 'var(--c-green)' : 'var(--text-faint)' }} />
              <span style={styles.activeAcctName}>{active.displayName || active.email}</span>
              <span style={styles.activeAcctManage}>Manage ›</span>
            </>
          ) : (
            <span style={styles.sideMuted}>No account · add in Settings</span>
          )}
        </button>
        {google && !google.configured && (
          <div style={styles.sideWarn}>OAuth client not set — see Settings.</div>
        )}

        <div style={{ flex: 1 }} />

        <div style={styles.sideNav}>
          {([
            ['chat', 'Chat', ChatIcon],
            ['gtm', 'GTM Tools', GtmLogo],
            ['ga4', 'GA4 Tools', Ga4Logo],
            ['prompts', 'Prompts', PromptsIcon],
            ['settings', 'Settings', SettingsIcon],
          ] as Array<[View, string, () => JSX.Element]>).map(([v, label, Icon]) => (
            <button
              key={v}
              className="nav-item"
              data-active={view === v ? 'true' : 'false'}
              style={{ ...styles.navItem, ...(view === v ? styles.navActive : {}) }}
              onClick={() => setView(v)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          ))}
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
            <button style={styles.monitorBarBtn} onClick={() => { setView('ga4'); setGa4Tab('monitoring'); setMonitorAlert(null); }}>View</button>
            <button style={styles.errorClose} onClick={() => setMonitorAlert(null)}>✕</button>
          </div>
        )}

        {reauthIds
          .map((id) => accounts.find((a) => a.id === id && !a.hasGoogleToken))
          .filter((a): a is AccountView => Boolean(a))
          .map((a) => (
            <div key={a.id} style={styles.monitorBarCrit}>
              <span style={{ flex: 1 }}>
                🔑 Google session expired for <b>{a.email}</b> — reads/writes will fail until you re-connect. Testing-mode consent screens expire tokens every 7 days.
              </span>
              <button
                style={styles.monitorBarBtn}
                disabled={connecting}
                onClick={async () => { await run(() => window.desktop.accounts.setActive(a.id)); await connect(); }}
              >
                {connecting ? 'Connecting…' : 'Re-connect'}
              </button>
              <button style={styles.errorClose} onClick={() => setReauthIds((prev) => prev.filter((x) => x !== a.id))}>✕</button>
            </div>
          ))}

        {/* ChatView stays MOUNTED across tab switches (hidden, not unmounted) so an in-flight
            response keeps streaming and the conversation isn't lost when you pop into GTM Tools. */}
        <div style={{ display: view === 'chat' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ChatView key={active?.id ?? 'none'} active={active} onError={setError} refresh={refresh} seed={chatSeed} />
        </div>
        {/* Keyed by view so each switch replays the fade+lift entrance (smooth page transition). Chat is
            excluded — it lives in the always-mounted div above so its stream survives tab switches. */}
        {view !== 'chat' && (
          <div key={view} className="view-enter" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {view === 'gtm' ? (
          <GtmToolsView key={active?.id ?? 'none'} active={active} onError={setError} refresh={refresh} />
        ) : view === 'ga4' ? (
          <Ga4ToolsView key={active?.id ?? 'none'} active={active} onError={setError} tab={ga4Tab} setTab={setGa4Tab} />
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
            accounts={accounts}
            connect={connect}
            connecting={connecting}
            cancelConnect={cancelConnect}
            google={google}
            info={info}
            selfTest={selfTest}
            onError={setError}
            run={run}
            refresh={refresh}
          />
        ) : null}
          </div>
        )}
      </main>
      {showShortcuts && (
        <ShortcutsOverlay
          onClose={() => setShowShortcuts(false)}
          shortcuts={[
            { keys: ['Ctrl', '1'], label: 'Go to Chat' },
            { keys: ['Ctrl', '2'], label: 'Go to GTM Tools' },
            { keys: ['Ctrl', '3'], label: 'Go to GA4 Tools' },
            { keys: ['Ctrl', '4'], label: 'Go to Prompts' },
            { keys: ['Ctrl', '5'], label: 'Go to Settings' },
            { keys: ['?'], label: 'Show / hide this help' },
            { keys: ['Esc'], label: 'Close dialogs' },
          ]}
        />
      )}
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
function chatThreadKey(accountId: string | undefined, product: 'gtm' | 'ga4', scopeId: string | undefined): string {
  // GTM threads key on the selected container, GA4 threads on the selected property - switching the
  // working target switches to (or starts) that target's own conversation.
  return `${accountId ?? 'none'}|${product}|${scopeId ?? 'na'}`;
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
  // Slash-command autocomplete: highlighted index in the menu; reset whenever the input text changes.
  const [slashIdx, setSlashIdx] = useState(0);
  // One stored conversation per account + product + container; survives tab switches + restarts.
  const threadKey = chatThreadKey(active?.id, product, product === 'gtm' ? active?.gtmContext?.containerId : active?.ga4Context?.property);
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
  // Reset the slash-menu highlight when the query text changes (typing narrows/refills the menu).
  useEffect(() => { setSlashIdx(0); }, [input]);

  // Accept a slash command from the menu: fill the box with "/name " and, if it needs a different
  // toolset (e.g. /report → GA4), flip the product NOW so the thread is settled before the user sends.
  const acceptSlash = (cmd: SlashCommand): void => {
    setInput(`/${cmd.name} `);
    if (cmd.product && cmd.product !== product) setProduct(cmd.product);
    taRef.current?.focus();
  };

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

  // Slash-command autocomplete: which commands to offer for the current input, and the clamped highlight.
  const slashMatches = ready && !busy ? slashMenuMatches(input) : [];
  const slashActive = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    // Expand a slash command (/audit, /report, …) into the full instruction, and DISPLAY the short
    // command while SENDING the expansion. A command whose toolset lives in the other product flips it
    // first (keep the command in the box; the user presses Enter again once the thread has settled).
    const resolved = resolveChatInput(text, product);
    if (resolved.product !== product) { setProduct(resolved.product); return; }
    onError('');
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    const now = Date.now();
    setMessages((m) => [...m, { role: 'user', text: resolved.display, ts: now }, { role: 'assistant', text: '', tools: [], ts: now }]);
    setInput('');
    setBusy(true);
    setRevertable(null);
    try {
      await window.desktop.llm.chatStream(history, resolved.sent, product, (ev) => {
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
      {product === 'ga4' && active && <Ga4ContextBar active={active} refresh={refresh} onError={onError} />}

      <div style={styles.chatLog}>
        {messages.length === 0 && (
          <EmptyState
            icon="💬"
            title="Ask about your GTM & GA4"
            hint={'Try “list my GTM accounts”, “run a GA4 report for last 28 days”, or “create an email-click event tag”.'}
          />
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

      <div style={{ ...styles.composer, position: 'relative' }}>
        {slashMatches.length > 0 && (
          <div className="sheet-in" style={styles.slashMenu} role="listbox" aria-label="Slash commands">
            <div style={styles.slashMenuHead}>Commands</div>
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === slashActive}
                style={{ ...styles.slashItem, ...(i === slashActive ? styles.slashItemActive : {}) }}
                onMouseEnter={() => setSlashIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); acceptSlash(c); }}
              >
                <span style={styles.slashName}>/{c.name} <span style={styles.slashHint}>{c.hint}</span></span>
                <span style={styles.slashDesc}>{c.desc}</span>
              </button>
            ))}
            <div style={styles.slashMenuFoot}>↑↓ navigate · Enter select · Esc dismiss</div>
          </div>
        )}
        <textarea
          ref={taRef}
          style={styles.composerInput}
          placeholder={ready ? 'Message, or / for commands…  (Enter to send, Shift+Enter for a new line)' : hint}
          value={input}
          disabled={!ready || busy}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // When the slash menu is open, the arrow/Enter/Tab/Esc keys drive it instead of the textarea.
            if (slashMatches.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((slashActive + 1) % slashMatches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((slashActive - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSlash(slashMatches[slashActive]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
            }
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

/** One option in a SearchableSelect: a stable value, a display label, and an optional monospace hint
 *  shown after the label (e.g. a container's GTM-XXXX public id) that is ALSO matched by the search. */
interface SearchOption { value: string; label: string; hint?: string }

/** A native-<select> replacement with a type-to-filter search box — so picking from dozens of GTM
 *  accounts / containers / workspaces doesn't mean scrolling a long native list. Opens a popover with an
 *  autofocused search input + a filtered, keyboard-navigable list (↑/↓/Enter, Esc/outside-click closes).
 *  Purely presentational: value/onChange are controlled by the caller exactly like the <select> it
 *  replaces, so the existing pick* handlers are unchanged. */
function SearchableSelect({
  value, options, onChange, placeholder, disabled, chosen, searchPlaceholder, minWidth = 200,
}: {
  value: string;
  options: SearchOption[];
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  chosen?: boolean;
  searchPlaceholder?: string;
  minWidth?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q))
    : options;

  // Close on outside click / Escape (only while open, so we don't keep global listeners around).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // On open: clear the query, reset the highlight, and focus the search box.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (v: string): void => { onChange(v); setOpen(false); };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        style={{
          ...styles.ctxSelect,
          ...(chosen ? styles.ctxSelectChosen : {}),
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
          minWidth, width: '100%', maxWidth: 260, textAlign: 'left',
        }}
        title={selected?.label ?? placeholder}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text)' : 'var(--text-muted)' }}>
          {selected ? selected.label : placeholder}{selected?.hint ? ` (${selected.hint})` : ''}
        </span>
        <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 60,
            minWidth: '100%', width: 'max-content', maxWidth: 360,
            background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8,
            boxShadow: '0 10px 28px rgba(0,0,0,0.30)', overflow: 'hidden',
          }}
        >
          <div style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[active]; if (o) choose(o.value); }
              }}
              placeholder={searchPlaceholder ?? 'Search…'}
              style={{ ...styles.ctxSelect, width: '100%', maxWidth: 'none', boxSizing: 'border-box', background: 'var(--surface-2)' }}
            />
          </div>
          <div ref={listRef} style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>No matches</div>
            ) : (
              filtered.map((o, i) => (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  style={{
                    padding: '7px 10px', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6,
                    background: i === active ? 'var(--surface-3)' : 'transparent',
                    color: o.value === value ? 'var(--c-blue)' : 'var(--text)',
                    fontWeight: o.value === value ? 600 : 400,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{o.label}</span>
                  {o.hint && <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>{o.hint}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
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

  const loadContainers = async (accountId: string): Promise<void> => {
    if (!accountId) return;
    setLoading('containers');
    try {
      const list = await window.desktop.data.listGtmContainers(accountId);
      setContainers(list);
      // A silent empty dropdown looks broken — tell the user WHY nothing populated.
      if (list.length === 0) {
        onError('No GTM containers found for this account. This Google sign-in may not have access to its containers — check you picked the right account, or re-connect Google in Settings.');
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  };
  const loadWorkspaces = async (accountId: string, containerId: string): Promise<void> => {
    if (!accountId || !containerId) return;
    setLoading('workspaces');
    try {
      setWorkspaces(await window.desktop.data.listGtmWorkspaces(accountId, containerId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  };

  // THE FIX: load containers whenever an account is selected — a MANUAL pick OR an account carried over
  // from the saved context (the dropdown shows it, but NO onChange fires, so the fetch never ran → the
  // container dropdown stayed empty). Ref-guarded so each account fetches once (also dedupes React
  // StrictMode's double-mount). Same for workspaces once a container is selected.
  const loadedForAccount = useRef<string>('');
  const loadedForContainer = useRef<string>('');
  useEffect(() => {
    if (editing && sel.accountId && loadedForAccount.current !== sel.accountId) {
      loadedForAccount.current = sel.accountId;
      void loadContainers(sel.accountId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, sel.accountId]);
  useEffect(() => {
    const key = sel.accountId && sel.containerId ? `${sel.accountId}/${sel.containerId}` : '';
    if (editing && key && loadedForContainer.current !== key) {
      loadedForContainer.current = key;
      void loadWorkspaces(sel.accountId!, sel.containerId!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, sel.accountId, sel.containerId]);

  function pickAccount(accountId: string): void {
    const acc = accounts.find((a) => a.accountId === accountId);
    setSel({ accountId, accountName: acc?.name });
    setContainers([]);
    setWorkspaces([]);
    // containers load via the effect above — the single fetch path (also covers a pre-selected account)
  }

  function pickContainer(containerId: string): void {
    const c = containers.find((x) => x.containerId === containerId);
    setSel((s) => ({ ...s, containerId, containerName: c?.name, containerPublicId: c?.publicId, workspaceId: undefined, workspaceName: undefined }));
    setWorkspaces([]);
    // workspaces load via the effect above
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
        <span style={styles.ctxBreadcrumb}>
          <span style={styles.ctxMutedLabel}>Working in</span>
          <span style={styles.ctxCrumb}>📁 {ctx.accountName}</span>
          <span style={styles.ctxSep}>›</span>
          {/* The selected container is highlighted in a blue pill so it reads as the active target. */}
          <span style={styles.ctxContainerPill} title={ctx.containerPublicId ? `${ctx.containerName} (${ctx.containerPublicId})` : ctx.containerName}>
            {ctx.containerName}{ctx.containerPublicId ? <span style={styles.ctxPillId}> {ctx.containerPublicId}</span> : null}
          </span>
          <span style={styles.ctxSep}>›</span>
          <span style={styles.ctxWorkspacePill}>{ctx.workspaceName ?? 'workspace?'}</span>
        </span>
        <button style={styles.ctxChangeBtn} onClick={() => { setSel(ctx); setEditing(true); }}>
          ✎ Change
        </button>
      </div>
    );
  }

  return (
    <div style={styles.ctxBarEdit}>
      <span style={styles.ctxMutedLabel}>Working in</span>
      {/* Each dropdown is labelled so it's clear which level you're picking; the container gets a blue
          "chosen" highlight the moment it's selected, and Workspace unlocks only after a container. */}
      <div style={styles.ctxField}>
        <span style={styles.ctxFieldLabel}>Account</span>
        <SearchableSelect
          value={sel.accountId ?? ''}
          chosen={!!sel.accountId}
          onChange={(v) => void pickAccount(v)}
          placeholder="Select account…"
          searchPlaceholder="Search accounts…"
          options={accounts.map((a) => ({ value: a.accountId, label: a.name }))}
        />
      </div>
      <div style={styles.ctxField}>
        <span style={styles.ctxFieldLabel}>Container</span>
        <SearchableSelect
          value={sel.containerId ?? ''}
          chosen={!!sel.containerId}
          disabled={!sel.accountId || loading === 'containers'}
          onChange={(v) => void pickContainer(v)}
          placeholder={loading === 'containers' ? 'Loading…' : !sel.accountId ? 'Pick an account first' : 'Select container…'}
          searchPlaceholder="Search by name or GTM-ID…"
          options={containers.map((c) => ({ value: c.containerId, label: c.name, ...(c.publicId ? { hint: c.publicId } : {}) }))}
        />
      </div>
      <div style={styles.ctxField}>
        <span style={styles.ctxFieldLabel}>Workspace</span>
        <SearchableSelect
          value={sel.workspaceId ?? ''}
          chosen={!!sel.workspaceId}
          disabled={!sel.containerId || loading === 'workspaces'}
          onChange={(v) => pickWorkspace(v)}
          placeholder={loading === 'workspaces' ? 'Loading…' : !sel.containerId ? 'Pick a container first' : 'Select workspace…'}
          searchPlaceholder="Search workspaces…"
          options={workspaces.map((w) => ({ value: w.workspaceId, label: w.name }))}
        />
      </div>
      <button style={{ ...styles.ctxUseBtn, ...(!sel.containerId ? styles.ctxUseBtnDisabled : {}) }} onClick={save} disabled={!sel.containerId}>
        ✓ Use this container
      </button>
      {ctx?.containerId && (
        <button style={styles.linkBtn} onClick={() => setEditing(false)}>cancel</button>
      )}
    </div>
  );
}

/** Which GA4 property the GA4 chat works against — the GA4 mirror of GtmContextBar, so the active
 *  target is always visible above the conversation. ONE dropdown (every reachable property, grouped
 *  by GA4 account, name + numeric id) + the same summary-pill-with-Change pattern. Persisted on the
 *  account (ga4Context) and injected into the chat system prompt so the model never asks "which
 *  property?". */
function Ga4ContextBar({
  active,
  refresh,
  onError,
}: {
  active: AccountView;
  refresh: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const ctx = active.ga4Context;
  const [editing, setEditing] = useState(!ctx?.property);
  const [props, setProps] = useState<Ga4PropertyListItem[]>([]);
  const [sel, setSel] = useState<string>(ctx?.property ?? '');
  const [loading, setLoading] = useState(false);
  // Free-text filter over the property list (name, account, or numeric id) — accounts with many
  // properties make an unfiltered dropdown unusable.
  const [query, setQuery] = useState('');

  // Load the property list when the picker opens (ref-guarded per account, same pattern as the GTM
  // bar: also covers React StrictMode's double-mount).
  const loadedForAccount = useRef<string>('');
  useEffect(() => {
    if (editing && loadedForAccount.current !== active.id) {
      loadedForAccount.current = active.id;
      setLoading(true);
      window.desktop.ga4
        .listProperties()
        .then((list) => {
          setProps(list);
          // A silent empty dropdown looks broken — tell the user WHY nothing populated.
          if (list.length === 0) {
            onError('No GA4 properties found for this account. This Google sign-in may not have access to any GA4 property — check you picked the right account, or re-connect Google in Settings.');
          }
        })
        .catch((e) => onError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, active.id]);

  // Group by parent GA4 account so the dropdown reads like the GA4 UI's property switcher; the
  // search box narrows it first (match on property name, account name, or the numeric id).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props;
    return props.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q) ||
        (p.accountName ?? '').toLowerCase().includes(q) ||
        p.property.replace('properties/', '').includes(q)
    );
  }, [props, query]);
  const groups = useMemo(() => {
    const m = new Map<string, Ga4PropertyListItem[]>();
    for (const p of filtered) {
      const k = p.accountName || '(no account)';
      const arr = m.get(k) ?? [];
      arr.push(p);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [filtered]);
  // Typing down to exactly ONE match selects it — Enter/✓ then confirms without touching the dropdown.
  useEffect(() => {
    if (query.trim() && filtered.length === 1) setSel(filtered[0].property);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filtered]);

  async function save(): Promise<void> {
    const p = props.find((x) => x.property === sel);
    if (!p) return;
    try {
      await window.desktop.accounts.setGa4Context(active.id, { property: p.property, propertyName: p.displayName, accountName: p.accountName });
      await refresh();
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!editing && ctx?.property) {
    return (
      <div style={styles.ctxBar}>
        <span style={styles.ctxBreadcrumb}>
          <span style={styles.ctxMutedLabel}>Working in</span>
          {ctx.accountName ? (
            <>
              <span style={styles.ctxCrumb}>📊 {ctx.accountName}</span>
              <span style={styles.ctxSep}>›</span>
            </>
          ) : null}
          {/* The selected property is highlighted in a blue pill so it reads as the active target. */}
          <span style={styles.ctxContainerPill} title={`${ctx.propertyName ?? ''} (${ctx.property})`}>
            {ctx.propertyName ?? ctx.property}
            <span style={styles.ctxPillId}> #{(ctx.property ?? '').replace('properties/', '')}</span>
          </span>
        </span>
        <button style={styles.ctxChangeBtn} onClick={() => { setSel(ctx.property ?? ''); setEditing(true); }}>
          ✎ Change
        </button>
      </div>
    );
  }

  return (
    <div style={styles.ctxBarEdit}>
      <span style={styles.ctxMutedLabel}>Working in</span>
      <label style={styles.ctxField}>
        <span style={styles.ctxFieldLabel}>Search</span>
        <input
          style={{ ...styles.ctxSelect, width: 170 }}
          type="text"
          placeholder="🔍 Name, account or id…"
          value={query}
          disabled={loading}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sel && filtered.some((p) => p.property === sel)) void save();
          }}
        />
      </label>
      <label style={styles.ctxField}>
        <span style={styles.ctxFieldLabel}>GA4 property{query.trim() ? ` (${filtered.length} match${filtered.length === 1 ? '' : 'es'})` : ''}</span>
        <select style={{ ...styles.ctxSelect, ...(sel ? styles.ctxSelectChosen : {}) }} value={sel} disabled={loading} onChange={(e) => setSel(e.target.value)}>
          <option value="">{loading ? 'Loading…' : query.trim() && filtered.length === 0 ? 'No property matches the search' : 'Select property…'}</option>
          {groups.map(([acct, list]) => (
            <optgroup key={acct} label={acct}>
              {list.map((p) => (
                <option key={p.property} value={p.property}>
                  {p.displayName} (#{p.property.replace('properties/', '')})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <button style={{ ...styles.ctxUseBtn, ...(!sel ? styles.ctxUseBtnDisabled : {}) }} onClick={() => void save()} disabled={!sel}>
        ✓ Use this property
      </button>
      {ctx?.property && (
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
  // The table is its OWN scroll viewport in BOTH axes: maxWidth:100% keeps it inside the flex column,
  // maxHeight caps it so the horizontal scrollbar sits at the bottom of the VISIBLE table (always
  // reachable) instead of stranded below a tall table; flexShrink:0 stops the flex column from
  // compressing it; and the sticky header (th/selTh) keeps the column labels in view while rows scroll.
  wrap: { overflow: 'auto', maxWidth: '100%', maxHeight: 'calc(100vh - 300px)', border: '1px solid var(--border)', borderRadius: 12, flexShrink: 0 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12, color: 'var(--text-dim)' },
  th: { position: 'sticky', top: 0, zIndex: 2, textAlign: 'left', padding: '8px 10px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  td: { padding: '6px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', whiteSpace: 'normal', wordBreak: 'break-word' },
  tdTag: { padding: '6px 10px', borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--c-blue-bg)', verticalAlign: 'top', background: 'var(--surface-2)' },
  selTh: { position: 'sticky', top: 0, zIndex: 3, width: 56, textAlign: 'center', padding: '8px 8px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' },
  selTd: { padding: '6px 8px', textAlign: 'center', verticalAlign: 'top', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', whiteSpace: 'nowrap' },
  // Editable cells are auto-growing WRAPPING textareas (see GrowCell) so a long tag name / regex
  // value wraps to multiple lines and stays fully visible instead of being clipped in a 1-line input.
  cellInput: { width: '100%', minWidth: 150, boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 6px', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.35, resize: 'none', overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'block' },
  cellSelect: { width: '100%', minWidth: 120, boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 4px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  pager: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--text-muted)' },
  pagerBtn: { background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 7, padding: '4px 12px', fontSize: 13, cursor: 'pointer' },
  // ── "How to install" panel (the site-side requirements a suggestion's trigger needs to fire) ──
  // A status chip (colour-coded by install status) doubles as the expand toggle — background/border/
  // colour are set inline per status so it reads at a glance without opening the panel.
  installChip: { display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, border: '1px solid transparent', cursor: 'pointer', lineHeight: 1.3 },
  installTd: { padding: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' },
  // The panel is capped + scrolls internally so a long <script> never widens the table.
  installPanel: { maxWidth: '100%', overflowX: 'auto', padding: '10px 14px', boxSizing: 'border-box' },
  installReq: { border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: 'var(--surface)' },
  installReqOk: { border: '1px solid var(--c-green-border)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: 'var(--c-green-bg)' },
  installReqLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 4 },
  installDetail: { fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.4 },
  installMeta: { fontSize: 12, color: 'var(--text-dim)', margin: '2px 0' },
  // "Create listener tag" action row on a listener-tag requirement.
  installActions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  installCreateBtn: { background: 'var(--c-blue)', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  installCreateBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  // An OPTIONAL improvement (html-attribute) — a quiet muted row, NOT a mandatory-looking box, so it
  // never contradicts a "fires natively" line above it.
  installOptional: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 },
  optionalPill: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 20, padding: '1px 8px', flexShrink: 0 },
  installOptionalText: { fontSize: 12, color: 'var(--text-dim)', flex: 1, lineHeight: 1.4 },
  installInfo: { fontSize: 13, color: 'var(--text-muted)', cursor: 'help', flexShrink: 0 },
  // "Show code" disclosure — collapses a listener/site-code snippet so the panel stays short.
  installDisclosure: { background: 'transparent', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: 11, padding: '2px 0', marginTop: 4 },
  // "Mark done" check-off on site-code / optional rows — a manual toggle the user ticks once the work is
  // done on their site (the app can't verify site-side code), turning the row + the row chip green.
  installCheck: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', marginTop: 8, userSelect: 'none' },
  installDoneText: { color: 'var(--c-green)', fontWeight: 600 },
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

// ── "How to install" panel ────────────────────────────────────────────────────
// Read-only surface for a suggestion's structured install plan: the site-side
// requirement(s) a tag's trigger needs to actually fire (a listener tag / an HTML
// attribute / site code), or a green "nothing to install" when GTM's native
// trigger already sees the event. Show/copy only — no create button in this phase.
type InstallPlanView = NonNullable<SuggestedTagView['install']>;
type InstallReqView = InstallPlanView['requires'][number];

/** GTM trigger the listener tag attaches to → human wording. */
const FIRES_LABEL: Record<Extract<InstallReqView, { kind: 'listener-tag' }>['tag']['fires'], string> = {
  all_pages: 'All Pages',
  dom_ready: 'DOM Ready',
  window_loaded: 'Window Loaded',
};

/** A "Show code" disclosure — keeps a listener/site-code snippet collapsed by default so the panel stays
 *  short; the CodeBlock (with its own copy button) appears only on demand. */
function CollapsibleCode({ code, ariaLabel }: { code: string; ariaLabel: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" style={tplStyles.installDisclosure} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? '▾ Hide code' : '▸ Show code'}
      </button>
      {open && <CodeBlock code={code} ariaLabel={ariaLabel} />}
    </div>
  );
}

/** Colour + label for the install-status chip, computed against the plan's live "done" progress. Tones
 *  map to the theme's status ramps: green = ready / done, blue = a 1-click listener, amber = site code.
 *  Once every REQUIRED step is checked off, the chip flips to a green "✓ Done" regardless of kind. */
function installChipView(p: InstallProgress): { label: string; bg: string; border: string; color: string } {
  const GREEN = { bg: 'var(--c-green-bg)', border: 'var(--c-green-border)', color: 'var(--c-green)' };
  const BLUE = { bg: 'var(--c-blue-bg)', border: 'var(--c-blue-border)', color: 'var(--c-blue)' };
  const AMBER = { bg: 'var(--c-amber-bg)', border: 'var(--c-amber-border)', color: 'var(--c-amber)' };
  const optLeft = p.optionalTotal - p.optionalDone;
  // Nothing actionable (defensive — the chip isn't rendered for a pure-ready plan).
  if (p.requiredTotal === 0 && p.optionalTotal === 0) return { label: 'Ready to fire', ...GREEN };
  // Required steps still outstanding → the demanding chip (amber site code beats blue listener).
  if (p.requiredTotal > 0 && !p.allRequiredDone) {
    if (p.kind === 'code') return { label: 'Needs site code', ...AMBER };
    const left = p.requiredTotal - p.requiredDone;
    return { label: `${left} listener tag${left === 1 ? '' : 's'} to create`, ...BLUE };
  }
  // Required done (or none). If there were required steps, that's a green "✓ Done"; a form that only
  // fires natively with optional tips stays "Ready" until the tips are applied too.
  if (p.requiredTotal > 0) return { label: optLeft > 0 ? `✓ Done · ${optLeft} optional left` : '✓ Done', ...GREEN };
  return optLeft > 0 ? { label: `Ready · ${optLeft} optional tip${optLeft === 1 ? '' : 's'}`, ...GREEN } : { label: '✓ Done', ...GREEN };
}

/** The row-cell status chip that doubles as the "How to install" expand toggle. Its colour + label
 *  summarise the whole plan (against the live "done" check-offs) so the user can triage without opening
 *  the panel — and it turns green "✓ Done" once every required step is checked off. */
function InstallChip({ install, done, open, onClick, tagName }: { install: InstallPlanView; done: Record<number, boolean>; open: boolean; onClick: () => void; tagName: string }): JSX.Element {
  const view = installChipView(installPlanProgress(install, done));
  return (
    <button
      type="button"
      style={{ ...tplStyles.installChip, background: view.bg, borderColor: view.border, color: view.color }}
      onClick={onClick}
      aria-expanded={open}
      aria-label={`How to install ${tagName}: ${view.label}`}
      title="Show what this tag needs to fire"
    >
      {view.label} {open ? '▾' : '▸'}
    </button>
  );
}

/** Render one install requirement, styled by kind. A 'listener-tag' gets a "Create listener tag" button
 *  (wired by InstallPanel) that creates it in the active DRAFT workspace on explicit click; 'site-code'
 *  and the optional 'html-attribute' get a manual "mark done" check-off (the app can't verify site-side
 *  work) that turns the row — and the row's status chip — green. */
function InstallRequirementRow({
  req,
  targetReady,
  status,
  done,
  onToggleDone,
  onCreate,
}: {
  req: InstallReqView;
  /** Whether a GTM account/container/workspace is selected — gates the create button. */
  targetReady: boolean;
  /** This requirement's create status (idle unless a listener-tag create was attempted). */
  status: ListenerCreateStatus;
  /** Whether the user has checked this requirement off (persisted in the parent, survives collapse). */
  done: boolean;
  /** Toggle the done check-off (site-code / optional rows). */
  onToggleDone?: (value: boolean) => void;
  /** Create handler (present only for a 'listener-tag' requirement). */
  onCreate?: () => void;
}): JSX.Element {
  switch (req.kind) {
    case 'native':
      return (
        <div style={tplStyles.installReqOk}>
          <span style={{ color: 'var(--c-green)', fontWeight: 700 }}>✓ </span>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>{req.detail}</span>
        </div>
      );
    case 'provider-native':
      return (
        <div style={tplStyles.installReqOk}>
          <span style={{ color: 'var(--c-green)', fontWeight: 700 }}>✓ </span>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>{req.detail}</span>
        </div>
      );
    case 'listener-tag': {
      // Satisfied = created/exists this session, OR marked done in the parent (survives a collapse that
      // resets the transient create status). A satisfied listener counts toward the chip's "done".
      const satisfied = done || status.state === 'created' || status.state === 'exists';
      return (
        <div style={{ ...tplStyles.installReq, ...(satisfied ? { borderColor: 'var(--c-green-border)' } : {}) }}>
          <div style={tplStyles.installReqLabel}>Create a Custom HTML listener tag</div>
          <div style={tplStyles.installMeta}>
            <strong style={{ color: 'var(--text)' }}>{req.tag.name}</strong>
          </div>
          <div style={tplStyles.installMeta}>
            fires on: <code style={mdStyles.code}>{FIRES_LABEL[req.tag.fires]}</code>
          </div>
          <CollapsibleCode code={req.tag.html} ariaLabel={`Custom HTML listener tag "${req.tag.name}"`} />
          {req.dlvScope && (
            <div style={tplStyles.installMeta}>
              Scopes the trigger via <code style={mdStyles.code}>{`{{dlv - ${req.dlvScope.key}}}`}</code> = <code style={mdStyles.code}>{req.dlvScope.value}</code>
            </div>
          )}
          <div style={tplStyles.installDetail}>{req.detail}</div>
          {/* Actionable create: drop this Custom HTML listener into the active DRAFT workspace on an
              explicit click (draft-only, never published — same posture as the ✓ create-tags flow). */}
          <div style={tplStyles.installActions}>
            <button
              type="button"
              style={{ ...tplStyles.installCreateBtn, ...(!targetReady || status.state === 'creating' || satisfied ? tplStyles.installCreateBtnDisabled : {}) }}
              onClick={onCreate}
              disabled={!targetReady || status.state === 'creating' || satisfied}
              title={targetReady ? `Create the "${req.tag.name}" Custom HTML listener on All Pages in the draft workspace` : 'Select a GTM account, container and workspace first'}
              aria-label={`Create the listener tag "${req.tag.name}" in the draft workspace`}
            >
              {status.state === 'creating' ? 'Creating…' : 'Create listener tag'}
            </button>
            {status.state === 'created' && <span style={tplStyles.installDoneText}>✓ Created{status.reused ? ' · trigger reused' : ''}</span>}
            {status.state === 'exists' && <span style={tplStyles.installDoneText}>✓ Already exists</span>}
            {status.state === 'idle' && done && <span style={tplStyles.installDoneText}>✓ Done</span>}
            {status.state === 'err' && <span style={{ color: 'var(--c-red)', fontSize: 12 }} title={status.msg}>✗ {status.msg}</span>}
          </div>
        </div>
      );
    }
    case 'html-attribute':
      // OPTIONAL improvement — the tag already fires; this only sharpens scoping. A quiet muted row (not
      // a mandatory-looking box), with the long "why" tucked into the ⓘ tooltip and a "mark applied" tick.
      return (
        <div style={{ ...tplStyles.installOptional, ...(done ? { borderColor: 'var(--c-green-border)' } : {}) }}>
          <span style={tplStyles.optionalPill}>Optional</span>
          <span style={{ ...tplStyles.installOptionalText, ...(done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}) }}>
            Add <code style={mdStyles.code}>{`${req.attribute}="${req.value}"`}</code> to <code style={mdStyles.code}>{req.selector}</code> for precise scoping
          </span>
          <span style={tplStyles.installInfo} title={req.detail} aria-label={req.detail}>ⓘ</span>
          <label style={{ ...tplStyles.installCheck, marginTop: 0 }} title="Mark this optional tip as applied">
            <input type="checkbox" checked={done} onChange={(e) => onToggleDone?.(e.target.checked)} />
            {done ? <span style={tplStyles.installDoneText}>✓ Applied</span> : 'Applied'}
          </label>
        </div>
      );
    case 'site-code':
      return (
        <div style={{ ...tplStyles.installReq, ...(done ? { borderColor: 'var(--c-green-border)' } : {}) }}>
          <div style={tplStyles.installReqLabel}>Add code to your site</div>
          <div style={tplStyles.installMeta}>Add this to your site ({req.where}):</div>
          <CollapsibleCode code={req.snippet} ariaLabel={`Site code snippet for ${req.where}`} />
          <div style={tplStyles.installDetail}>{req.detail}</div>
          <div>
            <label style={tplStyles.installCheck} title="Tick once your developer has added this to the site">
              <input type="checkbox" checked={done} onChange={(e) => onToggleDone?.(e.target.checked)} />
              {done ? <span style={tplStyles.installDoneText}>✓ Added to my site</span> : "I've added this to my site"}
            </label>
          </div>
        </div>
      );
    default: {
      // Exhaustiveness guard — a new requirement kind should force a compile error here.
      const _never: never = req;
      return <>{String(_never)}</>;
    }
  }
}

/** Per-listener-requirement create status (keyed by requirement index within one plan). */
type ListenerCreateStatus =
  | { state: 'idle' }
  | { state: 'creating' }
  | { state: 'created'; reused: boolean }
  | { state: 'exists' }
  | { state: 'err'; msg: string };

/** The expandable panel body for one suggestion's install plan. Threads the active GTM target down so a
 *  'listener-tag' requirement can offer a "Create listener tag" button that creates it in the DRAFT
 *  workspace. Per-requirement create status is kept here (keyed by requirement index); the "done"
 *  check-off state is owned by the parent (so it survives a collapse and feeds the row's status chip). */
function InstallPanel({ plan, gtmTarget, done, onToggleDone }: { plan: InstallPlanView; gtmTarget: { accountId?: string; containerId?: string; workspaceId?: string }; done: Record<number, boolean>; onToggleDone: (index: number, value: boolean) => void }): JSX.Element {
  const [statuses, setStatuses] = useState<Record<number, ListenerCreateStatus>>({});
  const acct = gtmTarget.accountId ?? '';
  const cont = gtmTarget.containerId ?? '';
  const ws = gtmTarget.workspaceId ?? '';
  const targetReady = Boolean(acct && cont && ws);

  async function createListener(index: number, tag: { name: string; html: string }): Promise<void> {
    if (!targetReady) return;
    setStatuses((s) => ({ ...s, [index]: { state: 'creating' } }));
    try {
      const o = await window.desktop.tags.createListenerTag(acct, cont, ws, { name: tag.name, html: tag.html });
      setStatuses((s) => ({
        ...s,
        [index]: o.ok
          ? { state: 'created', reused: o.triggerReused === true }
          : o.existing
            ? { state: 'exists' }
            : { state: 'err', msg: o.error ?? 'failed' },
      }));
      // A created OR already-existing listener is "done" — record it in the parent so the row's chip
      // turns green even after the panel is collapsed (which resets the transient status above).
      if (o.ok || o.existing) onToggleDone(index, true);
    } catch (e) {
      setStatuses((s) => ({ ...s, [index]: { state: 'err', msg: e instanceof Error ? e.message : String(e) } }));
    }
  }

  return (
    <div style={tplStyles.installPanel}>
      {/* The status chip in the row already carries the summary, so the panel goes straight to the
          per-requirement rows — no duplicated summary line. */}
      {plan.requires.map((req, i) => (
        <InstallRequirementRow
          key={i}
          req={req}
          targetReady={targetReady}
          status={statuses[i] ?? { state: 'idle' }}
          done={done[i] === true}
          onToggleDone={(v) => onToggleDone(i, v)}
          onCreate={req.kind === 'listener-tag' ? () => createListener(i, req.tag) : undefined}
        />
      ))}
    </div>
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
  gtmTarget,
  screenshots,
  onShot,
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
  /** The active GTM account/container/workspace, so the install panel's "Create listener tag" button
   *  can create the listener in the right DRAFT workspace. Any field empty → the button is disabled. */
  gtmTarget: { accountId?: string; containerId?: string; workspaceId?: string };
  /** tagId → proof-screenshot data-URI: the element/location this suggested tag would track, ringed.
   *  Captured by the locate-only screenshot pass; shown as a thumbnail under the Page cell. */
  screenshots?: Record<string, string>;
  /** Open a suggestion's proof screenshot full-screen. */
  onShot?: (shot: { src: string; name: string }) => void;
}): JSX.Element {
  // Which suggestions have their "How to install" panel expanded (keyed by id).
  const [installOpen, setInstallOpen] = useState<Record<string, boolean>>({});
  const toggleInstall = (id: string): void => setInstallOpen((o) => ({ ...o, [id]: !o[id] }));
  // Per-suggestion "done" check-offs for its install requirements (keyed by suggestion id → requirement
  // index). Owned here (not in InstallPanel) so a mark survives the panel collapsing AND feeds the row's
  // status chip. Session-scoped — a manual acknowledgement that site-side work is done, not persisted.
  const [installDone, setInstallDone] = useState<Record<string, Record<number, boolean>>>({});
  const setReqDone = (sid: string, index: number, value: boolean): void =>
    setInstallDone((m) => ({ ...m, [sid]: { ...(m[sid] ?? {}), [index]: value } }));
  // The install panel row spans every column: ✓ + Page + the 10 template headers.
  const totalCols = 2 + TEMPLATE_HEADERS.length;
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
            // Add a SECOND trigger condition (ANDed) — e.g. scope a form/click tag to a specific
            // {{Page Path}} when several forms share a name. Pre-fills the first unused variable; a
            // blank-value row is dropped on create (applyWhensToTrigger), so an unfilled row is harmless.
            const usedWhenVars = new Set(whenRows.map((r) => r.variable));
            const freeWhenVar = VARIABLE_OPTIONS.find((o) => !usedWhenVars.has(o.value))?.value;
            const addWhen = (): void => {
              if (freeWhenVar) onEdit(s.id, { whens: [...whenRows, { variable: freeWhenVar, condition: 'equals', value: '' }] });
            };
            // Remove a condition — lets the user undo an added "when" (or drop any condition they don't
            // want) if they change their mind. Writes the reduced list as the edit overlay; on create,
            // applyWhensToTrigger rebuilds the trigger from exactly the remaining rows.
            const removeWhen = (idx: number): void => onEdit(s.id, { whens: whenRows.filter((_, j) => j !== idx) });
            const groupRows = Array.from({ length: rowCount }, (_, i) => {
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
                      {/* Install-status chip — only when the plan asks the user to add something site-side
                          (a listener tag / HTML attribute / site code). Hidden for native GTM triggers
                          (clicks, pageviews) and already-tracked events, where nothing installs. The chip's
                          colour + label triage the plan at a glance; click to expand the detail. */}
                      {s.install && installPlanNeedsAction(s.install) && (
                        <div>
                          <InstallChip install={s.install} done={installDone[s.id] ?? {}} open={!!installOpen[s.id]} onClick={() => toggleInstall(s.id)} tagName={g.tagName} />
                        </div>
                      )}
                      {/* Proof screenshot: the element/location this tag would track, ringed on its page. */}
                      {screenshots?.[s.id] && (
                        <div style={{ marginTop: 6 }}>
                          <ProofThumb
                            screenshot={screenshots[s.id]}
                            name={`${g.tagName} · ${s.page}`}
                            onOpen={() => onShot?.({ src: screenshots[s.id], name: `${g.tagName} · ${s.page}` })}
                          />
                        </div>
                      )}
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
                  <td style={tplStyles.td}>
                    {w ? (
                      whensEditable ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <GrowCell value={w.value} disabled={creating} onChange={(v) => editWhen(i, { value: v })} ariaLabel="Trigger when value" />
                          {/* Remove THIS condition — undo an added "when" or drop one that's not wanted. */}
                          <button
                            type="button"
                            onClick={() => removeWhen(i)}
                            disabled={creating}
                            title="Remove this condition"
                            aria-label="Remove this trigger condition"
                            style={{ flexShrink: 0, width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, fontSize: 13, lineHeight: 1, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-2)', borderRadius: 4, cursor: 'pointer' }}
                          >
                            ×
                          </button>
                        </span>
                      ) : w.value
                    ) : ''}
                    {/* "+ condition" appears once, on the last when-row (or row 0 when there are none):
                        append another ANDed condition such as {{Page Path}} equals "/contact". */}
                    {whensEditable && freeWhenVar && i === Math.max(whenRows.length - 1, 0) && (
                      <button
                        type="button"
                        onClick={addWhen}
                        disabled={creating}
                        title="Add another trigger condition (ANDed) — e.g. scope this tag to a specific Page Path"
                        style={{ marginTop: 4, padding: '1px 7px', fontSize: 11, lineHeight: 1.6, color: 'var(--c-blue)', background: 'none', border: '1px dashed var(--border-2)', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        + condition
                      </button>
                    )}
                  </td>
                </tr>
              );
            });
            // One extra full-width row directly AFTER the group when its install panel is expanded.
            if (s.install && installPlanNeedsAction(s.install) && installOpen[s.id]) {
              groupRows.push(
                <tr key={s.id + ':install'}>
                  <td colSpan={totalCols} style={tplStyles.installTd}>
                    <InstallPanel plan={s.install} gtmTarget={gtmTarget} done={installDone[s.id] ?? {}} onToggleDone={(index, value) => setReqDone(s.id, index, value)} />
                  </td>
                </tr>,
              );
            }
            return groupRows;
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
// GA4 tools — the two GA4 surfaces (Audit + Monitoring) under one sidebar entry, mirroring GTM Tools'
// sub-tab pattern. The active tab is owned by App (passed in) so the cross-tab monitor alert banner
// can deep-link straight to the Monitoring sub-tab.
function Ga4ToolsView({
  active,
  onError,
  tab,
  setTab,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
  tab: Ga4Tab;
  setTab: (t: Ga4Tab) => void;
}): JSX.Element {
  return (
    <div style={styles.gtmWorkspace}>
      <div style={styles.subTabs} role="tablist">
        <button style={tab === 'audit' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('audit')} role="tab" aria-selected={tab === 'audit'}>
          📊 GA4 Audit
        </button>
        <button style={tab === 'monitoring' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('monitoring')} role="tab" aria-selected={tab === 'monitoring'}>
          🔔 GA4 Monitoring
        </button>
      </div>
      {tab === 'audit' ? (
        <Ga4AuditPanel key={(active?.id ?? 'none') + ':ga4aud'} active={active} onError={onError} />
      ) : (
        <Ga4MonitoringPanel key={(active?.id ?? 'none') + ':ga4mon'} active={active} onError={onError} />
      )}
    </div>
  );
}

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
        <button style={tab === 'verify' ? styles.subTabOn : styles.subTabOff} onClick={() => setTab('verify')} role="tab" aria-selected={tab === 'verify'}>
          ✅ Tag verification
          <span style={styles.betaBadge}>Beta</span>
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
      ) : tab === 'verify' ? (
        <VerifyPanel key={(active?.id ?? 'none') + ':vfy'} active={active} onError={onError} />
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
  // Crawl progress shown WHILE scanning (the list itself is rendered once, deduplicated, on completion).
  const [scanProgress, setScanProgress] = useState<{ scanned: number; found: number; queued: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestedTagView[]>([]);
  const [meta, setMeta] = useState<TagScanResult['summary'] | null>(null);
  // The scanned site + scan time (from the scan result) — surfaced in the install-runbook header.
  const [scanMeta, setScanMeta] = useState<{ site?: string; scannedAt?: string }>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, TagEdit>>({});
  // Locate-only PROOF screenshots for the creatable suggestions (tagId → JPEG data-URI), captured
  // after each scan by reusing the verify driver (ring the element + shot). `shotStatus` drives the
  // "capturing…" line; `sLightbox` is the image shown full-screen. Best-effort — never blocks the panel.
  const [sShots, setSShots] = useState<Record<string, string>>({});
  const [shotStatus, setShotStatus] = useState<{ loading: boolean; done: number; total?: number; current?: string } | null>(null);
  // Live per-tag capture progress pushed from main. Only applied while a capture is actually
  // loading (a late event from a cancelled run must not resurrect the banner).
  useEffect(
    () =>
      window.desktop.tags.onShotProgress((prog) => {
        let path = prog.page;
        try { path = new URL(prog.page).pathname || prog.page; } catch { /* keep raw */ }
        setShotStatus((st) => (st && st.loading ? { loading: true, done: prog.done, total: prog.total, current: `${prog.label} · ${path}` } : st));
      }),
    [],
  );
  const [sLightbox, setSLightbox] = useState<{ src: string; name: string } | null>(null);
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
  // "Auto-verify & heal" loop: after creating tags, verify they fire; auto-apply confident
  // trigger fixes (approve-per-round) and re-verify; pause on tags with no confident fix.
  const [healPhase, setHealPhase] = useState<'idle' | 'busy' | 'review' | 'paused' | 'done'>('idle');
  const [healRound, setHealRound] = useState(0);
  const [healVerdicts, setHealVerdicts] = useState<VerifyTagsResult['verdicts']>([]);
  const [healMeta, setHealMeta] = useState<{ injected: boolean; previewAuth: boolean }>({ injected: false, previewAuth: false });
  const [healSkipped, setHealSkipped] = useState<Record<string, boolean>>({});
  const [healNote, setHealNote] = useState('');
  // Corrected triggers already applied to the draft, keyed by tag id — fed into the NEXT round's
  // verify input so re-verify drives the FIXED interaction (not the stale original) and can converge.
  const [appliedTriggers, setAppliedTriggers] = useState<Record<string, VerifyTagInput['trigger']>>({});
  // The CURRENT editable workspace for the heal loop. Minting a preview SUBMITS the workspace (it goes
  // read-only) and GTM auto-creates a fresh one — we switch to it so later fixes/mints don't fail
  // "already submitted". A ref (not state) so the value is current synchronously inside a round.
  const healWsRef = useRef<string>('');
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
  // Browser-driver diagnostics (separate "show debug" toggle): per-page form-probe
  // DOM counts + console/page errors — why a scan found nothing.
  const [scanDebug, setScanDebug] = useState<TagScanResult['debug'] | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const [discoverMode, setDiscoverMode] = useState<'site' | 'single' | 'csv'>('site');
  // CSV mode: paste / load a list of landing-page URLs and scan them all directly (no discovery).
  const [csvText, setCsvText] = useState('');
  const csvFileRef = useRef<HTMLInputElement>(null);
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
    // A new suggestion set invalidates any prior scan's proof screenshots.
    setSShots({});
    setShotStatus(null);
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
    setScanMeta({ site: res.site || res.siteHost || undefined, scannedAt: res.scannedAt || undefined });
    setWarnings(res.warnings);
    setScanLog({ pages: res.pages, notScanned: res.notScanned, inventory: res.inventory, installed: res.installed });
    setScanDebug(res.debug ?? null);
    resetHeal(); // a new scan invalidates any prior heal verdicts
    // Dedupe ONCE and feed BOTH the render and the screenshot pass. Capturing over the RAW list wastes
    // the bounded shot budget (MAX_SCREENSHOTS) on rows that were deduped away, which can starve later
    // (form) tags of a screenshot even though they were locatable.
    const deduped = dedupeViewsByGtmName(res.suggestions);
    loadSuggestions(deduped);
    // Fill in a proof screenshot per creatable tag (the element it would track, ringed) — async +
    // best-effort so the suggestion list is usable immediately and screenshots appear as they arrive.
    void captureSuggestionShots(deduped, res.site || res.siteHost || url);
  }

  // Reuse the verify driver's ring + capture (locate-only) to grab a proof screenshot of WHERE each
  // suggested tag would fire. Never blocks the panel — screenshots are a nicety layered onto the list.
  async function captureSuggestionShots(list: SuggestedTagView[], base: string): Promise<void> {
    const target = (base || url || '').trim();
    setSShots({});
    if (!target || list.length === 0) { setShotStatus(null); return; }
    setShotStatus({ loading: true, done: 0 });
    try {
      const res = await window.desktop.tags.screenshotTags(target, list);
      const map: Record<string, string> = {};
      for (const shot of res.shots) if (shot.screenshot) map[shot.tagId] = shot.screenshot;
      setSShots(map);
      setShotStatus({ loading: false, done: Object.keys(map).length });
    } catch {
      setShotStatus(null); // best-effort — a screenshot failure never breaks the suggestions
    }
  }

  // Clear the whole review state so switching source mode starts a fresh, clean
  // tab instead of showing the previous scan's stale suggestions/results.
  function resetScanState(): void {
    resetHeal();
    setSuggestions([]);
    setSShots({});
    setShotStatus(null);
    setSLightbox(null);
    setMeta(null);
    setScanMeta({});
    setWarnings([]);
    setScanLog(null);
    setScanDebug(null);
    setDiscovered(null);
    setSelected({});
    setSelectedPages({});
    setEdits({});
    setStatuses({});
    setDone(null);
    setScanProgress(null);
    setExportNote('');
  }

  // Switch the source mode (Main website / Single page / CSV) → clean slate.
  function changeMode(m: 'site' | 'single' | 'csv'): void {
    if (m === discoverMode) return;
    resetScanState();
    setDiscoverMode(m);
  }

  // Progress-ONLY while scanning: we do NOT render a partial list mid-scan. Streaming a not-yet-complete
  // list can flash the SAME tag several times before every page is collapsed (a page scanned twice, the
  // same CTA seen on several pages, etc.). Instead we show live progress and render the ONE final,
  // deduplicated list when the scan finishes (applyScanResult → loadSuggestions). `found` counts unique
  // tags so far (deduped) so the number is honest and never shows the transient duplicates.
  const onScanProgress = (p: ScanProgressView): void => {
    setScanProgress({ scanned: p.scanned, queued: p.queued, found: dedupeViewsByGtmName(p.suggestions).length });
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
  async function doDiscover(): Promise<void> {
    const target = url.trim();
    if (!target || discovering || scanning) return;
    if (discoverMode === 'single') {
      await doSinglePageScan();
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
      setScanDebug(null);
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

  // Download the whole scan's measurement plan as a client-ready "install runbook"
  // Markdown: per-tag GTM structure + site-side install steps + a consolidated
  // "what your developer must do" section. Uses the SAME deduped, edit-applied list
  // the CSV export uses.
  async function downloadRunbook(format: 'md' | 'pdf' = 'md'): Promise<void> {
    const picked = suggestions.filter((s) => selected[s.id]);
    const list = (picked.length ? picked : suggestions).map(effective);
    if (!list.length) return;
    setExportNote('');
    try {
      const md = suggestionsToInstallRunbookMarkdown(list, { site: scanMeta.site, scannedAt: scanMeta.scannedAt });
      const ext = format === 'pdf' ? 'pdf' : 'md';
      const saved = await window.desktop.tags.exportRunbook('Measurement Install Runbook.' + ext, md, format);
      const label = format === 'pdf' ? 'runbook (PDF)' : 'runbook';
      setExportNote(saved ? `✓ Saved ${label} to ${saved}` : 'Export cancelled');
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
    resetHeal(); // a fresh create invalidates any prior heal run
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

  // ── Auto-verify & heal loop ───────────────────────────────────────────────
  const HEAL_MAX_ROUNDS = 5;
  function healErrorText(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    if (/invalid_grant|expired or revoked|AUTH_EXPIRED/i.test(m)) return 'Your Google connection expired — re-connect (the banner up top) and retry.';
    if (/ETIMEDOUT|fetch failed|network|getaddrinfo/i.test(m)) return 'Could not reach Google (network). Check your connection and retry.';
    return m;
  }
  // Tags from this scan that are now IN the container (created this session or already existed).
  function healableTags(): SuggestedTagView[] {
    return suggestions.filter((s) => statuses[s.id]?.state === 'ok' || statuses[s.id]?.state === 'exists');
  }
  function classifyAndSetPhase(verdicts: VerifyTagsResult['verdicts'], skipped: Record<string, boolean>, round: number): void {
    const activeV = verdicts.filter((v) => !skipped[v.tagId]);
    const notFired = activeV.filter((v) => !v.fired);
    // Inconclusive-with-no-fix = "couldn't auto-test here" (CTA on another page / needs a real
    // submit). Re-running rounds will never flip these, so they must NOT keep the loop paused
    // forever — they don't block "done", and they're reported separately from genuine failures.
    const inconclusive = notFired.filter((v) => v.inconclusive && !v.suggestedTrigger);
    const genuine = notFired.filter((v) => !(v.inconclusive && !v.suggestedTrigger));
    const fixable = genuine.filter((v) => v.suggestedTrigger);
    const firing = activeV.length - notFired.length;
    const tail = inconclusive.length ? ` · ${inconclusive.length} couldn't be auto-tested here` : '';
    if (genuine.length === 0) {
      setHealPhase('done');
      setHealNote(inconclusive.length
        ? `✅ All testable tag(s) fire.${tail} (their CTA/form is on another page or needs a real submit — verify those in GTM Preview).`
        : `✅ All ${activeV.length} tag(s) fire.`);
    } else if (fixable.length > 0) {
      setHealPhase('review');
      setHealNote(`Round ${round}: ${firing}/${activeV.length} firing · ${fixable.length} auto-fixable${tail}.`);
    } else {
      setHealPhase('paused');
      setHealNote(`Round ${round}: ${firing}/${activeV.length} firing · ${genuine.length} need your call (no confident auto-fix)${tail}.`);
    }
  }
  function resetHeal(): void {
    setHealPhase('idle');
    setHealRound(0);
    setHealVerdicts([]);
    setHealMeta({ injected: false, previewAuth: false });
    setHealSkipped({});
    setHealNote('');
    setAppliedTriggers({});
  }
  // Mint a fresh preview (the draft changed) and verify the created tags, carrying the scan
  // inventory so a non-firing tag gets a CONCRETE corrected trigger. `overrides` supplies the
  // corrected triggers already applied to the draft (keyed by tag id) so re-verify drives the
  // FIXED interaction, not the stale original. Guards leave a recoverable phase (never stuck 'busy').
  // After a mint submits the workspace, follow GTM to the fresh editable one it hands back: point the
  // loop's ref at it AND switch the app's active workspace so later fixes/chat/panels use it too.
  async function followMintedWorkspace(newWorkspaceId: string): Promise<void> {
    if (!active || !ctx || !newWorkspaceId || newWorkspaceId === healWsRef.current) return;
    healWsRef.current = newWorkspaceId;
    try {
      await window.desktop.accounts.setGtmContext(active.id, { ...ctx, workspaceId: newWorkspaceId, workspaceName: 'Workspace (auto)' });
    } catch { /* best-effort — the loop still uses healWsRef */ }
  }
  async function runHealRound(roundNo: number, skipped: Record<string, boolean>, overrides: Record<string, VerifyTagInput['trigger']>): Promise<void> {
    if (!targetReady || !ctx) { setHealPhase('idle'); setHealNote('Pick a GTM account, container and draft workspace first.'); return; }
    const target = url.trim();
    if (!target) { setHealPhase('idle'); setHealNote('Enter the site URL to verify against (the Main website / Single page field).'); return; }
    const created = healableTags();
    if (created.length === 0) { setHealPhase('idle'); setHealNote('Create some tags first — there are none in the container to verify.'); return; }
    setHealPhase('busy');
    setHealNote(`Round ${roundNo}: minting a preview & verifying ${created.length} tag(s)…`);
    try {
      const ws = healWsRef.current || ctx.workspaceId!;
      const { snippet, newWorkspaceId } = await window.desktop.tags.mintPreview(ctx.accountId!, ctx.containerId!, ws);
      await followMintedWorkspace(newWorkspaceId); // the minted ws is now read-only; continue in the new one
      const tags: VerifyTagInput[] = created.map((s) => ({ id: s.id, tagName: s.tagName, eventName: s.eventName, platform: s.platform, measurementId: s.measurementId, page: s.page, trigger: overrides[s.id] ?? s.trigger }));
      const elements = scanLog?.inventory.elements ?? [];
      const res = await window.desktop.tags.verify(target, tags, elements, { containerSnippet: snippet });
      setHealVerdicts(res.verdicts);
      setHealMeta({ injected: res.injected, previewAuth: res.previewAuth });
      setHealRound(roundNo);
      classifyAndSetPhase(res.verdicts, skipped, roundNo);
    } catch (e) {
      setHealPhase(healVerdicts.length > 0 ? 'paused' : 'idle');
      setHealNote(healErrorText(e));
    }
  }
  async function startHeal(): Promise<void> {
    setHealSkipped({});
    setHealVerdicts([]);
    setHealNote('');
    setAppliedTriggers({});
    healWsRef.current = ctx?.workspaceId ?? '';
    await runHealRound(1, {}, {});
  }
  // Approve-per-round: apply every confident trigger fix (not skipped) via the retarget primitive,
  // record what was applied so the next round drives the corrected interaction, then re-verify.
  async function applyFixesAndReverify(): Promise<void> {
    if (!ctx) return;
    const fixable = healVerdicts.filter((v) => !v.fired && v.suggestedTrigger && !healSkipped[v.tagId]);
    if (fixable.length === 0) return;
    setHealPhase('busy');
    setHealNote(`Applying ${fixable.length} trigger fix(es) to the draft…`);
    const applied: Record<string, VerifyTagInput['trigger']> = { ...appliedTriggers };
    try {
      const ws = healWsRef.current || ctx.workspaceId!; // the current EDITABLE workspace (post-mint)
      for (const v of fixable) {
        await window.desktop.gtm.retargetTrigger({
          accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: ws,
          tagName: v.tagName, trigger: v.suggestedTrigger!,
        });
        applied[v.tagId] = v.suggestedTrigger!; // re-verify must drive the FIXED interaction
      }
    } catch (e) {
      setAppliedTriggers(applied); // keep whatever succeeded before the failure
      setHealNote(healErrorText(e));
      setHealPhase('review');
      return;
    }
    setAppliedTriggers(applied);
    const next = healRound + 1;
    if (next > HEAL_MAX_ROUNDS) {
      await runHealRound(healRound, healSkipped, applied);
      setHealPhase('done');
      setHealNote(`Stopped after ${HEAL_MAX_ROUNDS} rounds — re-verified; see what remains.`);
      return;
    }
    await runHealRound(next, healSkipped, applied);
  }
  function skipHealTag(tagId: string): void {
    const next = { ...healSkipped, [tagId]: true };
    setHealSkipped(next);
    classifyAndSetPhase(healVerdicts, next, healRound);
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
            {(['site', 'single', 'csv'] as const).map((m) => (
              <button
                key={m}
                style={discoverMode === m ? styles.toggleOn : styles.toggleOff}
                onClick={() => changeMode(m)}
                disabled={scanning || discovering}
              >
                {m === 'site' ? 'Main website' : m === 'single' ? 'Single page' : '📄 Landing pages (CSV)'}
              </button>
            ))}
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
                  {discoverMode === 'single'
                    ? scanning
                      ? 'Scanning…'
                      : 'Scan page'
                    : discovering
                      ? 'Discovering…'
                      : 'Discover pages'}
                </button>
              </div>
              <div style={styles.muted}>
                {discoverMode === 'single'
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

        {/* Debug: browser-driver diagnostics (form-probe DOM counts + console/page errors) */}
        {scanDebug && (
          <div style={styles.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={styles.muted}>
                Debug · driver {scanDebug.driver} · settle {scanDebug.settleMode} · {scanDebug.pages.length} page load(s) ·{' '}
                {scanDebug.consoleErrors.length} console error(s) · {scanDebug.pageErrors.length} page error(s)
              </div>
              <button style={styles.linkBtn} onClick={() => setShowDebug((o) => !o)}>
                {showDebug ? 'hide debug' : 'show debug'}
              </button>
            </div>
            {showDebug && (
              <div style={{ marginTop: 10 }}>
                <div style={styles.h2}>Page loads ({scanDebug.pages.length})</div>
                <div style={styles.invScroll}>
                  <table style={styles.invTable}>
                    <thead>
                      <tr>
                        <th style={styles.invTh}>Page</th>
                        <th style={styles.invTh}>HTTP</th>
                        <th style={styles.invTh}>DOM form/input/submit</th>
                        <th style={styles.invTh}>Extracted</th>
                        <th style={styles.invTh}>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanDebug.pages.map((p, i) => (
                        <tr key={i}>
                          <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{p.url}</td>
                          <td style={styles.invTd}>{p.httpStatus ?? '—'}</td>
                          <td style={styles.invTd}>{p.probe ? `${p.probe.forms}/${p.probe.inputs}/${p.probe.submitish}` : '—'}</td>
                          <td style={styles.invTd}>{p.probe ? p.probe.extracted : '—'}</td>
                          <td style={{ ...styles.invTd, color: 'var(--text-faint)' }}>{p.error ?? ''}</td>
                        </tr>
                      ))}
                      {scanDebug.pages.length === 0 && (
                        <tr>
                          <td style={styles.invTd} colSpan={5}>
                            none
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {scanDebug.consoleErrors.length > 0 && (
                  <>
                    <div style={{ ...styles.h2, marginTop: 14 }}>Browser console errors ({scanDebug.consoleErrors.length})</div>
                    <ul style={styles.resultList}>
                      {scanDebug.consoleErrors.slice(0, 50).map((m, i) => (
                        <li key={i} style={styles.resultRow}>{m}</li>
                      ))}
                    </ul>
                  </>
                )}
                {scanDebug.pageErrors.length > 0 && (
                  <>
                    <div style={{ ...styles.h2, marginTop: 12 }}>Page errors ({scanDebug.pageErrors.length})</div>
                    <ul style={styles.resultList}>
                      {scanDebug.pageErrors.map((m, i) => (
                        <li key={i} style={styles.resultRow}>{m}</li>
                      ))}
                    </ul>
                  </>
                )}
                {scanDebug.consoleErrors.length === 0 && scanDebug.pageErrors.length === 0 && (
                  <div style={{ ...styles.muted, marginTop: 10 }}>
                    No browser console or page errors captured — the pages loaded cleanly. If suggestions are still missing, the
                    elements likely aren&apos;t standard DOM (custom widgets) or the page needs more settle time.
                  </div>
                )}
              </div>
            )}
          </div>
        )}


        {/* Crawl progress — the FULL de-duplicated list appears when the scan finishes (not streamed). */}
        {scanning && (
          <div style={styles.scanBanner}>
            ⏳ Scanning all pages…{scanProgress ? ` ${scanProgress.scanned} read` : ' starting'}
            {scanProgress && scanProgress.queued > 0 ? ` · ${scanProgress.queued} queued` : ''}
            {scanProgress ? ` · ${scanProgress.found} unique tag(s) found` : ''}
            {' '}— the full, de-duplicated list appears when the scan finishes.
          </div>
        )}

        {/* Results */}
        {suggestions.length === 0 ? (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏷</div>
            {scanning
              ? 'Scanning all pages… the de-duplicated tag list appears here when the scan finishes (progress above).'
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
                <button style={styles.linkBtn} onClick={() => void downloadRunbook('md')}>
                  ⬇ Install runbook
                </button>
                <button style={styles.linkBtn} onClick={() => void downloadRunbook('pdf')}>
                  ⬇ Runbook (PDF)
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
                {shotStatus?.loading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', background: 'var(--c-blue-bg, rgba(59,130,246,.12))', border: '1px solid var(--c-blue-bg, rgba(59,130,246,.25))', borderRadius: 8 }}>
                    <span style={{ fontSize: 16 }}>📸</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                        Capturing proof screenshots{shotStatus.total ? ` — ${Math.min(shotStatus.done + 1, shotStatus.total)} of ${shotStatus.total}` : '…'}
                      </div>
                      {shotStatus.current && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          now: {shotStatus.current}
                        </div>
                      )}
                      <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 2, background: 'var(--c-blue)', transition: 'width .3s ease', width: shotStatus.total ? `${Math.round((shotStatus.done / Math.max(1, shotStatus.total)) * 100)}%` : '8%' }} />
                      </div>
                    </div>
                  </div>
                ) : shotStatus && shotStatus.done > 0 ? (
                  <div style={{ ...styles.muted, fontSize: 12 }}>📸 Captured {shotStatus.done} location screenshot(s) — click a thumbnail under “Page” to view.</div>
                ) : null}
                <SuggestionTemplateTable
                  suggestions={pageItems.map(effective)}
                  edits={edits}
                  selected={selected}
                  statuses={statuses}
                  creating={creating}
                  alreadyExists={alreadyExists}
                  onToggle={(id, v) => setSelected((sel) => ({ ...sel, [id]: v }))}
                  onEdit={(id, patch) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }))}
                  gtmTarget={{ accountId: ctx?.accountId, containerId: ctx?.containerId, workspaceId: ctx?.workspaceId }}
                  screenshots={sShots}
                  onShot={setSLightbox}
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

            {sLightbox && <ProofLightbox shot={sLightbox} onClose={() => setSLightbox(null)} />}

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
                  <span style={{ color: done.failed ? 'var(--c-amber)' : 'var(--c-green)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {done.created} of {done.total} created
                    {done.existing ? ` · ${done.existing} already existed` : ''}
                    {done.failed ? ` · ${done.failed} failed` : ''} — open GTM to review &amp; publish.
                    {done.created > 0 && (
                      <span style={{ color: 'var(--text-muted)' }}>
                        Verify &amp; auto-fix them below, or in the <b>✅ Tag verification</b> tab.
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}

            {/* Auto-verify & heal: verify the created tags fire, auto-apply confident trigger fixes
                (approve per round), re-verify, loop; pause on tags with no confident fix. */}
            {done && done.created + done.existing > 0 && (
              <div style={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 340px' }}>
                    <div style={{ fontWeight: 600 }}>Auto-verify &amp; heal <span style={styles.betaBadge}>Beta</span></div>
                    <div style={styles.muted}>
                      Proves the tags you just created fire, auto-applies confident trigger fixes (you approve each round),
                      re-verifies, and loops until they fire or nothing more is auto-fixable. Uses the scanned page inventory
                      for concrete fixes. Draft-only writes; nothing is sent and nothing is published.
                    </div>
                  </div>
                  <button
                    style={styles.primaryBtn}
                    onClick={() => void startHeal()}
                    disabled={!targetReady || healPhase === 'busy' || !url.trim()}
                    title={targetReady ? 'Mint a preview, verify each created tag, and heal the fixable ones' : 'Pick a GTM account, container and draft workspace first'}
                  >
                    {healPhase === 'busy' ? 'Working…' : healPhase === 'idle' ? 'Start auto-verify & heal' : 'Restart'}
                  </button>
                </div>
                {healNote && (
                  <div style={{ ...styles.muted, marginTop: 8, color: healPhase === 'done' ? 'var(--c-green)' : healPhase === 'paused' ? 'var(--c-amber)' : 'var(--text)' }}>
                    {healNote}
                  </div>
                )}
                {healMeta.injected && !healMeta.previewAuth && (
                  <div style={{ ...styles.muted, color: 'var(--c-amber)', marginTop: 4 }}>
                    ⚠ The preview had no draft auth (gtm_auth/gtm_preview) — the published container loaded, so draft tags won&apos;t fire. Re-connect with the &ldquo;edit container versions&rdquo; permission.
                  </div>
                )}
                {healVerdicts.length > 0 && (() => {
                  const activeV = healVerdicts.filter((v) => !healSkipped[v.tagId]);
                  const fired = activeV.filter((v) => v.fired);
                  const notFired = activeV.filter((v) => !v.fired);
                  const fixable = notFired.filter((v) => v.suggestedTrigger);
                  const untestable = notFired.filter((v) => !v.suggestedTrigger && v.inconclusive);
                  const needsYou = notFired.filter((v) => !v.suggestedTrigger && !v.inconclusive);
                  const skippedCount = healVerdicts.length - activeV.length;
                  return (
                    <div style={{ marginTop: 10 }}>
                      {fired.length > 0 && (
                        <>
                          <div style={{ ...styles.h2, color: 'var(--c-green)' }}>✅ Firing ({fired.length})</div>
                          <ul style={styles.resultList}>
                            {fired.map((v) => (
                              <li key={v.tagId} style={styles.resultRow}>
                                <span style={{ fontWeight: 600, color: 'var(--c-green)' }}>FIRED</span> {v.tagName}
                                {v.event ? <span style={styles.muted}> — {v.event}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {fixable.length > 0 && (
                        <>
                          <div style={{ ...styles.h2, color: 'var(--c-blue)', marginTop: 10 }}>🔧 Auto-fixable ({fixable.length})</div>
                          <ul style={styles.resultList}>
                            {fixable.map((v) => (
                              <li key={v.tagId} style={{ ...styles.resultRow, display: 'block' }}>
                                <div><span style={{ fontWeight: 600 }}>{v.tagName}</span></div>
                                {v.fixNote ? <div style={{ ...styles.muted, marginLeft: 8 }}>Fix: {v.fixNote}</div> : null}
                                <button style={{ ...styles.linkBtn, marginLeft: 8 }} onClick={() => skipHealTag(v.tagId)}>skip this one</button>
                              </li>
                            ))}
                          </ul>
                          {healPhase === 'review' && (
                            <button style={styles.primaryBtn} onClick={() => void applyFixesAndReverify()}>
                              Apply {fixable.length} fix(es) &amp; re-verify (round {healRound + 1})
                            </button>
                          )}
                        </>
                      )}
                      {needsYou.length > 0 && (
                        <>
                          <div style={{ ...styles.h2, color: 'var(--c-amber)', marginTop: 10 }}>⏸ Needs your call ({needsYou.length})</div>
                          <ul style={styles.resultList}>
                            {needsYou.map((v) => (
                              <li key={v.tagId} style={{ ...styles.resultRow, display: 'block' }}>
                                <div><span style={{ fontWeight: 600, color: 'var(--c-red)' }}>NOT FIRED</span> {v.tagName}</div>
                                {v.reason ? <div style={{ ...styles.muted, marginLeft: 8 }}>Why: {v.reason}</div> : null}
                                <div style={{ marginLeft: 8, marginTop: 2 }}>
                                  <button style={styles.linkBtn} onClick={() => skipHealTag(v.tagId)}>skip</button>
                                  <span style={{ ...styles.muted, marginLeft: 8 }}>— or fix it in GTM, then Restart.</span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {untestable.length > 0 && (
                        <>
                          <div style={{ ...styles.h2, color: 'var(--c-amber)', marginTop: 10 }}>⏭ Couldn’t auto-test here ({untestable.length})</div>
                          <div style={{ ...styles.muted, fontSize: 12 }}>Not broken — their CTA/form is on another page or needs a real submit. Verify in GTM Preview.</div>
                          <ul style={styles.resultList}>
                            {untestable.map((v) => (
                              <li key={v.tagId} style={{ ...styles.resultRow, display: 'block' }}>
                                <div><span style={{ fontWeight: 600, color: 'var(--c-amber)' }}>UNTESTED HERE</span> {v.tagName}</div>
                                {v.reason ? <div style={{ ...styles.muted, marginLeft: 8 }}>Why: {v.reason}</div> : null}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {skippedCount > 0 && <div style={{ ...styles.muted, marginTop: 6 }}>{skippedCount} skipped.</div>}
                      {(healPhase === 'paused' || healPhase === 'review') && (
                        <div style={{ marginTop: 8 }}>
                          <button style={styles.toggleOff} onClick={() => { setHealPhase('done'); setHealNote('Stopped.'); }}>Stop</button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────── Tag verification (does it fire?) ───────────────────── */

// A compact label for the live-progress page url: its path (+ query), or the host for the homepage.
function vProgressPageLabel(u: string): string {
  try { const url = new URL(u); return url.pathname === '/' ? url.host : url.pathname + url.search; } catch { return u; }
}

// A verdict's interaction kind → a short human label + icon for the results list.
function verdictKindLabel(v: VerifyTagsResult['verdicts'][number]): { label: string; icon: string } {
  switch (v.interaction?.kind) {
    case 'submit': return { label: 'Form', icon: '📝' };
    case 'click': return { label: 'Click', icon: '🖱' };
    case 'navigate': return { label: 'Page load', icon: '📄' };
    case 'custom_event': return { label: 'Custom event', icon: '⚡' };
    default: return { label: 'Tag', icon: '🏷' };
  }
}

// "How to actually verify this one" for an INCONCLUSIVE verdict (couldn't auto-test here). These
// tags aren't broken — they just need the right page or a real interaction, not an operator change.
function verdictHowToTest(v: VerifyTagsResult['verdicts'][number]): string {
  const k = v.interaction?.kind;
  const found = v.interaction?.targetFound;
  if (k === 'custom_event') {
    return 'This tag fires on a dataLayer event a synthetic push can’t fully reproduce (a form’s own data, or a page / Custom-JS condition). If it’s a FORM tag, verify it in the “Forms — verified by a real submit” section below — it submits each matched form for real and re-checks this tag. Otherwise trigger the event in GTM Preview. If the tag is still a DRAFT, paste your GTM Preview snippet above so it loads.';
  }
  // Element WAS found + interacted, but no beacon we recognise fired → an undecodable Custom Template /
  // Custom HTML (pixel) tag, not a wrong-page problem.
  if ((k === 'click' || k === 'submit') && found) {
    return 'This is a Custom Template / Custom HTML (pixel) tag we can’t decode. The interaction happened but no recognised pixel beacon fired — it may beacon to a host we don’t classify, run server-side, or be consent-gated. Confirm in GTM Preview or your browser’s Network tab (look for the vendor’s request).';
  }
  if (k === 'click' || k === 'submit') {
    return 'The matching CTA/form isn’t on the page we drove — it likely lives on another page (e.g. careers, blog, a service page), or its exact label differs. Re-run Verify with that page’s URL, or confirm the button’s exact text.';
  }
  return 'Re-verify against the page this trigger’s element lives on, or exercise it with a real interaction in GTM Preview.';
}

// "What to change" for a NOT-FIRED verdict — actionable even without a scan inventory, derived from
// the interaction kind + reason. The engine's own fixNote (when present) always wins.
function verdictHowToFix(v: VerifyTagsResult['verdicts'][number]): string {
  if (v.fixNote) return v.fixNote;
  const r = v.reason ?? '';
  const k = v.interaction?.kind;
  const found = v.interaction?.targetFound;
  if (k === 'submit' && !found) {
    return 'No matching <form> was found on this page. Check the trigger’s Form ID / classes, or verify against the page the form actually lives on (site-wide form triggers are driven on the URL above).';
  }
  if (k === 'click' && !found) {
    return 'No control on this page matched the trigger. The CTA’s real text/URL may differ from the trigger, the element may render late (SPA) or be a non-standard element, or it lives on another page. Match the trigger to the real control, loosen “equals”→“contains”, or verify against that page.';
  }
  if (/fired GA4 hit/.test(r)) {
    return 'The trigger fired, but no hit for this tag’s event name. Align the tag’s Event Name with what actually fires (see the observed events in the reason), or fix the tag config.';
  }
  if (/no .* beacon fired/.test(r)) {
    return 'The interaction fired but this pixel/ad tag sent no beacon to its vendor. Check the tag isn’t paused or blocked by an exception trigger, that its Consent Mode gate (ad_storage) isn’t denying it, and that the pixel/conversion id is set.';
  }
  if (/no GA4 hit fired|no .* hit fired/.test(r)) {
    return 'The trigger ran but no hit fired. The tag may not be in the loaded container (use “Auto” or paste a Preview snippet so DRAFT tags load), or a tag-level condition / Consent Mode gate is blocking it.';
  }
  if (k === 'navigate') {
    return 'The base/config tag didn’t fire on load. Make sure the container is actually injected (use “Auto” or a Preview snippet), and that Consent Mode isn’t denying analytics_storage.';
  }
  // Monitor-verified runs read from GTM itself — the container is PROVEN to be on the page, so
  // "confirm the container is injected" would be wrong advice (and contradicts the run's own evidence).
  if (v.verifiedByMonitor) {
    return 'The container IS on this page (GTM itself reported this run), so injection is not the problem. Open this tag’s trigger in GTM and compare each condition — event name, form name / id, page path — with what the page really sent (see the dataLayer log above). If the trigger looks right, check for a blocking exception trigger or a Consent Mode gate.';
  }
  return 'Confirm the container is injected (Auto / Preview snippet) and the trigger’s conditions match this page.';
}

// ── Tag-verification results: scorecard + one results table (replaces the old wall-of-text lists) ──
type VVerdict = VerifyTagsResult['verdicts'][number];
type VStatus = 'fired' | 'config' | 'server' | 'untested' | 'issue';
/** Bucket a verdict into a single status the scorecard + table share. */
function verdictStatus(v: VVerdict): VStatus {
  if (v.fired) return v.synthetic ? 'config' : 'fired';
  if (v.serverRelay) return 'server';
  if (v.inconclusive) return 'untested';
  return 'issue';
}
// Semantic colour per status — green success, amber caveat, blue server, gray neutral, red error.
const V_STATUS: Record<VStatus, { short: string; icon: string; color: string; bg: string; border: string }> = {
  fired: { short: 'Fired', icon: '✅', color: 'var(--c-green)', bg: 'var(--c-green-bg)', border: 'var(--c-green-border)' },
  config: { short: 'Config OK', icon: '⚙', color: 'var(--c-amber)', bg: 'var(--c-amber-bg)', border: 'var(--c-amber-border)' },
  server: { short: 'Server-side', icon: '🛰', color: 'var(--c-blue)', bg: 'var(--c-blue-bg)', border: 'var(--c-blue-border)' },
  untested: { short: 'Untested', icon: '⏭', color: 'var(--text-muted)', bg: 'var(--surface-3)', border: 'var(--border-2)' },
  issue: { short: 'Issue', icon: '⚠', color: 'var(--c-red)', bg: 'var(--c-red-bg)', border: 'var(--c-red-border)' },
};

/** The result scorecard — big-number stat cards, one per meaningful outcome. */
function VerifyScorecard({ fired, config, server, untested, issues }: { fired: number; config: number; server: number; untested: number; issues: number }): JSX.Element {
  const cards: Array<{ label: string; n: number; s: VStatus }> = [
    { label: 'Fired', n: fired, s: 'fired' },
    ...(config ? [{ label: 'Config-verified', n: config, s: 'config' as const }] : []),
    ...(server ? [{ label: 'Server-side', n: server, s: 'server' as const }] : []),
    { label: 'Issues', n: issues, s: (issues ? 'issue' : 'fired') as VStatus },
    ...(untested ? [{ label: 'Untested here', n: untested, s: 'untested' as const }] : []),
  ];
  return (
    <div style={vStyles.scoreGrid}>
      {cards.map((c, i) => {
        const m = V_STATUS[c.s];
        return (
          <div key={c.label} className="hover-lift rise-in" style={{ ...vStyles.scoreCard, background: m.bg, borderColor: m.border, '--d': `${i * 0.05}s` } as React.CSSProperties}>
            <div style={{ ...vStyles.scoreNum, color: m.color }}>{c.n}</div>
            <div style={vStyles.scoreLabel}>{c.label}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Phase 3: the Tag-Assistant-style EVENT TIMELINE — one card per dataLayer event GTM processed, with the
 *  exact push (API Call), resolved variables, and the tags it fired. This is the "show it in detail" view,
 *  rendered inside the app from the authoritative Tag Assistant debug stream. */
function TaEventTimeline({ events }: { events: NonNullable<VerifyTagsResult['taEvents']> }): JSX.Element {
  const [open, setOpen] = useState<Set<number>>(new Set([events.find((e) => e.tagsFired.length)?.seq ?? -1]));
  const [shot, setShot] = useState<{ src: string; name: string } | null>(null);
  const statusColor = (s: string): string => (s === 'fired' ? 'var(--c-green)' : s === 'failed' ? 'var(--c-red)' : 'var(--text-muted)');
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6, letterSpacing: 0.2 }}>Event timeline <span style={{ ...styles.muted, fontWeight: 400 }}>· what Tag Assistant saw, event by event</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {events.map((ev) => {
          const isOpen = open.has(ev.seq);
          const firedN = ev.tagsFired.filter((t) => t.status === 'fired').length;
          const failedN = ev.tagsFired.filter((t) => t.status === 'failed').length;
          const apiEntries = ev.apiCall ? Object.entries(ev.apiCall).filter(([k]) => k !== 'gtm.uniqueEventId') : [];
          const varEntries = ev.variables ? Object.entries(ev.variables) : [];
          return (
            <div key={ev.seq} style={{ border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <button
                onClick={() => setOpen((o) => { const n = new Set(o); n.has(ev.seq) ? n.delete(ev.seq) : n.add(ev.seq); return n; })}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
              >
                <span style={{ opacity: 0.6, fontSize: 11, width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                <code style={{ fontSize: 12.5, fontWeight: 600 }}>{ev.eventName || '(unnamed event)'}</code>
                <span style={{ flex: 1 }} />
                {firedN > 0 && <span style={{ fontSize: 11.5, color: 'var(--c-green)', fontWeight: 600 }}>{firedN} fired</span>}
                {failedN > 0 && <span style={{ fontSize: 11.5, color: 'var(--c-red)', fontWeight: 600 }}>{failedN} failed</span>}
                {ev.tagsFired.length === 0 && <span style={{ fontSize: 11.5, ...styles.muted }}>no tags</span>}
                {ev.screenshot && <span title="Tag Assistant screenshot attached" style={{ fontSize: 11, opacity: 0.6 }}>📷</span>}
              </button>
              {isOpen && (
                <div style={{ padding: '2px 10px 10px 30px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {apiEntries.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, ...styles.muted, marginBottom: 3 }}>API CALL — dataLayer.push</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 11.5, background: 'var(--surface-3)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.6, overflowX: 'auto' }}>
                        {apiEntries.map(([k, v]) => (
                          <div key={k}><span style={{ color: 'var(--c-blue)' }}>{k}</span>: <span>{typeof v === 'string' ? v : JSON.stringify(v)}</span></div>
                        ))}
                      </div>
                    </div>
                  )}
                  {ev.tagsFired.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, ...styles.muted, marginBottom: 3 }}>TAGS ON THIS EVENT</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {ev.tagsFired.map((t) => (
                          <div key={t.name} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ color: statusColor(t.status), fontWeight: 700 }}>{t.status === 'fired' ? '✓' : t.status === 'failed' ? '✕' : '•'}</span>
                            <span>{t.name}</span>
                            <span style={{ ...styles.muted, fontSize: 11 }}>{t.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {varEntries.length > 0 && (
                    <details>
                      <summary style={{ fontSize: 11, fontWeight: 700, ...styles.muted, cursor: 'pointer' }}>RESOLVED VARIABLES ({varEntries.length})</summary>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 4, lineHeight: 1.6, maxHeight: 160, overflowY: 'auto' }}>
                        {varEntries.map(([k, v]) => (<div key={k}><span style={{ opacity: 0.7 }}>{k}</span>: {v}</div>))}
                      </div>
                    </details>
                  )}
                  {ev.screenshot && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, ...styles.muted, marginBottom: 3 }}>TAG ASSISTANT PANEL</div>
                      <ProofThumb screenshot={ev.screenshot} name={`Tag Assistant — ${ev.eventName}`} onOpen={() => setShot({ src: ev.screenshot!, name: `Tag Assistant — ${ev.eventName}` })} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shot && <ProofLightbox shot={shot} onClose={() => setShot(null)} />}
    </div>
  );
}

/** Phase 3: DLV-based trigger suggestions for tags that did NOT fire — built from the real captured
 *  pushes, so the user can create/align a trigger for anything not firing. */
function TaTriggerSuggestions({ suggestions }: { suggestions: NonNullable<VerifyTagsResult['taSuggestions']> }): JSX.Element {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>How to track the tags that didn’t fire <span style={{ ...styles.muted, fontWeight: 400 }}>· DLV-based trigger suggestions</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {suggestions.map((s) => (
          <div key={s.tagName} style={{ border: '1px solid var(--c-amber-border)', background: 'var(--c-amber-bg)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>{s.tagName}</div>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>{s.how}</div>
            {s.conditions.length > 0 && (
              <div style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {s.conditions.map((c) => (
                  <span key={c.key} style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '2px 6px' }}>{c.builtin ? `{{${c.key}}}` : `{{dlv - ${c.key}}}`} = “{c.value}”</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A clickable screenshot thumbnail (opens the full image in a lightbox) — the visual proof cell.
 *  Shared by tag verification AND the tag-suggestion panel (both pass a JPEG data-URI + a name). */
function ProofThumb({ screenshot, name, onOpen }: { screenshot?: string; name: string; onOpen: () => void }): JSX.Element {
  if (!screenshot) return <span style={styles.muted}>—</span>;
  return (
    <button
      onClick={onOpen}
      title="View the full screenshot"
      style={{ padding: 0, border: '1px solid var(--border-2)', borderRadius: 5, cursor: 'zoom-in', lineHeight: 0, background: 'none' }}
    >
      <img src={screenshot} alt={`Screenshot for ${name}`} style={{ width: 72, height: 46, objectFit: 'cover', objectPosition: 'top', borderRadius: 4, display: 'block' }} />
    </button>
  );
}

/** One table for every informational verdict (fired / config-verified / server-side / untested). */
function VerifyResultsTable({ rows, onProof }: { rows: VVerdict[]; onProof: (v: VVerdict) => void }): JSX.Element {
  const anyProof = rows.some((v) => v.screenshot);
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)' }}>
      <table style={vStyles.table}>
        <thead>
          <tr>
            {['Status', 'Tag', 'Event', 'Fired via', 'Signal', ...(anyProof ? ['Proof'] : [])].map((h) => (
              <th key={h} style={vStyles.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const st = verdictStatus(v);
            const m = V_STATUS[st];
            const via = verdictKindLabel(v);
            // For an authoritative (monitor) verdict the "signal" is GTM's own report — its status +
            // execution time — not a sniffed beacon. Otherwise fall back to the observed beacon host(s).
            const signal = v.verifiedByMonitor
              ? (v.fired ? `GTM monitor: ${v.monitorStatus ?? 'fired'}${typeof v.monitorExecutionMs === 'number' ? ` · ${v.monitorExecutionMs}ms` : ''}` : '—')
              : v.observedBeacons?.length ? v.observedBeacons.join(', ') : v.fired ? 'GA4 hit' : '—';
            // Keep the per-tag "why / how to verify" guidance on hover so the compact table doesn't lose it.
            const hint = st === 'untested' ? verdictHowToTest(v) : v.reason ?? '';
            return (
              <tr key={v.tagId} title={hint || undefined}>
                <td style={vStyles.td}><span style={{ ...vStyles.statusPill, color: m.color, background: m.bg, borderColor: m.border }}>{m.icon} {m.short}</span></td>
                <td style={{ ...vStyles.td, color: 'var(--text)', fontWeight: 500 }}>{v.tagName}</td>
                <td style={vStyles.td}>{v.event ? <code style={mdStyles.code}>{v.event}</code> : <span style={styles.muted}>—</span>}</td>
                <td style={{ ...vStyles.td, whiteSpace: 'nowrap' }}><span title={via.label} aria-hidden>{via.icon}</span> {via.label}</td>
                <td style={{ ...vStyles.td, color: 'var(--text-muted)', fontSize: 12 }}>{signal}</td>
                {anyProof ? <td style={vStyles.td}><ProofThumb screenshot={v.screenshot} name={v.tagName} onOpen={() => onProof(v)} /></td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Full-screen overlay showing one verification screenshot. Close via the ✕ button, clicking the backdrop, or Esc. */
function ProofLightbox({ shot, onClose }: { shot: { src: string; name: string }; onClose: () => void }): JSX.Element {
  const [hoverClose, setHoverClose] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out' }}
    >
      {/* Explicit close button (top-right) — some users don't discover click-anywhere/Esc. */}
      <button
        type="button"
        aria-label="Close screenshot"
        title="Close (Esc)"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onMouseEnter={() => setHoverClose(true)}
        onMouseLeave={() => setHoverClose(false)}
        style={{
          position: 'fixed', top: 16, right: 20, zIndex: 1001,
          width: 40, height: 40, borderRadius: '50%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, lineHeight: 1, color: '#fff',
          background: hoverClose ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.35)',
          transition: 'background 0.12s ease',
        }}
      >
        ✕
      </button>
      <div style={{ color: '#fff', fontSize: 13, marginBottom: 8, fontWeight: 600, maxWidth: '92vw', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        📸 {shot.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>· click ✕, the backdrop, or press Esc to close</span>
      </div>
      <img
        src={shot.src}
        alt={`Verification screenshot for ${shot.name}`}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)', cursor: 'default' }}
      />
    </div>
  );
}

const vStyles: Record<string, React.CSSProperties> = {
  scoreGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10, margin: '12px 0 4px' },
  scoreCard: { border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3 },
  scoreNum: { fontSize: 28, fontWeight: 700, lineHeight: 1.05 },
  scoreLabel: { fontSize: 13, color: 'var(--text-dim)', fontWeight: 500 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '9px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-2)', fontWeight: 600, whiteSpace: 'nowrap' },
  td: { padding: '9px 12px', borderTop: '1px solid var(--border)', color: 'var(--text-dim)', verticalAlign: 'middle' },
  statusPill: { display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid transparent', borderRadius: 20, padding: '2px 9px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
};

// Real-submit form review (Phase 1b): fetch a page's forms + their OWN fields (Option 2) and show
// each with a locale-appropriate, EDITABLE test value + a Location picker. READ-ONLY — nothing is
// submitted here; the actual submit + tag-firing check is Phase 2.
// Container-tag-driven form verification: from the site's MAIN url, crawl to find forms, keep only the
// ones that HAVE a container form tag, collapse their fields into ONE de-duplicated data-entry set;
// the operator fills once, then every matched form is submitted for real and each tag is verified (with
// a fix suggestion when it doesn't fire). Real submits — an explicit warning + confirm gate them.
// Rendered INSIDE VerifyPanel — shares the same URL + Preview snippet as tag verification (one panel,
// one URL). This subsection does the container-tag-driven REAL-submit form check.
function FormFillReview({ url, snippet, active, onError, runSignal, onStatus, onReviewedForms, showFields = true, onSubmitForms, firedTags, onScanProgress }: { url: string; snippet: string; active: AccountView | undefined; onError: (m: string) => void; runSignal: number; onStatus?: (s: { loading: boolean; count: number | null }) => void; onReviewedForms?: (forms: NonNullable<VerifyTagsOptions['reviewedForms']>) => void; showFields?: boolean; onSubmitForms?: () => void; firedTags?: Set<string>; onScanProgress?: (p: VerifyProgressView) => void }): JSX.Element {
  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);
  const [plan, setPlan] = useState<FormTagVerifyPlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The ONE shared, de-duplicated data-entry: dedup key → value. Filled once, applied to every form.
  const [shared, setShared] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false); // Submit appears once the operator has entered/edited data
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<Record<number, SubmitFormVerifyResult>>({});
  // The real-submit screenshot currently shown full-screen (visual proof), or null.
  const [fLightbox, setFLightbox] = useState<{ src: string; name: string } | null>(null);

  const dedupKey = (role: string, label: string): string => (role === 'select' ? `select|${(label || '').toLowerCase().trim()}` : role);
  const isCheckbox = (t: string): boolean => t === 'checkbox' || t === 'radio';
  const setShrd = (k: string, v: string): void => { setTouched(true); setShared((s) => ({ ...s, [k]: v })); };

  // Auto-discover forms-with-tags whenever a tag-verify runs above (parent bumps runSignal). This is
  // what replaces a separate "Find forms with tags" button — one verify action does both. Skips the
  // initial mount (runSignal 0); fetchPlan itself no-ops with a note if the URL / GTM target isn't ready.
  useEffect(() => {
    if (runSignal > 0) void fetchPlan();
  }, [runSignal]); // intentionally only on the verify signal — not on url edits

  // Publish the operator-reviewed forms (matched forms + the edited shared values applied) UP to the
  // parent so the NEXT "Verify with Tag Assistant" run submits exactly these — Phase 2b. Recomputes
  // whenever the plan or an edited value changes.
  useEffect(() => {
    if (!onReviewedForms) return;
    const forms = (plan?.matched ?? []).map((form) => ({
      page: form.page,
      formId: form.formId,
      formClasses: form.formClasses,
      method: form.method,
      fields: form.fields.map((f) => ({ selector: f.selector, type: f.type, value: shared[dedupKey(f.role, f.label)] ?? f.value })),
      // Carry which tags this form is expected to fire, so a form tag whose form WAS submitted but that
      // didn't fire is reported as "not firing" (a real trigger mismatch), not vaguely "untested".
      expectedTags: form.expectedTags.map((t) => t.tagName),
    }));
    onReviewedForms(forms);
  }, [plan, shared]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchPlan(): Promise<void> {
    const target = url.trim();
    if (!target) { setNote('Enter your site’s main URL.'); return; }
    if (!ready || !ctx) { setNote('Pick a GTM account, container and workspace in the GTM bar above first — that’s the container whose form tags we verify.'); return; }
    setLoading(true); setNote(null); onError(''); setResults({}); setPlan(null); setTouched(false);
    onStatus?.({ loading: true, count: null }); // this run's form-discovery is now in flight
    let count: number | null = null;
    try {
      const res = await window.desktop.tags.formTagVerifyPlan(target, { accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: ctx.workspaceId! }, onScanProgress);
      setPlan(res);
      const sv: Record<string, string> = {};
      for (const f of res.sharedFields) sv[f.key] = f.value;
      setShared(sv);
      if (res.error) setNote(res.error);
      else if (res.matched.length === 0) setNote(`Crawled ${res.pagesCrawled} page(s) but found no site form matching your container’s form tags — the forms may be on pages we didn’t reach, render late, or their names differ from the tags.`);
      count = res.error ? null : res.matched.length;
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); onStatus?.({ loading: false, count }); }
  }

  async function submitAll(): Promise<void> {
    if (!plan || !ctx || submitting) return;
    setSubmitting(true); setConfirming(false); setResults({});
    try {
      for (let i = 0; i < plan.matched.length; i++) {
        const form = plan.matched[i];
        const fields = form.fields.map((f) => ({ selector: f.selector, type: f.type, value: shared[dedupKey(f.role, f.label)] ?? f.value }));
        const submitOpts = { ...(snippet.trim() ? { containerSnippet: snippet.trim() } : {}), accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: ctx.workspaceId! };
        try {
          const res = await window.desktop.tags.submitFormAndVerify(form.page, { formId: form.formId, formClasses: form.formClasses, method: form.method, fields }, submitOpts);
          setResults((r) => ({ ...r, [i]: res }));
        } catch (e) {
          setResults((r) => ({ ...r, [i]: { ok: false, injected: false, previewAuth: false, filled: 0, submitted: false, error: e instanceof Error ? e.message : String(e), events: [], beacons: [] } }));
        }
      }
    } finally { setSubmitting(false); }
  }

  // For a NOT-fired tag on a submitted form: what to change.
  const fixFor = (r: SubmitFormVerifyResult, tag: { eventName: string; platform: string }): string => {
    if (!r.submitted) return `The form couldn’t be submitted (${r.note ?? 'no form/submit control found'}). Check the form’s fields/selectors, then retry.`;
    const isPixel = !(tag.platform === 'ga4_event' || tag.platform === 'google_tag');
    if (isPixel) {
      if (r.beacons.length === 0) return `The form submitted but this ${tag.platform.replace(/_/g, ' ')} tag sent NO beacon — check it isn’t paused / blocked by an exception, its Consent Mode gate (ad_storage) isn’t denying it, and its pixel/conversion id is set. For DRAFT tags, paste a Preview snippet above.`;
      return `The form beaconed to [${r.beacons.join(', ')}] but not this tag’s vendor — the tag’s trigger/condition may not match this form, or it’s configured for a different pixel.`;
    }
    if (r.events.length === 0) return `The form submitted but pushed NO GA4 event — the site isn’t emitting its form_submission dataLayer event. Add the form’s listener (a Custom HTML tag that pushes the event on submit-success), or, for DRAFT tags, paste a GTM Preview snippet above. Confirm in GTM Preview.`;
    return `The form fired [${r.events.join(', ')}] but not “${tag.eventName}”. Either this tag’s trigger condition (form name / id / page) doesn’t match this form, or its GA4 Event Name differs — align the tag’s Event Name to one of the fired events, or fix its form-name condition.`;
  };

  const matched = plan?.matched ?? [];

  return (
    <>
      <div style={{ borderTop: '1px solid rgba(128,128,128,0.22)', marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>Forms — verified by a real submit</div>
        <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 2, marginBottom: 6 }}>
          When you run <b>Verify with Tag Assistant</b>, we first scan the site and match its forms to your container’s form tags. If you choose to verify them, edit the shared data once below and submit — each form is submitted for real inside the Tag Assistant session and its form_submission (and the tags it fired) show in the results above. Real submits create a real lead per form.
        </div>
      </div>
      <div style={styles.card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* No separate "find forms" button — the tag-verify above triggers discovery. */}
          {loading ? (
            <span style={{ ...styles.muted, fontSize: 12.5 }}>Crawling &amp; matching forms…</span>
          ) : plan ? (
            <span style={{ fontSize: 12.5, color: matched.length ? 'var(--c-green)' : 'var(--text-muted)' }}>
              {matched.length ? `✓ ${matched.length} form(s) with tags` : 'No forms with tags found'}
            </span>
          ) : (
            <span style={{ ...styles.muted, fontSize: 12.5 }}>Runs when you verify above</span>
          )}
        </div>
        {showFields && (
          <div style={{ ...styles.muted, fontSize: 12, marginTop: 6 }}>
            Each field is pre-filled with a generic, editable test value (name “Test”, email test@gmail.com) — edit any of them below.
          </div>
        )}
          {note && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--c-amber)', background: 'rgba(230,160,30,0.08)', color: 'var(--text)' }}>{note}</div>
          )}
        </div>

        {plan && matched.length > 0 && (showFields || firedTags) && (
          <>
            {showFields && (
            <div style={styles.card}>
              <div style={styles.h2}>Enter the data once ({plan.sharedFields.length} field(s))</div>
              <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6 }}>
                Fields are de-duplicated across the {matched.length} form(s) — this data fills every one of them. Edit anything, then submit.
              </div>
              <ul style={styles.resultList}>
                {plan.sharedFields.map((f) => (
                  <li key={f.key} style={{ ...styles.resultRow, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 150, fontSize: 13 }}>{f.label}<span style={{ ...styles.muted, marginLeft: 6, fontSize: 11 }}>{f.role}</span></span>
                    {isCheckbox(f.type) ? (
                      <label style={{ ...styles.muted, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="checkbox" checked={(shared[f.key] ?? f.value) === 'true'} onChange={(e) => setShrd(f.key, e.target.checked ? 'true' : '')} />
                        {(shared[f.key] ?? f.value) === 'true' ? 'checked' : 'unchecked'}
                      </label>
                    ) : f.options && f.options.length ? (
                      <select value={shared[f.key] ?? f.value} onChange={(e) => setShrd(f.key, e.target.value)} style={{ ...styles.input, minWidth: 180 }}>
                        {f.options.map((o) => (<option key={o} value={o}>{o}</option>))}
                      </select>
                    ) : (
                      <input value={shared[f.key] ?? f.value} onChange={(e) => setShrd(f.key, e.target.value)} style={{ ...styles.input, flex: 1, minWidth: 180 }} />
                    )}
                  </li>
                ))}
              </ul>
              {(touched || Object.keys(results).length > 0 || onSubmitForms) ? (
                confirming ? (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--c-red)', background: 'rgba(220,60,60,0.08)', fontSize: 13 }}>
                    <div style={{ color: 'var(--text)' }}>
                      ⚠ This <b>really submits all {matched.length} form(s)</b> — a real submission / lead is created for each in your CRM / inbox and can trigger
                      autoresponders, Slack/Zapier automations, or sales-rep assignment. GA4 and known ad-pixel hits are captured (not sent), but a less-common
                      pixel or server-side automation may still fire for real. Continue?
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {/* Orchestrated flow: hand back to the parent's single Tag Assistant run (click tags +
                          real submits). Legacy (no onSubmitForms): the standalone beacon-based submit. */}
                      <button style={styles.dangerGhost} onClick={() => { setConfirming(false); if (onSubmitForms) onSubmitForms(); else void submitAll(); }} disabled={submitting}>{submitting ? 'Submitting…' : `Yes, submit all ${matched.length} & verify`}</button>
                      <button style={styles.toggleOff} onClick={() => setConfirming(false)} disabled={submitting}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button style={styles.primaryBtn} onClick={() => setConfirming(true)} disabled={submitting}>
                    {submitting ? 'Submitting…' : onSubmitForms ? `Submit all ${matched.length} form(s) & run Tag Assistant` : `Submit all ${matched.length} form(s) & verify`}
                  </button>
                )
              ) : (
                <div style={{ ...styles.muted, fontSize: 12 }}>Review / edit the data above — the Submit button appears once you enter it.</div>
              )}
            </div>
            )}

            {matched.map((form, i) => {
              const r = results[i];
              return (
                <div key={`${form.page}|${form.formId}|${form.formTitle}`} style={styles.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={styles.h2}>{form.formTitle || '(untitled form)'}</div>
                    <span style={{ ...styles.muted, fontSize: 12, border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '1px 6px' }}>{form.purpose}</span>
                    <span style={{ ...styles.muted, fontSize: 12 }}>{form.page.replace(/^https?:\/\//, '').slice(0, 60)}</span>
                    {form.method === 'js' ? <span style={{ ...styles.muted, fontSize: 12 }}>(JS/div widget)</span> : null}
                  </div>
                  {firedTags ? (
                    // AFTER a Tag Assistant run: show whether each expected tag actually fired (from the
                    // real submit), so the Forms section itself reports fired / not-fired per tag.
                    <ul style={{ ...styles.resultList, marginTop: 6 }}>
                      {form.expectedTags.map((t) => {
                        const didFire = firedTags.has(t.tagName);
                        return (
                          <li key={t.tagName} style={{ ...styles.resultRow, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: didFire ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap' }}>{didFire ? '✅ Fired' : '❌ Not fired'}</span>
                            <span style={{ fontSize: 12.5 }}>{t.tagName}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 4 }}>Tag(s) expected to fire: {form.expectedTags.map((t) => t.tagName).join(', ')}</div>
                  )}
                  {r && (
                    <div style={{ fontSize: 12.5, marginTop: 8 }}>
                      {r.error ? (
                        <span style={{ color: 'var(--c-red)' }}>Error: {r.error}</span>
                      ) : (
                        <>
                          <div style={{ ...styles.muted }}>
                            {r.submitted ? `Submitted (${r.filled} field(s)).` : `Not submitted: ${r.note ?? 'no form/submit control'}.`}
                            {r.events.length > 0 ? ` Fired: ${r.events.join(', ')}.` : ''}
                            {r.injected && !r.previewAuth ? ' (snippet had no preview auth — published container loaded)' : ''}
                          </div>
                          {r.screenshot ? (
                            <button
                              onClick={() => setFLightbox({ src: r.screenshot!, name: form.formTitle || 'form' })}
                              title="View the screenshot of the real submit (the form is ringed)"
                              style={{ padding: 0, border: '1px solid var(--border-2)', borderRadius: 6, cursor: 'zoom-in', lineHeight: 0, background: 'none', marginTop: 6 }}
                            >
                              <img src={r.screenshot} alt={`Submit screenshot for ${form.formTitle}`} style={{ width: 132, height: 82, objectFit: 'cover', objectPosition: 'top', borderRadius: 5, display: 'block' }} />
                            </button>
                          ) : null}
                          {/* Per-tag results as a TABLE (mirrors the monitor firing table) instead of a list. */}
                          <div style={{ overflowX: 'auto', marginTop: 8 }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                              <thead>
                                <tr>
                                  {['Status', 'Tag', 'Result'].map((h) => (
                                    <th key={h} style={{ textAlign: 'left', padding: '5px 8px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {form.expectedTags.map((t) => {
                                  const fired = (r.firedTags ?? []).some((ft) => ft.tagName === t.tagName);
                                  // A pixel tag fed server-side (CAPI): no browser beacon, but the form relayed to
                                  // the first-party sGTM. Expected, not a failure — same rule as the synthetic path.
                                  const serverSide = !fired && (r.serverRelayTags ?? []).some((n) => n === t.tagName);
                                  return (
                                    <tr key={t.tagName} style={{ borderBottom: '1px solid var(--border)' }}>
                                      <td style={{ padding: '5px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                                        {fired ? <span style={{ color: 'var(--c-green)', fontWeight: 600 }}>✅ Fired</span>
                                          : serverSide ? <span style={{ color: 'var(--c-blue)', fontWeight: 600 }}>🛰 Server-side</span>
                                          : <span style={{ color: 'var(--c-red)', fontWeight: 600 }}>❌ Not fired</span>}
                                      </td>
                                      <td style={{ padding: '5px 8px', verticalAlign: 'top', fontWeight: 600 }}>{t.tagName}</td>
                                      <td style={{ padding: '5px 8px', verticalAlign: 'top', color: 'var(--text-dim)' }}>
                                        {fired ? 'Browser beacon captured on the real submit.'
                                          : serverSide ? 'No browser beacon — relayed server-side to your sGTM (CAPI). Confirm in the vendor’s Events Manager → Test Events.'
                                          : fixFor(r, t)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {plan && plan.unmatchedTags.length > 0 && (() => {
          // A form tag can be UNMATCHED (we found no site form for it) yet still FIRE during the run (its
          // form is named differently, shares a page, or another submit triggered it). Those are NOT a
          // problem — only tags that neither matched a form NOR fired need manual checking. Before a run
          // (no firedTags) we can't split, so show the plain unmatched list.
          const firedUnmatched = firedTags ? plan.unmatchedTags.filter((n) => firedTags.has(n)) : [];
          const openUnmatched = firedTags ? plan.unmatchedTags.filter((n) => !firedTags.has(n)) : plan.unmatchedTags;
          return (
            <>
              {firedUnmatched.length > 0 && (
                <div style={styles.card}>
                  <div style={{ ...styles.h2, color: 'var(--c-green)' }}>Form tags that fired without a matched form ({firedUnmatched.length})</div>
                  <div style={{ ...styles.muted, fontSize: 12 }}>These form tags fired during the run even though we didn’t pair them to a specific site form (the form is likely named differently or shares a page). They ARE firing — no action needed.</div>
                  <ul style={styles.resultList}>
                    {firedUnmatched.map((n) => (<li key={n} style={{ ...styles.resultRow, display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ color: 'var(--c-green)', fontWeight: 600, fontSize: 12.5 }}>✅ Fired</span><span style={{ fontSize: 12.5 }}>{n}</span></li>))}
                  </ul>
                </div>
              )}
              {openUnmatched.length > 0 && (
                <div style={styles.card}>
                  <div style={{ ...styles.h2, color: 'var(--c-amber)' }}>{firedTags ? `Not found and not fired (${openUnmatched.length})` : `Form tags with no matching form (${openUnmatched.length})`}</div>
                  <div style={{ ...styles.muted, fontSize: 12 }}>{firedTags ? 'These form tags neither matched a form we found NOR fired during the run — the form may be on an un-crawled / behind-login page, render late, or its name differs from the tag. Verify those manually.' : 'These container form tags matched no form we found on the site — the form may be on an un-crawled/behind-login page, render late, or its name differs from the tag. Verify those manually.'}</div>
                  <ul style={styles.resultList}>
                    {openUnmatched.map((n) => (<li key={n} style={styles.resultRow}>{n}</li>))}
                  </ul>
                </div>
              )}
            </>
          );
        })()}
      {fLightbox && <ProofLightbox shot={fLightbox} onClose={() => setFLightbox(null)} />}
    </>
  );
}

// Dedicated "Tag verification" workspace: proves the container's existing tags (and forms) fire when
// their trigger runs, splitting the result into Fired vs Not firing (with the reason + the change
// needed). Reuses the container-verify mapper + the abort-first verify engine; nothing real is sent.
function VerifyPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);
  const [vUrl, setVUrl] = useState('');
  const [vSnippet, setVSnippet] = useState('');
  const [vVerifyPages, setVVerifyPages] = useState('');
  const [vVerifying, setVVerifying] = useState(false);
  const [vVerifyKind, setVVerifyKind] = useState<'firing' | 'ta' | null>(null);
  // The operator-reviewed forms (edited values) published up from the Forms panel — submitted for real by
  // the next "Verify with Tag Assistant" run (Phase 2b). A ref so an edit doesn't re-render the buttons.
  const vReviewedFormsRef = useRef<NonNullable<VerifyTagsOptions['reviewedForms']>>([]);
  const [vProgress, setVProgress] = useState<VerifyProgressView | null>(null);
  const [vResult, setVResult] = useState<VerifyTagsResult | null>(null);
  const [vSkipped, setVSkipped] = useState<Array<{ tagId: string; name: string; reason: string }>>([]);
  const [vShowSkipped, setVShowSkipped] = useState(false);
  const [vShowNet, setVShowNet] = useState(false);
  const [vShowDl, setVShowDl] = useState(false);
  // The results TABLE (with per-tag screenshots) is the primary view; the event-by-event timeline is a
  // collapsed secondary detail (users found the side-by-side table easier to read).
  const [vShowTimeline, setVShowTimeline] = useState(false);
  // Whether the LAST run actually submitted the forms (Proceed), so the Forms section shows per-form
  // fired/not-fired only when they were really tested — a Skip run must not show forms as "not fired".
  const [vFormsVerified, setVFormsVerified] = useState(false);
  // Collapse the (tall) setup form once a run completes — the results table becomes the focus; a compact
  // bar shows the URL(s) used + a "Start new tag verification" button that re-opens the form.
  const [vSetupOpen, setVSetupOpen] = useState(true);
  // Results filters (empty set = show all): status (fired/untested/notfired), interaction type
  // (click/form), platform (ga4/meta/html), and a tag-name search. Pure client-side over the verdicts.
  const [fStatus, setFStatus] = useState<Set<string>>(new Set());
  const [fType, setFType] = useState<Set<string>>(new Set());
  const [fPlatform, setFPlatform] = useState<Set<string>>(new Set());
  const [fSearch, setFSearch] = useState('');
  // The verification screenshot currently shown full-screen (visual proof), or null.
  const [vLightbox, setVLightbox] = useState<{ src: string; name: string } | null>(null);
  const showProof = (v: VVerdict): void => { if (v.screenshot) setVLightbox({ src: v.screenshot, name: v.tagName }); };
  // The embedded form-discovery's status (bubbled up) so this ONE Verify run shows a single combined
  // state — tags + forms — instead of two independent-looking passes.
  const [vFormStatus, setVFormStatus] = useState<{ loading: boolean; count: number | null }>({ loading: false, count: null });
  // The Tag-Assistant wizard stage: idle → scanning (crawl + match forms) → gate (skip/proceed) →
  // filling (edit the shared data). The actual Tag Assistant run (click tags [+ real form submits]) fires
  // when the user picks Skip, Proceed+Submit, or when the scan finds no forms.
  const [vTaStage, setVTaStage] = useState<'idle' | 'scanning' | 'gate' | 'filling'>('idle');
  const [vNote, setVNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  // Bumped whenever a tag-verify runs; the embedded Forms subsection watches it and auto-discovers the
  // site's forms-with-tags in the same pass — so there's ONE action, not a separate "find forms" button.
  const [vRunSignal, setVRunSignal] = useState(0);
  // Event-name aligns applied this session (tagId → new event name), so the row shows "✓ aligned".
  const [aligned, setAligned] = useState<Record<string, string>>({});
  const [aligning, setAligning] = useState<string | null>(null);
  // The CURRENT editable workspace. "Auto" mints a preview which SUBMITS the workspace (now read-only)
  // and hands back a fresh one; a later "Align Event Name" write must target THAT, not the stale
  // context prop (which lags a render behind) — otherwise "Workspace is already submitted".
  const vWsRef = useRef<string>(ctx?.workspaceId ?? '');
  useEffect(() => { vWsRef.current = ctx?.workspaceId ?? ''; }, [ctx?.workspaceId]);

  function verifyErrorText(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    if (/invalid_grant|expired or revoked|token has been expired|AUTH_EXPIRED/i.test(m)) {
      return 'Your Google connection has expired or was revoked. Re-connect this account (sidebar → the account, or Settings → Connect) and try again.';
    }
    if (/ETIMEDOUT|fetch failed|ENOTFOUND|ECONNREFUSED|network|getaddrinfo/i.test(m)) {
      return 'Could not reach Google (network timeout). Check your internet / VPN / proxy and try again.';
    }
    return m;
  }

  async function runVerify(snippetOverride?: string, useMonitor = false, withForms = false): Promise<void> {
    if (!ready || !ctx || vVerifying) return;
    const target = vUrl.trim();
    if (!target) { setVNote({ kind: 'error', text: 'Enter the site URL to verify against.' }); return; }
    // AUTHORITATIVE mode automates the REAL Tag Assistant — ZERO GTM writes (no version, no workspace,
    // no container). No confirm needed; it may require a one-time Google sign-in (surfaced below).
    const canMonitor = Boolean(ctx.accountId && ctx.containerId && ctx.workspaceId);
    if (useMonitor && !canMonitor) {
      setVNote({ kind: 'error', text: 'Pick a GTM account, container and workspace first — verification reads that container’s tags.' });
      return;
    }
    setVTaStage('idle'); // a run supersedes the scan/gate/fill wizard
    setVVerifying(true);
    setVVerifyKind(useMonitor ? 'ta' : 'firing');
    setVProgress({ phase: 'prepare', message: 'Preparing verification…' });
    setVNote(null);
    onError('');
    // Submit the operator's REVIEWED/edited forms (from the Forms panel) only when this run was launched
    // from "Proceed with form verification" (withForms). The forms were already scanned + matched up front
    // (startTaFlow), so there's no re-discovery here and the edited values are read straight off the ref.
    const reviewedForms = useMonitor && withForms ? [...vReviewedFormsRef.current] : [];
    setVFormsVerified(reviewedForms.length > 0); // this run submitted forms → show per-form fired status
    try {
      const { tags, skipped } = await window.desktop.gtm.verifiableTags(ctx.accountId!, ctx.containerId!, ctx.workspaceId!);
      setVSkipped(skipped);
      if (tags.length === 0) {
        setVResult(null);
        setVNote({
          kind: 'info',
          text:
            skipped.length > 0
              ? `None of this container's ${skipped.length} tag(s) map to a drivable trigger (click / form / custom-event / page load) — see “not verifiable” below.`
              : "This container has no readable tags. If it should have tags, your Google connection has likely expired — re-connect and retry.",
        });
        return;
      }
      const snippet = (snippetOverride ?? vSnippet).trim();
      // "Pages to verify" — one URL per line. When present, verify drives every tag on each of these pages
      // (skips the auto-crawl), so forms/tags on pages the crawl missed get exercised.
      const verifyPages = vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const res = await window.desktop.tags.verify(
        target,
        tags,
        [],
        {
          gtmDebug: true,
          ...(snippet ? { containerSnippet: snippet } : {}),
          ...(verifyPages.length ? { verifyPages } : {}),
          // Phase 2b: submit the user's REVIEWED/edited form values (from the Forms panel) instead of the
          // auto defaults. Snapshotted above before the panel re-discovered; empty on the first run.
          ...(reviewedForms.length ? { reviewedForms } : {}),
          ...(useMonitor ? { monitor: { accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: ctx.workspaceId! } } : {}),
        },
        (p) => setVProgress(p), // live "scanning <url>" / "verifying <url>" feed
      );
      setVResult(res);
      if (!res.error) setVSetupOpen(false); // run done → collapse the setup form, lead with the results
    } catch (e) {
      setVNote({ kind: 'error', text: verifyErrorText(e) });
    } finally {
      setVVerifying(false);
      setVVerifyKind(null);
      setVProgress(null);
    }
  }

  // STEP 1 of the Tag-Assistant flow: scan the site and match its forms to the container's form tags FIRST
  // (no Tag Assistant yet). When the scan lands we either gate (forms found → ask skip/proceed) or, if there
  // are none, go straight to click-tag verification. Bumping vRunSignal triggers the Forms panel's scan; the
  // decision is made in the effect below once its status bubbles back.
  async function startTaFlow(): Promise<void> {
    if (!ready || !ctx || vVerifying || vTaStage === 'scanning') return;
    const target = vUrl.trim();
    if (!target) { setVNote({ kind: 'error', text: 'Enter the site URL to verify against.' }); return; }
    if (!(ctx.accountId && ctx.containerId && ctx.workspaceId)) {
      setVNote({ kind: 'error', text: 'Pick a GTM account, container and workspace first — verification reads that container’s tags.' });
      return;
    }
    setVNote(null); onError(''); setVResult(null);
    vReviewedFormsRef.current = [];
    setVFormStatus({ loading: true, count: null }); // guards the effect from acting on a prior scan's count
    setVTaStage('scanning');
    setVRunSignal((n) => n + 1); // Forms panel crawls + matches forms-with-tags for this URL
  }

  // Once STEP 1's scan finishes: forms found → open the skip/proceed gate; none → verify click tags only.
  useEffect(() => {
    if (vTaStage !== 'scanning' || vFormStatus.loading) return;
    if (vFormStatus.count && vFormStatus.count > 0) setVTaStage('gate');
    else { setVTaStage('idle'); void runVerify(undefined, true, false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vTaStage, vFormStatus]);

  // Apply the "align event name" fix: set the GA4 tag's Event Name to the value that actually
  // fired (draft-only write), then prompt a re-verify to confirm.
  async function alignEventName(v: VerifyTagsResult['verdicts'][number], eventName: string): Promise<void> {
    if (!ready || !ctx || aligning) return;
    setAligning(v.tagId);
    setVNote(null);
    try {
      await window.desktop.gtm.setTagEventName({ accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: vWsRef.current || ctx.workspaceId!, tagName: v.tagName, eventName });
      setAligned((a) => ({ ...a, [v.tagId]: eventName }));
      setVNote({ kind: 'info', text: `Set “${v.tagName}” Event Name → ${eventName}. Re-verify to confirm it fires.` });
    } catch (e) {
      setVNote({ kind: 'error', text: verifyErrorText(e) });
    } finally {
      setAligning(null);
    }
  }

  const fired = vResult?.verdicts.filter((v) => v.fired) ?? [];
  // Split real-interaction fires (real click / page load) from SYNTHETIC ones: a custom_event tag
  // "fired" because WE pushed its dataLayer event, which proves the tag's config but NOT that a real
  // submit emits it. Surfaced separately so a form fire isn't over-claimed as a real-submit proof.
  const firedReal = fired.filter((v) => !v.synthetic);
  const firedSynthetic = fired.filter((v) => v.synthetic);
  // A tag we couldn't actually exercise on this run (CTA/form on another page, or a shared
  // dataLayer event that needs form-specific data) is NOT a failure — separate it from genuine
  // "not firing" so a working tag is never mislabelled broken.
  // Server-side pixels (Meta/TikTok/… fed via the Conversion API) relay to the first-party sGTM and
  // send NO browser beacon — that's expected, not broken. Give them their own group so they never sit
  // under ❌ "not firing" NOR the "couldn't reach it" note (which would misdescribe why).
  const serverRelayed = vResult?.verdicts.filter((v) => !v.fired && v.inconclusive && v.serverRelay) ?? [];
  const inconclusive = vResult?.verdicts.filter((v) => !v.fired && v.inconclusive && !v.serverRelay) ?? [];
  const notFired = vResult?.verdicts.filter((v) => !v.fired && !v.inconclusive) ?? [];

  // ── Results filters (client-side over the verdicts) ────────────────────────────────────────────────
  const platformOf = (name: string): string =>
    /\bmeta\b|facebook|fb\s*pixel/i.test(name) ? 'meta'
      : /\bga4\b|google\s*analytics|gtag/i.test(name) ? 'ga4'
      : /\bchtml\b|custom\s*html|\bhtml\b/i.test(name) ? 'html'
      : 'other';
  const typeOf = (v: VVerdict): string => {
    const k = v.interaction?.kind;
    if (k === 'submit' || /form_submission|form_submit/i.test(v.event ?? '')) return 'form';
    if (k === 'click') return 'click';
    return 'other';
  };
  const passesTPS = (v: VVerdict): boolean => {
    if (fType.size && !fType.has(typeOf(v))) return false;
    if (fPlatform.size && !fPlatform.has(platformOf(v.tagName))) return false;
    const q = fSearch.trim().toLowerCase();
    if (q && !v.tagName.toLowerCase().includes(q)) return false;
    return true;
  };
  const showStatus = (s: string): boolean => fStatus.size === 0 || fStatus.has(s);
  const fFiredReal = firedReal.filter(passesTPS);
  const fFiredSynthetic = firedSynthetic.filter(passesTPS);
  const fServerRelayed = serverRelayed.filter(passesTPS);
  const fInconclusive = inconclusive.filter(passesTPS);
  const fNotFired = notFired.filter(passesTPS);
  const filtersActive = fStatus.size > 0 || fType.size > 0 || fPlatform.size > 0 || fSearch.trim().length > 0;
  const toggleF = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => (): void =>
    setter((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const FILTER_GROUPS: Array<{ label: string; items: Array<[string, string]>; set: Set<string>; setter: React.Dispatch<React.SetStateAction<Set<string>>> }> = [
    { label: 'Status', items: [['fired', 'Fired'], ['untested', 'Untested'], ['notfired', 'Not firing']], set: fStatus, setter: setFStatus },
    { label: 'Type', items: [['click', 'Clicks'], ['form', 'Forms']], set: fType, setter: setFType },
    { label: 'Platform', items: [['ga4', 'GA4'], ['meta', 'Meta'], ['html', 'cHTML']], set: fPlatform, setter: setFPlatform },
  ];

  return (
    <div style={styles.reviewWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>Tag verification</div>
          <div style={styles.chatSub}>Prove the container’s tags &amp; forms actually fire when their trigger runs — nothing real is sent (hits are captured &amp; aborted).</div>
        </div>
      </div>

      <div style={styles.reviewBody}>
        <div style={styles.card}>
          <div style={styles.muted}>
            Container:{' '}
            {ctx?.containerId ? (
              <b style={{ color: 'var(--text)' }}>{ctx.accountName} › {ctx.containerName} › {ctx.workspaceName ?? 'workspace?'}</b>
            ) : (
              <b style={{ color: 'var(--c-amber)' }}>none</b>
            )}
            {active?.email ? ` · ${active.email}` : ''}
          </div>
          {!vSetupOpen ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ ...styles.muted, fontSize: 13 }}>
                Verified: <b style={{ color: 'var(--text)' }}>{(vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)[0]) || vUrl.trim()}</b>
                {vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length > 1 ? <span style={styles.muted}> +{vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length - 1} more URL(s)</span> : null}
                {vResult?.pagesDriven?.length ? <span style={styles.muted}> · drove {vResult.pagesDriven.length} page(s)</span> : null}
              </span>
              <button style={styles.primaryBtn} onClick={() => { setVSetupOpen(true); setVNote(null); }}>Start new tag verification</button>
            </div>
          ) : (<>
          {!ready && (
            <div style={{ color: 'var(--c-amber)', fontSize: 13, marginTop: 4 }}>
              {!active?.hasGoogleToken ? 'Sign this account into Google first.' : 'Pick a GTM account, container and draft workspace in the Chat tab (the GTM bar), then return here.'}
            </div>
          )}
          <div style={{ ...styles.muted, marginTop: 8 }}>
            <b>One Verify run</b> drives every tag’s trigger on the live site AND discovers the forms that
            have a tracking tag — with a screenshot of each. It tests the tags as they’re <b>published</b> on
            this URL; <b>nothing is created in your container</b> (no version, no preview). The real form
            submit stays a separate, confirmed step below. To test UNPUBLISHED <b>draft</b> tags, paste a GTM
            <b> Preview</b> snippet (Tag Assistant) below — that loads your drafts and still creates nothing.
          </div>
          <input
            value={vUrl}
            onChange={(e) => setVUrl(e.target.value)}
            placeholder="https://www.example.com — the live site whose pages carry this container"
            style={{ ...styles.input, width: '100%', marginTop: 8 }}
            disabled={!ready}
          />
          <textarea
            value={vSnippet}
            onChange={(e) => setVSnippet(e.target.value)}
            placeholder="Paste your GTM PREVIEW snippet (with gtm_auth & gtm_preview). Required for 'Verify with Tag Assistant' to see your GTM container's tags — in GTM click Preview, then Share/Copy the snippet. Creates no version/environment."
            style={{ ...styles.input, width: '100%', minHeight: 52, marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}
            disabled={!ready}
          />
          <textarea
            value={vVerifyPages}
            onChange={(e) => setVVerifyPages(e.target.value)}
            placeholder="Pages to verify (optional) — one URL per line. When set, verify SKIPS the auto-crawl and drives every tag on ONLY these pages, so forms/tags on pages the crawl missed still get tested. e.g. https://www.example.com/contact"
            style={{ ...styles.input, width: '100%', minHeight: 52, marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}
            disabled={!ready}
          />
          {vVerifyPages.trim() && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Verifying only {vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length} page(s) — the site crawl is skipped.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <button
              style={styles.primaryBtn}
              onClick={() => void runVerify()}
              disabled={!ready || vVerifying || !vUrl.trim()}
              title="Load the live site and verify each tag — nothing is created in your container (no version, no preview)"
            >
              {vVerifyKind === 'firing' ? 'Verifying…' : 'Verify firing'}
            </button>
            <button
              style={{ background: 'transparent', color: 'var(--c-blue)', border: '1px solid var(--c-blue)', borderRadius: 10, padding: '10px 16px', fontSize: 14, cursor: 'pointer', ...(!ready || vVerifying || vTaStage === 'scanning' || !vUrl.trim() ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
              onClick={() => void startTaFlow()}
              disabled={!ready || vVerifying || vTaStage === 'scanning' || !vUrl.trim()}
              title="Authoritative: automates the REAL Tag Assistant — connects it to the site, drives your tags, and reads GTM's own per-event firing. First it scans the site for forms with tags and asks whether to verify those too. ZERO GTM writes. Signs in to Tag Assistant ONCE (saved after that, so it never asks again) and your normal Chrome can stay open."
            >
              {vVerifyKind === 'ta' ? 'Verifying with Tag Assistant…' : vTaStage === 'scanning' ? 'Scanning site for forms…' : 'Verify with Tag Assistant'}
            </button>
          </div>
          {/* STEP 2 — the skip/proceed gate, shown once the up-front form scan finds forms with tags. */}
          {vTaStage === 'gate' && (
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--c-blue)', background: 'rgba(70,130,240,0.06)' }}>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8, lineHeight: 1.45 }}>
                Found <b>{vFormStatus.count}</b> form(s) with a tracking tag. Verifying them submits each form <b>for real</b> (a real lead per form). Verify the forms too, or just the click tags?
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={styles.primaryBtn} onClick={() => setVTaStage('filling')}>Proceed with form verification</button>
                <button style={styles.toggleOff} onClick={() => { setVTaStage('idle'); void runVerify(undefined, true, false); }}>Skip forms — verify click tags only</button>
              </div>
            </div>
          )}
          {/* Sequential now: STEP 1 scans the site for forms, then (after the skip/proceed gate) the Tag
              Assistant run verifies the click tags [+ submits the reviewed forms for real]. */}
          {(vVerifying || vFormStatus.loading) ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden>⏳</span>
                <span>
                  {(vFormStatus.loading && !vVerifying)
                    ? <b>Scanning the site &amp; matching forms to tags…</b>
                    : <>
                        <b>Verifying with Tag Assistant</b>
                        {vFormStatus.count ? <span style={{ color: 'var(--c-green)' }}> · {vFormStatus.count} form(s) found</span> : null}
                      </>}
                </span>
              </div>
              {/* Indeterminate bar — no % is known (the driver loads + drives every page), so an animated
                  sliver signals "working" without a false percentage. */}
              <div className="vf-progress" role="progressbar" aria-label="Verification in progress" aria-busy="true" style={{ marginTop: 8 }} />
              {/* Live feed: the page being scanned/driven right now — low-opacity + fading so it reads as
                  "work in flight", with a phase label and (for the crawl/drive) an honest done/total. */}
              {vProgress && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, minWidth: 0 }}>
                  <span className="vf-live-dot" aria-hidden />
                  <span style={{ fontWeight: 600, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {vProgress.phase === 'crawl' ? 'Scanning pages'
                      : vProgress.phase === 'drive' ? 'Verifying tags'
                      : vProgress.phase === 'monitor' ? 'Minting monitor preview'
                      : 'Preparing'}
                  </span>
                  {vProgress.page && (
                    <span
                      key={vProgress.page}
                      className="vf-live-url"
                      title={vProgress.page}
                      style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 11.5, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}
                    >
                      {vProgressPageLabel(vProgress.page)}
                    </span>
                  )}
                  {typeof vProgress.done === 'number' && (
                    <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: 0.7, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      {vProgress.done}{vProgress.total ? ` / ${vProgress.total}` : ''}
                    </span>
                  )}
                </div>
              )}
              {/* Switching tabs UNMOUNTS this panel (it is conditionally rendered), which drops the in-flight
                  run's result — warn so the user doesn't lose a minute-long verification. */}
              <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45, border: '1px solid var(--c-amber)', background: 'rgba(230,160,30,0.08)', color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span aria-hidden>⚠️</span>
                <span>Keep this tab open until it finishes — it loads and drives every page, which can take a minute on a larger site. Leaving or switching tabs cancels the run and you'll have to start over.</span>
              </div>
            </div>
          ) : (vResult && !vResult.error && vTaStage === 'idle' && vFormStatus.count !== null && vFormStatus.count > 0) ? (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-dim)' }}>
              This site has <b>{vFormStatus.count}</b> form(s) with a tracking tag. To verify those by a real submit, run <b>Verify with Tag Assistant</b> again and choose <b>Proceed with form verification</b>.
            </div>
          ) : null}
          {vNote && (
            <div
              style={{
                marginTop: 10, padding: '8px 10px', borderRadius: 8, fontSize: 13, lineHeight: 1.45,
                border: `1px solid ${vNote.kind === 'error' ? 'var(--c-red)' : 'var(--c-amber)'}`,
                background: vNote.kind === 'error' ? 'rgba(220,60,60,0.08)' : 'rgba(230,160,30,0.08)',
                color: 'var(--text)',
              }}
            >
              {vNote.text}
            </div>
          )}
          </>)}
        </div>

        {vResult && (
          <div style={styles.card}>
            {vResult.injected && !vResult.previewAuth && (
              <div style={{ ...styles.muted, color: 'var(--c-amber)', marginBottom: 6 }}>
                ⚠ The snippet has no preview auth (gtm_auth/gtm_preview) — it loaded the PUBLISHED container, so DRAFT tags won’t fire. Use “Auto”, or paste the GTM Preview / Environment snippet.
              </div>
            )}
            {!vResult.injected && (
              <div style={{ ...styles.muted, color: 'var(--c-amber)', marginBottom: 6 }}>
                ⚠ Tested the page as-is (no container injected) — a tag can only fire if its container is already published on this URL. Use “Auto” or a Preview snippet to load DRAFT tags.
              </div>
            )}
            {/* GTM debug signal (Phase B): the #1 cause of "0 fired" is the container never loading. */}
            {vResult.gtmDebug && !vResult.gtmDebug.containerLoaded && vResult.injected && (
              <div style={{ ...styles.muted, color: 'var(--c-red)', marginBottom: 6 }}>
                ⚠ GTM debug: no GTM-XXXX container was detected on the page — the container didn’t load, so nothing could fire. Check the preview snippet / auth, or that the site isn’t blocking googletagmanager.com.
              </div>
            )}
            {/* AUTHORITATIVE run: results came from GTM's OWN monitor (addEventCallback), like Tag
                Assistant — the fired/not-fired below is exactly what GTM did, not beacon inference. */}
            {vResult.verifiedByMonitor && !vResult.error && (
              <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45, border: '1px solid var(--c-green)', background: 'rgba(60,180,90,0.08)', color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span aria-hidden>✓</span>
                <span><b>Authoritative</b> — read from the real Tag Assistant debug stream: each tag below is exactly what GTM fired on the driven events, not inferred from network hits. Nothing was created in your container (no version, no workspace).</span>
              </div>
            )}
            {vResult.error ? (
              <div style={{ fontWeight: 600, color: 'var(--c-red)' }}>Error: {vResult.error}</div>
            ) : (
              <VerifyScorecard fired={firedReal.length} config={firedSynthetic.length} server={serverRelayed.length} untested={inconclusive.length} issues={notFired.length} />
            )}
            {/* Filter + search bar for the results below — status / interaction type / platform / free text. */}
            {!vResult.error && vResult.verdicts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)' }}>
                <input
                  value={fSearch}
                  onChange={(e) => setFSearch(e.target.value)}
                  placeholder="Search tags…"
                  style={{ ...styles.input, flex: '1 1 170px', minWidth: 130, maxWidth: 260, padding: '5px 9px', fontSize: 12.5 }}
                />
                {FILTER_GROUPS.map((g) => (
                  <div key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <span style={{ ...styles.muted, fontSize: 11.5 }}>{g.label}:</span>
                    {g.items.map(([key, txt]) => {
                      const active = g.set.has(key);
                      return (
                        <button
                          key={key}
                          onClick={toggleF(g.setter, key)}
                          style={{ padding: '2px 9px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${active ? 'var(--c-blue)' : 'var(--border-2)'}`, background: active ? 'var(--c-blue)' : 'transparent', color: active ? '#fff' : 'var(--text-dim)' }}
                        >
                          {txt}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {filtersActive && (
                  <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => { setFStatus(new Set()); setFType(new Set()); setFPlatform(new Set()); setFSearch(''); }}>clear</button>
                )}
              </div>
            )}
            {filtersActive && !vResult.error && ((showStatus('fired') ? fFiredReal.length + fFiredSynthetic.length + fServerRelayed.length : 0) + (showStatus('untested') ? fInconclusive.length : 0) + (showStatus('notfired') ? fNotFired.length : 0)) === 0 && (
              <div style={{ ...styles.muted, fontSize: 13, marginTop: 12, padding: 12, textAlign: 'center', border: '1px dashed var(--border-2)', borderRadius: 8 }}>No tags match the current filters.</div>
            )}
            {/* Phase 3: the Tag-Assistant-style detail — the event timeline (API Call + tags fired per
                event). Collapsed by default: the results TABLE below now carries the per-tag screenshots,
                so it's the primary at-a-glance view; the timeline is opt-in detail. */}
            {!vResult.error && vResult.taEvents && vResult.taEvents.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button style={styles.linkBtn} onClick={() => setVShowTimeline((o) => !o)}>
                  {vShowTimeline ? 'hide' : 'show'} event-by-event timeline ({vResult.taEvents.length} event{vResult.taEvents.length === 1 ? '' : 's'})
                </button>
                {vShowTimeline && <TaEventTimeline events={vResult.taEvents} />}
              </div>
            )}
            {vResult.pagesDriven?.length && !vResult.error ? (
              <div style={{ ...styles.muted, fontSize: 12, marginTop: 2 }}>
                Drove across {vResult.pagesDriven.length} page(s)
                {vResult.pagesCrawled ? ` (scanned ${vResult.pagesCrawled}${vResult.pagesTotal && vResult.pagesTotal > vResult.pagesCrawled ? ` of ${vResult.pagesTotal}` : ''} site page(s) from the sitemap to locate each CTA)` : ''} — each click tag is
                driven on the page its CTA actually lives on.
                {vResult.pagesTotal && vResult.pagesCrawled && vResult.pagesTotal > vResult.pagesCrawled
                  ? ` The site has ${vResult.pagesTotal} pages; we scanned the ${vResult.pagesCrawled} highest-priority ones (forms/CTAs first) — a tag whose CTA lives only on an un-scanned page shows “untested here”.`
                  : ''}
              </div>
            ) : null}
            {vResult.gtmDebug && vResult.gtmDebug.containerLoaded && (
              <div style={{ ...styles.muted, fontSize: 12, marginTop: 2 }}>
                GTM debug: container {vResult.gtmDebug.containerIds.join(', ') || 'loaded'} · events seen: {vResult.gtmDebug.dataLayerEvents.slice(0, 12).join(', ') || '—'}
              </div>
            )}

            {vResult.networkLog && vResult.networkLog.length > 0 && (() => {
              const log = vResult.networkLog!;
              const hasMeta = log.some((h) => h.vendor === 'meta');
              const hasSgtm = log.some((h) => h.vendor === 'sgtm' || h.vendor === 'ga4');
              return (
                <div style={{ marginTop: 6 }}>
                  <button style={styles.linkBtn} onClick={() => setVShowNet((o) => !o)}>
                    {vShowNet ? 'hide' : 'show'} network log ({log.length} call{log.length === 1 ? '' : 's'} captured{hasMeta ? ' · Meta pixel seen' : ''})
                  </button>
                  {vShowNet && (
                    <div style={{ marginTop: 4 }}>
                      <ul style={{ ...styles.resultList, fontFamily: 'monospace', fontSize: 11.5 }}>
                        {log.map((h, i) => (
                          <li key={i} style={{ ...styles.resultRow, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span style={{ minWidth: 74, fontWeight: 700, color: h.vendor === 'meta' ? '#993556' : h.vendor === 'ga4' || h.vendor === 'sgtm' ? '#185FA5' : 'var(--text)' }}>{h.vendor}</span>
                            <span style={{ color: 'var(--text)' }}>{h.endpoint}</span>
                            {h.params ? <span style={styles.muted}>{h.params}</span> : null}
                          </li>
                        ))}
                      </ul>
                      <div style={{ ...styles.muted, fontSize: 11.5, marginTop: 2 }}>
                        Browser-side only (captured then aborted — nothing was delivered). {hasSgtm ? 'A /g/collect to your sGTM means the web→server relay fired; ' : ''}the server-side Meta CAPI call (graph.facebook.com) is not visible here — confirm it in sGTM Preview / Events Manager → Test Events.
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {vResult.dataLayer && vResult.dataLayer.length > 0 && (() => {
              const dl = vResult.dataLayer!;
              const real = dl.filter((e) => !e.synthetic);
              return (
                <div style={{ marginTop: 6 }}>
                  <button style={styles.linkBtn} onClick={() => setVShowDl((o) => !o)}>
                    {vShowDl ? 'hide' : 'show'} dataLayer ({real.length} real event{real.length === 1 ? '' : 's'} captured)
                  </button>
                  {vShowDl && (
                    <div style={{ marginTop: 4 }}>
                      <ul style={{ ...styles.resultList, fontFamily: 'monospace', fontSize: 11.5 }}>
                        {dl.map((e, i) => (
                          <li key={i} style={{ ...styles.resultRow, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span style={{ minWidth: 150, fontWeight: 700, color: e.synthetic ? 'var(--c-amber)' : '#185FA5' }}>{e.event}</span>
                            {e.params ? <span style={{ color: 'var(--text)' }}>{e.params}</span> : <span style={styles.muted}>(no params)</span>}
                            {e.synthetic ? <span style={{ ...styles.muted, fontStyle: 'italic' }}>· pushed by verifier (test)</span> : null}
                          </li>
                        ))}
                      </ul>
                      <div style={{ ...styles.muted, fontSize: 11.5, marginTop: 2 }}>
                        What your site actually pushed to the dataLayer. Use the event name + params as the trigger condition (e.g. a tag that keys off <code>form_name</code> should match the exact value shown here). Amber rows were pushed by the verifier to test a custom-event tag — not proof the site fires them.
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {showStatus('fired') && (fFiredReal.length + fFiredSynthetic.length + fServerRelayed.length) > 0 && !vResult.error && (
              <div style={{ marginTop: 12 }}>
                <VerifyResultsTable rows={[...fFiredReal, ...fFiredSynthetic, ...fServerRelayed]} onProof={showProof} />
                {(fFiredSynthetic.length > 0 || fServerRelayed.length > 0) && (
                  <div style={{ ...styles.muted, fontSize: 11.5, marginTop: 8, lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {fFiredSynthetic.length > 0 && <span>⚙ <b style={{ color: 'var(--c-amber)' }}>Config-verified</b> — fired on a synthetic dataLayer push (trigger is wired right), NOT a real submit. Confirm with a real submit in GTM Preview.</span>}
                    {fServerRelayed.length > 0 && <span>🛰 <b style={{ color: 'var(--c-blue)' }}>Server-side</b> — no browser beacon, but relayed to your sGTM (normal for Conversion-API destinations).</span>}
                  </div>
                )}
              </div>
            )}

            {/* UNTESTED = we never exercised the trigger here (its CTA wasn't on a page we drove, or its form
                wasn't submitted). NOT the same as "not firing". Show, per tag, WHY it wasn't tested + how to
                test it — visibly, not just on hover — so the operator knows these were skipped, not broken. */}
            {showStatus('untested') && fInconclusive.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...styles.h2, color: 'var(--text-dim)' }}>⏭ Untested here ({fInconclusive.length}{filtersActive && fInconclusive.length !== inconclusive.length ? ` of ${inconclusive.length}` : ''})</div>
                <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6, lineHeight: 1.5 }}>
                  We didn’t exercise these tags’ triggers in this run — this is <b>not</b> “not firing”. Either the CTA/link they listen to wasn’t on a page we drove, or (for a form tag) its form wasn’t among the ones submitted. Below is why each one, and how to actually test it.
                </div>
                <ul style={styles.resultList}>
                  {fInconclusive.map((v) => {
                    const k = verdictKindLabel(v);
                    return (
                      <li key={v.tagId} style={{ ...styles.resultRow, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'stretch' }}>
                        <div><span style={{ fontWeight: 600, color: 'var(--text-dim)' }}>UNTESTED</span> <span title={k.label} aria-hidden>{k.icon}</span> {v.tagName}</div>
                        {v.reason ? <div style={{ ...styles.muted, marginLeft: 8, marginTop: 2 }}>Why: {v.reason}</div> : null}
                        <div style={{ marginLeft: 8, marginTop: 2, color: 'var(--c-blue)', fontSize: 12.5 }}>How to test: {verdictHowToTest(v)}</div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {showStatus('notfired') && fNotFired.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...styles.h2, color: 'var(--c-red)' }}>❌ Not firing ({fNotFired.length}{filtersActive && fNotFired.length !== notFired.length ? ` of ${notFired.length}` : ''})</div>
                <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6, lineHeight: 1.5 }}>
                  We <b>did</b> exercise these — drove the click / submitted the form — but GTM did not fire the tag. That means a <b>trigger condition doesn’t match</b> what the page sent. Compare each condition (event name, form name / id, page path) against the dataLayer below.
                </div>
                <ul style={styles.resultList}>
                  {fNotFired.map((v) => {
                    const k = verdictKindLabel(v);
                    return (
                      <li key={v.tagId} style={{ ...styles.resultRow, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        {v.screenshot ? <div style={{ flexShrink: 0, marginTop: 2 }}><ProofThumb screenshot={v.screenshot} name={v.tagName} onOpen={() => showProof(v)} /></div> : null}
                        <div style={{ flex: 1, minWidth: 0 }}>
                        <div>
                          <span style={{ fontWeight: 600, color: 'var(--c-red)' }}>NOT FIRED</span>{' '}
                          <span title={k.label}>{k.icon}</span> {v.tagName}
                        </div>
                        {v.reason ? <div style={{ ...styles.muted, marginLeft: 8, marginTop: 2 }}>Why: {v.reason}</div> : null}
                        {v.observedBeacons && v.observedBeacons.length > 0 && (
                          <div style={{ ...styles.muted, marginLeft: 8, marginTop: 2, fontSize: 12 }}>Beacons seen: {v.observedBeacons.join(', ')}</div>
                        )}
                        <div style={{ marginLeft: 8, marginTop: 2, color: 'var(--c-blue)', fontSize: 12.5 }}>Fix: {verdictHowToFix(v)}</div>
                        {v.observedEvents && v.observedEvents.length > 0 && (
                          <div style={{ marginLeft: 8, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            {aligned[v.tagId] ? (
                              <span style={{ color: 'var(--c-green)', fontSize: 12.5 }}>✓ Event Name set to {aligned[v.tagId]} — re-verify to confirm.</span>
                            ) : (
                              v.observedEvents.map((ev) => (
                                <button
                                  key={ev}
                                  style={{ ...styles.toggleOff, fontSize: 12.5, padding: '3px 8px' }}
                                  disabled={aligning === v.tagId}
                                  onClick={() => void alignEventName(v, ev)}
                                  title={`Set this GA4 tag's Event Name to "${ev}" (draft-only; never publishes)`}
                                >
                                  {aligning === v.tagId ? 'Aligning…' : `Align Event Name → ${ev}`}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* FOOTER: DLV-based "how to fire the ones that didn't" suggestions. Placed at the END of the
                results (below the Fired / Untested / Not-firing tables) so it reads as a fix-it footer where
                the table ends, not a banner above the results. Same render condition as before. */}
            {!vResult.error && vResult.taSuggestions && vResult.taSuggestions.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-2)' }}>
                <TaTriggerSuggestions suggestions={vResult.taSuggestions} />
              </div>
            )}

          </div>
        )}

        {vSkipped.length > 0 && (
          <div style={styles.card}>
            <button style={styles.linkBtn} onClick={() => setVShowSkipped((o) => !o)}>
              {vShowSkipped ? 'hide' : 'show'} {vSkipped.length} tag(s) not verifiable here
            </button>
            {vShowSkipped && (
              <ul style={styles.resultList}>
                {vSkipped.map((s) => (
                  <li key={s.tagId} style={styles.resultRow}>
                    <b style={{ color: 'var(--text)' }}>{s.name}</b> <span style={styles.muted}>— {s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <FormFillReview url={vUrl} snippet={vSnippet} active={active} onError={onError} runSignal={vRunSignal} onStatus={setVFormStatus} onReviewedForms={(f) => { vReviewedFormsRef.current = f; }} showFields={vTaStage === 'filling'} onSubmitForms={() => { setVTaStage('idle'); void runVerify(undefined, true, true); }} firedTags={vResult && vResult.verifiedByMonitor && !vResult.error && vFormsVerified ? new Set(fired.map((v) => v.tagName)) : undefined} onScanProgress={(p) => setVProgress(p)} />
      </div>
      {vLightbox && <ProofLightbox shot={vLightbox} onClose={() => setVLightbox(null)} />}
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
  // "show debug": run context (scope + counts), the config-audit boundary +
  // runtime-required checks, and a preview of the exact tool+args each fix calls.
  const [showDebug, setShowDebug] = useState(false);

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
      // Filename carries BOTH container and workspace, so audits of different workspaces of the same
      // container don't collide on disk (e.g. "GTM audit - www-samarthanalytics-com-Default-Workspace").
      const slug = (s: string | undefined | null): string => (s ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      const cLabel = slug(ctx?.containerName) || 'container';
      const wLabel = slug(ctx?.workspaceName);
      const label = wLabel ? `${cLabel}-${wLabel}` : cLabel;
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
            <div style={{ marginTop: 6 }}>
              <button style={styles.linkBtn} onClick={() => setShowDebug((o) => !o)}>
                {showDebug ? 'hide debug' : 'show debug'}
              </button>
            </div>
            {showDebug && (
              <div style={{ marginTop: 6 }}>
                <div style={styles.h2}>Run context</div>
                <div style={styles.muted}>
                  account {ctx?.accountId ?? '—'} · container {ctx?.containerId ?? '—'} · workspace {ctx?.workspaceId ?? '—'} · tags{' '}
                  {report.counts.tags} · triggers {report.counts.triggers} · variables {report.counts.variables}
                  {report.counts.clients != null ? ` · clients ${report.counts.clients}` : ''}
                  {report.counts.transformations != null ? ` · transformations ${report.counts.transformations}` : ''} · GA4 base config{' '}
                  {report.hasGa4Config ? 'present' : 'absent'}
                </div>
                {report.boundary && (
                  <>
                    <div style={{ ...styles.h2, marginTop: 12 }}>Audit boundary</div>
                    <div style={styles.muted}>{report.boundary}</div>
                  </>
                )}
                {report.runtimeRequired && report.runtimeRequired.length > 0 && (
                  <>
                    <div style={{ ...styles.h2, marginTop: 12 }}>Needs live verification ({report.runtimeRequired.length})</div>
                    <ul style={styles.resultList}>
                      {report.runtimeRequired.map((r, i) => (
                        <li key={i} style={styles.resultRow}>{r}</li>
                      ))}
                    </ul>
                  </>
                )}
                {(() => {
                  const fixes = report.findings.filter((f) => f.fix);
                  return (
                    <>
                      <div style={{ ...styles.h2, marginTop: 12 }}>Fix preview ({fixes.length}) — the exact tool + args “Apply fix” calls</div>
                      {fixes.length === 0 ? (
                        <div style={styles.muted}>No auto-fixable findings.</div>
                      ) : (
                        <div style={styles.invScroll}>
                          <table style={styles.invTable}>
                            <thead>
                              <tr>
                                <th style={styles.invTh}>Finding</th>
                                <th style={styles.invTh}>Tool</th>
                                <th style={styles.invTh}>Args</th>
                              </tr>
                            </thead>
                            <tbody>
                              {fixes.slice(0, 100).map((f, i) => (
                                <tr key={i}>
                                  <td style={styles.invTd}>{f.resource?.name ?? f.message.slice(0, 60)}</td>
                                  <td style={styles.invTd}>{f.fix?.tool ?? ''}</td>
                                  <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{JSON.stringify(f.fix?.args ?? {})}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
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
  accounts,
  connect,
  connecting,
  cancelConnect,
  google,
  info,
  selfTest,
  onError,
  run,
  refresh,
}: {
  active: AccountView | undefined;
  accounts: AccountView[];
  connect: () => Promise<void>;
  connecting: boolean;
  cancelConnect: () => Promise<void>;
  google: GoogleClientStatus | null;
  info: AppInfo | null;
  selfTest: SecretSelfTest | null;
  onError: (m: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [theme, setTheme] = useTheme();
  // Single source of truth for app-level provider keys so the Language-model hint and the Providers editor
  // never disagree — a key change in one updates the other immediately, and a probe failure surfaces.
  const [provStatus, setProvStatus] = useState<ProviderStatus | null>(null);
  // Inline rename of the active account's display name (null = viewing; a string = editing that draft).
  // Reuses the same accounts.rename IPC as the sidebar pencil; an empty name restores the Google name/email.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // Inline rename in the Accounts list (id being renamed → draft value); separate from the active-account
  // Display-name field above so renaming a non-active account doesn't disturb it.
  const [rowRename, setRowRename] = useState<{ id: string; value: string } | null>(null);
  useEffect(() => {
    window.desktop.providers.status().then(setProvStatus).catch((e) => onError(String(e)));
  }, []);
  return (
    <div style={styles.settings}>
      <h1 style={styles.settingsTitle}>Settings</h1>

      <div style={styles.settingsCols}>
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

      {/* Accounts — the full switcher + management that used to live in the sidebar. Switch the active
          account, rename it, disconnect its Google token, remove it, or connect a new one. */}
      <section style={styles.card}>
        <h2 style={styles.h2}>Accounts</h2>
        <p style={styles.settingsSub}>Switch which Google account is active, rename it, or connect another. The active account is used across GTM Tools, GA4 Tools and Chat.</p>
        <div style={styles.acctRows}>
          {accounts.length === 0 && <p style={styles.muted}>No accounts yet — connect one below.</p>}
          {accounts.map((a) => (
            <div key={a.id} style={{ ...styles.acctRow, ...(a.isActive ? styles.acctRowActive : {}) }}>
              <span style={{ ...styles.dot, background: a.hasGoogleToken ? 'var(--c-green)' : 'var(--text-faint)' }} />
              {rowRename?.id === a.id ? (
                <input
                  autoFocus
                  style={{ ...styles.input, flex: 1, minWidth: 0 }}
                  value={rowRename.value}
                  placeholder={a.email}
                  aria-label="Account display name"
                  onChange={(e) => setRowRename({ id: a.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { const v = rowRename.value.trim(); setRowRename(null); void run(() => window.desktop.accounts.rename(a.id, v)); }
                    else if (e.key === 'Escape') setRowRename(null);
                  }}
                  onBlur={() => { const v = rowRename.value.trim(); setRowRename(null); void run(() => window.desktop.accounts.rename(a.id, v)); }}
                />
              ) : (
                <span style={styles.acctRowName} title={a.email}>
                  {a.displayName || a.email}
                  {a.displayName ? <span style={styles.acctRowEmail}> · {a.email}</span> : null}
                </span>
              )}
              {a.isActive ? (
                <span style={styles.acctActiveBadge}>Active</span>
              ) : (
                <button style={styles.acctRowBtn} onClick={() => void run(() => window.desktop.accounts.setActive(a.id))}>Switch</button>
              )}
              <button style={styles.acctRowBtn} onClick={() => setRowRename({ id: a.id, value: a.displayName ?? '' })}>Rename</button>
              {a.hasGoogleToken && (
                <button style={styles.acctRowBtn} onClick={() => run(() => window.desktop.google.disconnect(a.id))} title="Sign this account out of Google (keeps the account)">Disconnect</button>
              )}
              <button style={styles.acctRowBtnDanger} onClick={() => run(() => window.desktop.accounts.remove(a.id))} title="Remove this account entirely">Remove</button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          {connecting ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={styles.connectBtn} disabled>Signing in…</button>
              <button style={styles.cancelBtn} onClick={cancelConnect} title="Cancel sign-in">Cancel</button>
            </div>
          ) : (
            <button style={styles.connectBtn} onClick={connect} disabled={!google?.configured} title={google?.configured ? 'Connect another Google account' : 'Set the OAuth client above first'}>
              + Connect account
            </button>
          )}
          {google && !google.configured && <p style={{ ...styles.settingsSub, color: 'var(--c-amber)', marginTop: 8 }}>Set the OAuth client above before connecting an account.</p>}
        </div>
      </section>

      {active ? (
        <>
          <section style={styles.card}>
            <h2 style={styles.h2}>Active account</h2>
            <div style={styles.kv}>
              <span>Display name</span>
              {nameDraft === null ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {active.displayName || <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>Not set</span>}
                  </b>
                  <button style={styles.linkBtn} onClick={() => setNameDraft(active.displayName ?? '')}>
                    Rename
                  </button>
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, marginLeft: 16, minWidth: 0 }}>
                  <input
                    autoFocus
                    value={nameDraft}
                    placeholder={active.email}
                    aria-label="Account display name"
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter saves; Escape cancels; an empty name restores the Google name/email.
                      if (e.key === 'Enter') { const v = nameDraft.trim(); setNameDraft(null); void run(() => window.desktop.accounts.rename(active.id, v)); }
                      else if (e.key === 'Escape') setNameDraft(null);
                    }}
                    style={{ ...styles.input, minWidth: 0 }}
                  />
                  <button
                    style={styles.linkBtn}
                    onClick={() => { const v = nameDraft.trim(); setNameDraft(null); void run(() => window.desktop.accounts.rename(active.id, v)); }}
                  >
                    Save
                  </button>
                  <button style={styles.linkBtn} onClick={() => setNameDraft(null)}>Cancel</button>
                </span>
              )}
            </div>
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
    position: 'relative',
    margin: 0,
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
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
  // Sidebar active-account chip (read-only; click → Settings). Replaces the old accounts list.
  activeAcct: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'var(--surface-3)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  activeAcctName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  activeAcctManage: { fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 },
  // Settings → Accounts list rows.
  acctRows: { display: 'flex', flexDirection: 'column', gap: 6 },
  acctRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', flexWrap: 'wrap' },
  acctRowActive: { borderColor: 'var(--c-green-border)', background: 'var(--c-green-bg)' },
  acctRowName: { flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)', fontWeight: 500 },
  acctRowEmail: { color: 'var(--text-muted)', fontWeight: 400 },
  acctActiveBadge: { fontSize: 11, fontWeight: 600, color: 'var(--c-green)', background: 'var(--surface)', border: '1px solid var(--c-green-border)', borderRadius: 20, padding: '2px 10px' },
  acctRowBtn: { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  acctRowBtnDanger: { background: 'transparent', color: 'var(--c-red)', border: '1px solid var(--c-red-border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  acctRenameInput: { flex: 1, minWidth: 0, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '3px 7px', fontSize: 13, fontFamily: 'inherit' },
  connectBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer', marginTop: 8 },
  connectRow: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'stretch' },
  cancelBtn: { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer' },
  sideWarn: { color: 'var(--c-amber)', fontSize: 11, marginTop: 8 },
  sideNav: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 },
  navItem: { display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 10px', color: 'var(--text-dim)', cursor: 'pointer', textAlign: 'left', fontSize: 14, fontWeight: 600 },
  navActive: { background: 'var(--surface-3)', color: 'var(--text)', fontWeight: 700 },
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
  errorBar: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '10px 52px 10px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  errorClose: { background: 'transparent', border: 'none', color: 'var(--c-red)', cursor: 'pointer' },
  monitorBarCrit: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '9px 52px 9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarWarn: { background: 'var(--c-amber-bg)', borderBottom: '1px solid var(--c-amber-border)', color: 'var(--c-amber)', padding: '9px 52px 9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarBtn: { background: 'transparent', border: '1px solid currentColor', color: 'inherit', borderRadius: 7, padding: '3px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },

  chatWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  chatHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' },
  // Segmented control (chat GTM/GA4 switch + Settings theme): inner padding + gap so the active
  // option reads as a distinct blue pill inside the track — the selected side is unmistakable.
  toggle: { display: 'inline-flex', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 9, overflow: 'hidden', padding: 2, gap: 2 },
  toggleBtn: { background: 'transparent', color: 'var(--text-dim)', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 7 },
  toggleActive: { background: '#2563eb', color: '#fff', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', borderRadius: 7, boxShadow: '0 1px 3px rgba(37,99,235,0.45)' },
  chatTitle: { fontWeight: 600, fontSize: 19, color: 'var(--text)', letterSpacing: -0.3 },
  chatSub: { fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 },
  ctxBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 20px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-dim)' },
  ctxBarEdit: { display: 'flex', alignItems: 'flex-end', gap: 10, padding: '8px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  ctxSelect: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '6px 8px', fontSize: 13, maxWidth: 220 },
  // Collapsed breadcrumb: the active container reads as a highlighted blue pill; "Change" is a proper button.
  ctxBreadcrumb: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  ctxMutedLabel: { color: 'var(--text-muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 },
  ctxCrumb: { color: 'var(--text-dim)' },
  ctxSep: { color: 'var(--text-faint)' },
  ctxContainerPill: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--c-blue-bg)', color: 'var(--c-blue)', border: '1px solid var(--c-blue-border)', borderRadius: 20, padding: '2px 10px', fontWeight: 600, fontSize: 12.5 },
  ctxPillId: { color: 'var(--text-muted)', fontWeight: 400 },
  ctxWorkspacePill: { display: 'inline-flex', alignItems: 'center', background: 'var(--surface-3)', color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 10px', fontSize: 12.5 },
  ctxChangeBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface)', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 7, padding: '4px 12px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', flexShrink: 0 },
  // Edit view: labelled fields; the chosen dropdown gets a blue border so progress is obvious.
  ctxField: { display: 'flex', flexDirection: 'column', gap: 3 },
  ctxFieldLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', fontWeight: 600 },
  ctxSelectChosen: { borderColor: 'var(--c-blue)', boxShadow: '0 0 0 1px var(--c-blue)' },
  ctxUseBtn: { background: 'var(--c-blue)', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  ctxUseBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  chatLog: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: 'var(--text-faint)', textAlign: 'center', maxWidth: 420, margin: '60px auto', lineHeight: 1.6, flexShrink: 0 },
  userMsg: { alignSelf: 'flex-end', background: '#2563eb', color: '#fff', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14 },
  asstMsg: { alignSelf: 'flex-start', background: 'var(--surface-2)', color: 'var(--text)', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14, border: '1px solid var(--border)' },
  msgTime: { fontSize: 11, color: 'var(--text-faint)', margin: '3px 4px 0', userSelect: 'none' },
  toolTrace: { color: 'var(--c-blue)', fontSize: 11, marginBottom: 4 },
  toolErrors: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  toolErrorLine: { background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)', color: 'var(--c-red)', borderRadius: 8, padding: '6px 9px', fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' },
  composer: { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid var(--border)', alignItems: 'flex-end' },
  // Slash-command autocomplete menu — floats above the composer.
  slashMenu: { position: 'absolute', bottom: 'calc(100% - 6px)', left: 16, right: 16, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 12, boxShadow: '0 12px 32px rgba(2,6,23,0.22)', padding: 6, zIndex: 30, maxHeight: 300, overflowY: 'auto' },
  slashMenuHead: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-faint)', padding: '4px 8px 6px' },
  slashItem: { display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', color: 'var(--text)' },
  slashItemActive: { background: 'var(--c-blue-bg)' },
  slashName: { fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: 'ui-monospace, monospace' },
  slashHint: { color: 'var(--text-faint)', fontWeight: 400, fontSize: 12 },
  slashDesc: { fontSize: 12, color: 'var(--text-muted)' },
  slashMenuFoot: { fontSize: 10.5, color: 'var(--text-faint)', padding: '6px 8px 3px', borderTop: '1px solid var(--border)', marginTop: 4 },
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

  // Settings fills the available width as a responsive card grid (2–3 columns on wide screens, 1 on
  // narrow) instead of a fixed 720px column that left half the window empty. rowGap:0 because each card
  // already carries marginBottom:16; the title spans the full width above the grid (see settingsTitle).
  // Settings scrolls vertically; the CARDS live in an inner masonry (settingsCols) so short cards don't
  // leave a gap under a tall one the way a grid row would. The title sits full-width above the columns.
  settings: { flex: 1, overflowY: 'auto', padding: 24, maxWidth: 1400 },
  settingsTitle: { fontSize: 22, fontWeight: 700, margin: '0 0 16px' },
  // Masonry via CSS multi-column: cards pack tightly (each is breakInside:avoid). Auto height so the
  // OUTER `settings` scrolls vertically instead of the columns spilling sideways on a fixed-height box.
  settingsCols: { columnWidth: 340, columnGap: 16 },
  settingsSub: { color: 'var(--text-muted)', fontSize: 13, margin: '-2px 0 14px', lineHeight: 1.55 },
  card: { background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16, flexShrink: 0, breakInside: 'avoid' },
  // Section heading — a real 15px/600 heading (design level) rather than the old tiny all-caps label.
  h2: { fontSize: 15, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)', margin: '0 0 12px' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 14 },
  warn: { background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 10, padding: 14, marginBottom: 16, color: 'var(--c-amber)', lineHeight: 1.5 },
  diag: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: 'var(--text-muted)', fontSize: 12 },
  codeBlock: { background: 'var(--bg)', padding: '6px 8px', borderRadius: 6, color: 'var(--text)', overflowX: 'auto' },
  formRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  select: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  input: { flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  ghostBtn: { background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '9px 14px', fontSize: 13, cursor: 'pointer' },
  toggleOn: { background: '#1d4ed8', color: '#fff', border: '1px solid #2563eb', borderRadius: 10, padding: '8px 14px', fontSize: 13, cursor: 'pointer' },
  toggleOff: { background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '8px 14px', fontSize: 13, cursor: 'pointer' },
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
