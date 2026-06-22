import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo } from '../../preload';
import type {
  AccountView,
  AuditFindingView,
  AuditReportView,
  ChatTurn,
  CreateTagOutcome,
  DiscoverResult,
  Ga4AccountView,
  GoogleClientStatus,
  GtmAccountView,
  GtmContainerView,
  GtmContext,
  GtmWorkspaceView,
  LlmProvider,
  MonitorAlert,
  MonitorConfig,
  MonitorStatus,
  SecretSelfTest,
  SuggestedTagView,
  TagScanResult,
} from '../../shared/ipc';

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

type View = 'chat' | 'review' | 'audit' | 'settings';

/* Friendly labels for GTM type codes, so approvals read in plain English. */
const GTM_TYPE_LABELS: Record<string, string> = {
  gaawe: 'GA4 Event',
  gaawc: 'GA4 Configuration',
  awct: 'Google Ads Conversion',
  sp: 'Google Ads Remarketing',
  html: 'Custom HTML',
  img: 'Custom Image',
  linkClick: 'Click — Just Links',
  click: 'Click — All Elements',
  pageview: 'Page View',
  domReady: 'DOM Ready',
  windowLoaded: 'Window Loaded',
  formSubmission: 'Form Submission',
  c: 'Constant',
  jsm: 'Custom JavaScript',
  v: 'Data Layer Variable',
  smm: 'Lookup Table',
};
const gtmTypeLabel = (t: string): string => GTM_TYPE_LABELS[t] ?? t;

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
    fields.push({ key: 'tagName', label: 'Tag name', initial: String(tag.name ?? ''), apply: (d, v) => { const t = asObj(d.tag); t.name = v; d.tag = t; } });
    fields.push({ key: 'tagType', label: 'Tag type (code)', initial: String(tag.type ?? ''), apply: (d, v) => { const t = asObj(d.tag); t.type = v; d.tag = t; } });
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
    fields.push({ key: 'trigName', label: 'Trigger name', initial: String(trigger.name ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.name = v; d.trigger = t; } });
    fields.push({ key: 'trigType', label: 'Trigger type (code)', initial: String(trigger.type ?? ''), apply: (d, v) => { const t = asObj(d.trigger); t.type = v; d.trigger = t; } });
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
    fields.push({ key: 'varName', label: 'Variable name', initial: String(variable.name ?? ''), apply: (d, v) => { const t = asObj(d.variable); t.name = v; d.variable = t; } });
    fields.push({ key: 'varType', label: 'Variable type (code)', initial: String(variable.type ?? ''), apply: (d, v) => { const t = asObj(d.variable); t.type = v; d.variable = t; } });
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
  th: { border: '1px solid rgba(255,255,255,0.18)', padding: '6px 10px', textAlign: 'left', verticalAlign: 'top', background: 'rgba(255,255,255,0.06)', fontWeight: 600 },
  td: { border: '1px solid rgba(255,255,255,0.18)', padding: '6px 10px', textAlign: 'left', verticalAlign: 'top' },
  code: { background: 'rgba(255,255,255,0.10)', borderRadius: 4, padding: '1px 5px', fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  pre: { background: 'rgba(0,0,0,0.30)', borderRadius: 6, padding: 10, overflowX: 'auto', margin: '8px 0', fontFamily: 'ui-monospace, monospace', fontSize: 12 },
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
  return s.length > 0 && /^[|\s:-]+$/.test(s) && s.includes('-');
}
function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}
function isListItem(line: string): boolean {
  return /^\s*([-*]|\d+\.)\s+/.test(line);
}

function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
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
      blocks.push(<pre key={key++} style={mdStyles.pre}><code>{buf.join('\n')}</code></pre>);
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

  function approve(): void {
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
          {rows.length === 0 && <div style={{ color: '#9ca3af' }}>{proposal.summary}</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={proposal.destructive ? styles.dangerSolid : styles.primaryBtn} onClick={approve}>
          {proposal.destructive ? 'Yes, delete' : 'Approve & apply'}
        </button>
        <button style={styles.ghostBtn} onClick={onReject}>
          Cancel
        </button>
      </div>
      <div style={styles.confirmNote}>
        {proposal.destructive
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
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const active = accounts.find((a) => a.isActive);

  async function refresh(): Promise<void> {
    setAccounts(await window.desktop.accounts.list());
  }

  useEffect(() => {
    window.desktop.getInfo().then(setInfo).catch((e) => setError(String(e)));
    window.desktop.google.status().then(setGoogle).catch((e) => setError(String(e)));
    window.desktop.secrets.selfTest().then(setSelfTest).catch((e) => setError(String(e)));
    refresh().catch((e) => setError(String(e)));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
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
            <button
              key={a.id}
              style={{ ...styles.acctBtn, ...(a.isActive ? styles.acctBtnActive : {}) }}
              onClick={() => run(() => window.desktop.accounts.setActive(a.id))}
              title={a.email}
            >
              <span style={{ ...styles.dot, background: a.hasGoogleToken ? '#34d399' : '#6b7280' }} />
              <span style={styles.acctEmail}>{a.displayName || a.email}</span>
            </button>
          ))}
        </div>

        <button
          style={styles.connectBtn}
          onClick={connect}
          disabled={connecting || !google?.configured}
        >
          {connecting ? 'Signing in…' : '+ Connect account'}
        </button>
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
            style={{ ...styles.navItem, ...(view === 'review' ? styles.navActive : {}) }}
            onClick={() => setView('review')}
          >
            🏷 Tag suggestions
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'audit' ? styles.navActive : {}) }}
            onClick={() => setView('audit')}
          >
            🔍 Container audit
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

        {view === 'chat' ? (
          <ChatView key={active?.id ?? 'none'} active={active} onError={setError} refresh={refresh} />
        ) : view === 'review' ? (
          <TagReviewPanel key={active?.id ?? 'none'} active={active} onError={setError} />
        ) : view === 'audit' ? (
          <ContainerAuditPanel key={active?.id ?? 'none'} active={active} onError={setError} />
        ) : (
          <SettingsView
            active={active}
            google={google}
            info={info}
            selfTest={selfTest}
            onError={setError}
            run={run}
            refresh={refresh}
          />
        )}
      </main>
    </div>
  );
}

/* ───────────────────────────── Chat ───────────────────────────── */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
}

function ChatView({
  active,
  onError,
  refresh,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<'gtm' | 'ga4'>('gtm');
  const [pendingConfirm, setPendingConfirm] = useState<
    {
      confirmId: string;
      tool: string;
      summary: string;
      details: Record<string, unknown>;
      destructive?: boolean;
    } | null
  >(null);

  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [input]);

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
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '', tools: [] }]);
    setInput('');
    setBusy(true);
    try {
      await window.desktop.llm.chatStream(history, text, product, (ev) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, text: last.text + ev.delta };
          else if (ev.type === 'tool')
            copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), ev.name] };
          return copy;
        });
        if (ev.type === 'confirm') {
          setPendingConfirm({
            confirmId: ev.confirmId,
            tool: ev.tool,
            summary: ev.summary,
            details: ev.details,
            destructive: ev.destructive,
          });
        }
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setMessages((m) => (m[m.length - 1]?.role === 'assistant' && !m[m.length - 1].text ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
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
              onClick={() => {
                setProduct('gtm');
                setMessages([]);
              }}
            >
              GTM
            </button>
            <button
              style={product === 'ga4' ? styles.toggleActive : styles.toggleBtn}
              onClick={() => {
                setProduct('ga4');
                setMessages([]);
              }}
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
          <div key={i} style={m.role === 'user' ? styles.userMsg : styles.asstMsg}>
            {m.role === 'assistant' ? (
              m.text ? <Markdown text={m.text} /> : <span style={{ opacity: 0.6 }}>…</span>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || '…'}</div>
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
        <button style={styles.sendBtn} onClick={send} disabled={!ready || busy}>
          Send
        </button>
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
    setSel((s) => ({ ...s, containerId, containerName: c?.name, workspaceId: undefined, workspaceName: undefined }));
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
          📁 {ctx.accountName} › {ctx.containerName} ›{' '}
          <b style={{ color: '#e5e7eb' }}>{ctx.workspaceName ?? 'workspace?'}</b>
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
          <option key={c.containerId} value={c.containerId}>{c.name}</option>
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

type RowStatus = { state: 'idle' | 'creating' | 'ok' | 'err'; msg?: string };
interface TagEdit {
  tagName?: string;
  eventName?: string;
  measurementId?: string;
}

const CONF_BADGE: Record<'high' | 'medium' | 'low', React.CSSProperties> = {
  high: { background: '#064e3b', color: '#6ee7b7', border: '1px solid #065f46' },
  medium: { background: '#3a2c0a', color: '#fcd34d', border: '1px solid #92651a' },
  low: { background: '#1b2433', color: '#9ca3af', border: '1px solid #334155' },
};

const TRIGGER_TYPE_LABEL: Record<string, string> = {
  link_click: 'Link Click (linkClick)',
  all_clicks: 'All Elements Click (click)',
  form_submit: 'Form Submission (formSubmission)',
  custom_event: 'Custom Event (customEvent)',
  pageview: 'Page View (pageview)',
};
const triggerTypeLabel = (kind: string): string => TRIGGER_TYPE_LABEL[kind] ?? kind;

/** Human-readable trigger condition (the filter GTM will apply). */
function triggerCondition(s: SuggestedTagView): string {
  const t = s.trigger;
  const parts: string[] = [];
  if (t.clickUrlValue) parts.push(`{{Click URL}} ${t.clickUrlOperator ?? 'contains'} "${t.clickUrlValue}"`);
  if (t.clickTextValue) parts.push(`{{Click Text}} ${t.clickTextOperator ?? 'contains'} "${t.clickTextValue}"`);
  if (t.formIdValue) parts.push(`{{Form ID}} ${t.formIdOperator ?? 'equals'} "${t.formIdValue}"`);
  if (t.formClassesValue) parts.push(`{{Form Classes}} ${t.formClassesOperator ?? 'contains'} "${t.formClassesValue}"`);
  if (t.eventName) parts.push(`event = "${t.eventName}"`);
  if (parts.length === 0) return t.kind === 'all_clicks' ? 'fires on every click' : t.kind === 'form_submit' ? 'fires on every form submit' : '—';
  return parts.join(' AND ');
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

/** "outbound 40 · cta 30 · download 25 · phone 2 · email 1" for the inventory header. */
function kindCountsLabel(elements: Array<{ kind: string }>): string {
  const counts: Record<string, number> = {};
  for (const e of elements) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
}

function EditLine({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label style={styles.editRow}>
      <span style={styles.proposalLabel}>{label}</span>
      <input style={styles.editInput} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
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
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestedTagView[]>([]);
  const [meta, setMeta] = useState<TagScanResult['summary'] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, TagEdit>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<{ created: number; failed: number } | null>(null);
  const [settleMs, setSettleMs] = useState('2500');
  const [settleAuto, setSettleAuto] = useState(true);
  const effSettleMs = (): number | undefined => (settleAuto ? undefined : Number(settleMs) || undefined);
  const [scanLog, setScanLog] = useState<{ pages: TagScanResult['pages']; notScanned: TagScanResult['notScanned']; inventory: TagScanResult['inventory']; installed: TagScanResult['installed'] } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const [discoverMode, setDiscoverMode] = useState<'site' | 'sitemap'>('site');
  const [selectedPages, setSelectedPages] = useState<Record<string, boolean>>({});

  const ctx = active?.gtmContext;
  const targetReady = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);

  function loadSuggestions(list: SuggestedTagView[]): void {
    setSuggestions(list);
    // Default-select the real gaps; leave what GA4 Enhanced Measurement already
    // tracks unticked so the user opts in deliberately.
    setSelected(Object.fromEntries(list.map((s) => [s.id, !s.enhancedMeasurementOverlap])));
    setEdits({});
    setExpanded({});
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

  // Step 1: enumerate the site's pages (sitemap/crawl), then the user picks which to scan.
  async function doDiscover(): Promise<void> {
    const target = url.trim();
    if (!target || discovering || scanning) return;
    onError('');
    setDiscovering(true);
    setDiscovered(null);
    try {
      const res = discoverMode === 'sitemap' ? await window.desktop.tags.discoverSitemap(target) : await window.desktop.tags.discover(target);
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
    const urls = (discovered?.urls ?? []).filter((u) => selectedPages[u]);
    if (urls.length === 0 || scanning) return;
    onError('');
    setScanning(true);
    try {
      applyScanResult(await window.desktop.tags.scanUrls(urls, { settleMs: effSettleMs() }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  // Quick path: crawl + scan up to ~25 pages without the discover step.
  async function doQuickScan(): Promise<void> {
    const target = url.trim();
    if (!target || scanning) return;
    onError('');
    setScanning(true);
    try {
      applyScanResult(await window.desktop.tags.scan(target, { maxPages: 25, maxDepth: 2, settleMs: effSettleMs() }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
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

  const selectedIds = suggestions.filter((s) => selected[s.id]).map((s) => s.id);
  const setAll = (pred: (s: SuggestedTagView) => boolean): void =>
    setSelected(Object.fromEntries(suggestions.map((s) => [s.id, pred(s)])));

  function effective(s: SuggestedTagView): SuggestedTagView {
    const e = edits[s.id];
    if (!e) return s;
    return {
      ...s,
      tagName: e.tagName ?? s.tagName,
      eventName: e.eventName ?? s.eventName,
      measurementId: e.measurementId ?? s.measurementId,
    };
  }

  async function confirmCreate(): Promise<void> {
    if (!targetReady || !ctx) return;
    setCreating(true);
    onError('');
    const chosen = suggestions.filter((s) => selected[s.id]).map(effective);
    setStatuses((st) => {
      const n = { ...st };
      for (const s of chosen) n[s.id] = { state: 'creating' };
      return n;
    });
    try {
      const outcomes: CreateTagOutcome[] = await window.desktop.tags.createTags(
        ctx.accountId!,
        ctx.containerId!,
        ctx.workspaceId!,
        chosen
      );
      const byId = new Map(outcomes.map((o) => [o.id, o]));
      setStatuses((st) => {
        const n = { ...st };
        for (const s of chosen) {
          const o = byId.get(s.id);
          if (!o) n[s.id] = { state: 'err', msg: 'no result' };
          else if (o.ok) n[s.id] = { state: 'ok', msg: o.triggerReused ? 'created · trigger reused' : 'created · trigger created' };
          else n[s.id] = { state: 'err', msg: o.error ?? 'failed' };
        }
        return n;
      });
      const created = outcomes.filter((o) => o.ok).length;
      setDone({ created, failed: outcomes.length - created });
      // Succeeded rows: deselect (and they become read-only). Failures stay selected to retry.
      setSelected((sel) => {
        const n = { ...sel };
        for (const o of outcomes) if (o.ok) n[o.id] = false;
        return n;
      });
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
    }
  }

  const selectedPageCount = (discovered?.urls ?? []).filter((u) => selectedPages[u]).length;
  const setAllPages = (pred: (u: string, i: number) => boolean): void =>
    setSelectedPages(Object.fromEntries((discovered?.urls ?? []).map((u, i) => [u, pred(u, i)])));

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
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(['site', 'sitemap'] as const).map((m) => (
              <button
                key={m}
                style={discoverMode === m ? styles.toggleOn : styles.toggleOff}
                onClick={() => setDiscoverMode(m)}
                disabled={scanning || discovering}
              >
                {m === 'site' ? 'Main website' : 'Sitemap URL'}
              </button>
            ))}
          </div>
          <div style={styles.formRow}>
            <input
              style={styles.input}
              placeholder={discoverMode === 'sitemap' ? 'https://example.com/sitemap.xml' : 'https://example.com'}
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
              {discovering ? 'Discovering…' : 'Discover pages'}
            </button>
          </div>
          <div style={styles.muted}>
            {discoverMode === 'sitemap'
              ? 'Pastes a sitemap.xml (or sitemapindex) URL and lists its pages directly — handy when auto-discovery misses pages.'
              : 'First lists every page (sitemap if available, else a quick link-crawl) so you can pick which to deep-scan'}
            {' '}— then merges Electron's browser <i>and</i> a static parse (Cheerio). Read-only; nothing is created until you
            approve.{' '}
            <button style={styles.linkBtn} onClick={doQuickScan} disabled={!url.trim() || scanning || discovering}>
              quick scan (~25 pages)
            </button>{' '}
            ·{' '}
            <button style={styles.linkBtn} onClick={() => setPasteOpen((o) => !o)}>
              {pasteOpen ? 'hide paste' : 'paste a report'}
            </button>
          </div>
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
                Found <b style={{ color: '#e5e7eb' }}>{discovered.total}</b> page(s){' '}
                {discovered.viaSitemap ? 'via sitemap' : 'via link-crawl'} · {selectedPageCount} selected
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button style={styles.linkBtn} onClick={() => setAllPages(() => true)}>Select all</button>
                <button style={styles.linkBtn} onClick={() => setAllPages(() => false)}>Select none</button>
                <button style={styles.linkBtn} onClick={() => setAllPages((_u, i) => i < 25)}>First 25</button>
                <button style={styles.linkBtn} onClick={() => setAllPages((_u, i) => i < 50)}>First 50</button>
              </div>
            </div>
            {discovered.note && <div style={{ ...styles.muted, marginTop: 4 }}>{discovered.note}</div>}
            <div style={{ ...styles.muted, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>Existing container on this site:</span>
              {discovered.installed.containers.length > 0 || discovered.installed.measurementIds.length > 0 ? (
                [...discovered.installed.containers, ...discovered.installed.measurementIds].map((id) => (
                  <span key={id} style={styles.typeChip}>{id}</span>
                ))
              ) : (
                <span style={{ color: '#9ca3af' }}>none detected</span>
              )}
            </div>
            {discovered.urls.length > 0 ? (
              <div style={styles.pageListScroll}>
                {discovered.urls.map((u, i) => (
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
              <div style={{ ...styles.muted, marginTop: 6 }}>No pages found — try the quick scan above, or check the URL.</div>
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <button style={styles.primaryBtn} onClick={doScanSelected} disabled={selectedPageCount === 0 || scanning}>
                {scanning ? 'Scanning…' : `Scan selected (${selectedPageCount})`}
              </button>
              {selectedPageCount > 60 && <span style={{ color: '#fcd9a5', fontSize: 13 }}>Up to 60 pages are scanned per run.</span>}
            </div>
          </div>
        )}

        {/* Target */}
        <div style={styles.card}>
          <div style={styles.h2}>Create into</div>
          {targetReady && ctx ? (
            <div style={styles.muted}>
              📁 {ctx.accountName} › {ctx.containerName} › <b style={{ color: '#e5e7eb' }}>{ctx.workspaceName}</b>
              &nbsp;·&nbsp; {active?.email}
            </div>
          ) : (
            <div style={{ color: '#fcd9a5', fontSize: 13 }}>
              Pick a GTM account, container and draft workspace in <b>Chat</b> (the bar above the messages) first, then
              return here.
            </div>
          )}
          <div style={{ ...styles.muted, marginTop: 6 }}>
            measurementId defaults to the <code style={mdStyles.code}>{'{{GA4 Measurement ID}}'}</code> variable — make
            sure it exists in this container, or edit a row to a real G-XXXX id.
          </div>
        </div>

        {/* Warnings (scan or paste) */}
        {warnings.map((w, i) => (
          <div key={i} style={{ ...styles.muted, color: '#fcd9a5' }}>
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
                {[...scanLog.installed.containers, ...scanLog.installed.measurementIds].map((id) => (
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
                    <span style={{ textTransform: 'none', color: '#6b7280', fontWeight: 400, letterSpacing: 0 }}>
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

        {/* Results */}
        {suggestions.length === 0 ? (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏷</div>
            {scanLog
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
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button style={styles.linkBtn} onClick={() => setAll(() => true)}>
                  Select all
                </button>
                <button style={styles.linkBtn} onClick={() => setAll(() => false)}>
                  Select none
                </button>
                <button style={styles.linkBtn} onClick={() => setAll((s) => !s.enhancedMeasurementOverlap)}>
                  Select new only
                </button>
              </div>
            </div>

            <div style={styles.reviewList}>
              {suggestions.map((s) => {
                const st = statuses[s.id];
                const isSel = !!selected[s.id];
                const ed = edits[s.id] ?? {};
                const eff = effective(s);
                const okRow = st?.state === 'ok';
                return (
                  <div
                    key={s.id}
                    style={{
                      ...styles.reviewRow,
                      ...(okRow ? styles.reviewRowOk : {}),
                      opacity: s.enhancedMeasurementOverlap && !isSel && !okRow ? 0.72 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      disabled={okRow || creating}
                      onChange={(e) => setSelected((sel) => ({ ...sel, [s.id]: e.target.checked }))}
                      style={{ marginTop: 4 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.reviewRowHead}>
                        <span style={{ fontWeight: 600 }}>{eff.tagName}</span>
                        <span style={{ ...styles.badge, ...CONF_BADGE[s.confidence] }}>{s.confidence}</span>
                        <span style={styles.typeChip}>GA4 event</span>
                        {s.enhancedMeasurementOverlap && (
                          <span style={styles.emChip}>⚠ Enhanced Measurement already tracks this</span>
                        )}
                      </div>
                      <div style={styles.detailGrid}>
                        <span style={styles.detailKey}>Event</span>
                        <span><code style={mdStyles.code}>{eff.eventName}</code></span>
                        <span style={styles.detailKey}>Page</span>
                        <span>{s.page}</span>
                        <span style={styles.detailKey}>Tag type</span>
                        <span>GA4 Event (gaawe)</span>
                        <span style={styles.detailKey}>Trigger</span>
                        <span>
                          <b style={{ color: '#e5e7eb' }}>{s.trigger.name}</b> · {triggerTypeLabel(s.trigger.kind)}
                        </span>
                        <span style={styles.detailKey}>Condition</span>
                        <span>{triggerCondition(s)}</span>
                        <span style={styles.detailKey}>Parameters</span>
                        <span>
                          {(eff.eventParameters ?? []).length > 0
                            ? (eff.eventParameters ?? []).map((p, i) => (
                                <span key={i}>
                                  {i > 0 ? '  ·  ' : ''}
                                  <code style={mdStyles.code}>{p.name}</code>={p.value}
                                </span>
                              ))
                            : '—'}
                        </span>
                      </div>
                      <div style={styles.reviewEvidence}>{s.evidence}</div>
                      {s.note && (
                        <div style={{ fontSize: 12, marginTop: 4, color: '#fcd9a5', display: 'flex', gap: 6 }}>
                          <span>⚠</span>
                          <span>{s.note}</span>
                        </div>
                      )}
                      {st && st.state !== 'idle' && (
                        <div
                          style={{
                            fontSize: 12,
                            marginTop: 4,
                            color: st.state === 'ok' ? '#6ee7b7' : st.state === 'err' ? '#fca5a5' : '#9ca3af',
                          }}
                        >
                          {st.state === 'creating' ? 'Creating…' : st.state === 'ok' ? `✓ ${st.msg}` : `✗ ${st.msg}`}
                        </div>
                      )}
                      {expanded[s.id] && (
                        <div style={styles.editGrid}>
                          <EditLine
                            label="Tag name"
                            value={ed.tagName ?? s.tagName}
                            onChange={(v) => setEdits((m) => ({ ...m, [s.id]: { ...m[s.id], tagName: v } }))}
                          />
                          <EditLine
                            label="Event name"
                            value={ed.eventName ?? s.eventName}
                            onChange={(v) => setEdits((m) => ({ ...m, [s.id]: { ...m[s.id], eventName: v } }))}
                          />
                          <EditLine
                            label="Measurement ID"
                            value={ed.measurementId ?? s.measurementId}
                            onChange={(v) => setEdits((m) => ({ ...m, [s.id]: { ...m[s.id], measurementId: v } }))}
                          />
                        </div>
                      )}
                    </div>
                    {!okRow && (
                      <button style={styles.linkBtn} onClick={() => setExpanded((x) => ({ ...x, [s.id]: !x[s.id] }))}>
                        {expanded[s.id] ? 'done' : '✎ edit'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {confirming ? (
              <div style={styles.confirm}>
                <div style={styles.confirmHead}>Create {selectedIds.length} draft tag(s)?</div>
                <div style={{ ...styles.muted, margin: '6px 0', color: '#fcd9a5' }}>
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
                  disabled={!targetReady || selectedIds.length === 0}
                  onClick={() => setConfirming(true)}
                >
                  Approve &amp; create selected ({selectedIds.length})
                </button>
                {!targetReady && <span style={{ color: '#fcd9a5', fontSize: 13 }}>Pick a draft workspace first.</span>}
                {done && (
                  <span style={{ color: done.failed ? '#fcd9a5' : '#6ee7b7', fontSize: 13 }}>
                    {done.created} created{done.failed ? `, ${done.failed} failed` : ''} — open GTM to review &amp;
                    publish.
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

const SEV_BADGE: Record<string, React.CSSProperties> = {
  high: { background: '#3a1416', color: '#fca5a5', border: '1px solid #7f1d1d' },
  medium: { background: '#3a2c0a', color: '#fcd34d', border: '1px solid #92651a' },
  low: { background: '#1b2433', color: '#9ca3af', border: '1px solid #334155' },
  info: { background: '#10233f', color: '#93c5fd', border: '1px solid #1e3a5f' },
};
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

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
  const [ga4Mid, setGa4Mid] = useState('G-123456789');
  const [ga4, setGa4] = useState<{ state: 'idle' | 'confirm' | 'working' | 'done' | 'err'; msg?: string }>({ state: 'idle' });

  const ctx = active?.gtmContext;
  const ready = Boolean(active?.hasGoogleToken && ctx?.accountId && ctx?.containerId && ctx?.workspaceId);

  async function runAudit(): Promise<void> {
    if (!ready || !ctx || running) return;
    onError('');
    setRunning(true);
    setFix({});
    try {
      setReport(await window.desktop.gtm.audit(ctx.accountId!, ctx.containerId!, ctx.workspaceId!));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function applyFix(i: number, f: AuditFindingView): Promise<void> {
    if (!f.fix) return;
    const destructive = f.fix.tool.startsWith('delete');
    if (destructive && fix[i]?.state !== 'confirm') {
      setFix((s) => ({ ...s, [i]: { state: 'confirm' } }));
      return;
    }
    setFix((s) => ({ ...s, [i]: { state: 'fixing' } }));
    try {
      await window.desktop.gtm.applyFix(f.fix);
      setFix((s) => ({ ...s, [i]: { state: 'done' } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFix((s) => ({ ...s, [i]: { state: 'err', msg } }));
      onError(msg);
    }
  }

  async function ensureGa4Config(): Promise<void> {
    if (!ready || !ctx) return;
    if (ga4.state === 'idle' || ga4.state === 'err') {
      setGa4({ state: 'confirm' });
      return;
    }
    setGa4({ state: 'working' });
    onError('');
    try {
      const r = await window.desktop.gtm.ensureGa4Config({
        accountId: ctx.accountId!,
        containerId: ctx.containerId!,
        workspaceId: ctx.workspaceId!,
        measurementId: ga4Mid.trim() || undefined,
      });
      setGa4({
        state: 'done',
        msg: r.present
          ? `Already present — GA4 base tag "${r.existingTag}" exists; nothing created.`
          : `Created Google Tag "${r.tagName}" using {{${r.variableName}}}${r.variableCreated ? ` + the "${r.variableName}" variable (= ${r.measurementId})` : ''}. Draft only — publish in GTM.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGa4({ state: 'err', msg });
      onError(msg);
    }
  }

  const findings = [...(report?.findings ?? [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const fixable = (report?.findings ?? []).filter((f) => f.autoFixable).length;

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
              <b style={{ color: '#e5e7eb' }}>
                {ctx.accountName} › {ctx.containerName} › {ctx.workspaceName ?? 'workspace?'}
              </b>
            ) : (
              <b style={{ color: '#fcd9a5' }}>none</b>
            )}
            {active?.email ? ` · ${active.email}` : ''}
          </div>
          {!ready && (
            <div style={{ color: '#fcd9a5', fontSize: 13, marginTop: 4 }}>
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

        {/* GA4 base/config tag bootstrap */}
        <div style={styles.card}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>GA4 base (Configuration) tag</div>
          <div style={styles.muted}>
            Adds a Google Tag <b>only if the container has none</b> — storing the Measurement ID in a{' '}
            <code style={mdStyles.code}>GA4 - Variable</code> constant and referencing{' '}
            <code style={mdStyles.code}>{'{{GA4 - Variable}}'}</code>, firing on All Pages. Draft only.
          </div>
          <div style={{ ...styles.formRow, marginTop: 8, alignItems: 'center' }}>
            <label style={styles.scanNum}>
              Measurement ID
              <input
                style={{ ...styles.scanNumInput, width: 130 }}
                value={ga4Mid}
                disabled={ga4.state === 'working'}
                onChange={(e) => setGa4Mid(e.target.value)}
                placeholder="G-123456789"
              />
            </label>
            {ga4.state === 'confirm' ? (
              <>
                <button style={styles.primaryBtn} onClick={ensureGa4Config} disabled={!ready}>
                  Create it (draft)
                </button>
                <button style={styles.ghostBtn} onClick={() => setGa4({ state: 'idle' })}>
                  Cancel
                </button>
              </>
            ) : (
              <button style={styles.primaryBtn} onClick={ensureGa4Config} disabled={!ready || ga4.state === 'working'}>
                {ga4.state === 'working' ? 'Working…' : 'Add GA4 base tag if missing'}
              </button>
            )}
          </div>
          {ga4.state === 'confirm' && (
            <div style={{ ...styles.muted, marginTop: 6, color: '#fcd9a5' }}>
              Will create a <b>GA4 - Variable</b> constant (= {ga4Mid || 'G-123456789'}) and a <b>GA4 Configuration</b> Google
              Tag into the DRAFT workspace — only if no GA4 base tag already exists. Not published.
            </div>
          )}
          {ga4.msg && (
            <div style={{ marginTop: 6, fontSize: 13, color: ga4.state === 'err' ? '#fca5a5' : '#6ee7b7' }}>
              {ga4.state === 'err' ? '✗ ' : '✓ '}
              {ga4.msg}
            </div>
          )}
        </div>

        {report && (
          <div style={styles.card}>
            <div style={styles.muted}>
              {report.counts.tags} tag(s) · {report.counts.triggers} trigger(s) · {report.counts.variables} variable(s) ·{' '}
              <b style={{ color: report.counts.findings ? '#fcd34d' : '#6ee7b7' }}>
                {report.counts.findings} issue(s)
              </b>{' '}
              ({report.summary.high} high · {report.summary.medium} medium · {report.summary.low} low · {report.summary.info} info)
              {fixable > 0 ? ` · ${fixable} auto-fixable` : ''}
            </div>
          </div>
        )}

        {report && findings.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            No issues found — every tag has a trigger, nothing's mis-paused, no orphans. Looks clean.
          </div>
        )}

        {findings.length > 0 && (
          <div style={styles.reviewList}>
            {findings.map((f, i) => {
              const st = fix[i];
              const done = st?.state === 'done';
              return (
                <div key={i} style={{ ...styles.reviewRow, ...(done ? styles.reviewRowOk : {}) }}>
                  <span style={{ ...styles.badge, ...(SEV_BADGE[f.severity] ?? SEV_BADGE.info), marginTop: 2 }}>{f.severity}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {f.resource ? `${f.resource.name} ` : ''}
                      <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 12 }}>
                        {f.resource ? `(${f.resource.kind})` : f.category}
                      </span>
                    </div>
                    <div style={{ ...styles.reviewMetaLine, color: '#cbd5e1' }}>{f.message}</div>
                    <div style={styles.reviewEvidence}>{f.recommendation}</div>
                    {st && st.state !== 'idle' && st.state !== 'confirm' && (
                      <div style={{ fontSize: 12, marginTop: 4, color: st.state === 'done' ? '#6ee7b7' : st.state === 'err' ? '#fca5a5' : '#9ca3af' }}>
                        {st.state === 'fixing' ? 'Applying…' : st.state === 'done' ? '✓ applied — re-run to confirm' : `✗ ${st.msg}`}
                      </div>
                    )}
                  </div>
                  {f.autoFixable && f.fix && !done && (
                    <button
                      style={f.fix.tool.startsWith('delete') ? styles.dangerGhost : styles.ghostBtn}
                      disabled={st?.state === 'fixing'}
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
                  )}
                </div>
              );
            })}
          </div>
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
  return (
    <div style={styles.settings}>
      <h1 style={styles.settingsTitle}>Settings</h1>

      {google && !google.configured && (
        <section style={styles.warn}>
          <strong>Google OAuth client not configured.</strong> Create a Google “Desktop app” OAuth
          client, then drop a file at:
          <pre style={styles.codeBlock}>{google.configPath}</pre>
          <code>{'{ "clientId": "…apps.googleusercontent.com", "clientSecret": "…" }'}</code>
        </section>
      )}
      {active ? (
        <>
          <section style={styles.card}>
            <h2 style={styles.h2}>Active account</h2>
            <div style={styles.kv}><span>Email</span><b>{active.email}</b></div>
            <div style={styles.kv}><span>Google</span><b>{active.hasGoogleToken ? '✓ signed in' : '— not connected'}</b></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
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
            <LlmEditor account={active} onChange={refresh} onError={onError} />
          </section>

          <section style={styles.card}>
            <h2 style={styles.h2}>Data tools (read-only)</h2>
            <DataTools active={active} onError={onError} />
          </section>

          <section style={styles.card}>
            <h2 style={styles.h2}>Continuous monitoring (GTM)</h2>
            <MonitoringEditor active={active} onError={onError} />
          </section>
        </>
      ) : (
        <section style={styles.card}>
          <p style={styles.muted}>Connect a Google account to configure it.</p>
        </section>
      )}

      <section style={styles.card}>
        <h2 style={styles.h2}>Providers (API keys)</h2>
        <ProvidersEditor onChange={refresh} onError={onError} />
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Diagnostics</h2>
        {selfTest && (
          <div style={{ color: selfTest.ok ? '#34d399' : '#fca5a5', marginBottom: 8 }}>
            Secret store (DPAPI): {selfTest.ok ? '✓ working' : `✗ ${selfTest.detail}`}
          </div>
        )}
        {info && (
          <div style={styles.muted}>
            Electron {info.electron} · Node {info.node} · {info.platform}
          </div>
        )}
      </section>
    </div>
  );
}

/* Continuous-monitoring control: enable/interval + Audit now + latest alert. */
function MonitoringEditor({
  active,
  onError,
}: {
  active: AccountView;
  onError: (m: string) => void;
}): JSX.Element {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [alert, setAlert] = useState<MonitorAlert | null>(null);
  const [intervalDraft, setIntervalDraft] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.desktop.monitor
      .status()
      .then((s) => {
        setStatus(s);
        setIntervalDraft(String(s.intervalMinutes));
        // Show the most recent alert even if it fired while this view was closed.
        if (s.lastAlert) setAlert(s.lastAlert);
      })
      .catch((e) => onError(String(e)));
    const off = window.desktop.monitor.onAlert(setAlert);
    return off;
  }, [onError]);

  const update = async (patch: Partial<MonitorConfig>): Promise<void> => {
    try {
      const s = await window.desktop.monitor.configure(patch);
      setStatus(s);
      setIntervalDraft(String(s.intervalMinutes));
    } catch (e) {
      onError(String(e));
    }
  };

  const auditNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const a = await window.desktop.monitor.runNow();
      if (a) setAlert(a);
      setStatus(await window.desktop.monitor.status());
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const ctx = active.gtmContext;
  const ready = Boolean(active.hasGoogleToken && ctx?.containerId && ctx?.workspaceId);

  if (!ready) {
    return (
      <p style={styles.muted}>
        Pick a GTM container and workspace (in chat or Data tools) to enable monitoring.
      </p>
    );
  }

  return (
    <div>
      <p style={styles.muted}>
        Re-audits {ctx?.containerName ? `“${ctx.containerName}”` : 'the selected container'} on a timer and
        alerts you when NEW issues appear since the last check.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={status?.enabled ?? false}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
        <span>Enable automatic monitoring</span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={styles.muted}>Every</span>
        <input
          type="number"
          min={5}
          value={intervalDraft}
          // Commit on blur / Enter (not every keystroke) so changing the interval
          // doesn't trigger a live audit per digit.
          onChange={(e) => setIntervalDraft(e.target.value)}
          onBlur={() => {
            const n = Number(intervalDraft);
            if (Number.isFinite(n) && n !== status?.intervalMinutes) void update({ intervalMinutes: n });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          style={{ width: 70 }}
        />
        <span style={styles.muted}>minutes (min 5)</span>
        <button style={styles.ghostBtn} disabled={busy} onClick={() => void auditNow()}>
          {busy ? 'Auditing…' : 'Audit now'}
        </button>
      </div>
      {status?.lastRunAt ? (
        <div style={styles.muted}>Last check: {new Date(status.lastRunAt).toLocaleString()}</div>
      ) : null}
      {status?.lastError ? <div style={{ color: '#fca5a5' }}>Last error: {status.lastError}</div> : null}
      {alert ? (
        <div style={{ ...styles.warn, marginTop: 10 }}>
          <strong>
            {alert.newFindings.length} new issue{alert.newFindings.length === 1 ? '' : 's'}
          </strong>
          {alert.resolvedCount > 0 ? <span> · {alert.resolvedCount} resolved</span> : null}
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {alert.newFindings.slice(0, 6).map((f, i) => (
              <li key={i}>
                <b>{f.severity}</b> — {f.message}
              </li>
            ))}
          </ul>
          <div style={styles.muted}>Ask in chat to fix these.</div>
        </div>
      ) : null}
    </div>
  );
}

function LlmEditor({
  account,
  onChange,
  onError,
}: {
  account: AccountView;
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const [provider, setProvider] = useState<LlmProvider>(account.llm?.provider ?? 'openai');
  const [model, setModel] = useState(account.llm?.model ?? DEFAULT_MODEL.openai);
  const [saved, setSaved] = useState('');

  async function save(): Promise<void> {
    try {
      await window.desktop.accounts.setLlmConfig(account.id, provider, model);
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
        <select
          style={styles.select}
          value={provider}
          onChange={(e) => {
            const p = e.target.value as LlmProvider;
            setProvider(p);
            setModel(DEFAULT_MODEL[p]);
          }}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>
        <input style={styles.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
        <button style={styles.ghostBtn} onClick={save}>
          Save
        </button>
      </div>
      <div style={styles.muted}>
        API key: {account.llm?.hasApiKey ? `✓ using the app-level ${account.llm.provider} key` : '✗ not set — add it under Providers below'}
        {saved && <span style={{ color: '#34d399' }}> · {saved}</span>}
      </div>
    </div>
  );
}

function ProvidersEditor({
  onChange,
  onError,
}: {
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const providers: LlmProvider[] = ['openai', 'anthropic', 'gemini'];
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    window.desktop.providers.status().then(setStatus).catch((e) => onError(String(e)));
  }, []);

  async function save(p: LlmProvider): Promise<void> {
    try {
      const next = await window.desktop.providers.setKey(p, keys[p] ?? '');
      setStatus(next);
      setKeys((k) => ({ ...k, [p]: '' }));
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear(p: LlmProvider): Promise<void> {
    try {
      setStatus(await window.desktop.providers.clearKey(p));
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
            {p} {status[p] ? '✓' : ''}
          </span>
          <input
            style={styles.input}
            type="password"
            value={keys[p] ?? ''}
            onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
            placeholder={status[p] ? 'key saved — enter to replace' : 'API key'}
          />
          <button style={styles.ghostBtn} onClick={() => save(p)}>
            Save
          </button>
          {status[p] && (
            <button style={styles.dangerGhost} onClick={() => clear(p)}>
              Clear
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function DataTools({
  active,
  onError,
}: {
  active: AccountView;
  onError: (m: string) => void;
}): JSX.Element {
  const [rows, setRows] = useState<string[]>([]);
  const [loading, setLoading] = useState('');

  async function load(kind: 'gtm' | 'ga4'): Promise<void> {
    setLoading(kind);
    onError('');
    try {
      if (kind === 'gtm') {
        const r: GtmAccountView[] = await window.desktop.data.listGtmAccounts();
        setRows(r.map((a) => `${a.name} (${a.accountId})`));
      } else {
        const r: Ga4AccountView[] = await window.desktop.data.listGa4Accounts();
        setRows(r.map((a) => `${a.displayName} — ${a.propertyCount} properties`));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading('');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={styles.ghostBtn} disabled={!active.hasGoogleToken || !!loading} onClick={() => load('gtm')}>
          {loading === 'gtm' ? 'Loading…' : 'List GTM accounts'}
        </button>
        <button style={styles.ghostBtn} disabled={!active.hasGoogleToken || !!loading} onClick={() => load('ga4')}>
          {loading === 'ga4' ? 'Loading…' : 'List GA4 accounts'}
        </button>
      </div>
      {rows.length > 0 && (
        <ul style={styles.resultList}>
          {rows.map((r, i) => (
            <li key={i} style={styles.resultRow}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── Styles ─────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    margin: 0,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    color: '#e5e7eb',
    background: '#0b0f17',
  },
  sidebar: {
    width: 248,
    flexShrink: 0,
    background: '#0d1320',
    borderRight: '1px solid #1f2937',
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    boxSizing: 'border-box',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 },
  logo: { width: 34, height: 34, borderRadius: 9, background: '#2563eb', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 },
  brandName: { fontWeight: 700 },
  brandSub: { fontSize: 11, color: '#6b7280' },
  sideLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: '#6b7280', margin: '4px 0 8px' },
  accountList: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 },
  sideMuted: { color: '#6b7280', fontSize: 13, padding: '6px 4px' },
  acctBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid transparent', borderRadius: 8, padding: '8px 10px', color: '#cbd5e1', cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  acctBtnActive: { background: '#16223a', border: '1px solid #2c3e5e', color: '#fff' },
  acctEmail: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  connectBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer', marginTop: 8 },
  sideWarn: { color: '#fcd9a5', fontSize: 11, marginTop: 8 },
  sideNav: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16, borderTop: '1px solid #1f2937', paddingTop: 12 },
  navItem: { background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 10px', color: '#cbd5e1', cursor: 'pointer', textAlign: 'left', fontSize: 14 },
  navActive: { background: '#16223a', color: '#fff' },
  sideVersion: { color: '#4b5563', fontSize: 11, marginTop: 10 },

  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  errorBar: { background: '#1f1416', borderBottom: '1px solid #7f1d1d', color: '#fca5a5', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  errorClose: { background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer' },

  chatWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  chatHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #1f2937' },
  toggle: { display: 'flex', background: '#0d1320', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' },
  toggleBtn: { background: 'transparent', color: '#9ca3af', border: 'none', padding: '6px 14px', fontSize: 12, cursor: 'pointer' },
  toggleActive: { background: '#2563eb', color: '#fff', border: 'none', padding: '6px 14px', fontSize: 12, cursor: 'pointer' },
  chatTitle: { fontWeight: 600 },
  chatSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  ctxBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 20px', background: '#0d1320', borderBottom: '1px solid #1f2937', fontSize: 13, color: '#9ca3af' },
  ctxBarEdit: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', background: '#0d1320', borderBottom: '1px solid #1f2937', flexWrap: 'wrap' },
  ctxSelect: { background: '#161e2e', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 6, padding: '6px 8px', fontSize: 13, maxWidth: 200 },
  chatLog: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: '#6b7280', textAlign: 'center', maxWidth: 420, margin: '60px auto', lineHeight: 1.6, flexShrink: 0 },
  userMsg: { alignSelf: 'flex-end', background: '#2563eb', color: '#fff', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14 },
  asstMsg: { alignSelf: 'flex-start', background: '#161e2e', color: '#e5e7eb', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14, border: '1px solid #1f2937' },
  toolTrace: { color: '#93c5fd', fontSize: 11, marginBottom: 4 },
  composer: { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid #1f2937', alignItems: 'flex-end' },
  composerInput: {
    flex: 1,
    background: '#0d1320',
    color: '#e5e7eb',
    border: '1px solid #334155',
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

  confirm: { background: '#251c10', border: '1px solid #92651a', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: '#fcd9a5' },
  confirmDanger: { background: '#2a1416', border: '1px solid #b91c1c', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: '#fca5a5' },
  confirmHead: { fontWeight: 700 },
  proposalRows: { background: '#0b0f17', borderRadius: 8, padding: '4px 12px', margin: '6px 0 10px' },
  proposalRow: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid #1f2937', fontSize: 13 },
  proposalLabel: { color: '#9ca3af' },
  proposalValue: { color: '#e5e7eb', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' },
  editRow: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1f2937', flexWrap: 'wrap' },
  editInput: { flex: 1, maxWidth: 320, background: '#161e2e', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 6, padding: '6px 9px', fontSize: 13 },
  confirmNote: { color: '#9ca3af', fontSize: 11, marginTop: 8 },

  settings: { flex: 1, overflowY: 'auto', padding: 24, maxWidth: 720 },
  settingsTitle: { fontSize: 22, fontWeight: 700, margin: '0 0 16px' },
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: 18, marginBottom: 16, flexShrink: 0 },
  h2: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: '#9ca3af', margin: '0 0 12px' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1f2937', fontSize: 14 },
  warn: { background: '#251c10', border: '1px solid #92651a', borderRadius: 10, padding: 14, marginBottom: 16, color: '#fcd9a5', lineHeight: 1.5 },
  diag: { background: '#0f1722', border: '1px solid #1f2937', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#9ca3af', fontSize: 12 },
  codeBlock: { background: '#0b0f17', padding: '6px 8px', borderRadius: 6, color: '#e5e7eb', overflowX: 'auto' },
  formRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  select: { background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  input: { flex: 1, minWidth: 120, background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  ghostBtn: { background: '#1f2937', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  toggleOn: { background: '#1d4ed8', color: '#fff', border: '1px solid #2563eb', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
  toggleOff: { background: 'transparent', color: '#9ca3af', border: '1px solid #334155', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' },
  dangerGhost: { background: 'transparent', color: '#fca5a5', border: '1px solid #7f1d1d', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  dangerSolid: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  resultList: { listStyle: 'none', margin: '12px 0 0', padding: 0 },
  resultRow: { padding: '6px 0', borderBottom: '1px solid #1f2937', fontSize: 13, fontFamily: 'ui-monospace, monospace' },
  muted: { color: '#6b7280', fontSize: 13 },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
  linkBtn: { background: 'transparent', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },

  // Tag-suggestion review panel.
  reviewWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  reviewBody: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  pasteArea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 120,
    background: '#0d1320',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    resize: 'vertical',
    marginBottom: 8,
  },
  scanNum: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#9ca3af', flex: '0 0 auto' },
  scanNumInput: { width: 52, background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 8px', fontSize: 13 },
  scanSelect: { background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 8px', fontSize: 13 },
  reviewToolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 },
  reviewList: { display: 'flex', flexDirection: 'column', border: '1px solid #1f2937', borderRadius: 12, overflow: 'hidden', flexShrink: 0 },
  reviewRow: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderBottom: '1px solid #1f2937', background: '#111827' },
  reviewRowOk: { borderLeft: '3px solid #34d399', background: '#0f1b16' },
  reviewRowHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  reviewMetaLine: { color: '#9ca3af', fontSize: 12, marginTop: 3 },
  reviewEvidence: { color: '#6b7280', fontSize: 12, marginTop: 3, fontStyle: 'italic' },
  badge: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, borderRadius: 6, padding: '1px 7px' },
  typeChip: { fontSize: 11, color: '#93c5fd', background: '#10233f', border: '1px solid #1e3a5f', borderRadius: 6, padding: '1px 7px' },
  emChip: { fontSize: 11, color: '#fcd34d', background: '#3a2c0a', border: '1px solid #92651a', borderRadius: 6, padding: '1px 7px' },
  editGrid: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8, background: '#0b0f17', borderRadius: 8, padding: '4px 12px' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 12, rowGap: 3, marginTop: 5, fontSize: 12.5, color: '#cbd5e1', alignItems: 'start' },
  detailKey: { color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, paddingTop: 1 },
  invScroll: { maxHeight: 320, overflowY: 'auto', border: '1px solid #1f2937', borderRadius: 8 },
  invTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' },
  invTh: { textAlign: 'left', padding: '5px 8px', color: '#6b7280', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #1f2937', position: 'sticky', top: 0, background: '#111827' },
  invTd: { padding: '4px 8px', borderBottom: '1px solid #161e2e', color: '#cbd5e1', verticalAlign: 'top', overflow: 'hidden', textOverflow: 'ellipsis' },
  pageListScroll: { maxHeight: 300, overflowY: 'auto', border: '1px solid #1f2937', borderRadius: 8, marginTop: 8, padding: '4px 0' },
  pageRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12.5, cursor: 'pointer' },
  pagePath: { fontFamily: 'ui-monospace, monospace', color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
