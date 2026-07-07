import { useEffect, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4MonitorTargetStatus, Ga4MonitorAlertView, Ga4MonitorCheckView, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab — a dashboard-per-property layout that answers, top to bottom:
//   What is the problem? → the CRITICAL ALERT hero (the single worst finding, or an all-clear).
//   How serious / how much? → the OVERVIEW KPI cards (open issues, checks passing, needs attention, last check).
//   Why? → the AI SUMMARY card (the engine's plain-language read + the recommended next step).
//   What next? → the HEALTH CHECK cards (every check as a pass/warn/fail tile) + the full alert list.
// The "Monitor a GA4 property" card sits at the TOP (add a property + schedule) so adding one is the
// first action; below it, one TAB per monitored property renders the dashboard above for the selection.
// Every value shown here traces to a real field on the monitor run (Ga4MonitoringService in main) —
// no derived "confidence" scores or metrics the engine does not actually produce.

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const SEV_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const HEALTH: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))', label: 'Healthy', icon: '🟢' },
};
const CHECK_PILL: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  pass: { label: 'Pass', color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))', icon: '✓' },
  warn: { label: 'Warning', color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))', icon: '!' },
  fail: { label: 'Issue', color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))', icon: '✕' },
  skip: { label: 'Not run', color: 'var(--text-muted)', bg: 'var(--surface-3)', icon: '–' },
};

const box: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const card: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 };
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)', margin: '0 0 10px' };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const btn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--c-blue)', color: '#fff', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** The three things a property can post to its Slack channel, with WHAT-YOU-GET copy shown in the
 *  channel add/edit forms so the choice is informed, not a mystery toggle. */
const NOTIFY_OPTS: Array<{ key: 'alerts' | 'digest' | 'audit'; label: string; desc: string; example: string }> = [
  {
    key: 'alerts',
    label: 'New issue alerts',
    desc: 'Posts the moment a NEW problem appears - no data, a key event stopping, spike/drop, revenue integrity. One post per issue; it never repeats while the issue stays open.',
    example: '\u{1F534} CRITICAL - Traffic changed but conversions did not keep pace + the fix',
  },
  {
    key: 'digest',
    label: 'Weekly health digest',
    desc: 'Every 7 days, even when everything is healthy - so a quiet channel proves the monitor is alive.',
    example: '\u{1F7E2} HEALTHY - Everything looks healthy · Checks: 6 pass · Open alerts: 0',
  },
  {
    key: 'audit',
    label: 'Weekly audit summary',
    desc: 'Every 7 days: runs the FULL GA4 audit and posts its executive summary. Heavier than a health check (~15+ API calls).',
    example: 'Reporting reliability 58% · Setup completeness 76/100 (B) · Biggest risk + highest-impact fix',
  },
];
type NotifyPrefs = { alerts: boolean; digest: boolean; audit: boolean };

/** The checkbox rows shared by the add-property flow and the channel editor. */
function NotifyPicker({ value, onChange, disabled }: { value: NotifyPrefs; onChange: (v: NotifyPrefs) => void; disabled: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>What should this channel receive?</span>
      {NOTIFY_OPTS.map((o) => (
        <label key={o.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5 }}>
          <input type="checkbox" style={{ marginTop: 2 }} checked={value[o.key]} disabled={disabled} onChange={(e) => onChange({ ...value, [o.key]: e.target.checked })} />
          <span style={{ lineHeight: 1.45 }}>
            <b>{o.label}</b> - <span style={{ color: 'var(--text-muted)' }}>{o.desc}</span>
            <br />
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)' }}>e.g. {o.example}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function fmtTime(ms: number | null): string {
  if (!ms) return 'never';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}
/** Compact relative time ("just now", "12 min ago", "3 hr ago", then a date). */
function fmtAgo(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return '—'; }
}

const INTERVAL_PRESETS = [15, 30, 60, 120, 240, 720, 1440];
/** "45 min", "1 hr", "2 hr 30 min" — never a fractional-hour label, whatever the persisted value. */
function fmtInterval(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** The single worst alert in a run (highest severity), or null when the run is clean. */
function topAlert(run: Ga4MonitorRun): Ga4MonitorAlertView | null {
  if (!run.alerts.length) return null;
  return [...run.alerts].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0))[0];
}

/** Count checks by status once, for the KPI cards + the pass/fail read-out. */
function tallyChecks(checks: Ga4MonitorCheckView[]): Record<'pass' | 'warn' | 'fail' | 'skip', number> {
  const c = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const x of checks) c[x.status] = (c[x.status] ?? 0) + 1;
  return c;
}

/** One overview metric tile — big number + label + one line of context. */
function Kpi({ heading, value, sub, color }: { heading: string; value: React.ReactNode; sub?: string; color?: string }): JSX.Element {
  return (
    <div style={{ flex: '1 1 150px', minWidth: 140, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)' }}>{heading}</div>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.15, marginTop: 6, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

/** THE HERO — the one thing the operator should look at first: the worst open finding, or an
 *  all-clear when the run is healthy. Answers "what is the problem, and how serious is it?" */
function HeroCard({ run, isRunning, disabled, onRun }: { run: Ga4MonitorRun; isRunning: boolean; disabled: boolean; onRun: () => void }): JSX.Element {
  const top = topAlert(run);
  const isNew = top ? run.newAlertIds.includes(top.id) : false;

  if (!top) {
    return (
      <div style={{ ...card, borderColor: 'var(--c-green)', background: 'var(--c-green-bg, rgba(34,197,94,.08))', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 34, lineHeight: 1 }}>🟢</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--c-green)' }}>All clear — no issues detected</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>{run.summary}</div>
        </div>
        <button style={{ ...ghostBtn, color: 'var(--c-blue)', alignSelf: 'flex-start' }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
      </div>
    );
  }

  const col = SEV_COLOR[top.severity] ?? 'var(--c-red)';
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', borderColor: col, display: 'flex' }}>
      <div style={{ width: 6, background: col, flexShrink: 0 }} />
      <div style={{ padding: 18, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: '#fff', background: col, borderRadius: 6, padding: '3px 10px' }}>{top.severity}</span>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>Most urgent finding</span>
          {isNew && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--c-blue)', background: 'var(--c-blue-bg, rgba(59,130,246,.15))', borderRadius: 999, padding: '1px 8px' }}>NEW</span>}
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 10, lineHeight: 1.25 }}>{top.title}</div>
        <div style={{ fontSize: 14, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.55 }}>{top.detail}</div>
        {top.recommendation && (
          <div style={{ marginTop: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', marginBottom: 3 }}>Recommended fix</div>
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>{top.recommendation}</div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          <button style={{ ...primaryBtn, background: col }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
          {run.alerts.length > 1 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>+{run.alerts.length - 1} more {run.alerts.length - 1 === 1 ? 'alert' : 'alerts'} below</span>}
        </div>
      </div>
    </div>
  );
}

/** The engine's plain-language read of the run + the single recommended next step. Grounded in
 *  run.summary (always present) and the top alert's recommendation (when there is one). */
function AiSummary({ run }: { run: Ga4MonitorRun }): JSX.Element {
  const top = topAlert(run);
  const nextStep = top?.recommendation || (top ? `Investigate: ${top.title}.` : 'No action needed — keep the background monitor running so a new issue pages you the moment it appears.');
  const h = HEALTH[run.health] ?? HEALTH.healthy;
  return (
    <div style={{ ...card, background: 'var(--c-blue-bg, rgba(37,99,235,.06))', borderColor: 'var(--c-blue, #2563eb)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>✨</span>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.3 }}>AI summary</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: h.color, background: h.bg, borderRadius: 999, padding: '2px 10px' }}>{h.icon} {h.label}</span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}>{run.summary}</div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--c-blue-bg, rgba(37,99,235,.15))', color: 'var(--c-blue, #2563eb)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, flexShrink: 0, marginTop: 1 }}>→</span>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>Recommended next step</div>
          <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 2, lineHeight: 1.5 }}>{nextStep}</div>
        </div>
      </div>
    </div>
  );
}

/** One health check rendered as a status tile (icon + label + what-we-found). */
function CheckCard({ c }: { c: Ga4MonitorCheckView }): JSX.Element {
  const p = CHECK_PILL[c.status] ?? CHECK_PILL.skip;
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderLeft: `3px solid ${p.color}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: p.bg, color: p.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>{p.icon}</span>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: p.color, background: p.bg, borderRadius: 999, padding: '1px 8px' }}>{p.label}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>{c.detail}</div>
    </div>
  );
}

/** The full alert list (below the hero) — one compact row per alert, worst first, so nothing hides. */
function AlertList({ run }: { run: Ga4MonitorRun }): JSX.Element {
  const newIds = new Set(run.newAlertIds);
  const alerts = [...run.alerts].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  return (
    <div>
      <div style={sectionTitle}>All alerts ({alerts.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {alerts.map((a) => (
          <div key={a.id} style={{ borderLeft: `3px solid ${SEV_COLOR[a.severity] ?? 'var(--border)'}`, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, color: SEV_COLOR[a.severity] ?? 'var(--text)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{a.severity}</span>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{a.title}</span>
              {newIds.has(a.id) && <span style={{ fontSize: 10, background: 'var(--c-blue-bg, rgba(59,130,246,.15))', color: 'var(--c-blue)', borderRadius: 999, padding: '1px 7px', fontWeight: 800 }}>NEW</span>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>{a.detail}</div>
            {a.recommendation && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}><b>Fix:</b> {a.recommendation}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The selected property's dashboard: identity + controls, then (when a run exists) the hero,
 *  KPI cards, AI summary, health-check tiles and full alert list, then this property's Slack channel. */
function PropertyPanel({ t, runningId, busy, onRun, onTogglePause, onRemove, onSaveChannel, onTestChannel, onRemoveChannel }: {
  t: Ga4MonitorTargetStatus;
  runningId: string | null;
  busy: boolean;
  onRun: () => void;
  onTogglePause: () => void;
  onRemove: () => void;
  onSaveChannel: (url: string, label: string, notify: NotifyPrefs) => Promise<boolean>;
  onTestChannel: () => void;
  onRemoveChannel: () => void;
}): JSX.Element {
  const [editingChan, setEditingChan] = useState(false);
  const [chanUrl, setChanUrl] = useState('');
  const [chanLbl, setChanLbl] = useState('');
  const [chanNotify, setChanNotify] = useState<NotifyPrefs>({ alerts: true, digest: false, audit: false });
  const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
  const isRunning = runningId === t.propertyId || runningId === '*';
  const runDisabled = runningId !== null;
  const run = t.lastRun;
  const counts = run ? tallyChecks(run.checks) : null;
  const attention = counts ? counts.fail + counts.warn : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Property identity + controls ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: 22 }}>{t.propertyLabel || t.propertyId}</span>
            {h ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: h.color, background: h.bg, borderRadius: 999, padding: '2px 10px' }}>
                {h.icon} {h.label}
              </span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 10px' }}>⚪ No check yet</span>
            )}
            {!t.enabled && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 8px' }}>PAUSED</span>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{t.propertyId.replace('properties/', '')}</span>
            <span title={t.lastRunAt ? `Last check: ${fmtTime(t.lastRunAt)}` : undefined}>checked: {fmtAgo(t.lastRunAt)}</span>
            <span title={t.lastSlackAt ? `Last Slack alert: ${fmtTime(t.lastSlackAt)}` : 'No alert has been posted for this property yet'}>📣 last alert: {t.lastSlackAt ? fmtAgo(t.lastSlackAt) : 'none yet'}</span>
            {t.lastError && <span style={{ color: 'var(--c-red)', fontFamily: 'inherit' }} title={t.lastError}>last check failed</span>}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...ghostBtn, color: 'var(--c-blue)' }} disabled={runDisabled} onClick={onRun}>{isRunning ? 'Checking…' : '▶ Run check'}</button>
          <button style={ghostBtn} disabled={busy} title={t.enabled ? 'Pause background checks for this property' : 'Resume background checks'} onClick={onTogglePause}>{t.enabled ? '⏸ Pause' : '⏵ Resume'}</button>
          <button style={{ ...ghostBtn, color: 'var(--c-red)' }} disabled={busy} title="Stop monitoring this property" onClick={onRemove}>Remove</button>
        </div>
      </div>

      {run && counts ? (
        <>
          {/* ── What is the problem? ── */}
          <HeroCard run={run} isRunning={isRunning} disabled={runDisabled} onRun={onRun} />

          {/* ── How serious / how much? ── */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Kpi
              heading="Open issues"
              value={run.alerts.length}
              color={run.alerts.length ? (run.health === 'critical' ? 'var(--c-red)' : 'var(--c-amber, #b8860b)') : 'var(--c-green)'}
              sub={run.alerts.length ? `${run.alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length} high-priority` : 'none open'}
            />
            <Kpi
              heading="Checks passing"
              value={`${counts.pass}/${run.checks.length}`}
              color={counts.pass === run.checks.length ? 'var(--c-green)' : 'var(--text)'}
              sub={counts.skip ? `${counts.skip} not run` : 'all checks ran'}
            />
            <Kpi
              heading="Needs attention"
              value={attention}
              color={counts.fail ? 'var(--c-red)' : attention ? 'var(--c-amber, #b8860b)' : 'var(--c-green)'}
              sub={attention ? `${counts.fail} failing · ${counts.warn} warning` : 'nothing flagged'}
            />
            <Kpi heading="Last checked" value={fmtAgo(run.at)} sub={fmtTime(run.at)} />
          </div>

          {/* ── Why? ── */}
          <AiSummary run={run} />

          {/* ── What next? ── */}
          <div>
            <div style={sectionTitle}>Health checks</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {run.checks.map((c) => <CheckCard key={c.id} c={c} />)}
            </div>
          </div>

          {run.alerts.length > 1 && <AlertList run={run} />}
        </>
      ) : (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '36px 20px', color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 28 }}>🔍</span>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>No check has run for this property yet</div>
          <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
            Click <b>▶ Run check</b> above to verify data flow, key events, spikes/drops, conversion tracking and revenue integrity.
          </div>
        </div>
      )}

      {/* ── This property's Slack channel ── */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>💬 Slack channel</span>
          {t.hasWebhook ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--c-green-bg, rgba(34,197,94,.12))', color: 'var(--c-green)', borderRadius: 999, padding: '3px 12px', fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
                {t.slackLabel || 'own channel connected'}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                sends: {NOTIFY_OPTS.filter((o) => (o.key === 'alerts' ? t.notify?.alerts !== false : Boolean(t.notify?.[o.key]))).map((o) => o.label.toLowerCase()).join(' · ') || 'nothing selected'}
                {t.lastSlackAt ? ` · last posted ${fmtAgo(t.lastSlackAt)}` : ''}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
              no channel connected — this property will not alert Slack until you connect one
            </span>
          )}
          <span style={{ flex: 1 }} />
          {t.hasWebhook && <button style={ghostBtn} disabled={busy} onClick={onTestChannel}>Send test</button>}
          <button
            style={{ ...ghostBtn, color: 'var(--c-blue)' }}
            disabled={busy}
            onClick={() => { setEditingChan((v) => !v); setChanUrl(''); setChanLbl(t.slackLabel ?? ''); setChanNotify({ alerts: t.notify?.alerts !== false, digest: Boolean(t.notify?.digest), audit: Boolean(t.notify?.audit) }); }}
          >
            {editingChan ? 'Close' : t.hasWebhook ? '✎ Edit channel' : '＋ Connect channel'}
          </button>
        </div>
        {editingChan && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                style={{ ...input, flex: 2, minWidth: 240, fontSize: 12.5 }}
                type="password"
                placeholder={t.hasWebhook ? 'New webhook URL (leave empty to keep the current one)' : 'https://hooks.slack.com/services/…'}
                value={chanUrl}
                onChange={(e) => setChanUrl(e.target.value)}
              />
              <input
                style={{ ...input, flex: 1, minWidth: 150, fontSize: 12.5 }}
                type="text"
                placeholder="#acme-alerts (channel name)"
                value={chanLbl}
                onChange={(e) => setChanLbl(e.target.value)}
              />
              <button
                style={primaryBtn}
                disabled={busy || (!chanUrl.trim() && !t.hasWebhook)}
                onClick={() => { void onSaveChannel(chanUrl.trim(), chanLbl.trim(), chanNotify).then((ok) => { if (ok) { setEditingChan(false); setChanUrl(''); } }); }}
              >
                Save
              </button>
              {t.hasWebhook && (
                <button style={{ ...ghostBtn, color: 'var(--c-red)', alignSelf: 'center' }} disabled={busy} onClick={() => { onRemoveChannel(); setEditingChan(false); setChanUrl(''); setChanLbl(''); }}>
                  Remove channel
                </button>
              )}
            </div>
            <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
              <NotifyPicker value={chanNotify} onChange={setChanNotify} disabled={busy} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.4 }}>
              One property, one channel: everything selected above posts here. The URL is stored encrypted in your OS keychain. (How to get a webhook URL — see the Slack alerts card below.)
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Ga4MonitoringPanel({ active, onError }: { active: AccountView | undefined; onError: (m: string) => void }): JSX.Element {
  const signedIn = Boolean(active?.hasGoogleToken);
  const [properties, setProperties] = useState<Ga4PropertyListItem[] | null>(null);
  const [status, setStatus] = useState<Ga4MonitorStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addId, setAddId] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null); // propertyId, or '*' for a full sweep
  // Optional Slack channel captured WHILE adding a property (link + name + what to send, one step).
  const [addChanUrl, setAddChanUrl] = useState('');
  const [addChanLabel, setAddChanLabel] = useState('');
  const [addNotify, setAddNotify] = useState<NotifyPrefs>({ alerts: true, digest: false, audit: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function refreshStatus(): Promise<void> {
    try { setStatus(await window.desktop.ga4monitoring.status()); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => {
    void refreshStatus();
    if (signedIn) window.desktop.ga4.listProperties().then(setProperties).catch((e) => { onError(e instanceof Error ? e.message : String(e)); setProperties([]); });
    // Live runs (background sweeps + on-demand) → re-pull status (it carries every target's lastRun).
    const off = window.desktop.ga4monitoring.onRun(() => { void refreshStatus(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const targets: Ga4MonitorTargetStatus[] = status?.targetStatuses ?? [];
  // Keep a valid selection: follow the list (first target by default, next one after a removal).
  useEffect(() => {
    if (!targets.length) { setSelectedId(null); return; }
    if (!selectedId || !targets.some((t) => t.propertyId === selectedId)) setSelectedId(targets[0].propertyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function configure(patch: Parameters<typeof window.desktop.ga4monitoring.configure>[0]): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try { setStatus(await window.desktop.ga4monitoring.configure(patch)); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  /** Add a property — and, when the optional Slack fields were filled in the same step, connect its
   *  own channel first (setWebhook validates the URL, so a bad link aborts BEFORE the property is
   *  added and nothing half-configured is left behind). */
  async function addProperty(): Promise<void> {
    const prop = properties?.find((p) => p.property === addId);
    if (!prop || !status) return;
    setBusy(true); onError(''); setNote('');
    try {
      const url = addChanUrl.trim();
      const lbl = addChanLabel.trim();
      if (url) await window.desktop.ga4monitoring.setWebhook(url, prop.property);
      setStatus(await window.desktop.ga4monitoring.configure({
        targets: [...status.targets, { propertyId: prop.property, propertyLabel: prop.displayName, enabled: true, slackLabel: lbl || undefined, notify: addNotify }],
      }));
      setAddId(''); setAddChanUrl(''); setAddChanLabel(''); setAddNotify({ alerts: true, digest: false, audit: false });
      setSelectedId(prop.property);
      if (url) setNote(`Added ${prop.displayName} with its own Slack channel${lbl ? ` (${lbl})` : ''}.`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  function removeProperty(propertyId: string): void {
    if (!status) return;
    void configure({ targets: status.targets.filter((t) => t.propertyId !== propertyId) });
  }
  function togglePaused(propertyId: string): void {
    if (!status) return;
    void configure({ targets: status.targets.map((t) => (t.propertyId === propertyId ? { ...t, enabled: !t.enabled } : t)) });
  }

  async function runNow(propertyId?: string): Promise<void> {
    if (runningId) return;
    setRunningId(propertyId ?? '*'); onError(''); setNote('');
    try {
      const runs = await window.desktop.ga4monitoring.runNow(propertyId);
      if (!runs.length) setNote('Nothing to check — add a property and make sure the account is signed in to Google.');
      else {
        const sent = runs.reduce((s, r) => s + r.slackSent, 0);
        const err = runs.map((r) => r.slackError).find(Boolean);
        setNote(err ? `Slack: ${err}` : sent ? `Posted new issues to Slack (${sent} propert${sent === 1 ? 'y' : 'ies'}).` : '');
        if (propertyId) setSelectedId(propertyId);
      }
      void refreshStatus();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setRunningId(null); }
  }

  // ── Per-property channel handlers (used by the open property's panel) ──
  async function savePropertyChannel(propertyId: string, url: string, lbl: string, notify: NotifyPrefs): Promise<boolean> {
    if (!status) return false;
    setBusy(true); onError(''); setNote('');
    try {
      if (url) await window.desktop.ga4monitoring.setWebhook(url, propertyId);
      setStatus(await window.desktop.ga4monitoring.configure({
        targets: status.targets.map((t) => (t.propertyId === propertyId ? { ...t, slackLabel: lbl || undefined, notify } : t)),
      }));
      setNote(url ? 'Property channel saved (encrypted) — new issues for this property will post there.' : 'Channel name saved.');
      return true;
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  }
  async function removePropertyChannel(propertyId: string): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try { setStatus(await window.desktop.ga4monitoring.clearWebhook(propertyId)); setNote('Property channel removed — its alerts fall back to the default channel.'); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function testPropertyChannel(propertyId: string): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const r = await window.desktop.ga4monitoring.sendTest(propertyId);
      setNote(r.ok ? 'Test sent — check Slack to confirm which channel this property alerts.' : `Test failed: ${r.error ?? 'unknown error'}`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const addable = (properties ?? []).filter((p) => !targets.some((t) => t.propertyId === p.property));
  const selected = targets.find((t) => t.propertyId === selectedId) ?? null;
  const enabledCount = targets.filter((t) => t.enabled).length;
  // Overall health across every monitored property, so the header pill answers "is anything wrong?"
  const worst = targets.reduce<'critical' | 'warning' | 'healthy' | null>((acc, t) => {
    const hh = t.lastRun?.health;
    if (hh === 'critical' || acc === 'critical') return 'critical';
    if (hh === 'warning' || acc === 'warning') return 'warning';
    if (hh === 'healthy') return acc ?? 'healthy';
    return acc;
  }, null);
  const openIssues = targets.reduce((s, t) => s + (t.lastRun?.alerts.length ?? 0), 0);

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Sign in to Google on this account to monitor GA4 properties.</div>;
  }

  const intervalText = status ? fmtInterval(status.intervalMinutes) : '';
  // Always include the persisted interval in the dropdown so a legacy/off-preset value stays selected.
  const intervalOpts = status && !INTERVAL_PRESETS.includes(status.intervalMinutes)
    ? [...INTERVAL_PRESETS, status.intervalMinutes].sort((a, b) => a - b)
    : INTERVAL_PRESETS;

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header: identity + overall health + background status ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 26, fontWeight: 800 }}>🔔 GA4 Monitoring</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>
            {targets.length
              ? <>Watching <b>{targets.length}</b> propert{targets.length === 1 ? 'y' : 'ies'} · <b style={{ color: openIssues ? 'var(--c-red)' : 'var(--c-green)' }}>{openIssues}</b> open issue{openIssues === 1 ? '' : 's'} across all.</>
              : 'Background health checks for your GA4 properties — data flow, key events, spikes/drops, conversion tracking and revenue integrity.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          {worst && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: HEALTH[worst].color, background: HEALTH[worst].bg, border: `1px solid ${HEALTH[worst].color}`, borderRadius: 999, padding: '4px 12px' }}>
              {HEALTH[worst].icon} {HEALTH[worst].label}
            </span>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: status?.running ? 'var(--c-green)' : 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 12px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.running ? 'var(--c-green)' : 'var(--text-faint)', display: 'inline-block' }} />
            {status?.running ? `background on · every ${intervalText}` : 'background off'}
          </span>
        </div>
      </div>

      {note && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{note}</div>}
      {status?.lastError && <div style={{ fontSize: 12.5, color: 'var(--c-red)' }}>Last sweep error — {status.lastError}</div>}

      {/* ── Monitor a GA4 property (top of page): add a property (+ its optional Slack channel) and
             the shared schedule. Placed above the dashboard so adding a property is the first action,
             not something you scroll past the dashboard to reach. ── */}
      <div style={card}>
        <div style={{ ...sectionTitle, marginBottom: 14 }}>Monitor a GA4 property</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260, flex: 1 }}>
            <span style={label}>Add a GA4 property for monitoring</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <select style={{ ...input, flex: 1 }} value={addId} onChange={(e) => { setAddId(e.target.value); setAddChanUrl(''); setAddChanLabel(''); }}>
                <option value="">{properties === null ? 'Loading…' : addable.length ? 'Select a property…' : targets.length ? 'All accessible properties are being monitored' : 'No properties found'}</option>
                {addable.map((p) => (
                  <option key={p.property} value={p.property}>{p.displayName} ({p.property.replace('properties/', '')})</option>
                ))}
              </select>
              <button style={primaryBtn} onClick={() => void addProperty()} disabled={busy || !addId}>+ Add</button>
            </div>
            {addId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input style={{ ...input, flex: 2, minWidth: 220, fontSize: 12 }} type="password" placeholder="Slack webhook for this property (optional — connect later from its tab)" value={addChanUrl} onChange={(e) => setAddChanUrl(e.target.value)} />
                  <input style={{ ...input, flex: 1, minWidth: 130, fontSize: 12 }} type="text" placeholder="#channel name" value={addChanLabel} onChange={(e) => setAddChanLabel(e.target.value)} />
                </div>
                <div style={{ background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                  <NotifyPicker value={addNotify} onChange={setAddNotify} disabled={busy} />
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={label}>Check every</span>
            <select style={input} value={status?.intervalMinutes ?? 60} onChange={(e) => void configure({ intervalMinutes: Number(e.target.value) })}>
              {intervalOpts.map((m) => <option key={m} value={m}>{fmtInterval(m)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={label}>Trend window</span>
            <select style={input} value={status?.days ?? 28} onChange={(e) => void configure({ days: Number(e.target.value) })}>
              {[7, 14, 28, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 7 }}>
            <input type="checkbox" checked={Boolean(status?.enabled)} disabled={busy || !targets.length} onChange={(e) => void configure({ enabled: e.target.checked })} />
            Run in the background
          </label>
          <button style={primaryBtn} onClick={() => void runNow()} disabled={runningId !== null || enabledCount === 0}>
            {runningId === '*' ? 'Checking all…' : enabledCount > 1 ? `▶ Run all (${enabledCount})` : '▶ Run now'}
          </button>
        </div>
      </div>

      {/* ── Property tabs + the selected property's dashboard ── */}
      {targets.length === 0 ? (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 30 }}>📡</span>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>No properties monitored yet</div>
          <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 460, lineHeight: 1.5 }}>
            Pick a GA4 property in the <b>Monitor a GA4 property</b> panel above and click <b>＋ Add</b>. Each check verifies data flow, key events, spikes/drops, conversion tracking and revenue integrity — and can alert your Slack channel when something breaks.
          </div>
        </div>
      ) : (
        <div>
          <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {targets.map((t) => {
              const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
              const on = t.propertyId === selectedId;
              const alertCount = t.lastRun?.alerts.length ?? 0;
              return (
                <button
                  key={t.propertyId}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setSelectedId(t.propertyId)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    background: on ? 'var(--c-blue-bg, rgba(59,130,246,.12))' : 'var(--surface-2)',
                    color: 'var(--text)',
                    border: `1px solid ${on ? 'var(--c-blue)' : 'var(--border)'}`,
                    borderRadius: 9, padding: '7px 14px', cursor: 'pointer', fontSize: 13,
                    fontWeight: on ? 700 : 500,
                    opacity: t.enabled ? 1 : 0.55,
                  }}
                  title={`${t.propertyLabel || t.propertyId} (${t.propertyId.replace('properties/', '')})${t.enabled ? '' : ' — paused'}`}
                >
                  <span style={{ fontSize: 12 }}>{h ? h.icon : '⚪'}</span>
                  <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.propertyLabel || t.propertyId.replace('properties/', '')}</span>
                  {alertCount > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: h?.color ?? 'var(--text)', background: h?.bg ?? 'var(--surface-3)', borderRadius: 999, padding: '1px 7px' }}>{alertCount}</span>
                  )}
                </button>
              );
            })}
          </div>
          {selected && (
            <PropertyPanel
              key={selected.propertyId}
              t={selected}
              runningId={runningId}
              busy={busy}
              onRun={() => void runNow(selected.propertyId)}
              onTogglePause={() => togglePaused(selected.propertyId)}
              onRemove={() => removeProperty(selected.propertyId)}
              onSaveChannel={(url, lbl, notify) => savePropertyChannel(selected.propertyId, url, lbl, notify)}
              onTestChannel={() => void testPropertyChannel(selected.propertyId)}
              onRemoveChannel={() => void removePropertyChannel(selected.propertyId)}
            />
          )}
        </div>
      )}

      {/* ── Slack alerts how-to: each property has its OWN channel (connect it from the property's
             dashboard above) — there is no shared default channel. ── */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Slack alerts</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
          One property, one channel: connect each property's Slack channel from its dashboard above (<b>＋ Connect channel</b> / <b>✎ Edit channel</b>) and pick <b>what it receives</b> there — new issue alerts, the weekly health digest, and/or the weekly audit summary. How to get a webhook URL for a channel:
        </div>
        <ol style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, paddingLeft: 18 }}>
          <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--c-blue)' }}>api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> (or pick an existing app), then choose your workspace.</li>
          <li>In the app’s left menu open <b>Incoming Webhooks</b> and toggle <b>Activate Incoming Webhooks</b> to <b>On</b>.</li>
          <li>Click <b>Add New Webhook to Workspace</b>, pick the <b>channel</b> the alerts should post to, then <b>Allow</b>. (The channel is baked into the URL — that’s how you pick where alerts land.)</li>
          <li>Copy the generated <b>Webhook URL</b> — it starts with <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>https://hooks.slack.com/services/</code>.</li>
        </ol>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>The URL is stored encrypted in your OS keychain (never synced or logged). An ongoing issue is posted once per property, not on every check.</div>
      </div>

      {/* ── Footer status line ── */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>Background: <b style={{ color: status?.running ? 'var(--c-green)' : 'var(--text-faint)' }}>{status?.running ? 'on' : 'off'}</b></span>
        <span>Last check: {fmtTime(status?.lastRunAt ?? null)}</span>
        <span>Last Slack alert: {status?.lastSlackAt ? fmtTime(status.lastSlackAt) : 'none sent yet'}</span>
      </div>
    </div>
  );
}
