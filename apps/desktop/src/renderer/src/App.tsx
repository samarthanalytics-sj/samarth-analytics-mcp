import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThemeToggle, useTheme } from './ThemeToggle';
import { ShortcutsOverlay, EmptyState } from './ui';
import type { AppInfo } from '../../preload';
import type {
  AccountView,
  AuditFindingView,
  AuditReportView,
  WorkspaceCompareResultView,
  DependencyView,
  EntityDiffView,
  WsEntityKind,
  ConsolidatedEntityView,
  MergeStatus,
  ChatTurn,
  ChatAttachmentView,
  ChatMediaPart,
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
  ServerCoverageView,
  ServerPlanView,
  ServerPlanApplyResultView,
  ServerDocView,
  LlmProvider,
  NetworkLocationView,
  NetworkTestResultView,
  NetworkConnectionType,
  ProviderStatus,
  AdsReadiness,
  AdsAccountView,
  AdsConversionActionView,
  AdsCategoryOption,
  AdsPairingView,
  ScanProgressView,
  SecretSelfTest,
  SuggestPlatform,
  SuggestedTagView,
  TagScanResult,
  VerifyTagInput,
  VerifyTagsResult,
  VerifyTagsOptions,
  VerifyProgressView,
  VerifyExportRow,
  VerifyExportPayload,
  FormTagVerifyPlanResult,
  SubmitFormVerifyResult,
} from '../../shared/ipc';
import { suggestionToGroup, suggestionsToTemplateCsv, suggestionsToInstallRunbookMarkdown, installPlanNeedsAction, installPlanProgress, dedupeViewsByGtmName, TEMPLATE_HEADERS, applyTagEdit, adsIdentityIssue, TAG_TYPE_OPTIONS, STANDARD_TRIGGER_VARIABLES, CONDITION_LABELS, type TagEdit, type TemplateGroup, type TriggerWhen, type InstallProgress } from '../../shared/tag-template';
import { findMergeGroups, mergeGroup, mergeLabel, type MergeGroup } from '../../shared/tag-merge';
import { parseCsvUrls, parseCsvUrlStats, CSV_URL_CAP } from '../../shared/csv-urls';
import { MEMORY_KINDS, type Memory, type MemoryKind } from '../../shared/chat-memory';
import type { SeedCandidate } from '../../shared/memory-seed';
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
 *  default. This list only saves users from typing exact ids - any model the provider accepts still
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

/* ─────────────────────────── Icon rail (primary nav) ─────────────────────────── */

/** Monochrome line icon per primary view, drawn with currentColor so the item state sets the colour. */
const RAIL_ICON: Record<View, JSX.Element> = {
  chat: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />,
  gtm: <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7" cy="7" r="1.3" /></>,
  ga4: <><path d="M4 20h16" /><path d="M7 20v-6" /><path d="M12 20V9" /><path d="M17 20v-9" /></>,
  prompts: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="M4.9 4.9L7 7" /><path d="M17 17l2.1 2.1" /><path d="M19.1 4.9L17 7" /><path d="M7 17l-2.1 2.1" /></>,
};

/** One icon-rail item: line icon + tiny label, blue accent + left bar when active. An optional badge
 *  renders as an amber dot and replaces the tooltip (used for the "OAuth client not set" warning). */
function RailItem({ view, label, active, onClick, badge }: { view: View; label: string; active: boolean; onClick: () => void; badge?: string }): JSX.Element {
  return (
    <button
      style={{ ...styles.railItem, ...(active ? styles.railItemActive : {}) }}
      onClick={onClick}
      title={badge ?? label}
      aria-current={active ? 'page' : undefined}
    >
      {active && <span style={styles.railActiveBar} aria-hidden />}
      {badge && <span style={styles.railBadge} aria-hidden />}
      <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
        {RAIL_ICON[view]}
      </svg>
      <span style={styles.railLabel}>{label}</span>
    </button>
  );
}

/** "Swapnil Jaykar" → "SJ", "alex.johnson@acmecorp.com" → "AJ" — the rail avatar's initials. */
function initialsOf(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  const init = words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return init || name.slice(0, 2).toUpperCase();
}
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

/* Editable fields for a proposed write - names, types, key config. Each apply()
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
    // parameter change) has no name/type - showing a blank box and applying it would
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
   Renders what the assistant emits - GFM tables, headings, bold/italic, inline
   code, fenced code blocks, and bullet/ordered lists - as real elements so
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
  // **bold** | `code` | *italic* | [label](url) - bold is tried before italic.
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={`${kp}b${k}`}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<code key={`${kp}c${k}`} style={mdStyles.code}>{m[2]}</code>);
    else if (m[3] != null) out.push(<em key={`${kp}i${k}`}>{m[3]}</em>);
    else if (m[4] != null) out.push(<span key={`${kp}l${k}`}>{m[4]}</span>); // link label only - no in-app navigation
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
        {proposal.destructive ? '🗑 Delete - approve this action?' : '⚠ Approve this change to your GTM?'}
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
          ? `Type “${needType}” above to enable this - the final confirmation. Applies to a draft workspace - not published.`
          : proposal.destructive
            ? 'Delete needs two approvals. Applies to a draft workspace - not published.'
            : 'Edit any field above if needed. Applies to a draft workspace only - not published.'}
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
  // Accounts whose Google token expired/was revoked this session (backend cleared them) - one
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
    // The chat can switch the active workspace/container - re-fetch so the GTM bar follows.
    const off = window.desktop.accounts.onChanged(() => {
      refresh().catch((e) => setError(String(e)));
    });
    // Background GA4 monitoring runs push here: raise the cross-tab banner only when a run has NEW
    // issues (so an already-seen ongoing problem, or a clean run, doesn't nag).
    const offRun = window.desktop.ga4monitoring.onRun((run) => {
      if (run.newAlertIds.length > 0 && run.health !== 'healthy') setMonitorAlert(run);
    });
    // A dead Google token (invalid_grant) was just cleared by the backend - surface a
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
      // A user-initiated cancel isn't an error - don't surface it as one.
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
      {/* Compact icon rail. Account management lives in Settings → Accounts; the avatar at the bottom
          shows the active account (status dot = Google signed in) and jumps there. */}
      <aside style={styles.sidebar}>
        <div style={styles.railLogo} title={`Samarth · GTM / GA4 Desktop · v${info?.version ?? '0.0.0'}`}>S</div>

        <nav style={styles.railNav} aria-label="Primary">
          {([
            ['chat', 'Chat'],
            ['gtm', 'GTM'],
            ['ga4', 'GA4'],
            ['prompts', 'Prompts'],
          ] as Array<[View, string]>).map(([v, label]) => (
            <RailItem key={v} view={v} label={label} active={view === v} onClick={() => setView(v)} />
          ))}
        </nav>

        <div style={{ flex: 1 }} />

        <nav style={styles.railNav} aria-label="Settings and account">
          <RailItem
            view="settings"
            label="Settings"
            active={view === 'settings'}
            onClick={() => setView('settings')}
            badge={google && !google.configured ? 'OAuth client not set - open Settings' : undefined}
          />
        </nav>
        <button
          style={styles.railAvatar}
          onClick={() => setView('settings')}
          title={active ? `${active.email} - manage accounts in Settings` : 'Add an account in Settings'}
        >
          {active ? initialsOf(active.displayName || active.email) : '+'}
          <span style={{ ...styles.railAvatarDot, background: active?.hasGoogleToken ? 'var(--c-green)' : 'var(--text-faint)' }} aria-hidden />
        </button>
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
              {monitorAlert.health === 'critical' ? '🔴' : '🟠'} GA4 Monitor · <b>{monitorAlert.propertyLabel}</b>: {monitorAlert.newAlertIds.length} new issue{monitorAlert.newAlertIds.length === 1 ? '' : 's'} - {monitorAlert.alerts.find((a) => monitorAlert.newAlertIds.includes(a.id))?.title ?? monitorAlert.summary}
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
                🔑 Google session expired for <b>{a.email}</b> - reads/writes will fail until you re-connect. Testing-mode consent screens expire tokens every 7 days.
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
            excluded - it lives in the always-mounted div above so its stream survives tab switches. */}
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
   *  Optional - messages stored before this field existed simply render without a timestamp. */
  ts?: number;
  /** The exact text SENT to the model when it differs from the display (attachment injected).
   *  History replays `sent` so follow-up questions still see the document. */
  sent?: string;
  /** Attached-file chip data for the bubble (the content itself lives only in `sent`/`media`). */
  attachment?: { name: string; chars: number };
  /** Native media (pdf/image bytes) replayed with history so follow-ups keep seeing the file. */
  media?: ChatMediaPart[];
  /** Provenance: the memories injected into this reply's context ("why did you say that"). A snapshot
   *  at answer time, so it stays truthful even if a memory is later edited or deleted. */
  memoriesUsed?: Array<{ id: string; kind: string; text: string }>;
  /** Provider rate-limit / overload retries that happened while producing this reply, in order.
   *  Shown so a long wait reads as "waiting out a rate limit", not as a frozen app. */
  retries?: Array<{ provider: string; status: number; attempt: number; maxAttempts: number; delayMs: number }>;
}

/** The one-line notice for a provider retry, e.g. "Rate limited by OpenAI, retrying in 42s
 *  (attempt 2 of 4)". PURE. */
function formatRetryNotice(r: { provider: string; status: number; attempt: number; maxAttempts: number; delayMs: number }): string {
  const secs = Math.max(1, Math.round(r.delayMs / 1000));
  const cause = r.status === 429 ? `Rate limited by ${r.provider}` : `${r.provider} is busy (${r.status})`;
  return `${cause}, retrying in ${secs}s (attempt ${r.attempt} of ${r.maxAttempts})`;
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
    /* storage full/unavailable - non-fatal */
  }
}

/** Phase 2b — auto-suggest: run an LLM pass over the current conversation to PROPOSE durable memories, then
 *  let the user approve / edit / skip each one. Human-in-the-loop by design: nothing is saved until "Keep". */
function MemorySuggestBar({ active, product, messages, onError }: {
  active: AccountView | undefined; product: 'gtm' | 'ga4'; messages: ChatMessage[]; onError: (m: string) => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [cands, setCands] = useState<Array<{ id: number; kind: MemoryKind; text: string; scopeClient: boolean }> | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [savingId, setSavingId] = useState<number | null>(null); // the candidate whose save is in flight (guards double-click)

  const containerId = active?.gtmContext?.containerId;
  const property = active?.ga4Context?.property;
  const canClient = product === 'gtm' ? Boolean(containerId) : Boolean(property);
  const clientLabel = product === 'gtm' ? (active?.gtmContext?.containerName ?? containerId ?? '') : (active?.ga4Context?.propertyName ?? property ?? '');
  const hasChat = messages.filter((m) => (m.text ?? '').trim()).length >= 2;

  if (!active || !hasChat) return null;

  async function run(): Promise<void> {
    setBusy(true); setSavedCount(0);
    try {
      const history = messages.filter((m) => (m.text ?? '').trim()).map((m) => ({ role: m.role, text: m.text ?? '' }));
      const res = await window.desktop.memory.suggest(history);
      setCands(res.map((c, idx) => ({ id: idx, kind: c.kind, text: c.text, scopeClient: canClient })));
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  // Handlers key on the candidate's stable id (NOT its render-time index), so a save/skip that resolves
  // after the list has changed never touches a different, unreviewed candidate.
  const edit = (id: number, patch: Partial<{ kind: MemoryKind; text: string; scopeClient: boolean }>): void =>
    setCands((cs) => (cs ? cs.map((c) => (c.id === id ? { ...c, ...patch } : c)) : cs));
  const drop = (id: number): void => setCands((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
  async function keep(id: number): Promise<void> {
    const c = cands?.find((x) => x.id === id);
    if (!c || savingId !== null) return; // in-flight guard: ignore a second click while a save is pending
    setSavingId(id);
    try {
      const scope = c.scopeClient && canClient
        ? (product === 'gtm'
            ? { containerId: containerId!, ...(active?.gtmContext?.containerName ? { label: active.gtmContext.containerName } : {}) }
            : { property: property!, ...(active?.ga4Context?.propertyName ? { label: active.ga4Context.propertyName } : {}) })
        : {};
      await window.desktop.memory.add({ kind: c.kind, text: c.text, scope, source: 'auto' });
      setSavedCount((n) => n + 1);
      drop(id);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingId(null); }
  }

  const smallBtn: React.CSSProperties = { padding: '3px 9px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-dim)' };
  return (
    <div style={{ margin: '0 0 6px' }}>
      <button style={{ ...smallBtn, ...(busy ? { opacity: 0.6, cursor: 'wait' } : {}) }} disabled={busy} onClick={() => void run()} title="Read this conversation and propose notes worth remembering (you approve each)">
        {busy ? 'Reviewing chat…' : '🧠 Suggest memories from this chat'}
      </button>
      {cands !== null && (
        cands.length === 0 ? (
          <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 6 }}>Nothing new worth remembering here{savedCount ? `; saved ${savedCount}` : ''}. <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => setCands(null)}>dismiss</button></div>
        ) : (
          <div className="sheet-in" style={{ marginTop: 6, padding: 10, border: '1px solid var(--c-blue-border)', borderRadius: 10, background: 'var(--c-blue-bg)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 8 }}>
              <b>Review before saving.</b> These are proposals from this chat. Nothing is stored until you click <b>Keep</b>. Edit or skip anything.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cands.map((c) => {
                const disabled = !c.text.trim() || savingId !== null;
                return (
                  <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 8, border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--surface)' }}>
                    <textarea value={c.text} maxLength={500} onChange={(e) => edit(c.id, { text: e.target.value })} style={{ ...styles.input, width: '100%', minHeight: 40, fontSize: 12.5, resize: 'vertical' }} />
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <select value={c.kind} onChange={(e) => edit(c.id, { kind: e.target.value as MemoryKind })} style={{ ...styles.input, padding: '3px 6px', fontSize: 12 }}>
                        {MEMORY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      {canClient && (
                        <label style={{ fontSize: 11.5, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-dim)' }}>
                          <input type="checkbox" checked={c.scopeClient} onChange={(e) => edit(c.id, { scopeClient: e.target.checked })} /> only {clientLabel}
                        </label>
                      )}
                      <button style={{ ...styles.primaryBtn, padding: '3px 10px', fontSize: 12, ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} disabled={disabled} onClick={() => void keep(c.id)}>{savingId === c.id ? 'Saving…' : 'Keep'}</button>
                      <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => drop(c.id)}>Skip</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              {savedCount > 0 && <span style={{ fontSize: 12, color: 'var(--c-green)' }}>✓ Saved {savedCount}</span>}
              <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => setCands(null)}>Dismiss the rest</button>
            </div>
          </div>
        )
      )}
    </div>
  );
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
  const [attachment, setAttachment] = useState<ChatAttachmentView | null>(null);
  const [attaching, setAttaching] = useState(false);
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

  async function pickAttachment(): Promise<void> {
    if (attaching || busy) return;
    onError('');
    setAttaching(true);
    try {
      const a = await window.desktop.llm.pickAttachment();
      if (a) setAttachment(a);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if ((!text && !attachment) || busy) return;
    // Expand a slash command (/audit, /report, …) into the full instruction, and DISPLAY the short
    // command while SENDING the expansion. A command whose toolset lives in the other product flips it
    // first (keep the command in the box; the user presses Enter again once the thread has settled).
    const resolved = text ? resolveChatInput(text, product) : { display: '', sent: '', product };
    if (resolved.product !== product) { setProduct(resolved.product); return; }
    onError('');
    // Attachment: NATIVE media (pdf/image) rides as provider blocks - the model sees the actual
    // pages/pixels (figures, charts, tables, scans) - so only a marker goes into the text. Text
    // formats inject the extracted text as before. History replays m.sent + m.media so follow-up
    // questions still see the document.
    const att = attachment;
    const askDefault = att?.media?.kind === 'image' ? 'Please describe what this image shows.' : 'Please read the attached file and summarize what it contains.';
    const sentText = att
      ? att.media
        ? `[Attached file: ${att.name}]\n\n${resolved.sent || askDefault}`
        : `[Attached file: ${att.name}]\n\n<file-content>\n${att.text}\n</file-content>\n\n${resolved.sent || askDefault}`
      : resolved.sent;
    const mediaParts = att?.media ? [att.media] : undefined;
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.sent ?? m.text, ...(m.media ? { media: m.media } : {}) }));
    const now = Date.now();
    setMessages((m) => [
      ...m,
      { role: 'user', text: resolved.display, ...(att ? { sent: sentText, attachment: { name: att.name, chars: att.chars }, ...(mediaParts ? { media: mediaParts } : {}) } : {}), ts: now },
      { role: 'assistant', text: '', tools: [], ts: now },
    ]);
    setInput('');
    setAttachment(null);
    setBusy(true);
    setRevertable(null);
    try {
      await window.desktop.llm.chatStream(history, sentText, product, (ev) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, text: last.text + ev.delta };
          else if (ev.type === 'tool')
            copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), ev.name] };
          else if (ev.type === 'tool_result' && !ev.ok)
            copy[copy.length - 1] = { ...last, toolErrors: [...(last.toolErrors ?? []), { name: ev.name, error: ev.error ?? 'failed' }] };
          else if (ev.type === 'memories')
            copy[copy.length - 1] = { ...last, memoriesUsed: ev.used };
          else if (ev.type === 'retry')
            copy[copy.length - 1] = {
              ...last,
              retries: [
                ...(last.retries ?? []),
                { provider: ev.provider, status: ev.status, attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs },
              ],
            };
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
      }, mediaParts);
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

      {product === 'gtm' && active && <GtmContextBar key={active.id} active={active} refresh={refresh} onError={onError} />}
      {product === 'ga4' && active && <Ga4ContextBar key={active.id} active={active} refresh={refresh} onError={onError} />}

      <div style={styles.chatLog}>
        <div style={styles.chatColumn}>
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
                // Assistant replies read as documents (tables, audit sections) — give them the column;
                // user messages stay compact right-aligned bubbles.
                maxWidth: m.role === 'user' ? '75%' : '94%',
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              {m.role === 'assistant' && m.tools?.length ? (
                <div style={styles.toolTrace}>
                  {m.tools.map((name, j) => {
                    const failed = m.toolErrors?.some((te) => te.name === name);
                    // The newest call shows a spinner while the reply hasn't started streaming yet —
                    // completion isn't reported per-tool, only failures are, so ✓ means "ran, no error".
                    const running = busy && i === messages.length - 1 && j === (m.tools?.length ?? 0) - 1 && !m.text && !failed;
                    return (
                      <span key={j} style={{ ...styles.toolChip, ...(failed ? styles.toolChipFail : {}) }}>
                        {running ? (
                          <span className="spinner" style={{ fontSize: 9 }} aria-label="running" />
                        ) : (
                          <span style={{ color: failed ? 'var(--c-red)' : 'var(--c-green)', fontWeight: 700 }} aria-hidden>{failed ? '✕' : '✓'}</span>
                        )}
                        {name}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <div style={{ ...(m.role === 'user' ? styles.userMsg : styles.asstMsg), maxWidth: '100%' }}>
                {m.role === 'assistant' ? (
                  <>
                    {m.text ? <Markdown text={m.text} /> : m.toolErrors?.length || m.retries?.length ? null : <span style={{ opacity: 0.6 }}>…</span>}
                    {/* A rate-limit wait is announced live, so a 60s provider backoff reads as a
                        wait with a countdown rather than a frozen "Thinking…". */}
                    {m.retries?.length ? (
                      <div style={styles.retryLine}>
                        ⏳ {formatRetryNotice(m.retries[m.retries.length - 1])}
                        {m.retries.length > 1 ? ` · ${m.retries.length} retries so far this reply` : ''}
                      </div>
                    ) : null}
                    {m.toolErrors?.length ? (
                      <div style={styles.toolErrors}>
                        {m.toolErrors.map((te, j) => (
                          <div key={j} style={styles.toolErrorLine}>
                            ⚠️ <strong>{te.name}</strong> failed - {te.error}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {m.attachment && (
                      <div style={styles.msgAttach}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.attachment.name}</span>
                        {m.attachment.chars > 0 && <span style={{ opacity: 0.75, flexShrink: 0 }}>{m.attachment.chars.toLocaleString('en-US')} chars</span>}
                      </div>
                    )}
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || (m.attachment ? 'Read the attached file.' : '…')}</div>
                  </>
                )}
              </div>
              {m.ts != null && (
                <div style={styles.msgTime} title={new Date(m.ts).toLocaleString()}>
                  {formatMsgTime(m.ts)}
                </div>
              )}
              {/* Provenance — "why did you say that": the memories that were in this reply's context. */}
              {m.role === 'assistant' && m.memoriesUsed && m.memoriesUsed.length > 0 && (
                <details style={{ marginTop: 2, maxWidth: '100%' }}>
                  <summary style={{ fontSize: 11, color: 'var(--text-faint)', cursor: 'pointer', listStylePosition: 'inside' }} title="Saved memories that were part of this answer's context">
                    🧠 {m.memoriesUsed.length} memor{m.memoriesUsed.length === 1 ? 'y' : 'ies'} used
                  </summary>
                  <div style={{ marginTop: 4, padding: '6px 9px', border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {m.memoriesUsed.map((u) => (
                      <div key={u.id} style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.45, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '0px 6px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border-2)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0, marginTop: 1 }}>{u.kind}</span>
                        <span style={{ minWidth: 0 }}>{u.text}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Manage these in Settings → Memory.</div>
                  </div>
                </details>
              )}
            </div>
          ))}
          {busy && !pendingConfirm && (
            <div style={{ ...styles.asstMsg, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span className="spinner" style={{ fontSize: 11 }} aria-hidden /> Thinking…
            </div>
          )}
        </div>
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

      <MemorySuggestBar active={active} product={product} messages={messages} onError={onError} />

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
        {attachment && (
          <div className="pop-in" style={styles.attachChip}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</span>
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>
              {attachment.media
                ? attachment.media.kind === 'image'
                  ? 'image · read visually'
                  : `${attachment.chars.toLocaleString('en-US')} chars · read visually`
                : `${attachment.chars.toLocaleString('en-US')} chars${attachment.truncated ? ' · truncated' : ''}`}
            </span>
            <button style={styles.attachRemove} aria-label="Remove attachment" title="Remove attachment" onClick={() => setAttachment(null)}>×</button>
          </div>
        )}
        <div className="composer-shell" style={styles.composerShell}>
          <button
            style={styles.attachBtn}
            disabled={!ready || busy || attaching}
            onClick={() => void pickAttachment()}
            title="Attach a file - pdf, docx, xlsx, csv, images… (Claude/Gemini read pages and images natively)"
            aria-label="Attach a file"
          >
            {attaching ? (
              <span className="spinner" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            )}
          </button>
          <textarea
            ref={taRef}
            style={styles.composerInput}
            placeholder={ready ? (product === 'gtm' ? 'Ask about this GTM container, or / for commands…' : 'Ask about this GA4 property, or / for commands…') : hint}
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
              aria-label="Stop the running query"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="2.5" fill="currentColor" /></svg>
            </button>
          ) : (
            <button
              style={{ ...styles.sendBtn, ...(!ready || !input.trim() ? styles.sendBtnIdle : {}) }}
              onClick={send}
              disabled={!ready}
              title="Send (Enter)"
              aria-label="Send message"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          )}
        </div>
        <div style={styles.composerHints} aria-hidden>
          <span><b style={styles.hintKey}>Enter</b> to send · <b style={styles.hintKey}>Shift+Enter</b> for a new line · <b style={styles.hintKey}>/</b> for commands</span>
          <span>{product === 'gtm' ? 'GTM toolset' : 'GA4 toolset'}</span>
        </div>
      </div>
    </div>
  );
}

/** One option in a SearchableSelect: a stable value, a display label, and an optional monospace hint
 *  shown after the label (e.g. a container's GTM-XXXX public id) that is ALSO matched by the search. */
interface SearchOption { value: string; label: string; hint?: string }

/** A native-<select> replacement with a type-to-filter search box - so picking from dozens of GTM
 *  accounts / containers / workspaces doesn't mean scrolling a long native list. Opens a popover with an
 *  autofocused search input + a filtered, keyboard-navigable list (↑/↓/Enter, Esc/outside-click closes).
 *  Purely presentational: value/onChange are controlled by the caller exactly like the <select> it
 *  replaces, so the existing pick* handlers are unchanged. */
function SearchableSelect({
  value, options, onChange, placeholder, disabled, chosen, searchPlaceholder, minWidth = 200, emptyLabel,
}: {
  value: string;
  options: SearchOption[];
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  chosen?: boolean;
  searchPlaceholder?: string;
  minWidth?: number;
  /** Shown when there are NO options at all (not a search miss) — e.g. "No containers for this account".
   *  Keeps "No matches" for a non-empty search that filtered everything out. */
  emptyLabel?: string;
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
              <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>{q ? 'No matches' : (emptyLabel ?? 'No matches')}</div>
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
      // A silent empty dropdown looks broken - tell the user WHY nothing populated, and DON'T mark the
      // account as "loaded" so re-opening the picker (or the Retry link) re-fetches instead of staying blank.
      if (list.length === 0) {
        loadedForAccount.current = '';
        onError('No GTM containers found for this account. This Google sign-in may not have access to its containers - check you picked the right account, use ↻ Retry, or re-connect Google in Settings.');
      }
    } catch (e) {
      // A failed fetch must be retryable — clear the once-per-account guard so it isn't stuck empty.
      loadedForAccount.current = '';
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

  // THE FIX: load containers whenever an account is selected - a MANUAL pick OR an account carried over
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
    // containers load via the effect above - the single fetch path (also covers a pre-selected account)
  }

  /** Re-fetch containers for the current account — used by the "Retry" link when the list came back empty
   *  or a fetch failed. Clears the once-per-account guard so loadContainers runs again right away. */
  function retryContainers(): void {
    if (!sel.accountId) return;
    loadedForAccount.current = '';
    void loadContainers(sel.accountId);
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
        <span style={styles.ctxFieldLabel}>
          Container
          {/* When the list came back empty (no access, wrong account, or a transient fetch error) give a
              one-click way to re-fetch instead of leaving the user stuck on an empty dropdown. */}
          {sel.accountId && loading !== 'containers' && containers.length === 0 && (
            <button style={{ ...styles.linkBtn, marginLeft: 8, fontSize: 11 }} onClick={retryContainers} title="Re-fetch containers for this account">↻ Retry</button>
          )}
        </span>
        <SearchableSelect
          value={sel.containerId ?? ''}
          chosen={!!sel.containerId}
          disabled={!sel.accountId || loading === 'containers'}
          onChange={(v) => void pickContainer(v)}
          placeholder={loading === 'containers' ? 'Loading…' : !sel.accountId ? 'Pick an account first' : 'Select container…'}
          searchPlaceholder="Search by name or GTM-ID…"
          emptyLabel={sel.accountId ? 'No containers for this account — check Google access or use ↻ Retry.' : undefined}
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

/** Which GA4 property the GA4 chat works against - the GA4 mirror of GtmContextBar, so the active
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
  // Free-text filter over the property list (name, account, or numeric id) - accounts with many
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
          // A silent empty dropdown looks broken - tell the user WHY nothing populated.
          if (list.length === 0) {
            onError('No GA4 properties found for this account. This Google sign-in may not have access to any GA4 property - check you picked the right account, or re-connect Google in Settings.');
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
  // Typing down to exactly ONE match selects it - Enter/✓ then confirms without touching the dropdown.
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

type RowStatus = { state: 'idle' | 'creating' | 'ok' | 'err' | 'exists'; msg?: string; url?: string };

/** Deep link into the GTM UI: the workspace's Tags view, or ONE tag when its id is known. Matches the
 *  canonical tagManagerUrl shape the API itself hands out; opens externally (setWindowOpenHandler
 *  routes target=_blank to the system browser). */
const gtmTagUrl = (accountId: string, containerId: string, workspaceId: string, tagId?: string): string =>
  `https://tagmanager.google.com/#/container/accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags${tagId ? `/${tagId}` : ''}`;
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
      : '-';
  return parts.join(' AND ');
}

// The suggested tags rendered in the "GTM Structure - GA4 Events" template layout:
// one block per tag (tag + trigger on the first row; one row per event parameter /
// trigger condition). Same data the CSV download writes - via suggestionToGroup.
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
  // A status chip (colour-coded by install status) doubles as the expand toggle - background/border/
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
  installCreateBtn: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  installCreateBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  // An OPTIONAL improvement (html-attribute) - a quiet muted row, NOT a mandatory-looking box, so it
  // never contradicts a "fires natively" line above it.
  installOptional: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 },
  optionalPill: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 20, padding: '1px 8px', flexShrink: 0 },
  installOptionalText: { fontSize: 12, color: 'var(--text-dim)', flex: 1, lineHeight: 1.4 },
  installInfo: { fontSize: 13, color: 'var(--text-muted)', cursor: 'help', flexShrink: 0 },
  // "Show code" disclosure - collapses a listener/site-code snippet so the panel stays short.
  installDisclosure: { background: 'transparent', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: 11, padding: '2px 0', marginTop: 4 },
  // "Mark done" check-off on site-code / optional rows - a manual toggle the user ticks once the work is
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
// trigger already sees the event. Show/copy only - no create button in this phase.
type InstallPlanView = NonNullable<SuggestedTagView['install']>;
type InstallReqView = InstallPlanView['requires'][number];

/** GTM trigger the listener tag attaches to → human wording. */
const FIRES_LABEL: Record<Extract<InstallReqView, { kind: 'listener-tag' }>['tag']['fires'], string> = {
  all_pages: 'All Pages',
  dom_ready: 'DOM Ready',
  window_loaded: 'Window Loaded',
};

/** A "Show code" disclosure - keeps a listener/site-code snippet collapsed by default so the panel stays
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
  // Nothing actionable (defensive - the chip isn't rendered for a pure-ready plan).
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
 *  the panel - and it turns green "✓ Done" once every required step is checked off. */
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
 *  work) that turns the row - and the row's status chip - green. */
function InstallRequirementRow({
  req,
  targetReady,
  status,
  done,
  onToggleDone,
  onCreate,
}: {
  req: InstallReqView;
  /** Whether a GTM account/container/workspace is selected - gates the create button. */
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
              explicit click (draft-only, never published - same posture as the ✓ create-tags flow). */}
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
            {status.state === 'created' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={tplStyles.installDoneText}>✓ Created{status.reused ? ' · trigger reused' : ''}</span>
                {status.url && (
                  <a href={status.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--c-blue)', textDecoration: 'none' }} title="Open this tag in the GTM workspace (opens your browser)">view in GTM ↗</a>
                )}
              </span>
            )}
            {status.state === 'exists' && <span style={tplStyles.installDoneText}>✓ Already exists</span>}
            {status.state === 'idle' && done && <span style={tplStyles.installDoneText}>✓ Done</span>}
            {status.state === 'err' && <span style={{ color: 'var(--c-red)', fontSize: 12 }} title={status.msg}>✗ {status.msg}</span>}
          </div>
        </div>
      );
    }
    case 'html-attribute':
      // OPTIONAL improvement - the tag already fires; this only sharpens scoping. A quiet muted row (not
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
      // Exhaustiveness guard - a new requirement kind should force a compile error here.
      const _never: never = req;
      return <>{String(_never)}</>;
    }
  }
}

/** Per-listener-requirement create status (keyed by requirement index within one plan). */
type ListenerCreateStatus =
  | { state: 'idle' }
  | { state: 'creating' }
  | { state: 'created'; reused: boolean; url?: string }
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
          ? { state: 'created', reused: o.triggerReused === true, url: gtmTagUrl(acct, cont, ws, o.tagId) }
          : o.existing
            ? { state: 'exists' }
            : { state: 'err', msg: o.error ?? 'failed' },
      }));
      // A created OR already-existing listener is "done" - record it in the parent so the row's chip
      // turns green even after the panel is collapsed (which resets the transient status above).
      if (o.ok || o.existing) onToggleDone(index, true);
    } catch (e) {
      setStatuses((s) => ({ ...s, [index]: { state: 'err', msg: e instanceof Error ? e.message : String(e) } }));
    }
  }

  return (
    <div style={tplStyles.installPanel}>
      {/* The status chip in the row already carries the summary, so the panel goes straight to the
          per-requirement rows - no duplicated summary line. */}
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
// container (or just created) lock - no checkbox, no edit - so a tag can't be re-created.
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
  onFetchAds,
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
  /** Open the Google Ads picker for this row, to fill its Conversion ID + Label from the real account. */
  onFetchAds?: (suggestionId: string) => void;
}): JSX.Element {
  // Which suggestions have their "How to install" panel expanded (keyed by id).
  const [installOpen, setInstallOpen] = useState<Record<string, boolean>>({});
  const toggleInstall = (id: string): void => setInstallOpen((o) => ({ ...o, [id]: !o[id] }));
  // Per-suggestion "done" check-offs for its install requirements (keyed by suggestion id → requirement
  // index). Owned here (not in InstallPanel) so a mark survives the panel collapsing AND feeds the row's
  // status chip. Session-scoped - a manual acknowledgement that site-side work is done, not persisted.
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
            // Inputs stay editable unless the tag was just created (or a create is running) - NOT gated
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
            // Identity rows (the Google Ads Conversion ID / Label) are projected from the tag's own
            // fields, so they never read the generic `params` overlay: a stale overlay left behind by a
            // platform switch must not replace them.
            const hasIdentity = g.params.some((p) => p.field);
            const paramRows: TemplateGroup['params'] = hasIdentity ? g.params : (ed?.params ?? g.params);
            const adsIssue = adsIdentityIssue(s);
            const whenRows = ed?.whens ?? g.whens;
            const rowCount = Math.max(paramRows.length, whenRows.length, 1);
            const editParam = (idx: number, patch: Partial<{ name: string; variable: string }>): void =>
              onEdit(s.id, { params: paramRows.map((row, j) => (j === idx ? { ...row, ...patch } : row)) });
            const editWhen = (idx: number, patch: Partial<TriggerWhen>): void =>
              onEdit(s.id, { whens: whenRows.map((row, j) => (j === idx ? { ...row, ...patch } : row)) });
            // Add a SECOND trigger condition (ANDed) - e.g. scope a form/click tag to a specific
            // {{Page Path}} when several forms share a name. Pre-fills the first unused variable; a
            // blank-value row is dropped on create (applyWhensToTrigger), so an unfilled row is harmless.
            const usedWhenVars = new Set(whenRows.map((r) => r.variable));
            const freeWhenVar = VARIABLE_OPTIONS.find((o) => !usedWhenVars.has(o.value))?.value;
            const addWhen = (): void => {
              if (freeWhenVar) onEdit(s.id, { whens: [...whenRows, { variable: freeWhenVar, condition: 'equals', value: '' }] });
            };
            // Remove a condition - lets the user undo an added "when" (or drop any condition they don't
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
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ color: 'var(--c-green)', fontSize: 11 }} title={st?.msg}>✓ created</span>
                          {st?.url && (
                            <a href={st.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: 'var(--c-blue)', textDecoration: 'none' }} title="Open this tag in the GTM workspace (opens your browser)">
                              view in GTM ↗
                            </a>
                          )}
                        </span>
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
                          {/* A row skipped for missing Google Ads details is not a failure - it is
                              waiting on input, and its reason is already shown beside the id cell. */}
                          {st?.state === 'err' && (
                            adsIssue
                              ? <div style={{ color: 'var(--c-amber)', fontSize: 10, marginTop: 2 }} title={st?.msg}>⚠ needs details</div>
                              : <div style={{ color: 'var(--c-red)', fontSize: 10, marginTop: 2 }} title={st?.msg}>✗ failed</div>
                          )}
                        </>
                      )}
                    </td>
                  )}
                  {first && (
                    <td rowSpan={rowCount} style={{ ...tplStyles.td, whiteSpace: 'nowrap' }}>
                      {editable ? <GrowCell value={s.page} disabled={creating} onChange={(v) => onEdit(s.id, { page: v })} ariaLabel="Page" /> : <span style={{ color: 'var(--text-dim)' }}>{s.page}</span>}
                      {/* Install-status chip - only when the plan asks the user to add something site-side
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
                        : g.eventName ? <code style={mdStyles.code}>{g.eventName}</code> : <span style={{ color: 'var(--text-faint)' }}>-</span>}
                    </td>
                  )}
                  {/* An identity row's NAME is the tag's fixed field label ("Conversion ID"), so it is
                      never editable; its VALUE writes straight to that SuggestedTagView field. */}
                  <td style={tplStyles.td}>
                    {p
                      ? p.field
                        ? <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{p.name}</span>
                        : editable ? <GrowCell value={p.name} disabled={creating} onChange={(v) => editParam(i, { name: v })} ariaLabel="Parameter name" /> : p.name
                      : ''}
                  </td>
                  <td style={tplStyles.td}>
                    {p
                      ? p.field
                        ? (
                          <>
                            {editable
                              ? <GrowCell value={p.variable} disabled={creating} onChange={(v) => onEdit(s.id, p.field === 'conversionLabel' ? { conversionLabel: v } : { measurementId: v })} ariaLabel={p.name} />
                              : p.variable ? <code style={mdStyles.code}>{p.variable}</code> : <span style={{ color: 'var(--text-faint)' }}>-</span>}
                            {/* One note per block, on the last identity row, naming what is still missing,
                                plus the shortcut that fills BOTH values from the Ads account itself. */}
                            {editable && i === paramRows.length - 1 && (
                              <div style={{ marginTop: 3 }}>
                                {adsIssue && (
                                  <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--c-amber)', whiteSpace: 'normal', maxWidth: 260 }}>{adsIssue}</div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => onFetchAds?.(s.id)}
                                  disabled={creating}
                                  title="Pick a conversion action in your Google Ads account and fill these in"
                                  style={{ marginTop: 4, padding: '1px 7px', fontSize: 11, lineHeight: 1.6, color: 'var(--c-blue)', background: 'none', border: '1px dashed var(--border-2)', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                >
                                  Get from Google Ads
                                </button>
                              </div>
                            )}
                          </>
                        )
                        : editable ? <GrowCell value={p.variable} disabled={creating} onChange={(v) => editParam(i, { variable: v })} ariaLabel="Parameter variable" /> : <code style={mdStyles.code}>{p.variable}</code>
                      : ''}
                  </td>
                  {first && (
                    <td rowSpan={rowCount} style={tplStyles.td}>
                      {editable ? <GrowCell value={g.triggerName} disabled={creating} onChange={(v) => onEdit(s.id, { triggerName: v })} ariaLabel="Trigger name" /> : g.triggerName}
                    </td>
                  )}
                  {/* Trigger Type (the trigger KIND) is read-only: changing the kind strands the old
                      kind's filter fields (which the new kind's builder ignores → fires on everything) and
                      the conditions can't be re-specified in this table. Edit the kind in GTM instead. */}
                  {first && <td rowSpan={rowCount} style={tplStyles.td} title="Trigger type is structural - change it in GTM, or pick a suggestion of the right type">{g.triggerType}</td>}
                  <td style={tplStyles.td}>{w ? (whensEditable ? <CellSelect value={w.variable} options={varOptions} disabled={creating} onChange={(v) => editWhen(i, { variable: v })} ariaLabel="Trigger when variable" /> : <code style={mdStyles.code}>{w.variable}</code>) : ''}</td>
                  <td style={tplStyles.td}>{w ? (whensEditable ? <CellSelect value={w.condition} options={CONDITION_OPTIONS} disabled={creating} onChange={(v) => editWhen(i, { condition: v })} ariaLabel="Trigger when condition" /> : w.condition) : ''}</td>
                  <td style={tplStyles.td}>
                    {w ? (
                      whensEditable ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <GrowCell value={w.value} disabled={creating} onChange={(v) => editWhen(i, { value: v })} ariaLabel="Trigger when value" />
                          {/* Remove THIS condition - undo an added "when" or drop one that's not wanted. */}
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
                        title="Add another trigger condition (ANDed) - e.g. scope this tag to a specific Page Path"
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
// (GtmContextBar) over two sub-tabs - Tag suggestions and Container audit - so both
// GTM-container tools share the same target instead of each finding it on its own.
// GA4 tools - the two GA4 surfaces (Audit + Monitoring) under one sidebar entry, mirroring GTM Tools'
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
        <GtmContextBar key={active.id} active={active} refresh={refresh} onError={onError} />
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

// Sample prompts grouped by task - a quick reference + launcher for the chat. Replace the
// placeholder ids/names/URLs (G-…, container names, https URLs) with the user's own.
const PROMPT_GROUPS: Array<{ title: string; icon: string; product?: 'gtm' | 'ga4'; prompts: string[] }> = [
  {
    title: 'Audit & health',
    icon: '🔍',
    prompts: [
      'Audit my GTM container and list the findings by severity, worst first.',
      'What changed in my container since the last audit - any regressions?',
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
      'Reuse the existing trigger and variable if they already exist - do not create duplicates.',
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
    title: 'Meta - Pixel, CAPI & advanced matching',
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
      "Audit this GA4 property's data quality for the last 28 days - (not set) / Unassigned / (direct) bloat and any anomalies - with real values and a Pass / Partial / Fail / Not Verified status, worst first.",
      'Decision readiness: can this GA4 property answer which campaigns generate revenue, CAC by channel, abandonment, lead quality, LTV, refund rate, and repeat/churn within 90 days? Mark each Answerable / Partial / Not answerable, and list what it cannot measure and the missing input.',
      'Audit the ecommerce setup: which funnel steps fire (view_item → add_to_cart → begin_checkout → purchase), purchase parameter coverage (value, transaction_id, currency, items) as bars, plus any duplicate-transaction or revenue-gap risk.',
      'Score this GA4 property 0-100 with a letter grade, the reasons behind the score, and the top 3 fixes.',
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
  // The scanned site + scan time (from the scan result) - surfaced in the install-runbook header.
  const [scanMeta, setScanMeta] = useState<{ site?: string; scannedAt?: string }>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, TagEdit>>({});
  // Locate-only PROOF screenshots for the creatable suggestions (tagId → JPEG data-URI), captured
  // after each scan by reusing the verify driver (ring the element + shot). `shotStatus` drives the
  // "capturing…" line; `sLightbox` is the image shown full-screen. Best-effort - never blocks the panel.
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
  // Which suggestion row the Google Ads picker is open for (null = closed).
  const [adsPickerFor, setAdsPickerFor] = useState<string | null>(null);
  // Suggestion-list filters (search text + type). Display-only: they narrow which rows are SHOWN,
  // never which ids are selected/created.
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'click' | 'form' | 'other'>('all');
  // Filter the suggestion list by ad PLATFORM (GA4 / Meta / Google Ads / TikTok / …) - only shown when a
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
  // Corrected triggers already applied to the draft, keyed by tag id - fed into the NEXT round's
  // verify input so re-verify drives the FIXED interaction (not the stale original) and can converge.
  const [appliedTriggers, setAppliedTriggers] = useState<Record<string, VerifyTagInput['trigger']>>({});
  // The CURRENT editable workspace for the heal loop. Minting a preview SUBMITS the workspace (it goes
  // read-only) and GTM auto-creates a fresh one - we switch to it so later fixes/mints don't fail
  // "already submitted". A ref (not state) so the value is current synchronously inside a round.
  const healWsRef = useRef<string>('');
  const [settleMs, setSettleMs] = useState('2500');
  const [settleAuto, setSettleAuto] = useState(true);
  const effSettleMs = (): number | undefined => (settleAuto ? undefined : Number(settleMs) || undefined);
  // Pre-scan platform choice: a MULTI-SELECT of ad platforms to generate tags for. GA4 is the default;
  // any subset of the others may be toggled. Each non-GA4 platform's tags are derived from the GA4 ones
  // so every platform's tag shares one trigger per detection. Never send an empty array - a scan with
  // no platform makes no sense - so deselecting the last one falls back to ['ga4'] (see togglePlatform).
  const [platforms, setPlatforms] = useState<SuggestPlatform[]>(['ga4']);
  const togglePlatform = (p: SuggestPlatform): void =>
    setPlatforms((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      return next.length ? next : ['ga4'];
    });
  const [scanLog, setScanLog] = useState<{ pages: TagScanResult['pages']; notScanned: TagScanResult['notScanned']; inventory: TagScanResult['inventory']; installed: TagScanResult['installed'] } | null>(null);
  const [showLog, setShowLog] = useState(false);
  // Browser-driver diagnostics (separate "show debug" toggle): per-page form-probe
  // DOM counts + console/page errors - why a scan found nothing.
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
  // The container's existing tags - so suggestions already present are marked
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
    // Fill in a proof screenshot per creatable tag (the element it would track, ringed) - async +
    // best-effort so the suggestion list is usable immediately and screenshots appear as they arrive.
    void captureSuggestionShots(deduped, res.site || res.siteHost || url);
  }

  // Reuse the verify driver's ring + capture (locate-only) to grab a proof screenshot of WHERE each
  // suggested tag would fire. Never blocks the panel - screenshots are a nicety layered onto the list.
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
      setShotStatus(null); // best-effort - a screenshot failure never breaks the suggestions
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
    // Match on the RAW suggestion, not the effective (edited) one - otherwise renaming a tag so its new
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
  // applyTagEdit - the create flow, dedup, and merge grouping all read this effective view.
  const effective = (s: SuggestedTagView): SuggestedTagView => applyTagEdit(s, edits[s.id]);

  // A suggestion already exists in the container if a tag of its (effective) name is
  // there, or - for the GA4 Configuration - if any GA4 base tag is already present.
  const alreadyExists = (s: SuggestedTagView): boolean =>
    existing.names.has(effective(s).tagName.trim().toLowerCase()) || (s.platform === 'google_tag' && existing.hasGa4Base);

  // Mergeable groups: >=2 click tags sending the SAME event from different {{Click Text}} equals
  // triggers (e.g. "Learn More" vs "LEARN MORE"). Offered as an opt-in merge - rows already in the
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
    // distinct "Variants" name - the create flow matches existing tags/triggers by name, so a collision
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

  /** @param wsOverride retry into a DIFFERENT workspace than ctx names. Passed explicitly rather than
   *  read back from ctx, because setGtmContext updates the main process but the ctx PROP here is
   *  refreshed by the parent, and a retry must not race that. */
  async function confirmCreate(wsOverride?: string): Promise<void> {
    if (!targetReady || !ctx) return;
    const wsId = wsOverride ?? ctx.workspaceId!;
    const chosen = suggestions.filter((s) => selected[s.id] && !alreadyExists(s)).map(effective);
    setCreating(true);
    onError('');
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
        wsId,
        chosen,
        (p) => setCreateProgress(p),
      );
      const byId = new Map(outcomes.map((o) => [o.id, o]));
      setStatuses((st) => {
        const n = { ...st };
        for (const s of chosen) {
          const o = byId.get(s.id);
          if (!o) n[s.id] = { state: 'err', msg: 'no result' };
          else if (o.ok) n[s.id] = { state: 'ok', msg: o.triggerReused ? 'created · trigger reused' : 'created · trigger created', url: gtmTagUrl(ctx.accountId!, ctx.containerId!, wsId, o.tagId) };
          else if (o.existing) n[s.id] = { state: 'exists', msg: 'already exists in the container' };
          else n[s.id] = { state: 'err', msg: o.error ?? 'failed' };
        }
        return n;
      });
      const created = outcomes.filter((o) => o.ok).length;
      const existing = outcomes.filter((o) => o.existing).length;
      setDone({ created, existing, failed: outcomes.length - created - existing, total: chosen.length });
      // The workspace went read-only and GTM already made the replacement. Offer the move instead of
      // making the user hunt for it in the GTM bar: the old workspace no longer exists, so there is
      // nothing to weigh up. Still a button rather than an automatic retarget, because silently
      // redirecting a batch of writes to a different workspace is not something to do behind someone's back.
      setSwitchTo(outcomes.find((o) => o.switchToWorkspace)?.switchToWorkspace ?? null);
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
    if (/invalid_grant|expired or revoked|AUTH_EXPIRED/i.test(m)) return 'Your Google connection expired - re-connect (the banner up top) and retry.';
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
    // forever - they don't block "done", and they're reported separately from genuine failures.
    const inconclusive = notFired.filter((v) => v.inconclusive && !v.suggestedTrigger);
    const genuine = notFired.filter((v) => !(v.inconclusive && !v.suggestedTrigger));
    const fixable = genuine.filter((v) => v.suggestedTrigger);
    const firing = activeV.length - notFired.length;
    const tail = inconclusive.length ? ` · ${inconclusive.length} couldn't be auto-tested here` : '';
    if (genuine.length === 0) {
      setHealPhase('done');
      setHealNote(inconclusive.length
        ? `✅ All testable tag(s) fire.${tail} (their CTA/form is on another page or needs a real submit - verify those in GTM Preview).`
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
    } catch { /* best-effort - the loop still uses healWsRef */ }
  }
  async function runHealRound(roundNo: number, skipped: Record<string, boolean>, overrides: Record<string, VerifyTagInput['trigger']>): Promise<void> {
    if (!targetReady || !ctx) { setHealPhase('idle'); setHealNote('Pick a GTM account, container and draft workspace first.'); return; }
    const target = url.trim();
    if (!target) { setHealPhase('idle'); setHealNote('Enter the site URL to verify against (the Main website / Single page field).'); return; }
    const created = healableTags();
    if (created.length === 0) { setHealPhase('idle'); setHealNote('Create some tags first - there are none in the container to verify.'); return; }
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
      setHealNote(`Stopped after ${HEAL_MAX_ROUNDS} rounds - re-verified; see what remains.`);
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
  // Selected Google Ads rows that would build a tag which can never fire (unresolved placeholder id /
  // label, or an empty label). The main process skips exactly these rows and reports why, so this is a
  // heads-up, NOT a gate: the rest of the batch still creates.
  // Distinct failure reasons from the last create run, most common first. A batch normally fails for one
  // shared cause, so collapsing by message turns N identical tooltips into one readable line.
  // The successor workspace GTM minted after the target went read-only, when the last create run hit
  // that case. Drives the one-click switch-and-retry; cleared on any run that does not hit it.
  const [switchTo, setSwitchTo] = useState<{ id: string; name: string } | null>(null);

  /** Retarget the GTM context at the replacement workspace, then re-run the same approved batch. The
   *  rows are still selected, so confirmCreate picks up exactly what the user already approved. */
  async function switchWorkspaceAndRetry(): Promise<void> {
    if (!active || !ctx || !switchTo) return;
    try {
      await window.desktop.accounts.setGtmContext(active.id, { ...ctx, workspaceId: switchTo.id, workspaceName: switchTo.name });
      setSwitchTo(null);
      setDone(null);
      setStatuses({});
      await confirmCreate(switchTo.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  const failureReasons = useMemo(() => {
    const byMsg = new Map<string, number>();
    for (const st of Object.values(statuses)) {
      if (st?.state !== 'err') continue;
      const msg = (st.msg ?? 'failed').trim();
      byMsg.set(msg, (byMsg.get(msg) ?? 0) + 1);
    }
    return [...byMsg.entries()].map(([msg, count]) => ({ msg, count })).sort((a, b) => b.count - a.count);
  }, [statuses]);

  const adsBlocked = suggestions
    .filter((s) => selected[s.id] && !alreadyExists(s))
    .map((s) => ({ s: effective(s), issue: adsIdentityIssue(effective(s)) }))
    .filter((r): r is { s: SuggestedTagView; issue: string } => r.issue !== null);

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
          {/* Pre-scan platform choice: a MULTI-SELECT - toggle any subset of ad platforms. Each selected
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
                placeholder={'Paste landing-page URLs - one per line (or "url,label" per row):\nhttps://example.com/pricing\nhttps://example.com/demo, Demo page\nexample.com/contact'}
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
                (Cheerio) - up to {CSV_URL_CAP} pages per scan. Read-only; nothing is created until you approve.
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
                  : `First lists every page (sitemap if available, else a quick link-crawl) so you can pick which to deep-scan (up to ${CSV_URL_CAP} pages per scan)`}
                {' '}- merging Electron's browser <i>and</i> a static parse (Cheerio). Read-only; nothing is created until you
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
                <button style={styles.linkBtn} onClick={() => setAllPages((_u, i) => i < CSV_URL_CAP)}>First {CSV_URL_CAP}</button>
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
                  ? `All ${blogCount} discovered page${blogCount === 1 ? ' is a blog page' : 's are blog pages'} - untick "Skip blog pages" to include them.`
                  : 'No pages found - try the quick scan above, or check the URL.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <button style={styles.primaryBtn} onClick={doScanSelected} disabled={selectedPageCount === 0 || scanning}>
                {scanning ? 'Scanning…' : `Scan selected (${selectedPageCount})`}
              </button>
              <span style={{ color: selectedPageCount > CSV_URL_CAP ? 'var(--c-amber)' : 'var(--text-muted)', fontSize: 13 }}>
                {selectedPageCount > CSV_URL_CAP ? `Up to ${CSV_URL_CAP} pages are scanned per run - the first ${CSV_URL_CAP} of your ${selectedPageCount} selected.` : `Up to ${CSV_URL_CAP} pages per scan.`}
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
            measurementId defaults to the <code style={mdStyles.code}>{'{{GA4 Measurement ID}}'}</code> variable - make
            sure it exists in this container, or edit a row to a real G-XXXX id.
          </div>
          {platforms.includes('meta') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Meta tags use the <code style={mdStyles.code}>{'{{Meta Pixel ID}}'}</code> variable - set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('pinterest') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Pinterest tags use the <code style={mdStyles.code}>{'{{Pinterest Tag ID}}'}</code> variable - set it in
              the container (or edit the Tag ID per row).
            </div>
          )}
          {platforms.includes('tiktok') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              TikTok tags use the <code style={mdStyles.code}>{'{{TikTok Pixel ID}}'}</code> variable - set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('linkedin') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              LinkedIn tags use the <code style={mdStyles.code}>{'{{LinkedIn Partner ID}}'}</code> variable - set it in
              the container (or edit the Partner ID per row).
            </div>
          )}
          {platforms.includes('reddit') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Reddit tags use the <code style={mdStyles.code}>{'{{Reddit Pixel ID}}'}</code> variable - set it in the
              container (or edit the Pixel ID per row).
            </div>
          )}
          {platforms.includes('google_ads') && (
            <div style={{ ...styles.muted, marginTop: 6 }}>
              Google Ads conversions use the <code style={mdStyles.code}>{'{{Google Ads Conversion ID}}'}</code> and{' '}
              <code style={mdStyles.code}>{'{{Google Ads Conversion Label}}'}</code> variables - set them in the
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
                        <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{f.action || '-'}</td>
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
                      {' '}- {kindCountsLabel(scanLog.inventory.elements)}
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
                          <td style={styles.invTd}>{(e.text || '-').slice(0, 80)}</td>
                          <td style={{ ...styles.invTd, wordBreak: 'break-all' }}>{e.href || '-'}</td>
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
                      {p.page} - {p.forms} form(s), {p.elements} element(s)
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
                          {n.url} - {n.reason}
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
                          <td style={styles.invTd}>{p.httpStatus ?? '-'}</td>
                          <td style={styles.invTd}>{p.probe ? `${p.probe.forms}/${p.probe.inputs}/${p.probe.submitish}` : '-'}</td>
                          <td style={styles.invTd}>{p.probe ? p.probe.extracted : '-'}</td>
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
                    No browser console or page errors captured - the pages loaded cleanly. If suggestions are still missing, the
                    elements likely aren&apos;t standard DOM (custom widgets) or the page needs more settle time.
                  </div>
                )}
              </div>
            )}
          </div>
        )}


        {/* Crawl progress - the FULL de-duplicated list appears when the scan finishes (not streamed). */}
        {scanning && (
          <div style={styles.scanBanner}>
            ⏳ Scanning all pages…{scanProgress ? ` ${scanProgress.scanned} read` : ' starting'}
            {scanProgress && scanProgress.queued > 0 ? ` · ${scanProgress.queued} queued` : ''}
            {scanProgress ? ` · ${scanProgress.found} unique tag(s) found` : ''}
            {' '}- the full, de-duplicated list appears when the scan finishes.
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
              : 'Scan a website to see the GA4 event tags worth creating - form submissions (with the form provider), email & phone clicks, file downloads, outbound links and CTAs.'}
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
                {/* Platform filter - only when a scan produced more than one ad platform. */}
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
                  Tick a row to create it in GTM; edit fields inline (trigger type is fixed). Showing {curPage * PAGE_SIZE + 1}-{Math.min(visible.length, curPage * PAGE_SIZE + PAGE_SIZE)} of {visible.length} ({PAGE_SIZE} per page).
                </div>
                {shotStatus?.loading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', background: 'var(--c-blue-bg, rgba(59,130,246,.12))', border: '1px solid var(--c-blue-bg, rgba(59,130,246,.25))', borderRadius: 8 }}>
                    <span style={{ fontSize: 16 }}>📸</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                        Capturing proof screenshots{shotStatus.total ? ` - ${Math.min(shotStatus.done + 1, shotStatus.total)} of ${shotStatus.total}` : '…'}
                      </div>
                      {shotStatus.current && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          now: {shotStatus.current}
                        </div>
                      )}
                      <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 2, background: 'var(--primary)', transition: 'width .3s ease', width: shotStatus.total ? `${Math.round((shotStatus.done / Math.max(1, shotStatus.total)) * 100)}%` : '8%' }} />
                      </div>
                    </div>
                  </div>
                ) : shotStatus && shotStatus.done > 0 ? (
                  <div style={{ ...styles.muted, fontSize: 12 }}>📸 Captured {shotStatus.done} location screenshot(s) - click a thumbnail under “Page” to view.</div>
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
                  onFetchAds={setAdsPickerFor}
                />
                {adsPickerFor && (
                  <AdsPicker
                    gtmTarget={{ accountId: ctx?.accountId, containerId: ctx?.containerId, workspaceId: ctx?.workspaceId }}
                    onClose={() => setAdsPickerFor(null)}
                    onError={onError}
                    onPick={({ conversionId, conversionLabel }) => {
                      // Written into the EDIT overlay, not the raw suggestion, so the prefill is
                      // reversible and flows through the one path confirmCreate already reads.
                      setEdits((m) => ({ ...m, [adsPickerFor]: { ...m[adsPickerFor], measurementId: conversionId, conversionLabel } }));
                    }}
                  />
                )}
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
                  Into {ctx?.containerName} › {ctx?.workspaceName}. Applies to a DRAFT workspace only - not published. You
                  publish in GTM yourself.
                  {selectedHasEmOverlap && ' Some selected tags duplicate GA4 Enhanced Measurement auto-tracking.'}
                  {selectedUsesVar && ' Some tags use the {{GA4 Measurement ID}} variable - verify it exists in this container.'}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* Wrapped, NOT passed directly: confirmCreate now takes an optional workspace
                      override, and React would hand it the MouseEvent as that argument. */}
                  <button style={styles.primaryBtn} onClick={() => void confirmCreate()} disabled={creating}>
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
                {adsBlocked.length > 0 && (
                  <span style={{ color: 'var(--c-amber)', fontSize: 13 }}>
                    {adsBlocked.length === 1
                      ? `“${adsBlocked[0].s.tagName}” will be skipped: ${adsBlocked[0].issue}`
                      : `${adsBlocked.length} Google Ads tags will be skipped until their Conversion ID and Label are filled in.`}
                  </span>
                )}
                {creating && createProgress && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    Creating… {createProgress.done}/{createProgress.total}
                  </span>
                )}
                {!creating && done && (
                  <span style={{ color: done.failed ? 'var(--c-amber)' : 'var(--c-green)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {done.created} of {done.total} created
                    {done.existing ? ` · ${done.existing} already existed` : ''}
                    {done.failed ? ` · ${done.failed} failed` : ''}
                    {/* "open GTM to review" is actively misleading when nothing was created. */}
                    {done.created + done.existing > 0 ? ' - open GTM to review & publish.' : '.'}
                    {/* The REASON, not just the count. A batch usually fails for ONE shared reason (a
                        read-only workspace, expired auth), and burying it in a per-row tooltip meant a
                        failure could not be diagnosed without hovering a 10px mark. Show the distinct
                        reasons inline; they are already user-facing prose from the main process. */}
                    {/* The target went read-only and GTM already made the replacement. One click beats
                        sending the user to the GTM bar to find a workspace that usually has the SAME name. */}
                    {switchTo && (
                      <button
                        type="button"
                        style={{ ...styles.primaryBtn, marginLeft: 8 }}
                        disabled={creating}
                        onClick={() => void switchWorkspaceAndRetry()}
                      >
                        Switch to “{switchTo.name}” and retry
                      </button>
                    )}
                    {done.failed > 0 && failureReasons.length > 0 && (
                      <span style={{ display: 'block', width: '100%', marginTop: 4, color: 'var(--c-red)', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'normal' }}>
                        {failureReasons.map((r) => (
                          <span key={r.msg} style={{ display: 'block' }}>
                            {failureReasons.length > 1 || r.count > 1 ? `${r.count} tag(s): ` : ''}{r.msg}
                          </span>
                        ))}
                      </span>
                    )}
                    {done.created + done.existing > 0 && ctx?.accountId && ctx?.containerId && ctx?.workspaceId && (
                      <a
                        href={gtmTagUrl(ctx.accountId, ctx.containerId, ctx.workspaceId)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--c-blue)', fontWeight: 600, textDecoration: 'none' }}
                        title="Open this workspace's Tags view in Google Tag Manager (opens your browser)"
                      >
                        Open the workspace in GTM ↗
                      </a>
                    )}
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
                    ⚠ The preview had no draft auth (gtm_auth/gtm_preview) - the published container loaded, so draft tags won&apos;t fire. Re-connect with the &ldquo;edit container versions&rdquo; permission.
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
                                {v.event ? <span style={styles.muted}> - {v.event}</span> : null}
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
                                  <span style={{ ...styles.muted, marginLeft: 8 }}>- or fix it in GTM, then Restart.</span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {untestable.length > 0 && (
                        <>
                          <div style={{ ...styles.h2, color: 'var(--c-amber)', marginTop: 10 }}>⏭ Couldn’t auto-test here ({untestable.length})</div>
                          <div style={{ ...styles.muted, fontSize: 12 }}>Not broken - their CTA/form is on another page or needs a real submit. Verify in GTM Preview.</div>
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
// tags aren't broken - they just need the right page or a real interaction, not an operator change.
function verdictHowToTest(v: VerifyTagsResult['verdicts'][number]): string {
  const k = v.interaction?.kind;
  const found = v.interaction?.targetFound;
  if (k === 'custom_event') {
    return 'This tag fires on a dataLayer event a synthetic push can’t fully reproduce (a form’s own data, or a page / Custom-JS condition). If it’s a FORM tag, verify it in the “Forms - verified by a real submit” section below - it submits each matched form for real and re-checks this tag. Otherwise trigger the event in GTM Preview. If the tag is still a DRAFT, paste your GTM Preview snippet above so it loads.';
  }
  // Element WAS found + interacted, but no beacon we recognise fired → an undecodable Custom Template /
  // Custom HTML (pixel) tag, not a wrong-page problem.
  if ((k === 'click' || k === 'submit') && found) {
    return 'This is a Custom Template / Custom HTML (pixel) tag we can’t decode. The interaction happened but no recognised pixel beacon fired - it may beacon to a host we don’t classify, run server-side, or be consent-gated. Confirm in GTM Preview or your browser’s Network tab (look for the vendor’s request).';
  }
  if (k === 'click' || k === 'submit') {
    return 'The matching CTA/form isn’t on the page we drove - it likely lives on another page (e.g. careers, blog, a service page), or its exact label differs. Re-run Verify with that page’s URL, or confirm the button’s exact text.';
  }
  return 'Re-verify against the page this trigger’s element lives on, or exercise it with a real interaction in GTM Preview.';
}

// "What to change" for a NOT-FIRED verdict - actionable even without a scan inventory, derived from
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
  // Monitor-verified runs read from GTM itself - the container is PROVEN to be on the page, so
  // "confirm the container is injected" would be wrong advice (and contradicts the run's own evidence).
  if (v.verifiedByMonitor) {
    return 'The container IS on this page (GTM itself reported this run), so injection is not the problem. Open this tag’s trigger in GTM and compare each condition - event name, form name / id, page path - with what the page really sent (see the dataLayer log above). If the trigger looks right, check for a blocking exception trigger or a Consent Mode gate.';
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
// Semantic colour per status - green success, amber caveat, blue server, gray neutral, red error.
const V_STATUS: Record<VStatus, { short: string; icon: string; color: string; bg: string; border: string }> = {
  fired: { short: 'Fired', icon: '✅', color: 'var(--c-green)', bg: 'var(--c-green-bg)', border: 'var(--c-green-border)' },
  config: { short: 'Config OK', icon: '⚙', color: 'var(--c-amber)', bg: 'var(--c-amber-bg)', border: 'var(--c-amber-border)' },
  server: { short: 'Server-side', icon: '🛰', color: 'var(--c-blue)', bg: 'var(--c-blue-bg)', border: 'var(--c-blue-border)' },
  untested: { short: 'Untested', icon: '⏭', color: 'var(--text-muted)', bg: 'var(--surface-3)', border: 'var(--border-2)' },
  issue: { short: 'Issue', icon: '⚠', color: 'var(--c-red)', bg: 'var(--c-red-bg)', border: 'var(--c-red-border)' },
};
// The evidence line for a verdict - GTM's own monitor report when authoritative, else the observed
// beacon host(s). Shared by the results table AND the export so the download matches the screen.
function verdictSignal(v: VVerdict): string {
  return v.verifiedByMonitor
    ? (v.fired ? `GTM monitor: ${v.monitorStatus ?? 'fired'}${typeof v.monitorExecutionMs === 'number' ? ` · ${v.monitorExecutionMs}ms` : ''}` : '-')
    : v.observedBeacons?.length ? v.observedBeacons.join(', ') : v.fired ? 'GA4 hit' : '-';
}
// One verdict → an export row, reusing the same status/label/signal logic the on-screen table uses, so
// the CSV/PDF/DOC download is a faithful copy of what's shown. `eventName` is the tag's configured GA4
// event (e.g. "phone_click"); `event` is the dataLayer/trigger event (e.g. "gtm.linkClick").
function verdictToExportRow(v: VVerdict): VerifyExportRow {
  return {
    status: V_STATUS[verdictStatus(v)].short,
    tag: v.tagName,
    ...(v.event ? { triggerEvent: v.event } : {}),
    firedVia: verdictKindLabel(v).label,
    signal: verdictSignal(v),
    ...(v.screenshot ? { screenshot: v.screenshot } : {}),
  };
}

/** The result scorecard - big-number stat cards, one per meaningful outcome. */
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

/** Phase 3: the Tag-Assistant-style EVENT TIMELINE - one card per dataLayer event GTM processed, with the
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
                      <div style={{ fontSize: 11, fontWeight: 700, ...styles.muted, marginBottom: 3 }}>API CALL - dataLayer.push</div>
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
                      <ProofThumb screenshot={ev.screenshot} name={`Tag Assistant - ${ev.eventName}`} onOpen={() => setShot({ src: ev.screenshot!, name: `Tag Assistant - ${ev.eventName}` })} />
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

/** A clickable screenshot thumbnail (opens the full image in a lightbox) - the visual proof cell.
 *  Shared by tag verification AND the tag-suggestion panel (both pass a JPEG data-URI + a name). */
function ProofThumb({ screenshot, name, onOpen }: { screenshot?: string; name: string; onOpen: () => void }): JSX.Element {
  if (!screenshot) return <span style={styles.muted}>-</span>;
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
            // For an authoritative (monitor) verdict the "signal" is GTM's own report - its status +
            // execution time - not a sniffed beacon. Otherwise fall back to the observed beacon host(s).
            const signal = verdictSignal(v);
            // Keep the per-tag "why / how to verify" guidance on hover so the compact table doesn't lose it.
            const hint = st === 'untested' ? verdictHowToTest(v) : v.reason ?? '';
            return (
              <tr key={v.tagId} title={hint || undefined}>
                <td style={vStyles.td}><span style={{ ...vStyles.statusPill, color: m.color, background: m.bg, borderColor: m.border }}>{m.icon} {m.short}</span></td>
                <td style={{ ...vStyles.td, color: 'var(--text)', fontWeight: 500 }}>{v.tagName}</td>
                <td style={vStyles.td}>{v.event ? <code style={mdStyles.code}>{v.event}</code> : <span style={styles.muted}>-</span>}</td>
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
      {/* Explicit close button (top-right) - some users don't discover click-anywhere/Esc. */}
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
  dlBtn: { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 },
};

// Real-submit form review (Phase 1b): fetch a page's forms + their OWN fields (Option 2) and show
// each with a locale-appropriate, EDITABLE test value + a Location picker. READ-ONLY - nothing is
// submitted here; the actual submit + tag-firing check is Phase 2.
// Container-tag-driven form verification: from the site's MAIN url, crawl to find forms, keep only the
// ones that HAVE a container form tag, collapse their fields into ONE de-duplicated data-entry set;
// the operator fills once, then every matched form is submitted for real and each tag is verified (with
// a fix suggestion when it doesn't fire). Real submits - an explicit warning + confirm gate them.
// Rendered INSIDE VerifyPanel - shares the same URL + Preview snippet as tag verification (one panel,
// one URL). This subsection does the container-tag-driven REAL-submit form check.
function FormFillReview({ url, verifyPages, snippet, active, onError, runSignal, onStatus, onReviewedForms, showFields = true, onSubmitForms, firedTags, onScanProgress }: { url: string; verifyPages?: string[]; snippet: string; active: AccountView | undefined; onError: (m: string) => void; runSignal: number; onStatus?: (s: { loading: boolean; count: number | null }) => void; onReviewedForms?: (forms: NonNullable<VerifyTagsOptions['reviewedForms']>) => void; showFields?: boolean; onSubmitForms?: () => void; firedTags?: Set<string>; onScanProgress?: (p: VerifyProgressView) => void }): JSX.Element {
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
  // what replaces a separate "Find forms with tags" button - one verify action does both. Skips the
  // initial mount (runSignal 0); fetchPlan itself no-ops with a note if the URL / GTM target isn't ready.
  useEffect(() => {
    if (runSignal > 0) void fetchPlan();
  }, [runSignal]); // intentionally only on the verify signal - not on url edits

  // Publish the operator-reviewed forms (matched forms + the edited shared values applied) UP to the
  // parent so the NEXT "Verify with Tag Assistant" run submits exactly these - Phase 2b. Recomputes
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
    if (!ready || !ctx) { setNote('Pick a GTM account, container and workspace in the GTM bar above first - that’s the container whose form tags we verify.'); return; }
    setLoading(true); setNote(null); onError(''); setResults({}); setPlan(null); setTouched(false);
    onStatus?.({ loading: true, count: null }); // this run's form-discovery is now in flight
    let count: number | null = null;
    try {
      const res = await window.desktop.tags.formTagVerifyPlan(target, { accountId: ctx.accountId!, containerId: ctx.containerId!, workspaceId: ctx.workspaceId!, ...(verifyPages && verifyPages.length ? { verifyPages } : {}) }, onScanProgress);
      setPlan(res);
      const sv: Record<string, string> = {};
      for (const f of res.sharedFields) sv[f.key] = f.value;
      setShared(sv);
      if (res.error) setNote(res.error);
      else if (res.matched.length === 0) setNote(`Crawled ${res.pagesCrawled} page(s) but found no site form matching your container’s form tags - the forms may be on pages we didn’t reach, render late, or their names differ from the tags.`);
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
      if (r.beacons.length === 0) return `The form submitted but this ${tag.platform.replace(/_/g, ' ')} tag sent NO beacon - check it isn’t paused / blocked by an exception, its Consent Mode gate (ad_storage) isn’t denying it, and its pixel/conversion id is set. For DRAFT tags, paste a Preview snippet above.`;
      return `The form beaconed to [${r.beacons.join(', ')}] but not this tag’s vendor - the tag’s trigger/condition may not match this form, or it’s configured for a different pixel.`;
    }
    if (r.events.length === 0) return `The form submitted but pushed NO GA4 event - the site isn’t emitting its form_submission dataLayer event. Add the form’s listener (a Custom HTML tag that pushes the event on submit-success), or, for DRAFT tags, paste a GTM Preview snippet above. Confirm in GTM Preview.`;
    return `The form fired [${r.events.join(', ')}] but not “${tag.eventName}”. Either this tag’s trigger condition (form name / id / page) doesn’t match this form, or its GA4 Event Name differs - align the tag’s Event Name to one of the fired events, or fix its form-name condition.`;
  };

  const matched = plan?.matched ?? [];

  return (
    <>
      <div style={{ borderTop: '1px solid rgba(128,128,128,0.22)', marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>Forms - verified by a real submit</div>
        <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 2, marginBottom: 6 }}>
          When you run <b>Verify with Tag Assistant</b>, we first scan the site and match its forms to your container’s form tags. If you choose to verify them, edit the shared data once below and submit - each form is submitted for real inside the Tag Assistant session and its form_submission (and the tags it fired) show in the results above. Real submits create a real lead per form.
        </div>
      </div>
      <div style={styles.card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* No separate "find forms" button - the tag-verify above triggers discovery. */}
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
            Each field is pre-filled with a generic, editable test value (name “Test”, email test@gmail.com) - edit any of them below.
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
                Fields are de-duplicated across the {matched.length} form(s) - this data fills every one of them. Edit anything, then submit.
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
                      ⚠ This <b>really submits all {matched.length} form(s)</b> - a real submission / lead is created for each in your CRM / inbox and can trigger
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
                <div style={{ ...styles.muted, fontSize: 12 }}>Review / edit the data above - the Submit button appears once you enter it.</div>
              )}
            </div>
            )}

            {firedTags ? (
              // AFTER a Tag Assistant run: the per-form fired/not-fired result for every tag is already in
              // the Tags Fired table + Not-firing section above. Collapse this to a one-line summary so no
              // tag is listed twice (the per-form grid used to repeat all of them here).
              <div style={styles.card}>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {matched.length} form(s) were submitted for real. Each form tag’s fired / not-fired result is shown once in the <b style={{ color: 'var(--c-green)' }}>Tags Fired</b> table and the <b style={{ color: 'var(--c-red)' }}>Not firing</b> section above - not repeated here.
                </div>
              </div>
            ) : matched.map((form, i) => {
              const r = results[i];
              return (
                <div key={`${form.page}|${form.formId}|${form.formTitle}`} style={styles.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={styles.h2}>{form.formTitle || '(untitled form)'}</div>
                    <span style={{ ...styles.muted, fontSize: 12, border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '1px 6px' }}>{form.purpose}</span>
                    <span style={{ ...styles.muted, fontSize: 12 }}>{form.page.replace(/^https?:\/\//, '').slice(0, 60)}</span>
                    {form.method === 'js' ? <span style={{ ...styles.muted, fontSize: 12 }}>(JS/div widget)</span> : null}
                  </div>
                  {/* Pre-run review only (post-run this whole grid collapses to a summary - see above), so
                      just list the tags this form is expected to fire. */}
                  <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 4 }}>Tag(s) expected to fire: {form.expectedTags.map((t) => t.tagName).join(', ')}</div>
                  {r && (
                    <div style={{ fontSize: 12.5, marginTop: 8 }}>
                      {r.error ? (
                        <span style={{ color: 'var(--c-red)' }}>Error: {r.error}</span>
                      ) : (
                        <>
                          <div style={{ ...styles.muted }}>
                            {r.submitted ? `Submitted (${r.filled} field(s)).` : `Not submitted: ${r.note ?? 'no form/submit control'}.`}
                            {r.events.length > 0 ? ` Fired: ${r.events.join(', ')}.` : ''}
                            {r.injected && !r.previewAuth ? ' (snippet had no preview auth - published container loaded)' : ''}
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
                                  // the first-party sGTM. Expected, not a failure - same rule as the synthetic path.
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
                                          : serverSide ? 'No browser beacon - relayed server-side to your sGTM (CAPI). Confirm in the vendor’s Events Manager → Test Events.'
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
          // problem - only tags that neither matched a form NOR fired need manual checking. Before a run
          // (no firedTags) we can't split, so show the plain unmatched list.
          const firedUnmatched = firedTags ? plan.unmatchedTags.filter((n) => firedTags.has(n)) : [];
          const openUnmatched = firedTags ? plan.unmatchedTags.filter((n) => !firedTags.has(n)) : plan.unmatchedTags;
          return (
            <>
              {firedUnmatched.length > 0 && (
                <div style={styles.card}>
                  <div style={{ ...styles.h2, color: 'var(--c-green)' }}>Form tags that fired without a matched form ({firedUnmatched.length})</div>
                  <div style={{ ...styles.muted, fontSize: 12 }}>These form tags fired during the run even though we didn’t pair them to a specific site form (the form is likely named differently or shares a page). They ARE firing - no action needed.</div>
                  <ul style={styles.resultList}>
                    {firedUnmatched.map((n) => (<li key={n} style={{ ...styles.resultRow, display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ color: 'var(--c-green)', fontWeight: 600, fontSize: 12.5 }}>✅ Fired</span><span style={{ fontSize: 12.5 }}>{n}</span></li>))}
                  </ul>
                </div>
              )}
              {openUnmatched.length > 0 && (
                <div style={styles.card}>
                  <div style={{ ...styles.h2, color: 'var(--c-amber)' }}>{firedTags ? `Not found and not fired (${openUnmatched.length})` : `Form tags with no matching form (${openUnmatched.length})`}</div>
                  <div style={{ ...styles.muted, fontSize: 12 }}>{firedTags ? 'These form tags neither matched a form we found NOR fired during the run - the form may be on an un-crawled / behind-login page, render late, or its name differs from the tag. Verify those manually.' : 'These container form tags matched no form we found on the site - the form may be on an un-crawled/behind-login page, render late, or its name differs from the tag. Verify those manually.'}</div>
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
  // Stop button: a ref (read synchronously by the orchestration between the forms scan and the drive) plus a
  // UI flag. Stop signals the main-process scan/drive to bail early AND stops the renderer from advancing.
  const vCancelRef = useRef(false);
  const [vStopping, setVStopping] = useState(false);
  // The operator-reviewed forms (edited values) published up from the Forms panel - submitted for real by
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
  // fired/not-fired only when they were really tested - a Skip run must not show forms as "not fired".
  const [vFormsVerified, setVFormsVerified] = useState(false);
  // Collapse the (tall) setup form once a run completes - the results table becomes the focus; a compact
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
  // state - tags + forms - instead of two independent-looking passes.
  const [vFormStatus, setVFormStatus] = useState<{ loading: boolean; count: number | null }>({ loading: false, count: null });
  // The Tag-Assistant wizard stage: idle → scanning (crawl + match forms) → gate (skip/proceed) →
  // filling (edit the shared data). The actual Tag Assistant run (click tags [+ real form submits]) fires
  // when the user picks Skip, Proceed+Submit, or when the scan finds no forms.
  const [vTaStage, setVTaStage] = useState<'idle' | 'scanning' | 'gate' | 'filling'>('idle');
  const [vNote, setVNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  // Bumped whenever a tag-verify runs; the embedded Forms subsection watches it and auto-discovers the
  // site's forms-with-tags in the same pass - so there's ONE action, not a separate "find forms" button.
  const [vRunSignal, setVRunSignal] = useState(0);
  // Event-name aligns applied this session (tagId → new event name), so the row shows "✓ aligned".
  const [aligned, setAligned] = useState<Record<string, string>>({});
  const [aligning, setAligning] = useState<string | null>(null);
  // Results-download state: which format is currently exporting (or false), + the "saved to …" note.
  const [vExporting, setVExporting] = useState<false | 'xlsx' | 'pdf' | 'doc'>(false);
  const [vExportNote, setVExportNote] = useState('');
  // The CURRENT editable workspace. "Auto" mints a preview which SUBMITS the workspace (now read-only)
  // and hands back a fresh one; a later "Align Event Name" write must target THAT, not the stale
  // context prop (which lags a render behind) - otherwise "Workspace is already submitted".
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

  // The site URL to verify against: the top "live site" field, or - when that's left empty - the first
  // ABSOLUTE URL in the "Pages to verify" box, so a single absolute page there can stand on its own (no need
  // to type the site twice). A relative page (e.g. "/contact") still needs the top field to resolve against.
  function verifyTarget(): string {
    const pages = vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return vUrl.trim() || pages.find((u) => /^https?:\/\//i.test(u)) || '';
  }

  // Stop the in-flight run: tell the main-process scan/drive to bail (they resolve with a partial result),
  // and flip the renderer cancel flag so the orchestration doesn't advance from the scan into the drive.
  function stopVerify(): void {
    vCancelRef.current = true;
    setVStopping(true);
    setVNote({ kind: 'info', text: 'Stopping - finishing the current page…' });
    void window.desktop.tags.cancelVerify();
  }

  async function runVerify(snippetOverride?: string, useMonitor = false, withForms = false): Promise<void> {
    if (!ready || !ctx || vVerifying) return;
    const target = verifyTarget();
    if (!target) { setVNote({ kind: 'error', text: 'Enter the site URL to verify against (or paste an absolute URL in “Pages to verify”).' }); return; }
    vCancelRef.current = false; setVStopping(false); // fresh run - clear any prior Stop
    // AUTHORITATIVE mode automates the REAL Tag Assistant - ZERO GTM writes (no version, no workspace,
    // no container). No confirm needed; it may require a one-time Google sign-in (surfaced below).
    const canMonitor = Boolean(ctx.accountId && ctx.containerId && ctx.workspaceId);
    if (useMonitor && !canMonitor) {
      setVNote({ kind: 'error', text: 'Pick a GTM account, container and workspace first - verification reads that container’s tags.' });
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
              ? `None of this container's ${skipped.length} tag(s) map to a drivable trigger (click / form / custom-event / page load) - see “not verifiable” below.`
              : "This container has no readable tags. If it should have tags, your Google connection has likely expired - re-connect and retry.",
        });
        return;
      }
      const snippet = (snippetOverride ?? vSnippet).trim();
      // "Pages to verify" - one URL per line. When present, verify drives every tag on each of these pages
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
      if (vCancelRef.current) setVNote({ kind: 'info', text: 'Verification stopped - showing what was captured before you pressed Stop.' });
      else if (!res.error) setVSetupOpen(false); // run done → collapse the setup form, lead with the results
    } catch (e) {
      setVNote({ kind: 'error', text: verifyErrorText(e) });
    } finally {
      setVVerifying(false);
      setVVerifyKind(null);
      setVProgress(null);
      setVStopping(false);
    }
  }

  // STEP 1 of the Tag-Assistant flow: scan the site and match its forms to the container's form tags FIRST
  // (no Tag Assistant yet). When the scan lands we either gate (forms found → ask skip/proceed) or, if there
  // are none, go straight to click-tag verification. Bumping vRunSignal triggers the Forms panel's scan; the
  // decision is made in the effect below once its status bubbles back.
  async function startTaFlow(): Promise<void> {
    if (!ready || !ctx || vVerifying || vTaStage === 'scanning') return;
    const target = verifyTarget();
    if (!target) { setVNote({ kind: 'error', text: 'Enter the site URL to verify against (or paste an absolute URL in “Pages to verify”).' }); return; }
    if (!(ctx.accountId && ctx.containerId && ctx.workspaceId)) {
      setVNote({ kind: 'error', text: 'Pick a GTM account, container and workspace first - verification reads that container’s tags.' });
      return;
    }
    vCancelRef.current = false; setVStopping(false); // fresh run - clear any prior Stop
    setVNote(null); onError(''); setVResult(null);
    vReviewedFormsRef.current = [];
    setVFormStatus({ loading: true, count: null }); // guards the effect from acting on a prior scan's count
    setVTaStage('scanning');
    setVRunSignal((n) => n + 1); // Forms panel crawls + matches forms-with-tags for this URL
  }

  // Once STEP 1's scan finishes: forms found → open the skip/proceed gate; none → verify click tags only.
  useEffect(() => {
    if (vTaStage !== 'scanning' || vFormStatus.loading) return;
    // Stop pressed DURING the forms scan → don't advance into the gate / drive.
    if (vCancelRef.current) { setVTaStage('idle'); setVStopping(false); setVNote({ kind: 'info', text: 'Scan stopped.' }); return; }
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
  // dataLayer event that needs form-specific data) is NOT a failure - separate it from genuine
  // "not firing" so a working tag is never mislabelled broken.
  // Server-side pixels (Meta/TikTok/… fed via the Conversion API) relay to the first-party sGTM and
  // send NO browser beacon - that's expected, not broken. Give them their own group so they never sit
  // under ❌ "not firing" NOR the "couldn't reach it" note (which would misdescribe why).
  const serverRelayed = vResult?.verdicts.filter((v) => !v.fired && v.inconclusive && v.serverRelay) ?? [];
  const inconclusive = vResult?.verdicts.filter((v) => !v.fired && v.inconclusive && !v.serverRelay) ?? [];
  const notFired = vResult?.verdicts.filter((v) => !v.fired && !v.inconclusive) ?? [];
  // Concrete DLV trigger suggestion per tag, so each not-firing tag shows ITS OWN "create this trigger"
  // inline - no separate, repetitive suggestions section listing the same tags again.
  const suggByTag = new Map((vResult?.taSuggestions ?? []).map((s) => [s.tagName, s] as const));

  // Download the FULL results (every verdict, in display order - fired → config → server → untested →
  // not-firing) as CSV, PDF or DOC. The PDF/DOC embed each tag's proof screenshot. Independent of the
  // on-screen filters so the report is always the complete run. Read-only; no GTM access.
  async function downloadVerify(format: 'xlsx' | 'pdf' | 'doc'): Promise<void> {
    if (!vResult || vExporting) return;
    setVExporting(format);
    setVExportNote('');
    try {
      const ordered = [...firedReal, ...firedSynthetic, ...serverRelayed, ...inconclusive, ...notFired];
      const host = (() => { try { return new URL(vResult.url).hostname.replace(/^www\./, ''); } catch { return 'site'; } })();
      const payload: VerifyExportPayload = {
        url: vResult.url,
        authoritative: vResult.verifiedByMonitor,
        counts: { fired: firedReal.length, config: firedSynthetic.length, server: serverRelayed.length, untested: inconclusive.length, issues: notFired.length },
        ...(vResult.pagesDriven?.length ? { pagesDriven: vResult.pagesDriven.length } : {}),
        ...(vResult.pagesCrawled ? { pagesCrawled: vResult.pagesCrawled } : {}),
        ...(vResult.pagesTotal ? { pagesTotal: vResult.pagesTotal } : {}),
        rows: ordered.map(verdictToExportRow),
      };
      const saved = await window.desktop.tags.exportVerifyResults(format, `Tag verification - ${host}`, payload);
      setVExportNote(saved ? `✓ Saved to ${saved}` : 'Export cancelled');
    } catch (e) {
      setVNote({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setVExporting(false);
    }
  }

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
          <div style={styles.chatSub}>Prove the container’s tags &amp; forms actually fire when their trigger runs - nothing real is sent (hits are captured &amp; aborted).</div>
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
            <b>Verify with Tag Assistant</b> first scans the site for forms that have a tracking tag, then asks
            whether to submit those forms too (a real lead each) or just verify the click tags. It then drives
            every tag on the live site and reads GTM’s <b>own</b> per-event firing - <b>nothing is created in
            your container</b> (no version, no preview). To test UNPUBLISHED <b>draft</b> tags, paste a GTM
            <b> Preview</b> snippet below - that loads your drafts and still creates nothing.
          </div>
          <input
            value={vUrl}
            onChange={(e) => setVUrl(e.target.value)}
            placeholder="https://www.example.com - the live site whose pages carry this container"
            style={{ ...styles.input, width: '100%', marginTop: 8 }}
            disabled={!ready}
          />
          <textarea
            value={vSnippet}
            onChange={(e) => setVSnippet(e.target.value)}
            placeholder="Paste your GTM PREVIEW snippet (with gtm_auth & gtm_preview). Required for 'Verify with Tag Assistant' to see your GTM container's tags - in GTM click Preview, then Share/Copy the snippet. Creates no version/environment."
            style={{ ...styles.input, width: '100%', minHeight: 52, marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}
            disabled={!ready}
          />
          <textarea
            value={vVerifyPages}
            onChange={(e) => setVVerifyPages(e.target.value)}
            placeholder="Pages to verify (optional) - one URL per line. When set, verify SKIPS the auto-crawl and drives every tag on ONLY these pages, so forms/tags on pages the crawl missed still get tested. e.g. https://www.example.com/contact"
            style={{ ...styles.input, width: '100%', minHeight: 52, marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}
            disabled={!ready}
          />
          {vVerifyPages.trim() && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Verifying only {vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length} page(s) - the site crawl is skipped.
            </div>
          )}
          {/* Network & Location: the egress this audit runs from, so the operator can confirm the request
              originates from the expected network/VPN before (and while) driving the live site. Re-checks
              automatically when a run starts, so switching VPN server is reflected. */}
          <NetworkLocationInline refreshKey={vVerifying || vTaStage === 'scanning' ? 'run' : ''} />
          {/* Single entry point: Verify with Tag Assistant. It scans the site for forms with tags FIRST,
              then gates on skip/proceed (below), then drives every tag + reads GTM's own firing. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <button
              style={{ ...styles.primaryBtn, ...(!ready || vVerifying || vTaStage === 'scanning' || !verifyTarget() ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
              onClick={() => void startTaFlow()}
              disabled={!ready || vVerifying || vTaStage === 'scanning' || !verifyTarget()}
              title="Automates the REAL Tag Assistant - connects it to the site, drives your tags, and reads GTM's own per-event firing. First it scans the site for forms with tags and asks whether to verify those too (a real lead per form) or just the click tags. ZERO GTM writes. Signs in to Tag Assistant ONCE (saved after that, so it never asks again) and your normal Chrome can stay open."
            >
              {vVerifyKind === 'ta' ? 'Verifying with Tag Assistant…' : vTaStage === 'scanning' ? 'Scanning site for forms…' : 'Verify with Tag Assistant'}
            </button>
          </div>
          {/* STEP 2 - the skip/proceed gate, shown once the up-front form scan finds forms with tags. */}
          {vTaStage === 'gate' && (
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--c-blue)', background: 'rgba(70,130,240,0.06)' }}>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8, lineHeight: 1.45 }}>
                Found <b>{vFormStatus.count}</b> form(s) with a tracking tag. Verifying them submits each form <b>for real</b> (a real lead per form). Verify the forms too, or just the click tags?
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={styles.primaryBtn} onClick={() => setVTaStage('filling')}>Proceed with form verification</button>
                <button style={styles.toggleOff} onClick={() => { setVTaStage('idle'); void runVerify(undefined, true, false); }}>Skip forms - verify click tags only</button>
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
              {/* Indeterminate bar - no % is known (the driver loads + drives every page), so an animated
                  sliver signals "working" without a false percentage. */}
              <div className="vf-progress" role="progressbar" aria-label="Verification in progress" aria-busy="true" style={{ marginTop: 8 }} />
              {/* Live feed: the page being scanned/driven right now - low-opacity + fading so it reads as
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
              {/* Stop button - abort the scan/drive. The current page finishes, then it resolves with a
                  partial result (what was captured so far). */}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={stopVerify}
                  disabled={vStopping}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 8, cursor: vStopping ? 'not-allowed' : 'pointer', border: '1px solid var(--c-red)', background: 'var(--c-red-bg)', color: 'var(--c-red)', opacity: vStopping ? 0.6 : 1 }}
                  title="Stop the verification - the current page finishes, then it shows what was captured so far"
                >
                  {vStopping ? 'Stopping…' : '■ Stop'}
                </button>
              </div>
              {/* Switching tabs UNMOUNTS this panel (it is conditionally rendered), which drops the in-flight
                  run's result - warn so the user doesn't lose a minute-long verification. */}
              <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45, border: '1px solid var(--c-amber)', background: 'rgba(230,160,30,0.08)', color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span aria-hidden>⚠️</span>
                <span>Keep this tab open until it finishes - it loads and drives every page, which can take a minute on a larger site. Leaving or switching tabs cancels the run and you'll have to start over.</span>
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
                ⚠ The snippet has no preview auth (gtm_auth/gtm_preview) - it loaded the PUBLISHED container, so DRAFT tags won’t fire. Use “Auto”, or paste the GTM Preview / Environment snippet.
              </div>
            )}
            {!vResult.injected && (
              <div style={{ ...styles.muted, color: 'var(--c-amber)', marginBottom: 6 }}>
                ⚠ Tested the page as-is (no container injected) - a tag can only fire if its container is already published on this URL. Use “Auto” or a Preview snippet to load DRAFT tags.
              </div>
            )}
            {/* GTM debug signal (Phase B): the #1 cause of "0 fired" is the container never loading. */}
            {vResult.gtmDebug && !vResult.gtmDebug.containerLoaded && vResult.injected && (
              <div style={{ ...styles.muted, color: 'var(--c-red)', marginBottom: 6 }}>
                ⚠ GTM debug: no GTM-XXXX container was detected on the page - the container didn’t load, so nothing could fire. Check the preview snippet / auth, or that the site isn’t blocking googletagmanager.com.
              </div>
            )}
            {/* AUTHORITATIVE run: results came from GTM's OWN monitor (addEventCallback), like Tag
                Assistant - the fired/not-fired below is exactly what GTM did, not beacon inference. */}
            {vResult.verifiedByMonitor && !vResult.error && (
              <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45, border: '1px solid var(--c-green)', background: 'rgba(60,180,90,0.08)', color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span aria-hidden>✓</span>
                <span><b>Authoritative</b> - read from the real Tag Assistant debug stream: each tag below is exactly what GTM fired on the driven events, not inferred from network hits. Nothing was created in your container (no version, no workspace).</span>
              </div>
            )}
            {vResult.error ? (
              <div style={{ fontWeight: 600, color: 'var(--c-red)' }}>Error: {vResult.error}</div>
            ) : (
              <VerifyScorecard fired={firedReal.length} config={firedSynthetic.length} server={serverRelayed.length} untested={inconclusive.length} issues={notFired.length} />
            )}
            {/* Download the full results (every verdict) - CSV spreadsheet, or a styled PDF / Word doc that
                embeds each tag's proof screenshot. Independent of the on-screen filters. */}
            {!vResult.error && vResult.verdicts.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <span style={{ ...styles.muted, fontSize: 12.5, marginRight: 2 }}>Download results:</span>
                {(['xlsx', 'pdf', 'doc'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    style={{ ...vStyles.dlBtn, ...(vExporting ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
                    disabled={!!vExporting}
                    onClick={() => void downloadVerify(fmt)}
                    title={fmt === 'xlsx' ? 'Download an Excel (.xlsx) spreadsheet with each tag’s proof screenshot embedded' : `Download a styled ${fmt.toUpperCase()} report with each tag's proof screenshot`}
                  >
                    {vExporting === fmt ? '…' : '⬇'} {fmt === 'xlsx' ? 'EXCEL' : fmt.toUpperCase()}
                  </button>
                ))}
                {vExportNote && <span style={{ ...styles.muted, fontSize: 12 }}>{vExportNote}</span>}
              </div>
            )}
            {/* Filter + search bar for the results below - status / interaction type / platform / free text. */}
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
            {/* Phase 3: the Tag-Assistant-style detail - the event timeline (API Call + tags fired per
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
                {vResult.pagesCrawled ? ` (scanned ${vResult.pagesCrawled}${vResult.pagesTotal && vResult.pagesTotal > vResult.pagesCrawled ? ` of ${vResult.pagesTotal}` : ''} site page(s) from the sitemap to locate each CTA)` : ''} - each click tag is
                driven on the page its CTA actually lives on.
                {vResult.pagesTotal && vResult.pagesCrawled && vResult.pagesTotal > vResult.pagesCrawled
                  ? ` The site has ${vResult.pagesTotal} pages; we scanned the ${vResult.pagesCrawled} highest-priority ones (forms/CTAs first) - a tag whose CTA lives only on an un-scanned page shows “untested here”.`
                  : ''}
              </div>
            ) : null}
            {vResult.gtmDebug && vResult.gtmDebug.containerLoaded && (
              <div style={{ ...styles.muted, fontSize: 12, marginTop: 2 }}>
                GTM debug: container {vResult.gtmDebug.containerIds.join(', ') || 'loaded'} · events seen: {vResult.gtmDebug.dataLayerEvents.slice(0, 12).join(', ') || '-'}
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
                        Browser-side only (captured then aborted - nothing was delivered). {hasSgtm ? 'A /g/collect to your sGTM means the web→server relay fired; ' : ''}the server-side Meta CAPI call (graph.facebook.com) is not visible here - confirm it in sGTM Preview / Events Manager → Test Events.
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
                        What your site actually pushed to the dataLayer. Use the event name + params as the trigger condition (e.g. a tag that keys off <code>form_name</code> should match the exact value shown here). Amber rows were pushed by the verifier to test a custom-event tag - not proof the site fires them.
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
                    {fFiredSynthetic.length > 0 && <span>⚙ <b style={{ color: 'var(--c-amber)' }}>Config-verified</b> - fired on a synthetic dataLayer push (trigger is wired right), NOT a real submit. Confirm with a real submit in GTM Preview.</span>}
                    {fServerRelayed.length > 0 && <span>🛰 <b style={{ color: 'var(--c-blue)' }}>Server-side</b> - no browser beacon, but relayed to your sGTM (normal for Conversion-API destinations).</span>}
                  </div>
                )}
              </div>
            )}

            {/* UNTESTED = we never exercised the trigger here (its CTA wasn't on a page we drove, or its form
                wasn't submitted). NOT the same as "not firing". Show, per tag, WHY it wasn't tested + how to
                test it - visibly, not just on hover - so the operator knows these were skipped, not broken. */}
            {showStatus('untested') && fInconclusive.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...styles.h2, color: 'var(--text-dim)' }}>⏭ Untested here ({fInconclusive.length}{filtersActive && fInconclusive.length !== inconclusive.length ? ` of ${inconclusive.length}` : ''})</div>
                <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6, lineHeight: 1.5 }}>
                  We didn’t exercise these tags’ triggers in this run - this is <b>not</b> “not firing”. Either the CTA/link they listen to wasn’t on a page we drove, or (for a form tag) its form wasn’t among the ones submitted. Below is why each one, and how to actually test it.
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
                  We <b>did</b> exercise these - drove the click / submitted the form - but GTM did not fire the tag. That means a <b>trigger condition doesn’t match</b> what the page sent. Compare each condition (event name, form name / id, page path) against the dataLayer below.
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
                        {(() => {
                          // Prefer the CONCRETE, per-tag trigger suggestion (built from the real push, scoped to
                          // this tag's own form page) over the generic fix text - this is what replaces the old
                          // separate, repetitive "DLV suggestions" section.
                          const sug = suggByTag.get(v.tagName);
                          if (sug && sug.conditions.length > 0) {
                            return (
                              <div style={{ marginLeft: 8, marginTop: 3 }}>
                                <div style={{ color: 'var(--c-blue)', fontSize: 12.5 }}>Fix: {sug.how}</div>
                                <div style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {sug.conditions.map((c) => (
                                    <span key={c.key} style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '2px 6px' }}>{`{{${c.key}}}`} = “{c.value}”</span>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          return <div style={{ marginLeft: 8, marginTop: 2, color: 'var(--c-blue)', fontSize: 12.5 }}>Fix: {sug ? sug.how : verdictHowToFix(v)}</div>;
                        })()}
                        {v.observedEvents && v.observedEvents.length > 0 && (
                          <div style={{ marginLeft: 8, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            {aligned[v.tagId] ? (
                              <span style={{ color: 'var(--c-green)', fontSize: 12.5 }}>✓ Event Name set to {aligned[v.tagId]} - re-verify to confirm.</span>
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
                    <b style={{ color: 'var(--text)' }}>{s.name}</b> <span style={styles.muted}>- {s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <FormFillReview url={verifyTarget()} verifyPages={vVerifyPages.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)} snippet={vSnippet} active={active} onError={onError} runSignal={vRunSignal} onStatus={setVFormStatus} onReviewedForms={(f) => { vReviewedFormsRef.current = f; }} showFields={vTaStage === 'filling'} onSubmitForms={() => { setVTaStage('idle'); void runVerify(undefined, true, true); }} firedTags={vResult && vResult.verifiedByMonitor && !vResult.error && vFormsVerified ? new Set(fired.map((v) => v.tagName)) : undefined} onScanProgress={(p) => setVProgress(p)} />
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

/** Human label for the active audit filter value - used in the "nothing matches" empty state. */
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

// ───────────────────────── Workspace Comparison (Container Audit) ─────────────────────────
// A SEPARATE functionality from the audit / report: pick 2+ workspaces in the same container and diff them
// side by side (base vs each). Shows a summary of differences and a per-entity diff (added/removed/changed
// with field-level changes), with filtering + search, and a distinct "Report Generation" step (CSV / PDF).
const WS_STATUS_COLOR: Record<EntityDiffView['status'], { fg: string; bg: string; label: string }> = {
  added: { fg: 'var(--c-green)', bg: 'var(--c-green-bg)', label: 'Added' },
  removed: { fg: 'var(--c-red)', bg: 'var(--c-red-bg)', label: 'Removed' },
  changed: { fg: 'var(--c-amber)', bg: 'var(--c-amber-bg)', label: 'Changed' },
  unchanged: { fg: 'var(--text-muted)', bg: 'var(--surface-2)', label: 'Unchanged' },
};
const WS_KIND_LABEL: Record<WsEntityKind, string> = { tag: 'Tag', trigger: 'Trigger', variable: 'Variable', builtInVariable: 'Built-in var', folder: 'Folder' };
const WS_KINDS: WsEntityKind[] = ['tag', 'trigger', 'variable', 'builtInVariable', 'folder'];
const WS_MERGE_COLOR: Record<MergeStatus, { fg: string; bg: string; label: string }> = {
  safe: { fg: 'var(--c-green)', bg: 'var(--c-green-bg)', label: '✅ Safe to merge' },
  review: { fg: 'var(--c-amber)', bg: 'var(--c-amber-bg)', label: '⚠ Review required' },
  conflict: { fg: 'var(--c-red)', bg: 'var(--c-red-bg)', label: '❌ Cannot merge' },
};
// A compact stat tile for the summary dashboard.
function WsStatTile({ label, value, color }: { label: string; value: number; color?: string }): JSX.Element {
  return (
    <div style={{ flex: 1, minWidth: 96, border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', textAlign: 'center', background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ ...styles.muted, fontSize: 10.5, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function WorkspaceComparison({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element | null {
  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId);
  const [workspaces, setWorkspaces] = useState<GtmWorkspaceView[]>([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]); // ORDERED - first is the base
  const [result, setResult] = useState<WorkspaceCompareResultView | null>(null);
  const [comparing, setComparing] = useState(false);
  const [open, setOpen] = useState(false); // the whole comparison section is collapsed until opened
  const [fKind, setFKind] = useState<Set<WsEntityKind>>(new Set(WS_KINDS));
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');

  // Load the container's workspaces when the section is opened (or the container changes).
  useEffect(() => {
    if (!open || !ready || !ctx?.accountId || !ctx?.containerId) return;
    setWsLoading(true);
    setResult(null);
    setSelected([]);
    window.desktop.data
      .listGtmWorkspaces(ctx.accountId, ctx.containerId)
      .then((ws) => setWorkspaces(ws))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setWsLoading(false));
  }, [open, ready, ctx?.accountId, ctx?.containerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleWs = (id: string): void =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function compare(): Promise<void> {
    if (!ready || !ctx?.accountId || !ctx?.containerId || comparing || selected.length < 2) return;
    onError('');
    setComparing(true);
    setResult(null);
    setExportNote('');
    try {
      setResult(await window.desktop.gtm.compareWorkspaces(ctx.accountId, ctx.containerId, selected));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setComparing(false);
    }
  }

  async function generateReport(format: 'csv' | 'pdf' | 'xlsx'): Promise<void> {
    if (!result || exporting) return;
    setExporting(true);
    setExportNote('');
    try {
      const slug = (s: string | undefined | null): string => (s ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      const base = `Workspace comparison - ${slug(ctx?.containerName) || 'container'}`;
      let saved: string | null = null;
      if (format === 'pdf') {
        saved = await window.desktop.gtm.exportWorkspaceDiffPdf(`${base}.pdf`, result);
      } else if (format === 'xlsx') {
        saved = await window.desktop.gtm.exportWorkspaceDiffXlsx(`${base}.xlsx`, result);
      } else {
        const { workspaceDiffCsv } = await import('../../shared/gtm-workspace-diff-html');
        saved = await window.desktop.gtm.exportWorkspaceDiff(`${base}.csv`, workspaceDiffCsv(result));
      }
      setExportNote(saved ? `Saved ${saved}` : 'Export cancelled.');
    } catch (e) {
      setExportNote(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  if (!ready) return null;

  const canCompare = workspaces.length >= 2;

  return (
    <div style={{ ...styles.card, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Workspace Comparison</div>
          <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 2 }}>
            Compare two or more workspaces in this container side by side - configuration, tags, triggers, variables and folders.
            This is separate from the audit and its report.
          </div>
        </div>
        <button style={styles.toggleOff} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Open comparison'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {wsLoading ? (
            <div style={styles.muted}>Loading workspaces…</div>
          ) : !canCompare ? (
            <div style={{ color: 'var(--c-amber)', fontSize: 13 }}>
              This container has {workspaces.length} workspace(s). Workspace Comparison needs at least two - create a draft workspace, then compare.
            </div>
          ) : (
            <>
              <div style={{ ...styles.muted, fontSize: 12, marginBottom: 6 }}>
                Pick 2+ workspaces (up to 10). The <b>first</b> one you select is the <b>base</b>; every other is compared against it.
              </div>
              <ul style={{ ...styles.resultList, maxHeight: 200, overflowY: 'auto' }}>
                {workspaces.map((w) => {
                  const idx = selected.indexOf(w.workspaceId);
                  const isBase = idx === 0;
                  return (
                    <li key={w.workspaceId} style={{ ...styles.resultRow, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={idx >= 0} onChange={() => toggleWs(w.workspaceId)} disabled={selected.length >= 10 && idx < 0} />
                      <span style={{ fontSize: 13, color: 'var(--text)' }}>{w.name}</span>
                      {idx >= 0 && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: isBase ? 'var(--c-blue-bg)' : 'var(--surface-2)', color: isBase ? 'var(--c-blue)' : 'var(--text-muted)' }}>
                          {isBase ? 'BASE' : `#${idx + 1}`}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div style={{ marginTop: 8 }}>
                <button style={{ ...styles.primaryBtn, ...(selected.length < 2 || comparing ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} onClick={compare} disabled={selected.length < 2 || comparing}>
                  {comparing ? 'Comparing…' : `Compare ${selected.length || ''} workspace(s)`}
                </button>
              </div>
            </>
          )}

          {result && <WorkspaceDiffResults result={result} fKind={fKind} setFKind={setFKind} search={search} setSearch={setSearch} exporting={exporting} exportNote={exportNote} onReport={generateReport} />}
        </div>
      )}
    </div>
  );
}

/** The comparison OUTPUT: summary of differences, a filterable per-entity diff, and the separate report step. */
// The dependency view: a cross-workspace "missing dependency" callout (the merge-blockers) plus a
// per-workspace dependency graph (each entity and the triggers/variables it needs, green when they
// resolve, red when they don't). Powered by result.dependencies + result.missingDependencies.
function WsDependencySection({ result }: { result: WorkspaceCompareResultView }): JSX.Element {
  const perWs = result.dependencies ?? [];
  const miss = result.missingDependencies ?? [];
  const [wsIdx, setWsIdx] = useState(0);
  const [showAllDeps, setShowAllDeps] = useState(false);
  const [depSearch, setDepSearch] = useState('');
  const sel = perWs[Math.min(wsIdx, Math.max(0, perWs.length - 1))];
  const dq = depSearch.trim().toLowerCase();
  const entitiesWithDeps = (sel?.entities ?? []).filter((e) => e.dependsOn.length > 0 && (!dq || e.name.toLowerCase().includes(dq)));
  const DEP_CAP = 60;
  const shownDeps = showAllDeps ? entitiesWithDeps : entitiesWithDeps.slice(0, DEP_CAP);
  const depChip = (d: DependencyView): JSX.Element => (
    <span
      key={`${d.kind}|${d.name}`}
      title={d.present ? 'resolves in this workspace' : 'MISSING in this workspace'}
      style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap', background: d.present ? 'var(--c-green-bg)' : 'var(--c-red-bg)', color: d.present ? 'var(--c-green)' : 'var(--c-red)' }}
    >
      {d.kind === 'trigger' ? '⚡ ' : d.kind === 'builtInVariable' ? '◆ ' : '{ } '}{d.name}{d.present ? '' : ' ✕'}
    </span>
  );
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>Dependencies</div>
      {miss.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--c-green)', marginTop: 4 }}>✅ No cross-workspace dependency gaps detected. Variable dependencies are fully checked; any firing-trigger drift shows in the detailed diff below.</div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--c-red)', fontWeight: 600, marginBottom: 4 }}>⚠ {miss.length} cross-workspace dependency gap{miss.length > 1 ? 's' : ''} - resolve before merging.</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                  {['Entity', 'Needs', 'Present in', 'Missing in'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '5px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {miss.map((m, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 8px' }}><span style={{ ...styles.muted }}>{WS_KIND_LABEL[m.entity.kind]}</span> <b style={{ color: 'var(--text)' }}>{m.entity.name}</b></td>
                    <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{m.dependency.kind === 'builtInVariable' ? 'Built-in' : m.dependency.kind}: {m.dependency.name}</td>
                    <td style={{ padding: '5px 8px', color: 'var(--c-green)' }}>{m.presentIn.join(', ')}</td>
                    <td style={{ padding: '5px 8px', color: 'var(--c-red)', fontWeight: 600 }}>{m.missingIn.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {perWs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ ...styles.muted, fontSize: 12 }}>Graph for:</span>
            {perWs.map((w, i) => (
              <button key={w.workspaceId} onClick={() => { setWsIdx(i); setShowAllDeps(false); }} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${i === wsIdx ? 'var(--c-blue)' : 'var(--border-2)'}`, background: i === wsIdx ? 'var(--c-blue)' : 'transparent', color: i === wsIdx ? '#fff' : 'var(--text-muted)' }}>{w.name}</button>
            ))}
            <input value={depSearch} onChange={(e) => setDepSearch(e.target.value)} placeholder="Filter by name…" style={{ ...styles.input, minWidth: 140, marginLeft: 'auto' }} />
          </div>
          {entitiesWithDeps.length === 0 ? (
            <div style={{ ...styles.muted, fontSize: 12 }}>No tag/trigger/variable dependencies{dq ? ' match the filter' : ' to show for this workspace'}.</div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {shownDeps.map((e) => (
                  <div key={`${e.kind}|${e.name}`} style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: '7px 10px' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}><span style={{ ...styles.muted, fontWeight: 400 }}>{WS_KIND_LABEL[e.kind]}</span> {e.name}</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>{e.dependsOn.map(depChip)}</div>
                  </div>
                ))}
              </div>
              {entitiesWithDeps.length > DEP_CAP && (
                <button style={{ ...styles.linkBtn, marginTop: 6 }} onClick={() => setShowAllDeps((o) => !o)}>
                  {showAllDeps ? `show fewer` : `show all ${entitiesWithDeps.length} entities`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceDiffResults({
  result, fKind, setFKind, search, setSearch, exporting, exportNote, onReport,
}: {
  result: WorkspaceCompareResultView;
  fKind: Set<WsEntityKind>;
  setFKind: React.Dispatch<React.SetStateAction<Set<WsEntityKind>>>;
  search: string;
  setSearch: (s: string) => void;
  exporting: boolean;
  exportNote: string;
  onReport: (f: 'csv' | 'pdf' | 'xlsx') => void;
}): JSX.Element {
  const q = search.trim().toLowerCase();
  const con = result.consolidated;
  const stats = con.stats;
  const [fMerge, setFMerge] = useState<Set<MergeStatus>>(new Set(['safe', 'review', 'conflict']));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDetailed, setShowDetailed] = useState(false);
  const toggle = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, v: T): void =>
    set((s) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n; });
  const chip = (on: boolean, label: string, color: string, onClick: () => void): JSX.Element => (
    <button onClick={onClick} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? color : 'var(--border-2)'}`, background: on ? color : 'transparent', color: on ? '#fff' : 'var(--text-muted)' }}>{label}</button>
  );
  const nameMatch = (name: string): boolean => !q || name.toLowerCase().includes(q);
  // Per-entity variant number per workspace (1,2,3…) - so the common table shows which workspaces agree.
  const variantIndex = (e: ConsolidatedEntityView): Record<string, number> => {
    const seen = new Map<string, number>();
    const out: Record<string, number> = {};
    for (const w of result.workspaces) {
      const f = e.perWorkspace[w.workspaceId];
      const key = f ? JSON.stringify(Object.entries(f).sort()) : '';
      if (f && !seen.has(key)) seen.set(key, seen.size + 1);
      out[w.workspaceId] = f ? seen.get(key)! : 0;
    }
    return out;
  };
  const commonRows = con.common.filter((e) => fKind.has(e.kind) && fMerge.has(e.mergeStatus) && nameMatch(e.name));
  const uncommonRows = con.uncommon.filter((e) => fKind.has(e.kind) && nameMatch(e.name));

  return (
    <div style={{ marginTop: 14 }}>
      {/* Summary dashboard */}
      <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', lineHeight: 1.5, marginBottom: 10 }}>
        <b>Summary of differences.</b> {result.headline}
        <div style={{ ...styles.muted, fontSize: 11, marginTop: 4 }}>
          GTM has no per-workspace permissions or files - access is account/container-level and identical for every workspace. This compares configuration entities.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <WsStatTile label="Workspaces" value={stats.workspaces} />
        <WsStatTile label="Total items" value={stats.totalEntities} />
        <WsStatTile label="Common" value={stats.common} color="var(--c-blue)" />
        <WsStatTile label="Unique" value={stats.unique} color="var(--c-amber)" />
        <WsStatTile label="Mergeable" value={stats.mergeable} color="var(--c-green)" />
        <WsStatTile label="Conflicts" value={stats.conflicts} color={stats.conflicts ? 'var(--c-red)' : undefined} />
        <WsStatTile label="Missing items" value={stats.missing} />
      </div>

      {/* Per-kind statistics - Tags / Triggers / Variables / Built-in / Folders, each Total·Common·Unique.
          Click a card to focus the tables on that one type (a dedicated per-kind comparison). */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {WS_KINDS.map((k) => {
          const b = stats.byKind[k];
          if (!b || b.total === 0) return null;
          const isolated = fKind.size === 1 && fKind.has(k);
          return (
            <button
              key={k}
              onClick={() => setFKind(isolated ? new Set(WS_KINDS) : new Set([k]))}
              title={isolated ? 'Show all types' : `Show only ${WS_KIND_LABEL[k]}s`}
              style={{ textAlign: 'left', cursor: 'pointer', minWidth: 122, borderRadius: 8, padding: '7px 11px', border: `1px solid ${isolated ? 'var(--c-blue)' : 'var(--border-2)'}`, background: isolated ? 'var(--c-blue-bg)' : 'var(--surface)' }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{WS_KIND_LABEL[k]}s</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {b.total} total · <span style={{ color: 'var(--c-green)' }}>{b.common} common</span> · <span style={{ color: 'var(--c-amber)' }}>{b.unique} unique</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 10px' }}>
        <span style={{ ...styles.muted, fontSize: 12 }}>Merge:</span>
        {(['safe', 'review', 'conflict'] as const).map((m) => chip(fMerge.has(m), WS_MERGE_COLOR[m].label, WS_MERGE_COLOR[m].fg, () => toggle(setFMerge, m)))}
        <span style={{ ...styles.muted, fontSize: 12, marginLeft: 8 }}>Type:</span>
        {WS_KINDS.map((k) => chip(fKind.has(k), WS_KIND_LABEL[k], 'var(--c-blue)', () => toggle(setFKind, k)))}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name…" style={{ ...styles.input, minWidth: 160, marginLeft: 'auto' }} />
      </div>

      {/* COMMON items - in all selected workspaces */}
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', marginTop: 6 }}>
        Common items <span style={{ ...styles.muted, fontWeight: 400 }}>(in all {stats.workspaces} workspaces) - {commonRows.length} shown</span>
      </div>
      {commonRows.length === 0 ? (
        <div style={{ ...styles.muted, fontSize: 12.5, padding: 8, border: '1px dashed var(--border-2)', borderRadius: 6, textAlign: 'center', marginTop: 4 }}>No common items match the filters.</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                {['Type', 'Name', ...result.workspaces.map((w) => w.name), 'Merge status', 'Notes'].map((h, i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '5px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {commonRows.map((e) => {
                const key = `${e.kind}|${e.name}`;
                const m = WS_MERGE_COLOR[e.mergeStatus];
                const vi = variantIndex(e);
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr style={{ borderBottom: '1px solid var(--border)', cursor: e.identical ? 'default' : 'pointer' }} onClick={() => !e.identical && toggle(setExpanded, key)}>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{WS_KIND_LABEL[e.kind]}</td>
                      <td style={{ padding: '5px 8px', fontWeight: 600, color: 'var(--text)' }}>{!e.identical ? (isOpen ? '▾ ' : '▸ ') : ''}{e.name}</td>
                      {result.workspaces.map((w) => (
                        <td key={w.workspaceId} style={{ padding: '5px 8px', textAlign: 'center', color: e.identical ? 'var(--c-green)' : vi[w.workspaceId] === 1 ? 'var(--text)' : 'var(--c-amber)' }}>{e.identical ? '✓' : `v${vi[w.workspaceId]}`}</td>
                      ))}
                      <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: m.bg, color: m.fg }}>{m.label}</span></td>
                      <td style={{ padding: '5px 8px', fontSize: 11.5, color: 'var(--text-dim)' }}>{e.notes}</td>
                    </tr>
                    {isOpen && !e.identical && (
                      <tr>
                        <td colSpan={4 + result.workspaces.length} style={{ padding: '6px 12px', background: 'var(--surface-2)' }}>
                          <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                            {e.differingFields.map((f) => (
                              <div key={f} style={{ marginBottom: 2 }}>
                                <span style={{ color: 'var(--c-blue)' }}>{f}</span>:{' '}
                                {result.workspaces.map((w, i) => {
                                  const val = e.perWorkspace[w.workspaceId]?.[f];
                                  return <span key={w.workspaceId}>{i > 0 ? ' · ' : ''}<span style={{ ...styles.muted }}>{w.name}=</span><span style={{ color: 'var(--text)' }}>{val === undefined ? '(none)' : val.length > 60 ? val.slice(0, 60) + '…' : val || '(empty)'}</span></span>;
                                })}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* UNCOMMON items - missing from one or more workspaces */}
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', marginTop: 18 }}>
        Uncommon items <span style={{ ...styles.muted, fontWeight: 400 }}>(missing from one or more) - {uncommonRows.length} shown</span>
      </div>
      {uncommonRows.length === 0 ? (
        <div style={{ ...styles.muted, fontSize: 12.5, padding: 8, border: '1px dashed var(--border-2)', borderRadius: 6, textAlign: 'center', marginTop: 4 }}>No uncommon items{q || fKind.size < WS_KINDS.length ? ' match the filters' : ' - every item exists in all workspaces'}.</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                {['Type', 'Name', 'Present in', 'Missing from', 'Suggested action'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '5px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {uncommonRows.map((e) => {
                const key = `u|${e.kind}|${e.name}`;
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggle(setExpanded, key)}>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{WS_KIND_LABEL[e.kind]}</td>
                      <td style={{ padding: '5px 8px', fontWeight: 600, color: 'var(--text)' }}>{isOpen ? '▾ ' : '▸ '}{e.name}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--c-green)', fontSize: 12 }}>{e.presentIn.join(', ')}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--c-red)', fontSize: 12 }}>{e.missingFrom.join(', ')}</td>
                      <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--c-blue-bg)', color: 'var(--c-blue)' }}>Copy to missing</span></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} style={{ padding: '6px 12px', background: 'var(--surface-2)' }}>
                          <div style={{ ...styles.muted, fontSize: 11, marginBottom: 3 }}>Configuration (from {e.presentIn[0]}):</div>
                          <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                            {Object.entries(Object.values(e.perWorkspace).find((f) => f) ?? {}).map(([f, v]) => (
                              <div key={f}><span style={{ color: 'var(--c-blue)' }}>{f}</span>: <span style={{ color: 'var(--text)' }}>{v.length > 80 ? v.slice(0, 80) + '…' : v || '(empty)'}</span></div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Dependency graph + cross-workspace missing-dependency check */}
      <WsDependencySection result={result} />

      {/* Detailed base-vs-each diff (opt-in) */}
      <div style={{ marginTop: 14 }}>
        <button style={styles.linkBtn} onClick={() => setShowDetailed((o) => !o)}>{showDetailed ? 'hide' : 'show'} detailed base-vs-each diff</button>
        {showDetailed && result.pairs.map((p) => {
          const rows = p.entities.filter((e) => e.status !== 'unchanged' && fKind.has(e.kind) && nameMatch(e.name));
          return (
            <div key={p.bWorkspaceId} style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{p.bName} <span style={{ ...styles.muted, fontWeight: 400 }}>vs</span> {p.aName} <span style={{ ...styles.muted, fontWeight: 400, fontSize: 11 }}>(base)</span></div>
              {rows.length === 0 ? <div style={{ ...styles.muted, fontSize: 12 }}>Identical (or filtered out).</div> : (
                <ul style={styles.resultList}>
                  {rows.map((e) => {
                    const c = WS_STATUS_COLOR[e.status];
                    return (
                      <li key={`${e.kind}|${e.name}`} style={{ ...styles.resultRow, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{c.label}</span>
                          <span style={{ ...styles.muted, fontSize: 11.5 }}>{WS_KIND_LABEL[e.kind]}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{e.name}</span>
                          {/* Name the actual workspace each add/remove lives in, not a vague "this workspace". */}
                          {e.status === 'added' && <span style={{ fontSize: 11.5, color: 'var(--c-green)' }}>only in {p.bName}</span>}
                          {e.status === 'removed' && <span style={{ fontSize: 11.5, color: 'var(--c-red)' }}>only in {p.aName}</span>}
                        </div>
                        {e.status === 'changed' && e.changes && (
                          <div style={{ marginLeft: 8, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                            {e.changes.map((ch) => (
                              <div key={ch.field}><span style={{ color: 'var(--c-blue)' }}>{ch.field}</span>: <span style={{ ...styles.muted }}>{p.aName}:</span> <span style={{ color: 'var(--c-red)' }}>{ch.a === undefined ? '(none)' : ch.a.slice(0, 60)}</span> → <span style={{ ...styles.muted }}>{p.bName}:</span> <span style={{ color: 'var(--c-green)' }}>{ch.b === undefined ? '(none)' : ch.b.slice(0, 60)}</span></div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Report Generation - clearly SEPARATE from the comparison above. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-2)' }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>Report generation</div>
        <div style={{ ...styles.muted, fontSize: 12, margin: '2px 0 8px' }}>Generate a detailed comparison report - summary, common + uncommon items, merge recommendations and differences (separate from the on-screen comparison).</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={{ ...styles.primaryBtn, ...(exporting ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} onClick={() => onReport('xlsx')} disabled={exporting} title="Native Excel workbook - Summary, Common, Uncommon and Detailed-diff sheets with full config values">⬇ Export Excel (.xlsx)</button>
          <button style={{ ...styles.toggleOff, ...(exporting ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} onClick={() => onReport('pdf')} disabled={exporting}>Generate PDF report</button>
          <button style={{ ...styles.toggleOff, ...(exporting ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} onClick={() => onReport('csv')} disabled={exporting}>Export CSV</button>
          {exportNote && <span style={{ ...styles.muted, fontSize: 12 }}>{exportNote}</span>}
        </div>
      </div>
    </div>
  );
}

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

  // Download the FULL audit (all findings, worst-first) to a file the user picks - CSV
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
    if (fix[i]?.state === 'fixing') return; // already in flight - never double-issue a write
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
  // type filter). Deletes are EXCLUDED from THIS batch - they have their own confirmed bulk path
  // (applyDeleteBatch / the "Bulk delete" toolbar) plus a per-row two-click confirm. Consent fixes
  // apply their default ("require consent" - conservative, reversible); use a row's "No extra
  // consent" for the exceptions.
  const bulkFixable = findings.filter(
    (f, i) => typeMatches(f) && f.autoFixable && f.fix && !f.fix.tool.startsWith('delete') && fix[i]?.state !== 'done'
  ).length;
  const isConsentFix = (f: AuditFindingView): boolean => f.fix?.tool === 'set_gtm_tag_consent';
  // "Require consent" batch includes ad pixels (gating a pixel is the safe direction).
  const consentFixable = findings.filter((f, i) => typeMatches(f) && f.autoFixable && isConsentFix(f) && fix[i]?.state !== 'done').length;
  // "No extra consent" batch EXCLUDES B6 ad pixels - one-click un-gating an ad pixel is a
  // compliance regression, so those keep their per-row choice.
  const noExtraFixable = findings.filter(
    (f, i) => typeMatches(f) && f.autoFixable && isConsentFix(f) && f.checkId !== 'B6-ad-pixel-consent' && fix[i]?.state !== 'done'
  ).length;
  // Unpausing a paused tag is non-destructive (set_gtm_tag_paused → paused:false), so it
  // applies with NO confirmation - offered as its own one-click batch.
  const isUnpauseFix = (f: AuditFindingView): boolean => f.fix?.tool === 'set_gtm_tag_paused';
  const pausedFixable = findings.filter((f, i) => typeMatches(f) && f.autoFixable && isUnpauseFix(f) && fix[i]?.state !== 'done').length;
  // Rows to render - keep each finding's ORIGINAL index so the per-row fix state still aligns.
  const visible = findings.map((f, i) => ({ f, i })).filter(({ f }) => typeMatches(f));

  // ── Bulk delete (unused triggers + unused variables) ──────────────────────
  // The audit's two destructive fixes - delete_gtm_trigger (unused triggers) and
  // delete_gtm_variable (unused variables) - get selection checkboxes plus "Delete selected" /
  // "Delete all" buttons. Both scope to the current filter + search via `visible`, exactly like the
  // non-destructive batches. Single deletes keep their per-row two-click confirm; a bulk delete
  // asks ONE combined confirmation instead.
  const isDeletable = (f: AuditFindingView): boolean =>
    Boolean(f.autoFixable && f.fix && f.fix.tool.startsWith('delete'));
  const deletableTargets = visible
    .filter(({ f, i }) => isDeletable(f) && fix[i]?.state !== 'done' && fix[i]?.state !== 'fixing')
    .map(({ i }) => i);
  const selectedDelTargets = deletableTargets.filter((i) => selectedDel[i]);
  // True while any per-row delete is mid-flight - used to disable the bulk entry points so a single
  // in-flight delete can't be re-issued by a bulk run (applyDeleteBatch also re-validates at run time).
  const anyFixing = Object.values(fix).some((s) => s?.state === 'fixing');
  const delTriggerCount = (idxs: number[]): number => idxs.filter((i) => findings[i].fix?.tool === 'delete_gtm_trigger').length;
  const delVariableCount = (idxs: number[]): number => idxs.filter((i) => findings[i].fix?.tool === 'delete_gtm_variable').length;
  // "X unused trigger(s) · Y unused variable(s)" - the kind breakdown for a set of delete targets.
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
  // runs destructive fixes in bulk, so it never auto-includes anything - the caller passes an
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

  // A disabled button keeps its inline background, so Chromium won't auto-fade it - apply this when
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

        {/* Workspace Comparison - a distinct functionality within Container Audit (separate from Run audit
            and its report). Compares 2+ workspaces side by side with its own report generation. */}
        <WorkspaceComparison active={active} onError={onError} />

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
                  account {ctx?.accountId ?? '-'} · container {ctx?.containerId ?? '-'} · workspace {ctx?.workspaceId ?? '-'} · tags{' '}
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
                      <div style={{ ...styles.h2, marginTop: 12 }}>Fix preview ({fixes.length}) - the exact tool + args “Apply fix” calls</div>
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
                  title="Filter findings - and scope the batch fixes - by severity, issue type, tag type, or fixability"
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
                    title="Declare 'no additional consent required' on every consent finding at once - for tags that rely on Consent Mode at the Google-tag level. Advertising pixels are EXCLUDED (un-gating them is a compliance risk); use a pixel's own buttons."
                  >
                    {applyingAll ? 'Applying…' : `No extra consent on all (${noExtraFixable})`}
                  </button>
                )}
                {pausedFixable > 0 && (
                  <button
                    style={styles.ghostBtn}
                    onClick={() => applyBatch(isUnpauseFix)}
                    disabled={applyingAll}
                    title="Unpause every paused tag at once (set it live). No confirmation - unpausing is non-destructive."
                  >
                    {applyingAll ? 'Applying…' : `Unpause all paused (${pausedFixable})`}
                  </button>
                )}
                {applyingAll && (
                  <button
                    style={styles.dangerGhost}
                    onClick={cancelBatch}
                    disabled={canceling}
                    title="Stop the batch - the fix in progress finishes, then no more are applied. Already-applied fixes stay."
                  >
                    {canceling ? 'Stopping…' : 'Cancel'}
                  </button>
                )}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {applyingAll
                    ? canceling
                      ? `Stopping after the current fix… (${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0})`
                      : `Applying ${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0}… click Cancel to stop after the current fix.`
                    : 'Non-destructive fixes only - bulk delete for unused triggers / variables is below; “No extra consent” skips ad pixels.'}
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
                  title="Delete the checked unused triggers / variables - one confirmation, then each is removed from the draft workspace."
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
                      <b>not</b> refuse a referenced variable - one used only in a published version or a field the audit
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
            No issues found - every tag has a trigger, nothing's mis-paused, nothing unused. Looks clean.
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
                        {st.state === 'fixing' ? 'Applying…' : st.state === 'done' ? '✓ applied - re-run to confirm' : `✗ ${st.msg}`}
                      </div>
                    )}
                  </div>
                  {f.autoFixable && f.fix && !done && f.fix.tool === 'set_gtm_tag_consent' ? (
                    // Consent has two valid answers - let the user pick rather than
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
// GA4 client + trigger + GA4 relay tag (relaying the web container's GA4 Measurement ID), and - when
// a tagging-server URL is given - records it on the server container and points the web Google tag at
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
  // '' = create new; otherwise COMPLETE this existing server container (add whatever is missing).
  const [targetId, setTargetId] = useState('');
  const [serverList, setServerList] = useState<GtmContainerView[]>([]);
  // The one-click proof: the audit runs automatically on the resulting container.
  const [postAudit, setPostAudit] = useState<AuditReportView | null>(null);

  // Default the new container's name from the web container ("<web> - Server"), once, when it loads.
  useEffect(() => {
    if (ctx?.containerName) setName((n) => n || `${ctx.containerName} - Server`);
  }, [ctx?.containerName]);

  // Existing server containers -> the "complete existing" option (the shell-container case).
  useEffect(() => {
    if (!ctx?.accountId) return;
    window.desktop.data
      .listGtmContainers(ctx.accountId)
      .then((list) => setServerList(list.filter((c) => (c.usageContext ?? []).some((u) => /server/i.test(u)))))
      .catch(() => setServerList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.accountId]);

  const completing = serverList.find((c) => c.containerId === targetId) ?? null;

  // ── Audit-first PLAN flow: plan -> select -> collect values -> apply -> summary ──
  const [plan, setPlan] = useState<ServerPlanView | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [summary, setSummary] = useState<ServerPlanApplyResultView | null>(null);

  async function loadPlan(): Promise<void> {
    if (!ready || !ctx || planLoading) return;
    onError('');
    setPlanLoading(true);
    setPlan(null);
    setSummary(null);
    setApplyConfirm(false);
    try {
      const pl = await window.desktop.gtm.planServer(ctx.accountId!, ctx.containerId!, targetId || undefined);
      setPlan(pl);
      const defaults: Record<string, boolean> = {};
      for (const it of pl.items) if (it.status === 'missing' && it.executable) defaults[it.id] = it.defaultSelected;
      setSel(defaults);
      setVals((v) => ({ ...v, serverUrl: v.serverUrl || pl.detected.serverUrl || pl.detected.webWiredUrl || serverUrl.trim() || '' }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  }

  async function applyPlan(): Promise<void> {
    if (!ready || !ctx || !plan || applying) return;
    const selected = Object.keys(sel).filter((k) => sel[k]);
    if (!selected.length) return;
    onError('');
    setApplying(true);
    setApplyConfirm(false);
    setSummary(null);
    setPostAudit(null);
    try {
      const r = await window.desktop.gtm.applyServerPlan({
        accountId: ctx.accountId!,
        webContainerId: ctx.containerId!,
        ...(targetId ? { serverContainerId: targetId } : { newName: name.trim() }),
        selected,
        values: { ...vals, serverUrl: (vals.serverUrl ?? serverUrl).trim() },
      });
      setSummary(r);
      try {
        setPostAudit(await window.desktop.gtm.auditServer(ctx.accountId!, r.serverContainer.containerId, r.workspaceId));
      } catch { /* best-effort */ }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };
  const row: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13 };

  const [showCreate, setShowCreate] = useState(false);
  const [serverCount, setServerCount] = useState<number | null>(null);
  // First run (no server container in the account yet): creating one IS the main action - open its page.
  useEffect(() => {
    if (serverCount === 0) setShowCreate(true);
  }, [serverCount]);

  return (
    <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {!showCreate &&
        (Boolean(active?.hasGoogleToken && ctx?.accountId) ? (
          <ServerAuditSection accountId={ctx!.accountId!} onError={onError} webCtx={ctx} onServersLoaded={setServerCount} onOpenCreate={() => setShowCreate(true)} />
        ) : (
          <div style={{ color: 'var(--c-amber)', fontSize: 13 }}>
            {!active?.hasGoogleToken ? 'Sign this account into Google first.' : 'Pick a GTM account (and your web container) in the GTM bar above, then return here.'}
          </div>
        ))}

      {/* ── Create: its own PAGE (opened from the home tile; auto-opened on first run) ── */}
      {showCreate && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button style={styles.ghostBtn} onClick={() => setShowCreate(false)}>← Back</button>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Create a new server container</span>
            {serverCount === 0 && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--c-amber)' }}>none exists yet - start here</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Builds a NEW server-side (sGTM) container from the web container in the GTM bar: container + GA4 client + firing trigger + GA4 relay tag (relaying that web container&apos;s GA4 Measurement ID). Paste your tagging-server URL (Cloud Run / Stape / your host) to also record it and point the web Google tag at it. Draft-only - nothing is published, and GTM does not deploy the host.
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
          {serverList.length > 0 && (
            <label>
              <span style={lbl}>Target</span>
              <select style={styles.input} value={targetId} onChange={(e) => { setTargetId(e.target.value); setPostAudit(null); }}>
                <option value="">＋ Create a new server container</option>
                {serverList.map((c) => (
                  <option key={c.containerId} value={c.containerId}>Complete existing: {c.name}{c.publicId ? ` (${c.publicId})` : ''}</option>
                ))}
              </select>
            </label>
          )}
          {!targetId && (
            <label>
              <span style={lbl}>New server container name</span>
              <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. example.com - Server" />
            </label>
          )}
          {targetId && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              The audit below shows whatever “{completing?.name}” is missing - GA4 client, all-events trigger, GA4 relay (from the web container's Measurement ID), first-party GTM client, event-data variables - pick the fixes to apply. Existing pieces are reused, never duplicated.
            </div>
          )}
          <label>
            <span style={lbl}>Tagging server URL - optional (from Cloud Run / Stape / your host)</span>
            <input style={styles.input} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://sgtm.example.com" />
          </label>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            Leave the URL blank to create the container now and wire it later (after you deploy the host). You can set it any time from the chat with set_server_container_tagging_url.
          </div>

          {/* ── Audit-first plan: see everything, pick exactly what to create, then apply ── */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>Audit first, then apply selected fixes</span>
              <span style={{ flex: 1 }} />
              <button style={{ ...styles.ghostBtn, color: 'var(--c-blue)' }} disabled={planLoading || (!targetId && !name.trim())} onClick={() => void loadPlan()}>
                {planLoading ? 'Auditing…' : plan ? '↻ Re-plan' : '▶ Audit & plan'}
              </button>
            </div>
            {plan && (() => {
              const missing = plan.items.filter((i) => i.status === 'missing');
              const existing = plan.items.filter((i) => i.status === 'existing');
              const byId = new Map(plan.items.map((i) => [i.id, i]));
              const selectedIds = Object.keys(sel).filter((k) => sel[k]);
              const value = (k: string): string => (k === 'serverUrl' ? (vals.serverUrl ?? serverUrl) : vals[k] ?? '');
              const missingValueKeys = [...new Set(selectedIds.flatMap((id) => byId.get(id)?.requires ?? []))];
              const notReady = selectedIds
                .map((id) => byId.get(id)!)
                .filter((i) => i && (i.requires.some((k) => !value(k).trim()) || i.dependsOn.some((d) => byId.get(d)?.status === 'missing' && !sel[d])));
              const anyMeta = plan.items.some((i) => i.id.startsWith('meta_capi:') && i.status === 'missing');
              const anyTikTok = plan.items.some((i) => i.id.startsWith('tiktok_capi:') && i.status === 'missing');
              const CAT_COLOR: Record<string, string> = { critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber)', low: 'var(--text-muted)' };
              const setAll = (on: boolean): void => {
                const next: Record<string, boolean> = {};
                for (const it of missing) if (it.executable) next[it.id] = on;
                setSel(next);
              };
              return (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{missing.length} fix(es) available · {existing.length} piece(s) already in place</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: plan.detected.dataTag === 'configured' ? 'var(--c-green)' : plan.detected.dataTag === 'misconfigured' ? 'var(--c-amber)' : 'var(--text-faint)' }}>
                      Stape Data Tag: {plan.detected.dataTag === 'configured' ? '✓ configured' : plan.detected.dataTag === 'misconfigured' ? '⚠ misconfigured' : 'not installed'}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button style={styles.ghostBtn} onClick={() => setAll(true)}>Select all</button>
                    <button style={styles.ghostBtn} onClick={() => setAll(false)}>Deselect all</button>
                  </div>
                  {(['critical', 'high', 'medium', 'low'] as const).map((cat) => {
                    const items = missing.filter((i) => i.category === cat);
                    if (!items.length) return null;
                    return (
                      <div key={cat} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: CAT_COLOR[cat] }}>{cat}</div>
                        {items.map((it) => (
                          <label key={it.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, cursor: it.executable ? 'pointer' : 'default', opacity: it.executable ? 1 : 0.75 }}>
                            <input type="checkbox" style={{ marginTop: 2 }} disabled={!it.executable} checked={Boolean(sel[it.id])} onChange={(e) => setSel((m) => ({ ...m, [it.id]: e.target.checked }))} />
                            <span style={{ lineHeight: 1.45 }}>
                              <b>{it.name}</b> <span style={{ fontSize: 10.5, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{it.kind}</span>
                              <br />
                              <span style={{ color: 'var(--text-muted)' }}>{it.description}</span>
                              {it.dependsOn.length > 0 && (
                                <span style={{ color: 'var(--text-faint)' }}> Requires: {it.dependsOn.map((d) => byId.get(d)?.name ?? d).join(', ')}.</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  {existing.length > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                      Already in place: {existing.map((i) => i.name).join(' · ')}
                    </div>
                  )}
                  {(missingValueKeys.length > 0 || anyMeta || anyTikTok) && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
                      {missingValueKeys.includes('measurementId') && (
                        <input style={{ ...styles.input, flex: '1 1 170px' }} placeholder="GA4 Measurement ID (G-…)" value={vals.measurementId ?? ''} onChange={(e) => setVals((v) => ({ ...v, measurementId: e.target.value }))} />
                      )}
                      {(missingValueKeys.includes('serverUrl') || plan.detected.serverUrl == null) && (
                        <input style={{ ...styles.input, flex: '1 1 220px' }} placeholder="https://sgtm.example.com" value={vals.serverUrl ?? serverUrl} onChange={(e) => setVals((v) => ({ ...v, serverUrl: e.target.value }))} />
                      )}
                      {anyMeta && (
                        <>
                          <input style={{ ...styles.input, flex: '1 1 150px' }} placeholder="Meta Pixel ID" value={vals.metaPixelId ?? ''} onChange={(e) => setVals((v) => ({ ...v, metaPixelId: e.target.value }))} />
                          <input style={{ ...styles.input, flex: '1 1 190px' }} type="password" placeholder="Meta CAPI access token" value={vals.metaAccessToken ?? ''} onChange={(e) => setVals((v) => ({ ...v, metaAccessToken: e.target.value }))} />
                        </>
                      )}
                      {anyTikTok && (
                        <>
                          <input style={{ ...styles.input, flex: '1 1 150px' }} placeholder="TikTok Pixel ID" value={vals.tiktokPixelId ?? ''} onChange={(e) => setVals((v) => ({ ...v, tiktokPixelId: e.target.value }))} />
                          <input style={{ ...styles.input, flex: '1 1 190px' }} type="password" placeholder="TikTok access token" value={vals.tiktokAccessToken ?? ''} onChange={(e) => setVals((v) => ({ ...v, tiktokAccessToken: e.target.value }))} />
                        </>
                      )}
                    </div>
                  )}
                  {notReady.length > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--c-amber)' }}>
                      Not ready (missing a value or an unchecked dependency): {notReady.map((i) => i.name).join(', ')} - these will be SKIPPED, not guessed.
                    </div>
                  )}
                  {!applyConfirm ? (
                    <button style={styles.primaryBtn} disabled={applying || selectedIds.length === 0} onClick={() => setApplyConfirm(true)}>
                      {applying ? 'Applying…' : `Apply ${selectedIds.length} selected fix(es)`}
                    </button>
                  ) : (
                    <div style={styles.confirm}>
                      <div style={{ ...styles.muted, marginBottom: 8, color: 'var(--c-amber)' }}>
                        Apply {selectedIds.length} selected fix(es) to {targetId ? `“${completing?.name}”` : `new container “${name.trim()}”`}? Existing pieces are reused; unchecked items are untouched. Draft-only - not published.
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button style={styles.primaryBtn} disabled={applying} onClick={() => void applyPlan()}>{applying ? 'Applying…' : 'Confirm & apply'}</button>
                        <button style={styles.ghostBtn} disabled={applying} onClick={() => setApplyConfirm(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {summary && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
                      <div style={{ ...row, borderColor: summary.failed.length ? 'var(--c-amber-border)' : 'var(--c-green-border)', background: summary.failed.length ? 'var(--c-amber-bg)' : 'var(--c-green-bg)' }}>
                        ✓ Applied {summary.applied.length} · reused {summary.reused.length}
                        {summary.skipped.length > 0 && <> · skipped {summary.skipped.length}</>}
                        {summary.failed.length > 0 && <> · failed {summary.failed.length}</>}
                        {' '}on <b>{summary.serverContainer.name}</b> {summary.serverContainer.publicId}
                      </div>
                      {summary.applied.length > 0 && <div><b>Applied:</b> {summary.applied.map((id) => byId.get(id)?.name ?? id).join(', ')}</div>}
                      {summary.reused.length > 0 && <div style={{ color: 'var(--text-muted)' }}><b>Reused existing:</b> {summary.reused.map((id) => byId.get(id)?.name ?? id).join(', ')}</div>}
                      {summary.skipped.map((x) => (
                        <div key={x.id} style={{ color: 'var(--c-amber)' }}>Skipped {byId.get(x.id)?.name ?? x.id}: {x.reason}</div>
                      ))}
                      {summary.failed.map((x) => (
                        <div key={x.id} style={{ color: 'var(--c-red)' }}>Failed {byId.get(x.id)?.name ?? x.id}: {x.error}</div>
                      ))}
                      {postAudit && (
                        <div style={{ ...row, borderColor: postAudit.counts.findings === 0 ? 'var(--c-green-border)' : 'var(--c-amber-border)', background: postAudit.counts.findings === 0 ? 'var(--c-green-bg)' : 'var(--c-amber-bg)' }}>
                          {postAudit.counts.findings === 0 ? (
                            <>✓ <b>Verified:</b> the configuration audit came back clean - {postAudit.counts.clients ?? 0} client(s), {postAudit.counts.tags} tag(s), {postAudit.counts.triggers} trigger(s), {postAudit.counts.variables} variable(s).</>
                          ) : (
                            <>
                              <b>Verified with {postAudit.counts.findings} finding{postAudit.counts.findings === 1 ? '' : 's'}</b> ({postAudit.summary.critical} critical · {postAudit.summary.high} high · {postAudit.summary.medium} medium · {postAudit.summary.low} low): {postAudit.findings.slice(0, 2).map((f) => f.message.split(' - ')[0]).join('; ')}
                              {postAudit.counts.findings > 2 ? '…' : ''} - open the Audit service for the full list.
                            </>
                          )}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Open GTM to review &amp; publish the server container. Deploy the tagging-server host (Cloud Run / Stape) if you haven&apos;t, then verify it answers before relying on it.
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

        </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Audit an EXISTING server container (read-only, config-level): pick the server container +
 *  workspace, run the sGTM audit engine (clients claiming, duplicate GA4 relays that double-count,
 *  dead URL-encoded triggers, Meta CAPI pitfalls, legacy/duplicate clients, unused variables,
 *  dangling references) and render the findings. Never reads server runtime logs. */
function ServerAuditSection({
  accountId,
  onError,
  webCtx,
  onServersLoaded,
  onOpenCreate,
}: {
  accountId: string;
  onError: (m: string) => void;
  /** The GTM bar's web-container selection - the coverage comparison defaults to it. */
  webCtx?: GtmContext;
  /** Lets the parent auto-open the create wizard when the account has no server container yet. */
  onServersLoaded?: (count: number) => void;
  /** Opens the create-server-container page (a home tile). */
  onOpenCreate?: () => void;
}): JSX.Element {
  // Which service page is open; 'home' shows the picker + the selectable service tiles.
  const [view, setView] = useState<'home' | 'audit' | 'coverage' | 'docs'>('home');
  const [containers, setContainers] = useState<GtmContainerView[]>([]);
  const [containerId, setContainerId] = useState('');
  const [workspaces, setWorkspaces] = useState<GtmWorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<AuditReportView | null>(null);
  // Web <-> Server coverage: the web side of the comparison + its result.
  const [allContainers, setAllContainers] = useState<GtmContainerView[]>([]);
  const [webContainerId, setWebContainerId] = useState('');
  const [webWorkspaces, setWebWorkspaces] = useState<GtmWorkspaceView[]>([]);
  const [webWorkspaceId, setWebWorkspaceId] = useState('');
  const [covRunning, setCovRunning] = useState(false);
  const [coverage, setCoverage] = useState<ServerCoverageView | null>(null);

  useEffect(() => {
    setWebWorkspaces([]); setWebWorkspaceId(''); setCoverage(null);
    if (!webContainerId) return;
    window.desktop.data
      .listGtmWorkspaces(accountId, webContainerId)
      .then((ws) => {
        setWebWorkspaces(ws);
        // Prefer the GTM bar's workspace when comparing the bar's own container.
        const barWs = webCtx?.workspaceId && webContainerId === webCtx.containerId && ws.some((w) => w.workspaceId === webCtx.workspaceId) ? webCtx.workspaceId : '';
        setWebWorkspaceId(barWs || (ws.length ? ws[0].workspaceId : ''));
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webContainerId]);

  // One-click create for a MISSING coverage row (clone the template server tag; draft-only).
  const [rowCreate, setRowCreate] = useState<Record<number, { state: 'idle' | 'confirm' | 'creating' | 'done' | 'err'; msg?: string }>>({});
  async function createFromRow(i: number, row: NonNullable<ServerCoverageView['rows'][number]>): Promise<void> {
    if (!row.template || !containerId || !workspaceId) return;
    setRowCreate((m) => ({ ...m, [i]: { state: 'creating' } }));
    try {
      const platformLabel = row.platform === 'meta' ? 'Meta' : row.platform === 'tiktok' ? 'TikTok' : row.platform === 'linkedin' ? 'LinkedIn' : row.platform === 'pinterest' ? 'Pinterest' : row.platform;
      const r = await window.desktop.gtm.createServerTagForEvent(accountId, containerId, workspaceId, row.template.tagId, row.event, `${platformLabel} CAPI - ${row.event}`);
      setRowCreate((m) => ({ ...m, [i]: { state: 'done', msg: `✓ Created draft "${r.name}" on trigger "${r.triggerName}"${r.triggerReused ? ' (reused)' : ''} - review its outgoing event-name field in GTM, then publish.` } }));
    } catch (e) {
      setRowCreate((m) => ({ ...m, [i]: { state: 'err', msg: e instanceof Error ? e.message : String(e) } }));
    }
  }

  const [covExporting, setCovExporting] = useState(false);
  const [covNote, setCovNote] = useState('');
  async function exportCoverage(format: 'csv' | 'pdf'): Promise<void> {
    if (!coverage || covExporting) return;
    onError('');
    setCovExporting(true);
    setCovNote('');
    try {
      const saved = await window.desktop.gtm.exportServerCoverage(format, coverage, {
        webName: allContainers.find((c) => c.containerId === webContainerId)?.name,
        serverName: containers.find((c) => c.containerId === containerId)?.name,
        webWorkspace: webWorkspaces.find((w) => w.workspaceId === webWorkspaceId)?.name,
        serverWorkspace: workspaces.find((w) => w.workspaceId === workspaceId)?.name,
      });
      setCovNote(saved ? `✓ Saved to ${saved}` : 'Save cancelled.');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setCovExporting(false);
    }
  }

  async function runCoverage(): Promise<void> {
    if (!containerId || !workspaceId || !webContainerId || !webWorkspaceId || covRunning) return;
    onError('');
    setCovRunning(true);
    setCoverage(null);
    try {
      setCoverage(await window.desktop.gtm.serverCoverage(accountId, webContainerId, webWorkspaceId, containerId, workspaceId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setCovRunning(false);
    }
  }

  useEffect(() => {
    setContainers([]); setContainerId(''); setReport(null);
    window.desktop.data
      .listGtmContainers(accountId)
      .then((list) => {
        setAllContainers(list);
        const servers = list.filter((c) => (c.usageContext ?? []).some((u) => /server/i.test(u)));
        setContainers(servers);
        onServersLoaded?.(servers.length);
        if (servers.length === 1) setContainerId(servers[0].containerId);
        // The coverage comparison defaults to the web container already picked in the GTM bar -
        // don't make the user pick it twice. Falls back to a sole web container.
        const webs = list.filter((c) => !(c.usageContext ?? []).some((u) => /server/i.test(u)));
        const barWeb = webCtx?.containerId && webs.some((c) => c.containerId === webCtx.containerId) ? webCtx.containerId : '';
        if (barWeb) setWebContainerId(barWeb);
        else if (webs.length === 1) setWebContainerId(webs[0].containerId);
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    setWorkspaces([]); setWorkspaceId(''); setReport(null);
    if (!containerId) return;
    window.desktop.data
      .listGtmWorkspaces(accountId, containerId)
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length) setWorkspaceId(ws[0].workspaceId);
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  async function run(): Promise<void> {
    if (!containerId || !workspaceId || running) return;
    onError('');
    setRunning(true);
    setReport(null);
    try {
      setReport(await window.desktop.gtm.auditServer(accountId, containerId, workspaceId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const [docExporting, setDocExporting] = useState(false);
  const [docNote, setDocNote] = useState('');
  const [doc, setDoc] = useState<ServerDocView | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  // Opening the Documentation page loads the doc itself - the data shows ON the page,
  // downloads are the same content as files.
  useEffect(() => {
    if (view !== 'docs' || !containerId || !workspaceId) return;
    let cancelled = false;
    setDocLoading(true);
    setDoc(null);
    const cont = containers.find((c) => c.containerId === containerId);
    const ws = workspaces.find((x) => x.workspaceId === workspaceId);
    const webRef = webContainerId && webWorkspaceId ? { containerId: webContainerId, workspaceId: webWorkspaceId } : undefined;
    window.desktop.gtm
      .serverDoc(accountId, containerId, workspaceId, { containerName: cont?.name, publicId: cont?.publicId, workspaceName: ws?.name }, webRef)
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch((e) => { if (!cancelled) onError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setDocLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, containerId, workspaceId, webContainerId, webWorkspaceId]);
  async function exportDoc(format: 'md' | 'csv' | 'pdf' | 'xlsx'): Promise<void> {
    if (!containerId || !workspaceId || docExporting) return;
    onError('');
    setDocExporting(true);
    setDocNote('');
    try {
      const cont = containers.find((c) => c.containerId === containerId);
      const ws = workspaces.find((w) => w.workspaceId === workspaceId);
      const saved = await window.desktop.gtm.exportServerDoc(accountId, containerId, workspaceId, format, {
        containerName: cont?.name,
        publicId: cont?.publicId,
        workspaceName: ws?.name,
      }, webContainerId && webWorkspaceId ? { containerId: webContainerId, workspaceId: webWorkspaceId } : undefined);
      setDocNote(saved ? `✓ Saved to ${saved}` : 'Save cancelled.');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDocExporting(false);
    }
  }

  const SEV: Record<string, string> = { critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber)', low: 'var(--text-muted)', info: 'var(--text-faint)' };
  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(() => {
        const picked = Boolean(containerId && workspaceId);
        const ctxLine = picked
          ? `${containers.find((c) => c.containerId === containerId)?.name ?? containerId} · ${workspaces.find((w) => w.workspaceId === workspaceId)?.name ?? ''}`
          : '';
        const backRow = (title: string): JSX.Element => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button style={styles.ghostBtn} onClick={() => setView('home')}>← Back</button>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{ctxLine}</span>
          </div>
        );
        const tile = (title: string, desc: string, onOpen: () => void, enabled: boolean): JSX.Element => (
          <button
            key={title}
            onClick={onOpen}
            disabled={!enabled}
            style={{
              flex: '1 1 230px', minWidth: 220, textAlign: 'left', cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.55,
              border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', background: 'var(--surface, transparent)',
              display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 700, fontSize: 13.5 }}>
              {title}
              <span style={{ color: 'var(--c-blue)', fontWeight: 700 }}>→</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>{desc}</span>
          </button>
        );

        if (view === 'home') {
          return (
            <>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Server container</div>
              {containers.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
                  No server container in this GTM account yet.{' '}
                  <button style={{ ...styles.ghostBtn, color: 'var(--c-blue)' }} onClick={() => onOpenCreate?.()}>＋ Create one</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', display: 'block', marginBottom: 3 }}>1 · Server container</span>
                    <select style={{ ...styles.input, maxWidth: 320 }} value={containerId} onChange={(e) => setContainerId(e.target.value)}>
                      <option value="">Select server container…</option>
                      {containers.map((c) => (
                        <option key={c.containerId} value={c.containerId}>{c.name}{c.publicId ? ` (${c.publicId})` : ''}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', display: 'block', marginBottom: 3 }}>Workspace</span>
                    <select style={{ ...styles.input, maxWidth: 220 }} value={workspaceId} disabled={!containerId || !workspaces.length} onChange={(e) => setWorkspaceId(e.target.value)}>
                      {!workspaces.length && <option value="">{containerId ? 'Loading…' : 'Pick a container first'}</option>}
                      {workspaces.map((w) => (
                        <option key={w.workspaceId} value={w.workspaceId}>{w.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {containers.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', marginTop: 2 }}>2 · Pick a service</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
                    {tile('Audit configuration', 'Clients, relays, triggers, variables, CAPI pitfalls - read-only, never touches runtime.', () => setView('audit'), picked)}
                    {tile('Web ↔ Server coverage', `Is every web event handled server-side? Compares against ${webCtx?.containerName ?? 'your web container'}.`, () => setView('coverage'), picked)}
                    {tile('Documentation', 'The full container doc on the page - issues, destinations, request flow - plus MD / CSV / XLSX / PDF download.', () => setView('docs'), picked)}
                    {tile('＋ Create a new server container', 'Build a fresh sGTM container from the web container in the GTM bar (draft-only).', () => onOpenCreate?.(), true)}
                  </div>
                  {!picked && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Pick the server container and workspace above to open a service.</div>}
                </>
              )}
            </>
          );
        }

        if (view === 'audit') {
          return (
            <>
              {backRow('Audit configuration')}
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Read-only configuration audit: does a client claim incoming requests, do tags have triggers and destination ids, duplicate GA4 relays (double-counting), dead URL-encoded triggers, Meta CAPI pitfalls, legacy or duplicate clients, unused variables and broken {'{{references}}'}. It never reads server runtime logs.
              </div>
              <div>
                <button style={styles.primaryBtn} disabled={running} onClick={() => void run()}>
                  {running ? 'Auditing…' : report ? '▶ Re-run audit' : '▶ Run audit'}
                </button>
              </div>
            </>
          );
        }

        if (view === 'coverage') {
          return (
            <>
              {backRow('Web ↔ Server coverage')}
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Compares the WEB container's events against this server container: GA4 events are covered as a group by the GA4 client + relay; CAPI destinations are matched per event. Also checks the two silent killers: the web Google tag not pointing at the tagging server, and a web/server Measurement ID mismatch.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', display: 'block', marginBottom: 3 }}>Web container</span>
                  <select style={{ ...styles.input, maxWidth: 300 }} value={webContainerId} onChange={(e) => setWebContainerId(e.target.value)}>
                    <option value="">Select web container…</option>
                    {allContainers.filter((c) => !(c.usageContext ?? []).some((u) => /server/i.test(u))).map((c) => (
                      <option key={c.containerId} value={c.containerId}>{c.name}{c.publicId ? ` (${c.publicId})` : ''}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', display: 'block', marginBottom: 3 }}>Workspace</span>
                  <select style={{ ...styles.input, maxWidth: 200 }} value={webWorkspaceId} disabled={!webContainerId || !webWorkspaces.length} onChange={(e) => setWebWorkspaceId(e.target.value)}>
                    {!webWorkspaces.length && <option value="">{webContainerId ? 'Loading…' : 'Web container first'}</option>}
                    {webWorkspaces.map((w) => (
                      <option key={w.workspaceId} value={w.workspaceId}>{w.name}</option>
                    ))}
                  </select>
                </label>
                <button style={styles.primaryBtn} disabled={!webContainerId || !webWorkspaceId || covRunning} onClick={() => void runCoverage()}>
                  {covRunning ? 'Comparing…' : coverage ? '▶ Re-compare' : '▶ Compare'}
                </button>
              </div>
            </>
          );
        }

        const docTable = (title: string, head: string[], rows: string[][], emptyNote: string): JSX.Element => (
          <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</div>
            {rows.length ? (
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {head.map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((cell, j) => (
                          <td key={j} style={{ padding: '6px 10px', borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border)', verticalAlign: 'top', lineHeight: 1.45 }}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{emptyNote}</div>
            )}
          </div>
        );
        return (
          <>
            {backRow('Documentation')}
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              The container overview, configuration issues (the audit runs on the same snapshot), destinations, the request flow, and every client / tag / trigger / variable / transformation - shown below and downloadable as a file with the same content. Credentials are never shown or written; the doc describes the workspace draft and states the live version when readable.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {(['md', 'csv', 'xlsx', 'pdf'] as const).map((fmt) => (
                <button key={fmt} style={{ ...styles.primaryBtn }} disabled={docExporting} onClick={() => void exportDoc(fmt)}>
                  ⬇ {fmt.toUpperCase()}
                </button>
              ))}
              {docNote && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{docNote}</span>}
            </div>
            {docLoading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Reading the container configuration…</div>}
            {doc && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 2 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    {doc.meta.containerName}{doc.meta.publicId ? <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> ({doc.meta.publicId})</span> : null}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    {doc.meta.workspaceName ? `Workspace: ${doc.meta.workspaceName} · ` : ''}Generated: {doc.meta.generatedAt} · configuration-level (GTM API, no runtime data)
                  </div>
                  <div>
                    Tagging server URL(s): {doc.overview.taggingServerUrls.length ? <b>{doc.overview.taggingServerUrls.join(', ')}</b> : <span style={{ color: 'var(--c-amber)' }}>(not set - host not wired yet)</span>}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    {doc.overview.counts.clients} client(s) · {doc.overview.counts.tags} tag(s) · {doc.overview.counts.triggers} trigger(s) · {doc.overview.counts.variables} variable(s) · {doc.overview.counts.transformations} transformation(s)
                  </div>
                  {doc.overview.configScore != null && (
                    <div>
                      Configuration score: <b style={{ color: doc.overview.configScore >= 90 ? 'var(--c-green)' : doc.overview.configScore >= 70 ? 'var(--c-amber)' : 'var(--c-red)' }}>{doc.overview.configScore}/100</b>
                      {doc.webLink && <> · coverage {doc.webLink.coveragePct == null ? 'n/a' : `${doc.webLink.coveragePct}%`} · overall <b>{doc.webLink.score.overall}/100</b></>}
                      <span style={{ color: 'var(--text-faint)' }}> (100 - 25 per critical - 10 per high - 3 per medium - 1 per low)</span>
                    </div>
                  )}
                  {doc.meta.liveVersionId && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                      Live (published) version: {doc.meta.liveVersionId}. This page describes the workspace DRAFT, which may differ from what is live.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>Configuration issues</div>
                  {doc.findings.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--c-green)', fontWeight: 600 }}>✓ None found - the configuration audit came back clean.</div>
                  ) : (
                    doc.findings.map((f, i) => (
                      <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
                        <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 10.5, letterSpacing: 0.4, color: SEV[f.severity] ?? 'var(--text-muted)' }}>{f.severity}</span>
                        <span style={{ color: 'var(--text-faint)' }}> {f.where}</span>
                        <div style={{ lineHeight: 1.5, marginTop: 2 }}>{f.message}</div>
                        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}><b>Fix:</b> {f.recommendation}</div>
                      </div>
                    ))
                  )}
                </div>
                {doc.webLink && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>Web link (web container ↔ this server)</div>
                    <div style={{
                      border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5,
                      display: 'flex', flexDirection: 'column', gap: 4,
                      borderColor: doc.webLink.wiring === 'wired' && doc.webLink.idsMatch !== false ? 'var(--c-green-border)' : 'var(--c-amber-border)',
                      background: doc.webLink.wiring === 'wired' && doc.webLink.idsMatch !== false ? 'var(--c-green-bg)' : 'var(--c-amber-bg)',
                    }}>
                      {doc.webLink.lines.map((l, i) => (
                        <div key={i} style={{ lineHeight: 1.5 }}>{l}</div>
                      ))}
                    </div>
                  </div>
                )}
                {docTable('Destinations (where data goes)', ['Destination', 'Tag type(s)', 'Tags', 'Notes'],
                  doc.destinations.map((d) => [d.destination, d.types, String(d.tags), d.paused ? `${d.paused} paused` : '']),
                  'None - no server tag forwards data anywhere yet.')}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>Request flow</div>
                  <pre style={{ margin: 0, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.55, overflowX: 'auto', fontFamily: 'ui-monospace, monospace' }}>{doc.flowLines.join('\n')}</pre>
                </div>
                {doc.versions.length > 0 && docTable('Versions (newest first)', ['Version', 'Name', 'Tags', 'Triggers', 'Variables', 'Notes'],
                  doc.versions.map((v) => [`#${v.versionId}`, v.name, String(v.tags), String(v.triggers), String(v.variables), [v.live ? 'LIVE' : '', v.deleted ? 'deleted' : ''].filter(Boolean).join(' · ')]),
                  '')}
                {docTable('Clients (what claims incoming requests)', ['Client', 'Type'],
                  doc.clients.map((c) => [c.name, c.type]),
                  'None - nothing claims incoming requests, so no server tag can run.')}
                {docTable('Server tags', ['Tag', 'Type', 'Destination', 'Fires on', 'Uses variables', 'Notes'],
                  doc.tags.map((t) => [t.name, t.type, t.destination, t.firesOn, t.vars, t.notes]),
                  'None.')}
                {docTable('Triggers', ['Trigger', 'Type', 'Condition'],
                  doc.triggers.map((tr) => [tr.name, tr.type, tr.condition]),
                  'None.')}
                {docTable('Variables', ['Variable', 'Type', 'Used by'],
                  doc.variables.map((v) => [v.name, v.type, v.usedBy]),
                  'None.')}
                {docTable('Transformations', ['Transformation', 'Type'],
                  doc.transformations.map((x) => [x.name, x.type]),
                  'None configured - events pass through to destinations unmodified.')}
              </div>
            )}
          </>
        );
      })()}
      {view === 'audit' && report && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {report.counts.tags} tag(s) · {report.counts.triggers} trigger(s) · {report.counts.variables} variable(s) · {report.counts.clients ?? 0} client(s) · {report.counts.transformations ?? 0} transformation(s) - <b style={{ color: 'var(--text)' }}>{report.counts.findings} finding(s)</b>
            {report.counts.findings > 0 && <> ({report.summary.critical} critical · {report.summary.high} high · {report.summary.medium} medium · {report.summary.low} low · {report.summary.info} info)</>}
          </div>
          {report.findings.length === 0 && <div style={{ fontSize: 13, color: 'var(--c-green)', fontWeight: 600 }}>✓ No configuration issues found in this server workspace.</div>}
          {report.findings.map((f, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: SEV[f.severity] ?? 'var(--text-muted)' }}>{f.severity}</span>
                {f.resource && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{f.resource.kind}: {f.resource.name}</span>}
                {f.confidence && f.confidence !== 'certain' && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>({f.confidence})</span>}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{f.message}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}><b>Fix:</b> {f.recommendation}</div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Boundary: this audit reads the container CONFIGURATION via the GTM API. Whether the deployed host receives traffic, and what each destination accepted, need runtime checks (Tag verification / vendor Test Events).
          </div>
        </div>
      )}

      {/* ── Coverage results (on the coverage page) ── */}
      {view === 'coverage' && containers.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {coverage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Coverage result</span>
              <span style={{ flex: 1 }} />
              <button style={styles.ghostBtn} disabled={covExporting} onClick={() => void exportCoverage('csv')}>⬇ CSV</button>
              <button style={styles.ghostBtn} disabled={covExporting} onClick={() => void exportCoverage('pdf')}>⬇ PDF</button>
              {covNote && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{covNote}</span>}
            </div>
          )}
          {coverage && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* score strip */}
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
                {[
                  { label: 'Overall', v: `${coverage.score.overall}` },
                  { label: 'Configuration', v: `${coverage.score.configuration}` },
                  { label: 'Coverage', v: coverage.score.coverage == null ? 'n/a' : `${coverage.score.coverage}%` },
                ].map((k) => (
                  <div key={k.label}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)' }}>{k.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{k.v}</div>
                  </div>
                ))}
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {coverage.summary.covered} covered · {coverage.summary.missing} missing{coverage.summary.notMatchable ? ` · ${coverage.summary.notMatchable} not matchable (excluded from %)` : ''}
                </div>
              </div>
              {/* wiring + id warnings */}
              {coverage.webWiring.status === 'not_wired' && (
                <div style={{ fontSize: 12.5, color: 'var(--c-red)', border: '1px solid var(--c-red-border, var(--border))', borderRadius: 8, padding: '8px 12px' }}>
                  ✗ The web Google tag has NO server_container_url - the web container sends nothing to this server container. Point the Google tag at the tagging server (or use the create flow above).
                </div>
              )}
              {coverage.webWiring.status === 'url_mismatch' && (
                <div style={{ fontSize: 12.5, color: 'var(--c-amber)', border: '1px solid var(--c-amber-border, var(--border))', borderRadius: 8, padding: '8px 12px' }}>
                  ⚠ The web Google tag points at {coverage.webWiring.webUrl}, but this server container's tagging URL is {coverage.webWiring.serverUrls.join(', ') || '(unset)'} - different hosts.
                </div>
              )}
              {coverage.ga4.idsMatch === false && (
                <div style={{ fontSize: 12.5, color: 'var(--c-amber)', border: '1px solid var(--c-amber-border, var(--border))', borderRadius: 8, padding: '8px 12px' }}>
                  ⚠ Measurement ID mismatch: web sends {coverage.ga4.webMeasurementIds.join(', ')} but the server relay forwards {coverage.ga4.serverMeasurementIds.join(', ')} - events land in a different property.
                </div>
              )}
              {/* coverage table */}
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {['Event', 'Platform', 'Web tag', 'Server', 'Covered by / fix'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.rows.map((r, i) => (
                      <tr key={i}>
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>{r.event}</td>
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', fontSize: 11 }}>{r.platform}</td>
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{r.webTag}</td>
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', fontWeight: 700, color: r.status === 'covered' ? 'var(--c-green)' : r.status === 'missing' ? 'var(--c-red)' : 'var(--text-faint)' }}>
                          {r.status === 'covered' ? '✓ Covered' : r.status === 'missing' ? '✗ Missing' : '- Not matchable'}
                        </td>
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                          {r.by ?? r.recommendation ?? ''}
                          {r.status === 'missing' && r.template && (
                            <div style={{ marginTop: 4 }}>
                              {(rowCreate[i]?.state ?? 'idle') === 'idle' && (
                                <button style={{ ...styles.ghostBtn, color: 'var(--c-blue)' }} onClick={() => setRowCreate((m) => ({ ...m, [i]: { state: 'confirm' } }))}>
                                  ＋ Create from “{r.template.name}”
                                </button>
                              )}
                              {rowCreate[i]?.state === 'confirm' && (
                                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <span style={{ color: 'var(--c-amber)', fontSize: 12 }}>
                                    Create DRAFT server tag for “{r.event}” cloning “{r.template.name}” (credentials carry over; nothing published)?
                                  </span>
                                  <button style={styles.primaryBtn} onClick={() => void createFromRow(i, r)}>Confirm</button>
                                  <button style={styles.ghostBtn} onClick={() => setRowCreate((m) => ({ ...m, [i]: { state: 'idle' } }))}>Cancel</button>
                                </span>
                              )}
                              {rowCreate[i]?.state === 'creating' && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Creating draft…</span>}
                              {rowCreate[i]?.state === 'done' && <span style={{ fontSize: 12, color: 'var(--c-green)' }}>{rowCreate[i]!.msg}</span>}
                              {rowCreate[i]?.state === 'err' && <span style={{ fontSize: 12, color: 'var(--c-red)' }}>{rowCreate[i]!.msg}</span>}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {coverage.unusedServer.length > 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                  Server tags with no matching web event ({coverage.unusedServer.length}): {coverage.unusedServer.map((u) => `"${u.tag}" (${u.event})`).join(', ')} - server-only by design, or cleanup candidates.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Pick a GA4 property (search across all accessible accounts), choose a data window,
// and run the read-only config + data-quality audit (the same ga4-audit / data-quality
// engines the chat tools use) - coverage + findings by severity. Mirrors ContainerAuditPanel,
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
  // Custom date range (data-quality window) - used instead of `days` when `custom` is on.
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
  const todayIso = new Date().toISOString().slice(0, 10); // cap the pickers - GA4 has no future data

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
            {/* Property picker - a dropdown/combobox: the trigger shows the current selection; opening
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

                {/* Coverage - what was checked + its status (Pass / Partial / Fail / Not Verified). */}
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

/* ───────────────────────── Network & Location ───────────────────────── */

// A short "2m ago" style relative time for the last location check.
function relTimeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
function connTypeLabel(t: NetworkConnectionType): string {
  return t === 'vpn' ? 'VPN' : t === 'proxy' ? 'Proxy' : t === 'local' ? 'Local network' : 'Unknown';
}
function connTypeColor(t: NetworkConnectionType): string {
  return t === 'vpn' ? 'var(--c-green)' : t === 'proxy' ? 'var(--c-amber)' : t === 'local' ? 'var(--c-blue)' : 'var(--text-muted)';
}
// ISO-3166 alpha-2 → regional-indicator flag emoji; falls back to a globe for unknown codes.
function flagEmoji(cc: string | null): string {
  if (!cc || cc.length !== 2 || !/^[a-zA-Z]{2}$/.test(cc)) return '🌐';
  const base = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

/**
 * Shared loader for the current egress location. Loads the cached value on mount; when `refreshKey`
 * changes to a truthy value (e.g. a verify run starting) it forces a fresh check so a mid-session VPN
 * switch is picked up. `refresh()` backs the manual Refresh button.
 */
function useNetworkLocation(refreshKey?: unknown): { loc: NetworkLocationView | null; loading: boolean; refresh: () => Promise<void> } {
  const [loc, setLoc] = useState<NetworkLocationView | null>(null);
  const [loading, setLoading] = useState(true);
  const load = (force: boolean): Promise<void> => {
    setLoading(true);
    const p = force ? window.desktop.network.refreshLocation() : window.desktop.network.getLocation();
    return p.then(setLoc).catch(() => { /* keep previous value */ }).finally(() => setLoading(false));
  };
  useEffect(() => { void load(false); }, []); // initial cached load
  useEffect(() => { if (refreshKey) void load(true); }, [refreshKey]); // force-recheck when a run starts
  useEffect(() => window.desktop.network.onChange(setLoc), []); // live pushes while auto-detect is on
  return { loc, loading, refresh: () => load(true) };
}

// A small theme-aware switch (role=switch) for boolean settings - checkbox semantics, toggle look.
function SettingSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      style={{
        width: 38, height: 20, borderRadius: 999, position: 'relative', padding: 0, flexShrink: 0,
        border: `1px solid ${on ? 'var(--primary)' : 'var(--border-2)'}`,
        background: on ? 'var(--primary)' : 'var(--surface-3)',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        cursor: 'pointer',
      }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 14, height: 14, borderRadius: 999, background: '#fff', transition: 'left 0.15s ease', boxShadow: 'var(--shadow-1)' }} />
    </button>
  );
}

// One labeled row of the Network Status grid.
function NetKv({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <b style={{ textAlign: 'right', fontWeight: 600, ...(mono ? { fontFamily: 'var(--font-mono)', fontWeight: 500 } : {}) }}>{children}</b>
    </div>
  );
}

// The Settings → Network & Location section: a Network Status card (status badge, two-column
// facts grid, Refresh + Run Test) and an Auto Detect card with a switch.
function NetworkLocationCard(): JSX.Element {
  const { loc, loading, refresh } = useNetworkLocation();
  // Auto-detect preference (persisted in the main process). When on, the main process watches for network
  // changes and pushes updates, which the shared hook applies live to this card and the verify banner.
  const [auto, setAuto] = useState(false);
  useEffect(() => { window.desktop.network.getAutoDetect().then(setAuto).catch(() => { /* leave off */ }); }, []);
  const toggleAuto = (v: boolean): void => {
    setAuto(v);
    void window.desktop.network.setAutoDetect(v);
    if (v) void refresh(); // give an immediate reading when auto-detect is switched on
  };
  // "Run Test": timed reachability of the Google endpoints the app's features live on.
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<NetworkTestResultView[] | null>(null);
  const [testError, setTestError] = useState('');
  const runTest = async (): Promise<void> => {
    if (testing) return;
    setTesting(true);
    setTestError('');
    try {
      setTestResults(await window.desktop.network.runTest());
    } catch (e) {
      setTestResults(null);
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };
  const t = loc?.connectionType ?? 'unknown';
  const statusColor = !loc ? 'var(--text-faint)' : loc.status === 'connected' ? 'var(--c-green)' : loc.status === 'offline' ? 'var(--c-amber)' : 'var(--c-red)';
  const badgeBg = t === 'vpn' ? 'var(--c-green-bg)' : t === 'proxy' ? 'var(--c-amber-bg)' : t === 'local' ? 'var(--c-blue-bg)' : 'var(--surface-3)';
  const badgeBorder = t === 'vpn' ? 'var(--c-green-border)' : t === 'proxy' ? 'var(--c-amber-border)' : t === 'local' ? 'var(--c-blue-border)' : 'var(--border-2)';
  const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '-';
  return (
    <>
      <section style={styles.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor, flexShrink: 0 }} aria-hidden />
          <h2 style={{ ...styles.h2, margin: 0 }}>Network Status</h2>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: connTypeColor(t), background: badgeBg, border: `1px solid ${badgeBorder}`, borderRadius: 999, padding: '2px 10px' }}>
            {connTypeLabel(t)}{t === 'vpn' && loc?.provider ? ` · ${loc.provider}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button style={styles.ghostBtn} onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Checking…' : '↻ Refresh'}
          </button>
          <button style={styles.primaryBtnSm ?? styles.primaryBtn} onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Testing…' : 'Run Test'}
          </button>
        </div>
        <p style={styles.settingsSub}>
          Where this app&apos;s outbound traffic comes from - audits, form submissions and click events run from this
          network, so confirm it is the one you intend. Detected via a public IP-geolocation service.
        </p>
        {!loc ? (
          <p style={styles.muted}>{loading ? 'Checking your network location…' : 'Location not checked yet.'}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', columnGap: 28 }}>
            <div>
              <NetKv label="Public IP" mono>{loc.ip ?? '-'}</NetKv>
              <NetKv label="Country">{loc.country ? `${flagEmoji(loc.countryCode)} ${loc.country}` : '-'}</NetKv>
              <NetKv label="Region / State">{loc.region ?? '-'}</NetKv>
              <NetKv label="City">{loc.city ?? '-'}</NetKv>
            </div>
            <div>
              <NetKv label="ISP / network">{loc.org ? `${loc.org}${loc.asn ? ` · ${loc.asn}` : ''}` : '-'}</NetKv>
              <NetKv label="Timezone (system)">{sysTz}</NetKv>
              <NetKv label="VPN">
                <span style={{ color: t === 'vpn' ? 'var(--c-green)' : 'var(--c-green)' }}>
                  {t === 'vpn' ? `Detected${loc.provider ? ` - ${loc.provider}` : ''}` : 'Not detected'}
                </span>
              </NetKv>
              <NetKv label="Proxy">
                <span style={{ color: t === 'proxy' ? 'var(--c-amber)' : 'var(--c-green)' }}>
                  {t === 'proxy' ? 'Detected' : 'Not detected'}
                </span>
              </NetKv>
            </div>
          </div>
        )}
        {loc?.detail && <p style={{ ...styles.settingsSub, color: 'var(--c-amber)', marginTop: 8 }}>{loc.detail}</p>}
        {loc && loc.status === 'connected' && loc.detectedVia.length > 0 && (
          <p style={{ ...styles.settingsSub, marginTop: 8, opacity: 0.8 }}>
            Detected via {loc.detectedVia.join(' + ')}{loc.confidence !== 'none' ? ` (${loc.confidence} confidence)` : ''}.
          </p>
        )}
        {loc && <p style={{ ...styles.settingsSub, marginTop: 4 }}>Last checked {relTimeAgo(loc.checkedAt)}.</p>}
        {testError && <p style={{ ...styles.settingsSub, color: 'var(--c-red)', marginTop: 8 }}>Test failed: {testError}</p>}
        {testResults && (
          <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '4px 12px' }}>
            {testResults.map((r) => (
              <div key={r.host} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                <span style={{ color: r.ok ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 700, flexShrink: 0 }}>{r.ok ? '✓' : '✗'}</span>
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{r.host}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', color: r.ok ? 'var(--text-dim)' : 'var(--c-red)', flexShrink: 0 }}>
                  {r.ok ? `${r.ms} ms` : r.error ?? 'failed'}
                </span>
              </div>
            ))}
            <p style={{ ...styles.settingsSub, margin: '6px 0', border: 'none' }}>
              Reachability of the services this app depends on. Any HTTP response counts - it proves DNS, TLS and the
              network route; it is not a speed test.
            </p>
          </div>
        )}
      </section>
      <section style={styles.card}>
        <h2 style={styles.h2}>Auto Detect</h2>
        <p style={styles.settingsSub}>Continuously monitor VPN and proxy changes.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Enable Auto Detect</div>
            <div style={styles.settingsSub}>
              Automatically re-detect on change: your VPN connecting, disconnecting or switching server updates this
              card and the &quot;Running from&quot; banner live. Polls adapters locally and re-checks the public IP periodically.
            </div>
          </div>
          <SettingSwitch on={auto} onChange={toggleAuto} label="Enable auto detect" />
        </div>
      </section>
    </>
  );
}

// A compact one-line "Running from: …" banner for the audit/verify surface, so the operator can confirm
// the egress before and during a run. Force-rechecks whenever `refreshKey` flips (a run starting).
function NetworkLocationInline({ refreshKey }: { refreshKey?: unknown }): JSX.Element {
  const { loc, loading, refresh } = useNetworkLocation(refreshKey);
  const t = loc?.connectionType ?? 'unknown';
  const place = loc ? [loc.city, loc.country].filter(Boolean).join(', ') || '-' : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', marginTop: 8, marginBottom: 4 }}>
      <span aria-hidden>🌐</span>
      <span style={{ fontWeight: 600, color: 'var(--text-dim)' }}>Running from:</span>
      {loading && !loc ? (
        <span style={{ color: 'var(--text-muted)' }}>checking…</span>
      ) : loc ? (
        <>
          <span>{flagEmoji(loc.countryCode)} {place}</span>
          <span style={{ color: connTypeColor(t), fontWeight: 600 }}>· {connTypeLabel(t)}{loc.provider ? ` (${loc.provider})` : ''}</span>
          {loc.ip && <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>· {loc.ip}</span>}
          {loc.status !== 'connected' && <span style={{ color: 'var(--c-amber)' }}>· {loc.status}</span>}
          <span style={{ color: 'var(--text-faint)' }}>· checked {relTimeAgo(loc.checkedAt)}</span>
        </>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>location unavailable</span>
      )}
      <button
        onClick={() => void refresh()}
        disabled={loading}
        title="Re-check the current network location"
        style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--c-blue)', background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', padding: 0, whiteSpace: 'nowrap' }}
      >
        {loading ? '…' : '↻ refresh'}
      </button>
    </div>
  );
}

/* ─────────────────────────── Settings ─────────────────────────── */

/* Settings is a two-pane layout: a filterable section sub-nav on the left, the selected section's
 * cards on the right. Sections map 1:1 to what the app actually configures. */
const SETTINGS_SECTIONS: Array<{ id: string; title: string; sub: string; keywords: string }> = [
  { id: 'appearance', title: 'Appearance', sub: 'Theme and display', keywords: 'theme dark light mode display colour color' },
  { id: 'google', title: 'Google Sign-In', sub: 'OAuth & scopes', keywords: 'google oauth client id secret scopes sign in authentication' },
  { id: 'accounts', title: 'Accounts', sub: 'Manage accounts', keywords: 'account switch rename remove disconnect connect active google email' },
  { id: 'memory', title: 'Memory', sub: 'What the assistant remembers', keywords: 'memory remember notes facts preferences rules pinned' },
  { id: 'llm', title: 'Language Model', sub: 'AI provider & model', keywords: 'llm model ai provider anthropic openai gemini claude gpt chat' },
  { id: 'providers', title: 'Providers', sub: 'API credentials', keywords: 'api key credential anthropic openai google gemini token' },
  { id: 'network', title: 'Network & Location', sub: 'VPN & proxy', keywords: 'network location vpn proxy ip egress country city adapter' },
  { id: 'diagnostics', title: 'Diagnostics', sub: 'System info', keywords: 'diagnostics dpapi secret store runtime electron chrome node' },
  { id: 'about', title: 'About', sub: 'Version & updates', keywords: 'about version app info platform update' },
];

/** Monochrome line icon per settings section (currentColor, so the nav state sets the colour). */
const SETTINGS_ICON: Record<string, JSX.Element> = {
  appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5" /><path d="M12 19.5V22" /><path d="M2 12h2.5" /><path d="M19.5 12H22" /><path d="M4.9 4.9l1.8 1.8" /><path d="M17.3 17.3l1.8 1.8" /><path d="M19.1 4.9l-1.8 1.8" /><path d="M6.7 17.3l-1.8 1.8" /></>,
  google: <path d="M12 2l8 3v6c0 5-3.4 8-8 10-4.6-2-8-5-8-10V5z" />,
  accounts: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" /><path d="M17.5 13.4a6.5 6.5 0 0 1 4 5.6" /></>,
  llm: <><path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z" /><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z" /></>,
  providers: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L20 3" /><path d="M16 7l3 3" /></>,
  memory: <><path d="M17 3H7a2 2 0 0 0-2 2v16l7-4 7 4V5a2 2 0 0 0-2-2z" /></>,
  network: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14.5 14.5 0 0 1 0 18" /><path d="M12 3a14.5 14.5 0 0 0 0 18" /></>,
  diagnostics: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></>,
};

function SettingsSectionIcon({ id, size = 17 }: { id: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      {SETTINGS_ICON[id] ?? <circle cx="12" cy="12" r="9" />}
    </svg>
  );
}

/** Settings → Memory: the "remember what I told you" notes for the ACTIVE account. Add facts/preferences/
 *  rules the chat then injects into its system prompt each turn. Secrets are stripped in the main process. */
function MemoryCard({ active, onError }: { active: AccountView | undefined; onError: (m: string) => void }): JSX.Element {
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [scopeKind, setScopeKind] = useState<'account' | 'client'>('account');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Phase 3 auto-seed: facts derived from the active container's own config, awaiting the user's OK.
  const [seeds, setSeeds] = useState<SeedCandidate[] | null>(null);
  const [seeding, setSeeding] = useState(false);

  const gtm = active?.gtmContext;
  const ga4 = active?.ga4Context;
  const clientLabel = gtm?.containerId ? (gtm.containerName ?? gtm.containerId) : ga4?.property ? (ga4.propertyName ?? ga4.property) : '';
  const canClientScope = Boolean(gtm?.containerId || ga4?.property);

  function load(): void {
    if (!active?.id) { setItems([]); return; }
    setLoading(true);
    window.desktop.memory.list().then(setItems).catch((e) => onError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active?.id]);
  useEffect(() => { if (!canClientScope) setScopeKind('account'); }, [canClientScope]);

  async function add(): Promise<void> {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setNote('');
    try {
      const scope = scopeKind === 'client'
        ? (gtm?.containerId
            ? { containerId: gtm.containerId, ...(gtm.containerName ? { label: gtm.containerName } : {}) }
            : { property: ga4!.property!, ...(ga4?.propertyName ? { label: ga4.propertyName } : {}) })
        : {};
      const res = await window.desktop.memory.add({ kind, text: t, scope, source: 'manual' });
      setText('');
      setNote(res.redacted ? 'Saved. A secret was detected and removed before storing.' : res.deduped ? 'Already remembered (refreshed).' : 'Saved.');
      load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Read the active container's configuration and propose durable facts from it (no LLM, read-only).
  async function runSeed(): Promise<void> {
    if (seeding) return;
    setSeeding(true); setNote('');
    try { setSeeds(await window.desktop.memory.seed()); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSeeding(false); }
  }
  // Seeded facts describe THIS container, so they are always saved client-scoped. A candidate carrying
  // supersedesId REPLACES that stale auto-seeded note (the container changed since the last seed). Each
  // candidate is dropped from the review list as soon as ITS save lands, so a mid-batch failure never
  // leaves an already-saved item behind to be double-added on retry.
  async function addSeeds(list: SeedCandidate[]): Promise<void> {
    if (busy || !list.length) return;
    setBusy(true);
    let added = 0;
    try {
      const scope = gtm?.containerId ? { containerId: gtm.containerId, ...(gtm.containerName ? { label: gtm.containerName } : {}) } : {};
      for (const c of list) {
        if (c.supersedesId) await window.desktop.memory.remove(c.supersedesId);
        await window.desktop.memory.add({ kind: c.kind, text: c.text, scope, source: 'auto' });
        added += 1;
        setSeeds((s) => (s ? s.filter((x) => x !== c) : s));
      }
      setNote(`Added ${added} fact${added === 1 ? '' : 's'} from the container.`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); load(); }
  }

  async function patch(id: string, p: { pinned?: boolean; enabled?: boolean }): Promise<void> {
    try { await window.desktop.memory.update(id, p); load(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }
  async function del(id: string): Promise<void> {
    try { await window.desktop.memory.remove(id); load(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }

  const badge: React.CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 };
  const iconBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border-2)', borderRadius: 6, padding: '2px 7px', fontSize: 12, cursor: 'pointer', color: 'var(--text-dim)', whiteSpace: 'nowrap' };
  const scopeText = (m: Memory): string =>
    m.scope.containerId ? `container ${m.scope.label ?? m.scope.containerId}`
      : m.scope.property ? `property ${m.scope.label ?? m.scope.property}`
        : 'account-wide';

  return (
    <section style={styles.card}>
      <h2 style={styles.h2}>Memory <span style={{ ...styles.muted, fontSize: 12, fontWeight: 400 }}>({items.length})</span></h2>
      <p style={styles.settingsSub}>
        Notes the assistant remembers about this account and uses in Chat. <b>Rules</b> and <b>preferences</b> steer its behavior; <b>facts</b> are context it verifies against live data. Secrets are stripped automatically and never stored.
      </p>
      {!active ? (
        <p style={styles.muted}>Sign in to an account to save memories.</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Always use snake_case event names · This client's purchase fires on order_completed"
              style={{ ...styles.input, width: '100%', minHeight: 46, resize: 'vertical' }}
              maxLength={500}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} style={{ ...styles.input, padding: '5px 8px' }}>
                {MEMORY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as 'account' | 'client')} style={{ ...styles.input, padding: '5px 8px' }}>
                <option value="account">All of this account</option>
                {canClientScope && <option value="client">Only {clientLabel}</option>}
              </select>
              <button style={{ ...styles.primaryBtn, ...(busy || !text.trim() ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} disabled={busy || !text.trim()} onClick={() => void add()}>Remember</button>
              {gtm?.containerId && (
                <button
                  style={{ ...styles.toggleOff, ...(seeding ? { opacity: 0.6, cursor: 'wait' } : {}) }}
                  disabled={seeding}
                  onClick={() => void runSeed()}
                  title="Read this container's configuration and propose durable facts (Measurement IDs, platforms, consent, ecommerce, naming)"
                >
                  {seeding ? 'Reading container…' : '🌱 Seed from container'}
                </button>
              )}
              {note && <span style={{ ...styles.muted, fontSize: 12 }}>{note}</span>}
            </div>
          </div>

          {/* Auto-seed proposals: derived from the container's own config. Nothing is saved until you add it. */}
          {seeds !== null && (
            seeds.length === 0 ? (
              <div style={{ ...styles.muted, fontSize: 12.5, marginTop: 8 }}>
                Nothing new to seed from this container (everything it tells us is already remembered).{' '}
                <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => setSeeds(null)}>dismiss</button>
              </div>
            ) : (
              <div className="sheet-in" style={{ marginTop: 8, padding: 10, border: '1px solid var(--c-blue-border)', borderRadius: 10, background: 'var(--c-blue-bg)' }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 8 }}>
                  <b>From {clientLabel || 'this container'}.</b> Facts read straight from its configuration. They save scoped to this container.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {seeds.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 9px', border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--surface)' }}>
                      <span style={{ ...badge, flexShrink: 0, marginTop: 1 }}>{c.kind}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                        {c.text}
                        {c.supersedesId ? <span style={{ ...styles.muted, fontSize: 11 }}> · replaces an earlier note</span> : null}
                      </span>
                      <button style={{ ...iconBtn, ...(busy ? { opacity: 0.5 } : {}) }} disabled={busy} onClick={() => void addSeeds([c])}>Add</button>
                      <button style={iconBtn} onClick={() => setSeeds((s) => (s ? s.filter((x) => x !== c) : s))}>Skip</button>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button style={{ ...styles.primaryBtn, padding: '4px 12px', fontSize: 12.5, ...(busy ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }} disabled={busy} onClick={() => void addSeeds(seeds)}>Add all {seeds.length}</button>
                  <button style={{ ...styles.linkBtn, fontSize: 12 }} onClick={() => setSeeds(null)}>Dismiss</button>
                </div>
              </div>
            )
          )}
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loading ? (
              <span style={styles.muted}>Loading…</span>
            ) : items.length === 0 ? (
              <span style={{ ...styles.muted, fontSize: 13 }}>No memories yet. Add one above, or just tell the assistant to remember something.</span>
            ) : items.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', opacity: m.enabled ? 1 : 0.55 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>{m.pinned ? '★ ' : ''}{m.text}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={badge}>{m.kind}</span>
                    <span style={{ ...styles.muted, fontSize: 11 }}>{scopeText(m)}</span>
                    {/* Usage log: how often + how recently this note was injected into a chat. */}
                    {(m.useCount ?? 0) > 0 ? (
                      <span style={{ ...styles.muted, fontSize: 11 }} title={m.lastUsedAt ? `Last used ${new Date(m.lastUsedAt).toLocaleString()}` : undefined}>
                        · used {m.useCount}×{m.lastUsedAt ? ` · last ${new Date(m.lastUsedAt).toLocaleDateString()}` : ''}
                      </span>
                    ) : (
                      /* "no recorded use", NOT "never used" — memories saved before usage tracking existed
                         were injected into chats without being counted, so an absent count is only honest
                         about what was RECORDED. */
                      <span style={{ ...styles.muted, fontSize: 11, opacity: 0.7 }}>· no recorded use</span>
                    )}
                  </div>
                </div>
                <button title={m.pinned ? 'Unpin' : 'Pin (rank first)'} style={iconBtn} onClick={() => void patch(m.id, { pinned: !m.pinned })}>{m.pinned ? '★' : '☆'}</button>
                <button title={m.enabled ? 'Mute (keep but stop using)' : 'Enable'} style={iconBtn} onClick={() => void patch(m.id, { enabled: !m.enabled })}>{m.enabled ? 'On' : 'Muted'}</button>
                <button title="Delete" style={{ ...iconBtn, color: 'var(--c-red)' }} onClick={() => void del(m.id)}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

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
  // never disagree - a key change in one updates the other immediately, and a probe failure surfaces.
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
  // Two-pane navigation state: selected section + the search filter over the section list.
  const [section, setSection] = useState('appearance');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visibleSections = SETTINGS_SECTIONS.filter((s) => !q || `${s.title} ${s.sub} ${s.keywords}`.toLowerCase().includes(q));
  // If the search hides the selected section, show the first match instead (the selection is kept).
  const sec = visibleSections.some((s) => s.id === section) ? section : visibleSections[0]?.id ?? section;
  const current = SETTINGS_SECTIONS.find((s) => s.id === sec) ?? SETTINGS_SECTIONS[0];
  return (
    <div style={styles.settingsWrap}>
      <div style={styles.settingsTopBar}>
        <h1 style={styles.settingsTitle}>Settings</h1>
        <input
          style={styles.settingsSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
        />
      </div>
      <div style={styles.settingsShell}>
        <nav style={styles.settingsNav} aria-label="Settings sections">
          {visibleSections.map((s) => {
            const on = s.id === sec;
            return (
              <button
                key={s.id}
                style={{ ...styles.settingsNavItem, ...(on ? styles.settingsNavItemActive : {}) }}
                onClick={() => setSection(s.id)}
                aria-current={on ? 'true' : undefined}
              >
                <span style={{ ...styles.settingsNavIcon, color: on ? 'var(--c-blue)' : 'var(--text-muted)' }}>
                  <SettingsSectionIcon id={s.id} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={styles.settingsNavTitle}>{s.title}</span>
                  <span style={styles.settingsNavSub}>{s.sub}</span>
                </span>
              </button>
            );
          })}
          {visibleSections.length === 0 && <p style={{ ...styles.muted, padding: '8px 10px' }}>No settings match “{query}”.</p>}
        </nav>

        <div style={styles.settingsBody}>
          <div style={styles.settingsBodyCol}>
            <header style={styles.settingsHeader}>
              <span style={{ display: 'inline-flex', color: 'var(--text-muted)' }}><SettingsSectionIcon id={current.id} size={20} /></span>
              <div>
                <h2 style={styles.settingsHeaderTitle}>{current.title}</h2>
                <div style={styles.settingsHeaderSub}>{current.sub}</div>
              </div>
            </header>

      {sec === 'appearance' && (
      <section style={styles.card}>
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
      )}

      {sec === 'network' && <NetworkLocationCard />}

      {sec === 'memory' && <MemoryCard active={active} onError={onError} />}

      {sec === 'google' && (
      <section style={styles.card}>
        <h2 style={styles.h2}>OAuth client</h2>
        <OAuthClientCard google={google} />
        <div style={{ height: 1, background: 'var(--border-2)', margin: '18px 0' }} />
        <h2 style={styles.h2}>Scopes</h2>
        <GrantedScopesCard onError={onError} />
      </section>
      )}

      {/* Accounts - the full switcher + management. Switch the active account, rename it, disconnect
          its Google token, remove it, or connect a new one. */}
      {sec === 'accounts' && (<>
      <section style={styles.card}>
        <p style={styles.settingsSub}>Switch which Google account is active, rename it, or connect another. The active account is used across GTM Tools, GA4 Tools and Chat.</p>
        <div style={styles.acctRows}>
          {accounts.length === 0 && <p style={styles.muted}>No accounts yet. Connect one below.</p>}
          {accounts.map((a) => (
            <div key={a.id} style={{ ...styles.acctRow, ...(a.isActive ? styles.acctRowActive : {}) }}>
              <span style={{ ...styles.dot, marginTop: 6, background: a.hasGoogleToken ? 'var(--c-green)' : 'var(--text-faint)' }} />
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
                <span style={styles.acctIdentity}>
                  <span style={styles.acctRowName} title={a.displayName || a.email}>{a.displayName || a.email}</span>
                  {a.displayName ? <span style={styles.acctRowEmail} title={a.email}>{a.email}</span> : null}
                </span>
              )}
              <div style={styles.acctRowActions}>
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
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          {connecting ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...styles.connectDashed, flex: 1 }} disabled>Signing in…</button>
              <button style={styles.cancelBtn} onClick={cancelConnect} title="Cancel sign-in">Cancel</button>
            </div>
          ) : (
            <button style={styles.connectDashed} onClick={connect} disabled={!google?.configured} title={google?.configured ? 'Connect another Google account' : 'Set the OAuth client first (Google Sign-In section)'}>
              + Connect another account
            </button>
          )}
          {google && !google.configured && <p style={{ ...styles.settingsSub, color: 'var(--c-amber)', marginTop: 8 }}>Set the OAuth client (Google Sign-In section) before connecting an account.</p>}
        </div>
      </section>

      {active && (
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
      )}
      </>)}

      {sec === 'llm' && (active ? (
        <section style={styles.card}>
          <p style={styles.settingsSub}>The model this account uses for chat. Pick a preset or choose Custom to enter any model id.</p>
          {/* key by account id so switching accounts re-reads the newly active account's saved config. */}
          <LlmEditor key={active.id} account={active} provStatus={provStatus} onChange={refresh} onError={onError} />
        </section>
      ) : (
        <section style={styles.card}>
          <p style={styles.muted}>Connect a Google account first (Accounts section) to configure its model.</p>
        </section>
      ))}

      {sec === 'providers' && (
      <section style={styles.card}>
        <p style={styles.settingsSub}>App-level API keys, shared by every account that picks the provider.</p>
        <ProvidersEditor status={provStatus} onStatus={setProvStatus} onChange={refresh} onError={onError} />
        <div style={{ height: 1, background: 'var(--border-2)', margin: '18px 0' }} />
        <GoogleAdsCard onError={onError} />
      </section>
      )}

      {sec === 'diagnostics' && (
      <section style={styles.card}>
        {selfTest && (
          <div style={styles.kv}>
            <span>Secret store (DPAPI)</span>
            <b style={{ color: selfTest.ok ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 500 }}>
              {selfTest.ok ? '✓ working' : `✗ ${selfTest.detail}`}
            </b>
          </div>
        )}
        {info && (
          <div style={{ ...styles.kv, borderBottom: 'none' }}>
            <span>Runtime</span>
            <b style={{ fontWeight: 500, color: 'var(--text-dim)', textAlign: 'right' }}>
              Electron {info.electron} · Chrome {info.chrome} · Node {info.node} · {info.platform}
            </b>
          </div>
        )}
      </section>
      )}

      {sec === 'about' && (
      <section style={styles.card}>
        <div style={styles.kv}><span>App</span><b>{info?.name ?? 'Samarth Desktop'}</b></div>
        <div style={styles.kv}><span>Version</span><b>v{info?.version ?? '0.0.0'}</b></div>
        <div style={{ ...styles.kv, borderBottom: 'none' }}>
          <span>Platform</span>
          <b style={{ fontWeight: 500, color: 'var(--text-dim)' }}>{info?.platform ?? 'unknown'}</b>
        </div>
      </section>
      )}
          </div>
        </div>
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
  /** Shared app-level key status (single source of truth from SettingsView) - null until loaded. */
  provStatus: ProviderStatus | null;
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const initialProvider = account.llm?.provider ?? 'openai';
  const initialModel = account.llm?.model ?? DEFAULT_MODEL[initialProvider];
  const [provider, setProvider] = useState<LlmProvider>(initialProvider);
  const [model, setModel] = useState(initialModel);
  // Custom-vs-preset is STICKY state, not derived - so typing a custom id that transiently equals a preset
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

/**
 * Pick a Google Ads conversion action (or create one) and hand back its real Conversion ID and Label.
 *
 * Three steps, collapsed into one panel so the whole thing is a few clicks: account, then action, then
 * the values land in the row. Reuse is the default path and "Create new" is secondary, deliberately:
 * creating a conversion action is a REAL, immediately live write to the advertiser's Google Ads account
 * with no draft stage, unlike the GTM half which only ever touches a draft workspace.
 */
function AdsPicker({
  gtmTarget,
  onPick,
  onClose,
  onError,
}: {
  gtmTarget: { accountId?: string; containerId?: string; workspaceId?: string };
  onPick: (v: { conversionId: string; conversionLabel: string }) => void;
  onClose: () => void;
  onError: (m: string) => void;
}): JSX.Element {
  const [accounts, setAccounts] = useState<AdsAccountView[] | null>(null);
  const [account, setAccount] = useState<AdsAccountView | null>(null);
  const [actions, setActions] = useState<AdsConversionActionView[] | null>(null);
  const [crossAccountFrom, setCrossAccountFrom] = useState<string | undefined>();
  const [pairing, setPairing] = useState<AdsPairingView | null>(null);
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState<'reuse' | 'create'>('reuse');
  const [categories, setCategories] = useState<AdsCategoryOption[]>([]);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('SUBMIT_LEAD_FORM');
  const [createErr, setCreateErr] = useState('');
  const [confirmCreate, setConfirmCreate] = useState(false);

  const [blocked, setBlocked] = useState<AdsReadiness | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy('Loading Google Ads accounts…');
    setBlocked(null);
    try {
      // Preflight. Both preconditions fail as a 403 at call time, and a missing scope is NOT
      // invalid_grant, so without this the user would just see a raw error with no way forward.
      const ready = await window.desktop.ads.status();
      if (!ready.ready) { setBlocked(ready); setAccounts([]); return; }
      setAccounts(await window.desktop.ads.listAccounts());
      setCategories(await window.desktop.ads.categories());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setAccounts([]);
    } finally { setBusy(''); }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  /** Upgrade an account that signed in before adwords joined the default scope set. A token's scopes are
   *  fixed at grant time, so this is a fresh authorization; it requests the UNION, so the existing Tag
   *  Manager and Analytics grants survive. Offered right here rather than in Settings, because this is
   *  where the user actually hit the wall. */
  async function reconnect(): Promise<void> {
    setReconnecting(true);
    try {
      await window.desktop.google.connectAds();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally { setReconnecting(false); }
  }

  async function chooseAccount(a: AdsAccountView): Promise<void> {
    setAccount(a);
    setActions(null);
    setPairing(null);
    setBusy(`Loading conversion actions for ${a.name}…`);
    try {
      const res = await window.desktop.ads.listConversionActions(a.id, a.loginCustomerId);
      setActions(res.actions);
      setCrossAccountFrom(res.crossAccountFrom);
      // Advisory pairing check against the container the tag is actually going into. Uses the first
      // taggable action's id as the account's representative conversion id.
      const rep = res.actions.find((x) => x.taggable && x.conversionId)?.conversionId ?? null;
      if (gtmTarget.accountId && gtmTarget.containerId && gtmTarget.workspaceId) {
        setPairing(await window.desktop.ads.checkPairing(gtmTarget.accountId, gtmTarget.containerId, gtmTarget.workspaceId, rep, a.name));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setActions([]);
    } finally { setBusy(''); }
  }

  function pick(a: AdsConversionActionView): void {
    if (!a.conversionId || !a.conversionLabel) return;
    onPick({ conversionId: a.conversionId, conversionLabel: a.conversionLabel });
    onClose();
  }

  /** Dry run first (validateOnly), so a duplicate name is caught before anything is written. */
  async function validateThenConfirm(): Promise<void> {
    if (!account) return;
    setCreateErr('');
    setBusy('Checking…');
    try {
      const problem = await window.desktop.ads.validateConversionAction(account.id, { name: newName.trim(), category: newCategory }, account.loginCustomerId);
      if (problem) { setCreateErr(problem); return; }
      setConfirmCreate(true);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  }

  async function doCreate(): Promise<void> {
    if (!account) return;
    setBusy('Creating in Google Ads…');
    setCreateErr('');
    try {
      const made = await window.desktop.ads.createConversionAction(account.id, { name: newName.trim(), category: newCategory }, account.loginCustomerId);
      if (made.conversionId && made.conversionLabel) {
        onPick({ conversionId: made.conversionId, conversionLabel: made.conversionLabel });
        onClose();
      } else {
        setCreateErr(made.note ?? 'Created, but Google Ads has not returned its tag snippet yet. Reopen this picker in a moment and select it.');
        setConfirmCreate(false);
      }
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
      setConfirmCreate(false);
    } finally { setBusy(''); }
  }

  const usable = (actions ?? []).filter((a) => a.taggable && a.conversionId && a.conversionLabel);
  const unusable = (actions ?? []).filter((a) => !a.taggable || !a.conversionId || !a.conversionLabel);
  const pairTone = pairing?.verdict === 'mismatch' ? 'var(--c-amber)' : pairing?.verdict === 'match' ? 'var(--c-green)' : 'var(--text-muted)';

  return (
    <div style={adsStyles.overlay} onClick={onClose}>
      <div style={adsStyles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={adsStyles.head}>
          <div>
            <div style={{ fontWeight: 600 }}>Google Ads conversion</div>
            <div style={{ ...styles.muted, marginTop: 2 }}>
              {account ? `${account.name} · ${account.id}` : 'Pick the account this site advertises under.'}
            </div>
          </div>
          <button style={styles.ghostBtn} onClick={onClose}>Close</button>
        </div>

        {busy && <div style={{ ...styles.muted, padding: '8px 0' }}>{busy}</div>}

        {/* Blocked: fix it HERE rather than sending the user to Settings to hunt for it. */}
        {blocked && (
          <div style={styles.warn}>
            <div>{blocked.message} {blocked.reason === 'token' ? blocked.remedy : ''}</div>
            {blocked.reason === 'scope' && (
              <div style={{ marginTop: 8 }}>
                <button style={styles.primaryBtn} onClick={() => void reconnect()} disabled={reconnecting}>
                  {reconnecting ? 'Opening browser…' : 'Grant Google Ads access'}
                </button>
                <div style={{ ...styles.muted, marginTop: 6 }}>
                  This account signed in before Google Ads was part of the app, so its sign-in has to be
                  repeated once. Your Tag Manager and Analytics access is carried forward, not replaced.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 1: account */}
        {!account && !blocked && accounts && (
          accounts.length === 0 ? (
            <div style={styles.muted}>No Google Ads accounts are reachable from this Google account.</div>
          ) : (
            <div style={adsStyles.list}>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  style={{ ...adsStyles.row, opacity: a.manager || a.testAccount ? 0.6 : 1, cursor: a.manager ? 'default' : 'pointer' }}
                  disabled={a.manager}
                  onClick={() => void chooseAccount(a)}
                  title={a.manager ? 'Manager accounts do not hold conversion actions' : `Use ${a.name}`}
                >
                  <span style={{ paddingLeft: a.level > 0 ? 14 : 0 }}>
                    {a.name}
                    {a.manager && <span style={adsStyles.chip}>manager</span>}
                    {a.testAccount && <span style={adsStyles.chip}>test</span>}
                  </span>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{a.id}</span>
                </button>
              ))}
            </div>
          )
        )}

        {/* Steps 2 and 3: reuse or create */}
        {account && (
          <>
            {pairing && pairing.message && (
              <div style={{ ...styles.muted, color: pairTone, margin: '6px 0 10px' }}>
                {pairing.verdict === 'mismatch' ? '⚠ ' : pairing.verdict === 'match' ? '✓ ' : ''}{pairing.message}
              </div>
            )}
            {crossAccountFrom && (
              <div style={{ ...styles.muted, color: 'var(--c-amber)', marginBottom: 8 }}>
                Conversions for this account are managed by manager {crossAccountFrom} (cross-account conversion tracking).
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, margin: '4px 0 10px' }}>
              <button style={mode === 'reuse' ? styles.toggleOn : styles.toggleOff} onClick={() => setMode('reuse')}>
                Use an existing action ({usable.length})
              </button>
              <button style={mode === 'create' ? styles.toggleOn : styles.toggleOff} onClick={() => setMode('create')}>
                Create a new one
              </button>
              <button style={styles.ghostBtn} onClick={() => { setAccount(null); setActions(null); setPairing(null); }}>
                ← Change account
              </button>
            </div>

            {mode === 'reuse' && actions && (
              usable.length === 0 ? (
                <div style={styles.muted}>
                  This account has no conversion action that can drive a GTM tag. Create one, or paste the values by hand.
                </div>
              ) : (
                <div style={adsStyles.list}>
                  {usable.map((a) => (
                    <button key={a.resourceName} style={{ ...adsStyles.row, cursor: 'pointer' }} onClick={() => pick(a)}>
                      <span>
                        {a.name}
                        <span style={adsStyles.chip}>{a.category.replace(/_/g, ' ').toLowerCase()}</span>
                        {a.status !== 'ENABLED' && <span style={adsStyles.chip}>{a.status.toLowerCase()}</span>}
                      </span>
                      <code style={{ ...mdStyles.code, fontSize: 11 }}>{a.conversionId}/{a.conversionLabel}</code>
                    </button>
                  ))}
                  {unusable.length > 0 && (
                    <div style={{ ...styles.muted, marginTop: 8 }}>
                      {unusable.length} other action(s) cannot drive a GTM tag (no web snippet: upload, app, store visit, or Analytics-imported).
                    </div>
                  )}
                </div>
              )
            )}

            {mode === 'create' && !confirmCreate && (
              <div>
                <div style={styles.formRow}>
                  <input style={styles.input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Conversion action name (e.g. Contact Form Submit)" />
                  <select style={styles.select} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                    {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <button style={styles.primaryBtn} onClick={() => void validateThenConfirm()} disabled={busy !== '' || newName.trim() === ''}>
                    Continue
                  </button>
                </div>
                <p style={styles.muted}>
                  Counting defaults to {categories.find((c) => c.value === newCategory)?.counting === 'ONE_PER_CLICK' ? 'one per click (right for leads)' : 'many per click (right for purchases)'}.
                  Google assigns the Conversion Label; it cannot be chosen.
                </p>
                {createErr && <div style={{ ...styles.muted, color: 'var(--c-red)' }}>{createErr}</div>}
              </div>
            )}

            {mode === 'create' && confirmCreate && (
              <div style={styles.confirm}>
                <div style={styles.confirmHead}>Create this conversion action in Google Ads?</div>
                <div style={{ ...styles.muted, margin: '6px 0', color: 'var(--c-amber)' }}>
                  “{newName.trim()}” in <b>{account.name}</b>. This writes to the live Google Ads account
                  immediately. There is no draft stage and it will be visible to anyone using that account.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={styles.primaryBtn} onClick={() => void doCreate()} disabled={busy !== ''}>
                    {busy ? 'Creating…' : 'Create it'}
                  </button>
                  <button style={styles.ghostBtn} onClick={() => setConfirmCreate(false)} disabled={busy !== ''}>Cancel</button>
                </div>
                {createErr && <div style={{ ...styles.muted, color: 'var(--c-red)' }}>{createErr}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const adsStyles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 24 },
  panel: { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-l)', boxShadow: 'var(--shadow-3)', width: 'min(760px, 100%)', maxHeight: '80vh', overflow: 'auto', padding: 18 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 13, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-s)' },
  chip: { marginLeft: 6, padding: '1px 6px', fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999 },
};

/** Google Ads setup: the app-level developer token, the per-account adwords consent, and a live
 *  connection test. The two preconditions fail in DIFFERENT ways and need different remedies, so they
 *  are reported separately rather than as one "not working" state: the token belongs to the operator's
 *  Ads MANAGER account and is shared by every signed-in identity, while the scope is granted per Google
 *  account and needs a re-consent. */
function GoogleAdsCard({ onError }: { onError: (m: string) => void }): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [readiness, setReadiness] = useState<AdsReadiness | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'connecting' | 'testing'>('');
  const [result, setResult] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHasToken(await window.desktop.ads.hasDeveloperToken());
      setReadiness(await window.desktop.ads.status());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(): Promise<void> {
    setBusy('saving');
    setResult('');
    try {
      await window.desktop.ads.setDeveloperToken(token);
      setToken('');
      await refresh();
      setResult('Token saved.');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  }

  async function clear(): Promise<void> {
    try {
      await window.desktop.ads.clearDeveloperToken();
      setResult('');
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  /** A REAL call, not a stored flag: listing accounts is the first request that actually exercises the
   *  developer token against production, which is the only way to catch a Test-level token (the account
   *  list call itself succeeds with one, every follow-up fails). */
  async function test(): Promise<void> {
    setBusy('testing');
    setResult('');
    try {
      const accounts = await window.desktop.ads.listAccounts();
      const managers = accounts.filter((a) => a.manager).length;
      setResult(
        accounts.length === 0
          ? 'Connected, but this Google account can reach no Google Ads accounts.'
          : `✓ ${accounts.length} account(s) reachable${managers ? ` (${managers} manager)` : ''}: ${accounts.slice(0, 3).map((a) => a.name).join(', ')}${accounts.length > 3 ? ', …' : ''}`,
      );
    } catch (e) {
      setResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(''); }
  }

  const scopeMissing = readiness?.ready === false && readiness.reason === 'scope';

  return (
    <div>
      <p style={{ ...styles.settingsSub, marginTop: 0 }}>
        Google Ads: fetch a real Conversion ID and Label instead of copying them by hand.
      </p>
      <div style={styles.formRow}>
        <span style={{ width: 90, fontSize: 13, alignSelf: 'center' }}>
          Dev token {hasToken ? '✓' : ''}
        </span>
        <input
          style={styles.input}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? 'token saved (enter to replace)' : 'developer token from the Ads API Center'}
        />
        <button style={styles.ghostBtn} onClick={save} disabled={busy !== '' || token.trim() === ''}>
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {hasToken && <button style={styles.dangerGhost} onClick={clear} disabled={busy !== ''}>Clear</button>}
      </div>
      <p style={styles.muted}>
        Issued from a Google Ads <b>manager (MCC)</b> account under Tools and Settings, API Center. A standard
        Ads account cannot issue one. Shared by every signed-in Google account; stored encrypted (DPAPI).
      </p>

      <div style={{ ...styles.formRow, marginTop: 10 }}>
        <button style={styles.ghostBtn} onClick={test} disabled={busy !== '' || !hasToken}>
          {busy === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
      </div>

      {readiness && !readiness.ready && (
        <div style={{ ...styles.muted, color: 'var(--c-amber)' }}>
          {scopeMissing
            ? 'This account has not granted Google Ads access. Grant it under Google Sign-In.'
            : `${readiness.message} ${readiness.remedy ?? ''}`}
        </div>
      )}
      {readiness?.ready && !result && (
        <div style={{ ...styles.muted, color: 'var(--c-green)' }}>✓ Token and Google Ads access are both in place.</div>
      )}
      {result && (
        <div style={{ ...styles.muted, color: result.startsWith('✗') ? 'var(--c-red)' : 'var(--c-green)' }}>{result}</div>
      )}
      <p style={styles.muted}>
        Google Ads access itself comes from the normal Google sign-in, not from here. See Google Sign-In
        for what the active account has granted.
      </p>
    </div>
  );
}

/** What the ACTIVE account's Google sign-in actually authorizes, and the one action that can widen it.
 *
 *  This lives under "OAuth and scopes" rather than with the developer token in Providers, because it is
 *  a property of the SIGN-IN, not an API credential. Tag Manager, Analytics and Google Ads all come from
 *  one sign-in; there is no separate Google Ads login.
 *
 *  The button appears ONLY when the scope is genuinely missing, which happens for an account connected
 *  before adwords joined the default scope set: a token's scopes are fixed when it is granted, so such an
 *  account needs exactly one repeat sign-in. Showing it unconditionally invited a pointless re-consent. */
function GrantedScopesCard({ onError }: { onError: (m: string) => void }): JSX.Element {
  const [readiness, setReadiness] = useState<AdsReadiness | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setReadiness(await window.desktop.ads.status());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function grant(): Promise<void> {
    setBusy(true);
    try {
      await window.desktop.google.connectAds();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  // 'token' means the developer token is missing, which is a Providers concern, not a sign-in one: the
  // sign-in itself is fine, so report the scope as granted and point at the right place.
  const scopeMissing = readiness?.ready === false && readiness.reason === 'scope';

  return (
    <div>
      <p style={styles.muted}>One Google sign-in covers all three. There is no separate Google Ads login.</p>
      <div style={styles.kv}><span>Tag Manager</span><b style={{ color: 'var(--c-green)', fontWeight: 500 }}>✓ granted</b></div>
      <div style={styles.kv}><span>Analytics (GA4)</span><b style={{ color: 'var(--c-green)', fontWeight: 500 }}>✓ granted</b></div>
      <div style={styles.kv}>
        <span>Google Ads</span>
        <b style={{ color: scopeMissing ? 'var(--c-amber)' : 'var(--c-green)', fontWeight: 500 }}>
          {readiness === null ? 'checking…' : scopeMissing ? 'not granted' : '✓ granted'}
        </b>
      </div>
      {scopeMissing && (
        <div style={{ marginTop: 10 }}>
          <button style={styles.primaryBtn} onClick={() => void grant()} disabled={busy}>
            {busy ? 'Opening browser…' : 'Grant Google Ads access'}
          </button>
          <p style={styles.muted}>
            This account signed in before Google Ads was part of the app. A token's permissions are fixed
            when it is granted and cannot be widened in place, so its sign-in has to be repeated once. Tag
            Manager and Analytics access is carried forward, not replaced.
          </p>
        </div>
      )}
      <p style={styles.muted}>
        The container-publish scope is never requested: this app writes to draft workspaces only, and you
        publish in GTM yourself.
      </p>
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
  // The client id itself is intentionally not shown. When its shape looks off we still warn - without
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
    fontFamily: 'var(--font-sans)',
    color: 'var(--text)',
    background: 'var(--bg)',
  },
  // Compact icon rail: logo on top, icon+label nav, Settings + avatar pinned to the bottom.
  sidebar: {
    width: 68,
    flexShrink: 0,
    background: 'var(--surface)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '14px 8px 10px',
    boxSizing: 'border-box',
  },
  railLogo: { width: 36, height: 36, borderRadius: 10, background: 'var(--primary)', color: 'var(--on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, marginBottom: 14, flexShrink: 0, cursor: 'default', userSelect: 'none' },
  railNav: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' },
  railItem: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: '100%', padding: '8px 2px 7px', background: 'transparent', border: 'none', borderRadius: 10, color: 'var(--text-muted)', cursor: 'pointer' },
  railItemActive: { background: 'var(--surface-3)', color: 'var(--c-blue)' },
  railActiveBar: { position: 'absolute', left: 0, top: '24%', bottom: '24%', width: 3, borderRadius: 999, background: 'var(--primary)' },
  railBadge: { position: 'absolute', top: 6, right: 10, width: 7, height: 7, borderRadius: 999, background: 'var(--c-amber)' },
  railLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.2, lineHeight: 1 },
  railAvatar: { position: 'relative', width: 34, height: 34, borderRadius: 999, background: 'var(--surface-3)', border: '1px solid var(--border-2)', color: 'var(--text)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginTop: 8, flexShrink: 0 },
  railAvatarDot: { position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: 999, border: '2px solid var(--surface)', boxSizing: 'content-box' },
  sideMuted: { color: 'var(--text-faint)', fontSize: 13, padding: '6px 4px' },
  // Settings → Accounts list rows.
  acctRows: { display: 'flex', flexDirection: 'column', gap: 6 },
  acctRow: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', flexWrap: 'wrap' },
  acctRowActive: { borderColor: 'var(--c-green-border)', background: 'var(--c-green-bg)' },
  acctIdentity: { flex: 1, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden', paddingTop: 1 },
  acctRowName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)', fontWeight: 500, lineHeight: 1.35 },
  acctRowEmail: { color: 'var(--text-muted)', fontWeight: 400, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  acctRowActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 1 },
  acctActiveBadge: { fontSize: 11, fontWeight: 600, color: 'var(--c-green)', background: 'var(--surface)', border: '1px solid var(--c-green-border)', borderRadius: 20, padding: '2px 10px' },
  acctRowBtn: { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  acctRowBtnDanger: { background: 'transparent', color: 'var(--c-red)', border: '1px solid var(--c-red-border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  acctRenameInput: { flex: 1, minWidth: 0, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '3px 7px', fontSize: 13, fontFamily: 'inherit' },
  connectRow: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'stretch' },
  cancelBtn: { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer' },
  sideWarn: { color: 'var(--c-amber)', fontSize: 11, marginTop: 8 },
  sideVersion: { color: 'var(--text-faint)', fontSize: 10, marginTop: 8, userSelect: 'none' },

  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  gtmWorkspace: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  subTabs: { display: 'flex', gap: 8, padding: '10px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' },
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
  promptUse: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
  promptCopy: { background: 'transparent', color: 'var(--c-blue)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' },
  errorBar: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '10px 52px 10px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  errorClose: { background: 'transparent', border: 'none', color: 'var(--c-red)', cursor: 'pointer' },
  monitorBarCrit: { background: 'var(--c-red-bg)', borderBottom: '1px solid var(--c-red-border)', color: 'var(--c-red)', padding: '9px 52px 9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarWarn: { background: 'var(--c-amber-bg)', borderBottom: '1px solid var(--c-amber-border)', color: 'var(--c-amber)', padding: '9px 52px 9px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  monitorBarBtn: { background: 'transparent', border: '1px solid currentColor', color: 'inherit', borderRadius: 7, padding: '3px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },

  chatWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  chatHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' },
  // Segmented control (chat GTM/GA4 switch + Settings theme): inner padding + gap so the active
  // option reads as a distinct blue pill inside the track - the selected side is unmistakable.
  toggle: { display: 'inline-flex', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 9, overflow: 'hidden', padding: 2, gap: 2 },
  toggleBtn: { background: 'transparent', color: 'var(--text-dim)', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 7 },
  toggleActive: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', padding: '6px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', borderRadius: 7, boxShadow: '0 1px 3px var(--ring)' },
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
  ctxUseBtn: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  ctxUseBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  chatLog: { flex: 1, overflowY: 'auto', padding: 20 },
  // The conversation reads as a centered document column (like a report), not edge-to-edge bubbles.
  chatColumn: { width: '100%', maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 },
  // Tool-call trace above an assistant reply — which MCP tools ran for this answer, mono like a log line.
  toolTrace: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  toolChip: { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '3px 9px', fontSize: 11.5, fontFamily: 'ui-monospace, monospace', color: 'var(--text-dim)' },
  toolChipFail: { background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)', color: 'var(--c-red)' },
  empty: { color: 'var(--text-faint)', textAlign: 'center', maxWidth: 420, margin: '60px auto', lineHeight: 1.6, flexShrink: 0 },
  userMsg: { alignSelf: 'flex-end', background: 'var(--primary)', color: 'var(--on-primary)', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14 },
  asstMsg: { alignSelf: 'flex-start', background: 'var(--surface-2)', color: 'var(--text)', padding: '10px 14px', borderRadius: 14, maxWidth: '75%', fontSize: 14, border: '1px solid var(--border)' },
  msgTime: { fontSize: 10.5, color: 'var(--text-faint)', margin: '3px 4px 0', userSelect: 'none', fontFamily: 'ui-monospace, monospace', letterSpacing: 0.3 },
  toolErrors: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  toolErrorLine: { background: 'var(--c-red-bg)', border: '1px solid var(--c-red-border)', color: 'var(--c-red)', borderRadius: 8, padding: '6px 9px', fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' },
  // Provider rate-limit / overload retry notice: a WAIT, not a failure, so it uses the amber tokens.
  retryLine: { marginTop: 6, background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)', borderRadius: 8, padding: '6px 9px', fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word' },
  composer: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px 10px', borderTop: '1px solid var(--border)', position: 'relative' },
  // The input is a single rounded shell (textarea + icon send button inside); the focus ring lives on
  // the shell via .composer-shell:focus-within in global.css since the textarea itself is borderless.
  composerShell: { display: 'flex', alignItems: 'flex-end', gap: 8, width: '100%', maxWidth: 880, margin: '0 auto', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 14, padding: '6px 6px 6px 8px', boxSizing: 'border-box', transition: 'border-color 0.15s ease, box-shadow 0.15s ease' },
  composerHints: { width: '100%', maxWidth: 880, margin: '0 auto', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, color: 'var(--text-faint)', padding: '0 4px', boxSizing: 'border-box' },
  hintKey: { color: 'var(--text-muted)', fontWeight: 600 },
  // Slash-command autocomplete menu — floats above the composer.
  // Centered over the input shell (left/right 0 + margin auto — no transform, which would fight the
  // .sheet-in entrance animation's keyframed transform).
  slashMenu: { position: 'absolute', bottom: 'calc(100% - 6px)', left: 0, right: 0, margin: '0 auto', width: 'min(880px, calc(100% - 32px))', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 6, zIndex: 30, maxHeight: 300, overflowY: 'auto' },
  slashMenuHead: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-faint)', padding: '4px 8px 6px' },
  slashItem: { display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', color: 'var(--text)' },
  slashItemActive: { background: 'var(--c-blue-bg)' },
  slashName: { fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: 'ui-monospace, monospace' },
  slashHint: { color: 'var(--text-faint)', fontWeight: 400, fontSize: 12 },
  slashDesc: { fontSize: 12, color: 'var(--text-muted)' },
  slashMenuFoot: { fontSize: 10.5, color: 'var(--text-faint)', padding: '6px 8px 3px', borderTop: '1px solid var(--border)', marginTop: 4 },
  composerInput: {
    flex: 1,
    background: 'transparent',
    color: 'var(--text)',
    border: 'none',
    outline: 'none',
    padding: '8px 0',
    fontSize: 14,
    fontFamily: 'inherit',
    lineHeight: 1.45,
    resize: 'none',
    overflowY: 'auto',
    maxHeight: 160,
    boxSizing: 'border-box',
  },
  sendBtn: { width: 36, height: 36, background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 10, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  // Dimmed (but still themed blue) when there's nothing to send yet or the account isn't ready.
  sendBtnIdle: { opacity: 0.45 },
  stopBtn: { width: 36, height: 36, background: 'var(--danger)', color: 'var(--on-danger)', border: 'none', borderRadius: 10, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  // The paperclip lives INSIDE the composer shell (borderless icon button matching the send button's size).
  attachBtn: { background: 'transparent', color: 'var(--text-muted)', border: 'none', borderRadius: 8, width: 32, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0 },
  attachChip: { position: 'absolute', bottom: 'calc(100% + 6px)', left: 16, display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: 440, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 999, padding: '5px 8px 5px 12px', fontSize: 12.5, color: 'var(--text-dim)', boxShadow: 'var(--shadow-2)', zIndex: 25 },
  attachRemove: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
  msgAttach: { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.16)', borderRadius: 8, padding: '3px 9px', fontSize: 12, marginBottom: 6, maxWidth: '100%' },
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

  // Settings: title + search top bar over a two-pane shell (section sub-nav | section cards).
  settingsWrap: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  settingsTopBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 20px', borderBottom: '1px solid var(--border)' },
  settingsTitle: { fontSize: 19, fontWeight: 700, margin: 0, letterSpacing: -0.3 },
  settingsSearch: { width: 230, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontFamily: 'inherit' },
  settingsShell: { flex: 1, display: 'flex', minHeight: 0 },
  settingsNav: { width: 232, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 2 },
  settingsNavItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 10, padding: '9px 10px', cursor: 'pointer', color: 'var(--text-dim)' },
  settingsNavItemActive: { background: 'var(--surface-3)', color: 'var(--text)' },
  settingsNavIcon: { display: 'inline-flex', flexShrink: 0 },
  settingsNavTitle: { display: 'block', fontSize: 13.5, fontWeight: 600, lineHeight: 1.25 },
  settingsNavSub: { display: 'block', fontSize: 11, color: 'var(--text-faint)', marginTop: 1 },
  settingsBody: { flex: 1, overflowY: 'auto', padding: 24, minWidth: 0 },
  settingsBodyCol: { maxWidth: 720 },
  settingsHeader: { display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 16px' },
  settingsHeaderTitle: { fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: -0.2 },
  settingsHeaderSub: { fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 },
  connectDashed: { width: '100%', background: 'transparent', color: 'var(--text-muted)', border: '1px dashed var(--border-2)', borderRadius: 10, padding: '10px 12px', fontSize: 13, cursor: 'pointer' },
  settingsSub: { color: 'var(--text-muted)', fontSize: 13, margin: '-2px 0 14px', lineHeight: 1.55 },
  card: { background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16, flexShrink: 0, breakInside: 'avoid', boxShadow: 'var(--shadow-1)' },
  // Section heading - a real 15px/600 heading (design level) rather than the old tiny all-caps label.
  h2: { fontSize: 15, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)', margin: '0 0 12px' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 14 },
  warn: { background: 'var(--c-amber-bg)', border: '1px solid var(--c-amber-border)', borderRadius: 10, padding: 14, marginBottom: 16, color: 'var(--c-amber)', lineHeight: 1.5 },
  diag: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: 'var(--text-muted)', fontSize: 12 },
  codeBlock: { background: 'var(--bg)', padding: '6px 8px', borderRadius: 6, color: 'var(--text)', overflowX: 'auto' },
  formRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  select: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  input: { flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  primaryBtn: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  ghostBtn: { background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '9px 14px', fontSize: 13, cursor: 'pointer' },
  toggleOn: { background: 'var(--primary-active)', color: 'var(--on-primary)', border: '1px solid var(--primary)', borderRadius: 10, padding: '8px 14px', fontSize: 13, cursor: 'pointer' },
  toggleOff: { background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '8px 14px', fontSize: 13, cursor: 'pointer' },
  dangerGhost: { background: 'transparent', color: 'var(--c-red)', border: '1px solid var(--c-red-border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  dangerSolid: { background: 'var(--danger)', color: 'var(--on-danger)', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  resultList: { listStyle: 'none', margin: '12px 0 0', padding: 0 },
  resultRow: { padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13, fontFamily: 'ui-monospace, monospace' },
  muted: { color: 'var(--text-faint)', fontSize: 13 },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },
  // "Download the full audit" bar - a tinted, bordered strip so the export is an obvious call to
  // action rather than a faint text link. Its buttons are solid but a touch smaller than primaryBtn
  // so the "Apply all fixes" CTA still reads as the primary action.
  downloadBar: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 14px', background: 'var(--primary-soft)', border: '1px solid var(--primary-soft-border)', borderRadius: 10 },
  downloadBtn: { background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', borderRadius: 8, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 },

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

  // GA4 Audit panel - property picker list.
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
