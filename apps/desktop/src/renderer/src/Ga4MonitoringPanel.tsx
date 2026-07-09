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
// Solid accent colours for white-text surfaces (primary buttons + the hero severity badge). The theme
// --c-* accents INVERT to light pastels in dark mode (see memory: never put white on var(--c-*)), so
// these fixed mid-dark solids are used wherever white text sits on a filled accent — readable in BOTH modes.
const SOLID_BLUE = '#2563eb';
const SEV_SOLID: Record<string, string> = { critical: '#dc2626', high: '#dc2626', medium: '#b45309', low: '#b45309', info: '#475569' };
const HEALTH: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))', label: 'Healthy', icon: '🟢' },
};
const CHECK_PILL: Record<string, { label: string; color: string }> = {
  pass: { label: 'Pass', color: 'var(--c-green)' },
  warn: { label: 'Warning', color: 'var(--c-amber, #b8860b)' },
  fail: { label: 'Issue', color: 'var(--c-red)' },
  skip: { label: 'Not run', color: 'var(--text-muted)' },
};
/** Status tone for a KPI tile — colours the big number and the thin left accent border.
 *  `neutral` has no status (border falls back to the default). */
const TONE: Record<'red' | 'amber' | 'green' | 'neutral', { color: string }> = {
  red: { color: 'var(--c-red)' },
  amber: { color: 'var(--c-amber, #b8860b)' },
  green: { color: 'var(--c-green)' },
  neutral: { color: 'var(--text)' },
};

/** The Slack mark (official four-colour logo), inlined as SVG so it renders crisply at any size and
 *  needs no external asset. Decorative — the adjacent text labels it. */
function SlackMark({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 122.8 122.8" width={size} height={size} aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

/** A monochrome line icon per health-check TYPE (keyed by the engine's check id), so each row is
 *  scannable by category at a glance. Drawn with currentColor — the caller sets the (status) colour. */
const CHECK_ICON: Record<string, JSX.Element> = {
  data_flow: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  events: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>,
  trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M17 7h4v4" /></>,
  growth: <><path d="M4 20h16" /><path d="M7 20v-5" /><path d="M12 20v-10" /><path d="M17 20v-3" /></>,
  data_quality: <><path d="M4 4h16l-6.5 8v6l-3 2v-8z" /></>,
  consent_drift: <><path d="M12 2l8 3v6c0 5-3.4 8-8 10-4.6-2-8-5-8-10V5z" /><path d="M9 12l2 2 4-4" /></>,
  transactions: <><path d="M12 2v20" /><path d="M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></>,
  access: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L20 3" /><path d="M16 7l3 3" /></>,
  reconciliation: <><path d="M12 3v18" /><path d="M6 7h12" /><path d="M4 7l-2 5a3 3 0 006 0z" /><path d="M20 7l-2 5a3 3 0 006 0z" /></>,
  concentration: <><path d="M21.2 15.9A10 10 0 1 1 8 2.8" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></>,
  untagged: <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7" cy="7" r="1.3" /></>,
  invalid_traffic: <><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  referral_hygiene: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></>,
  pii: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  channel_shift: <><path d="M16 3h5v5" /><path d="M21 3l-8 8" /><path d="M8 21H3v-5" /><path d="M3 21l8-8" /></>,
};
function CheckTypeIcon({ id, size = 18 }: { id: string; size?: number }): JSX.Element {
  const inner = CHECK_ICON[id] ?? (<><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></>);
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>{inner}</svg>
  );
}

/** Scoped hover polish for the tiles — a subtle lift, no fake click affordance (the tile is not a link). */
const TILE_HOVER_CSS = `.ga4mon-tile{transition:box-shadow .13s ease, transform .13s ease}.ga4mon-tile:hover{box-shadow:0 4px 14px rgba(0,0,0,.18);transform:translateY(-1px)}`;

const box: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const card: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 };
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)', margin: '0 0 10px' };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const btn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...btn, background: SOLID_BLUE, color: '#fff', borderColor: 'transparent', fontWeight: 600 };
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

/** One overview metric — label + number + one line of context, in a plain (box-less) column. A thin
 *  vertical rule separates it from the previous metric (skip on the first). Colour lives only on the
 *  number (status tone). */
function Kpi({ heading, value, sub, tone = 'neutral', divider = false }: { heading: string; value: React.ReactNode; sub?: string; tone?: 'red' | 'amber' | 'green' | 'neutral'; divider?: boolean }): JSX.Element {
  const t = TONE[tone];
  return (
    <div style={{ flex: '1 1 160px', minWidth: 140, padding: divider ? '2px 0 2px 22px' : '2px 0', borderLeft: divider ? '1px solid var(--border)' : undefined }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)' }}>{heading}</div>
      <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, marginTop: 6, color: t.color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
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
        <div style={{ fontSize: 26, lineHeight: 1 }}>🟢</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-green)' }}>All clear — no issues detected</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>{run.summary}</div>
        </div>
        <button style={{ ...ghostBtn, color: 'var(--c-blue)', alignSelf: 'flex-start' }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
      </div>
    );
  }

  const col = SEV_COLOR[top.severity] ?? 'var(--c-red)';
  const solid = SEV_SOLID[top.severity] ?? '#dc2626';
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', borderColor: col, display: 'flex' }}>
      <div style={{ width: 6, background: solid, flexShrink: 0 }} />
      <div style={{ padding: 18, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: '#fff', background: solid, borderRadius: 6, padding: '3px 10px' }}>{top.severity}</span>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>Most urgent finding</span>
          {isNew && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--c-blue)', background: 'var(--c-blue-bg, rgba(59,130,246,.15))', borderRadius: 999, padding: '1px 8px' }}>NEW</span>}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10, lineHeight: 1.3 }}>{top.title}</div>
        <div style={{ fontSize: 14, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.55 }}>{top.detail}</div>
        {top.recommendation && (
          <div style={{ marginTop: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', marginBottom: 3 }}>Recommended fix</div>
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>{top.recommendation}</div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          <button style={{ ...primaryBtn, background: solid }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
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
    <div style={{ ...card, padding: 20, borderLeft: '3px solid var(--c-blue, #2563eb)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', color: 'var(--c-blue, #2563eb)', fontSize: 16 }}>✨</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>AI summary</span>
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

/** Plain-language "what this check verifies and why" per check type — revealed when a tile is expanded,
 *  so the operator's obvious next step (understand the signal) is one click away. */
const CHECK_EXPLAIN: Record<string, string> = {
  data_flow: 'Confirms sessions and users are still being recorded, so an outage or broken tag shows up as missing data.',
  events: 'Watches your key events for any that stopped firing or dropped sharply versus their recent baseline.',
  trend: 'Reads the direction of daily sessions across the trend window to catch a sustained rise or drop (today is excluded so an in-progress day is not misread).',
  growth: 'Compares conversion and revenue growth against session growth, so a traffic spike that does not convert is flagged instead of celebrated.',
  data_quality: 'Checks that traffic sources are attributed normally, rather than collapsing into (not set), self-referrals or internal traffic.',
  consent_drift: 'Tracks the share of sessions with no source; a rise often signals a Consent Mode v2 or cookie-banner change suppressing attribution.',
  transactions: 'Looks for duplicate or unlabelled purchase transactions that would inflate or distort reported revenue.',
  access: 'Verifies the monitor can still read this property’s reporting data (permissions, API access, quota).',
  reconciliation: 'Cross-checks campaign-reported revenue against channel-reported revenue; a big gap usually means paid traffic is landing in the wrong bucket (untagged) or being double-counted.',
  concentration: 'Flags when a single day, week or month dominates the totals — a sign of a spike, a backfill or a tracking glitch rather than steady traffic.',
  untagged: 'Measures the share of sessions with no campaign tags; a high share means paid or email traffic is being misattributed to organic or direct.',
  invalid_traffic: 'Looks for bot / invalid-traffic signatures (engagement patterns that do not look human) inflating your session counts.',
  referral_hygiene: 'Checks referral sources for self-referrals and payment-gateway domains that break attribution and pad referral traffic.',
  pii: 'Scans page paths for personal data (emails, names, ids) in URLs — a privacy risk that also fragments your reports.',
  channel_shift: 'Watches for a large shift in the channel mix versus the prior window, which can signal a tagging change rather than a real audience shift.',
};

// Bold the key figure in an insight — a percentage ("55% higher", "down 12%") or a currency amount
// ("INR 378,400", "$1,204") — so it jumps out of the sentence. Purely presentational; wording is untouched.
const FIGURE = /((?:INR|Rs\.?|₹|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)/g;
const FIGURE_ONE = /^(?:(?:INR|Rs\.?|₹|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)$/;
function emphasize(text: string): React.ReactNode {
  return text.split(FIGURE).map((part, i) =>
    FIGURE_ONE.test(part)
      ? <b key={i} style={{ fontWeight: 700, color: 'var(--text)' }}>{part}</b>
      : <span key={i}>{part}</span>,
  );
}

/** One health check as a PLAIN, EXPANDABLE tile: a neutral category icon, the label and a status pill.
 *  The insight is trimmed to a few lines with its key percentages emphasised; click (or Enter/Space on
 *  the Details button) to reveal the full insight plus a plain-language explainer of what the check does.
 *  The only colour on the card is the status pill. */
function CheckCard({ c }: { c: Ga4MonitorCheckView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const p = CHECK_PILL[c.status] ?? CHECK_PILL.skip;
  const explain = CHECK_EXPLAIN[c.id] ?? 'An additional health signal for this property.';
  const regionId = `ga4-check-${c.id}`;
  const toggle = (): void => setOpen((o) => !o);
  // Collapsed: clamp a long insight to 4 lines so the grid stays tidy; expanded shows it in full.
  const clamp: React.CSSProperties = open ? {} : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
  // The card body is a mouse convenience (click anywhere to expand); the real, keyboard-focusable and
  // screen-reader-named control is the inner <button>, so AT announces a concise name + expanded state.
  return (
    <div
      className="ga4mon-tile"
      onClick={toggle}
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }}><CheckTypeIcon id={c.id} /></span>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: p.color, background: 'var(--surface-2)', border: `1px solid ${p.color}`, borderRadius: 999, padding: '1px 8px' }}>{p.label}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5, ...clamp }}>{emphasize(c.detail)}</div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--c-blue)' }}
      >
        <span aria-hidden="true" style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease' }}>▸</span>
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <div id={regionId} style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{explain}</div>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Property identity + controls ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 18 }}>{t.propertyLabel || t.propertyId}</span>
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

          {/* ── How serious / how much? — a plain, box-less metric row ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 0, rowGap: 12, padding: '4px 0' }}>
            <Kpi
              heading="Open issues"
              value={run.alerts.length}
              tone={run.alerts.length ? (run.health === 'critical' ? 'red' : 'amber') : 'green'}
              sub={run.alerts.length ? `${run.alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length} high-priority` : 'none open'}
            />
            <Kpi
              divider
              heading="Checks passing"
              value={`${counts.pass}/${run.checks.length}`}
              tone={counts.fail === 0 && counts.warn === 0 ? 'green' : 'amber'}
              sub={counts.skip ? `${counts.skip} not run` : 'all checks ran'}
            />
            <Kpi
              divider
              heading="Needs attention"
              value={attention}
              tone={counts.fail ? 'red' : attention ? 'amber' : 'green'}
              sub={attention ? `${counts.fail} failing · ${counts.warn} warning` : 'nothing flagged'}
            />
            <Kpi divider heading="Last checked" value={fmtAgo(run.at)} sub={fmtTime(run.at)} />
          </div>

          {/* ── Why? ── */}
          <AiSummary run={run} />

          {/* ── What next? ── */}
          <div>
            <div style={sectionTitle}>Health checks</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}><SlackMark size={14} /> Slack channel</span>
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
    <div style={{ padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{TILE_HOVER_CSS}</style>
      {/* ── Header: identity + overall health + background status ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700 }}>🔔 GA4 Monitoring</h2>
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
                    background: on ? 'var(--surface-3)' : 'var(--surface-2)',
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600 }}><SlackMark size={16} /> Slack alerts</span>
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
