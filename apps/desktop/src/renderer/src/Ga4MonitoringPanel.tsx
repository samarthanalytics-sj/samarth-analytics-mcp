import { useEffect, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4MonitorTargetStatus, Ga4MonitorAlertView, Ga4MonitorCheckView, Ga4MonitorHistoryEntry, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab - a dashboard-per-property layout that answers, top to bottom:
//   What is the problem? → the CRITICAL ALERT hero (the single worst finding, or an all-clear).
//   How serious / how much? → the OVERVIEW KPI cards (open issues, checks passing, needs attention, last check).
//   Why? → the AI SUMMARY card (the engine's plain-language read + the recommended next step).
//   What next? → the HEALTH CHECK cards (every check as a pass/warn/fail tile) + the full alert list.
// The "Monitor a GA4 property" card sits at the TOP (add a property + schedule) so adding one is the
// first action; below it, one TAB per monitored property renders the dashboard above for the selection.
// Every value shown here traces to a real field on the monitor run (Ga4MonitoringService in main) -
// no derived "confidence" scores or metrics the engine does not actually produce.

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const SEV_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
// Solid accent colours for white-text surfaces (primary buttons + the hero severity badge). The theme
// --c-* accents INVERT to light pastels in dark mode (see memory: never put white on var(--c-*)), so
// these fixed mid-dark solids are used wherever white text sits on a filled accent - readable in BOTH modes.
const SOLID_BLUE = '#2563eb';
// Solid severity fills: every value carries WHITE text at >= 4.5:1 (AA) in both themes.
const SEV_SOLID: Record<string, string> = { critical: 'var(--danger)', high: 'var(--danger)', medium: '#b45309', low: '#b45309', info: '#475569' };
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

/** The Slack mark (official four-colour logo), inlined as SVG so it renders crisply at any size and
 *  needs no external asset. Decorative - the adjacent text labels it. */
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
 *  scannable by category at a glance. Drawn with currentColor - the caller sets the (status) colour. */
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
  consent_signal: <><circle cx="12" cy="12" r="1.8" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M8.5 15.5a5 5 0 0 1 0-7" /><path d="M18.4 5.6a9 9 0 0 1 0 12.8" /><path d="M5.6 18.4a9 9 0 0 1 0-12.8" /></>,
  freshness: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
  bigquery: <><path d="M20.4 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 3 16.3" /><path d="M12 12v9" /><path d="M8 16l4-4 4 4" /></>,
};
function CheckTypeIcon({ id, size = 18 }: { id: string; size?: number }): JSX.Element {
  const inner = CHECK_ICON[id] ?? (<><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></>);
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>{inner}</svg>
  );
}

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
const NOTIFY_OPTS: Array<{ key: 'alerts' | 'digest' | 'audit' | 'monthly'; label: string; desc: string; example: string }> = [
  {
    key: 'alerts',
    label: 'New issue alerts',
    desc: 'Posts the moment a NEW problem appears - no data, a key event stopping, spike/drop, revenue integrity. One post per issue; it never repeats while the issue stays open.',
    example: '\u{1F534} CRITICAL - Traffic changed but conversions did not keep pace + the fix',
  },
  {
    key: 'digest',
    label: 'Weekly all-clear',
    desc: 'Every 7 days. When everything passed it is ONE line you skim in two seconds; it expands to the full digest only when issues are open. Alerts interrupt - this just proves the monitor is alive.',
    example: '\u2705 All clear this week on Acme: every check passed.',
  },
  {
    key: 'monthly',
    label: 'Monthly tracking report',
    desc: 'Every 30 days, always - the story of the month: verdict, the data-trust number and how it moved, what was caught and what got fixed, what is still open, your numbers with a trust flag, and one recommendation.',
    example: '\u{1F4C5} Tracking held steady this month · Quotable data: 46%, up from 38%',
  },
  {
    key: 'audit',
    label: 'Weekly audit summary',
    desc: 'Every 7 days: runs the FULL GA4 audit and posts its executive summary. Heavier than a health check (~15+ API calls).',
    example: 'Reporting reliability 58% · Setup completeness 76/100 (B) · Biggest risk + highest-impact fix',
  },
];
type NotifyPrefs = { alerts: boolean; digest: boolean; audit: boolean; monthly: boolean };

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
  try { return new Date(ms).toLocaleString(); } catch { return '-'; }
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
  try { return new Date(ms).toLocaleDateString(); } catch { return '-'; }
}

const INTERVAL_PRESETS = [15, 30, 60, 120, 240, 720, 1440];
/** "45 min", "1 hr", "2 hr 30 min" - never a fractional-hour label, whatever the persisted value. */
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

/** THE HERO - the one thing the operator should look at first: the worst open finding, or an
 *  all-clear when the run is healthy. Answers "what is the problem, and how serious is it?" */
function HeroCard({ run, isRunning, disabled, onRun }: { run: Ga4MonitorRun; isRunning: boolean; disabled: boolean; onRun: () => void }): JSX.Element {
  const top = topAlert(run);
  const isNew = top ? run.newAlertIds.includes(top.id) : false;

  if (!top) {
    return (
      <div style={{ ...card, borderColor: 'var(--c-green)', background: 'var(--c-green-bg, rgba(34,197,94,.08))', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 26, lineHeight: 1 }}>🟢</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-green)' }}>All clear - no issues detected</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>{run.summary}</div>
        </div>
        <button style={{ ...ghostBtn, color: 'var(--c-blue)', alignSelf: 'flex-start' }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
      </div>
    );
  }

  const solid = SEV_SOLID[top.severity] ?? 'var(--danger)';
  // Real supporting lines only: the engine's structured metric lines as "evidence", its impact line
  // when it exists, and the recommended actions. Nothing here is fabricated for the layout.
  const evidence = (top.summaryLines ?? []).slice(0, 3);
  const actions = top.actions?.length ? top.actions : top.recommendation ? [top.recommendation] : [];
  return (
    <div style={{ ...card, padding: 18, borderLeft: `4px solid ${solid}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: '#fff', background: solid, borderRadius: 6, padding: '3px 10px' }}>{top.severity}</span>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>Most urgent finding</span>
        <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>· {fmtAgo(run.at)}</span>
        {isNew && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--c-blue)', background: 'var(--c-blue-bg, rgba(59,130,246,.15))', borderRadius: 999, padding: '1px 8px' }}>NEW</span>}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10, lineHeight: 1.3 }}>{top.title}</div>
      <div style={{ fontSize: 14, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.55 }}>{emphasize(top.detail)}</div>
      {(evidence.length > 0 || top.impact) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10 }}>
          {evidence.map((l, i) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{emphasize(l)}</div>
          ))}
          {top.impact && <div style={{ fontSize: 12.5, color: SEV_COLOR[top.severity] ?? 'var(--c-red)', fontWeight: 600, lineHeight: 1.5 }}>⚠ Impact: {emphasize(top.impact)}</div>}
        </div>
      )}
      {actions.length > 0 && (
        <div style={{ marginTop: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', marginBottom: 3 }}>Recommended action</div>
          {actions.slice(0, 3).map((a, i) => (
            <div key={i} style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.55 }}>{actions.length > 1 ? '· ' : ''}{a}</div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
        <button style={{ ...primaryBtn, background: solid }} disabled={disabled} onClick={onRun}>{isRunning ? 'Checking…' : '↻ Run check again'}</button>
        {run.alerts.length > 1 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>+{run.alerts.length - 1} more {run.alerts.length - 1 === 1 ? 'alert' : 'alerts'} below</span>}
      </div>
    </div>
  );
}

/** The engine's plain-language read of the run + the single recommended next step. Grounded in
 *  run.summary (always present) and the top alert's recommendation (when there is one). */
function AiSummary({ run }: { run: Ga4MonitorRun }): JSX.Element {
  const top = topAlert(run);
  const nextStep = top?.recommendation || (top ? `Investigate: ${top.title}.` : 'No action needed - keep the background monitor running so a new issue pages you the moment it appears.');
  const h = HEALTH[run.health] ?? HEALTH.healthy;
  return (
    <div style={{ ...card, padding: 20 }}>
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

/** Plain-language "what this check verifies and why" per check type - revealed when a tile is expanded,
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
  concentration: 'Flags when a single day, week or month dominates the totals - a sign of a spike, a backfill or a tracking glitch rather than steady traffic.',
  untagged: 'Measures the share of sessions with no campaign tags; a high share means paid or email traffic is being misattributed to organic or direct.',
  invalid_traffic: 'Looks for bot / invalid-traffic signatures (engagement patterns that do not look human) inflating your session counts.',
  referral_hygiene: 'Checks referral sources for self-referrals and payment-gateway domains that break attribution and pad referral traffic.',
  pii: 'Scans page paths for personal data (emails, names, ids) in URLs - a privacy risk that also fragments your reports.',
  channel_shift: 'Watches for a large shift in the channel mix versus the prior window, which can signal a tagging change rather than a real audience shift.',
  consent_signal: 'Probes live GA4 hits for the Consent Mode gcs= parameter, so a site collecting data without consent signals (a Consent Mode v2 gap) is caught.',
  freshness: 'Measures how far behind GA4’s processed data is running; a lag beyond the normal 24-48 hour window means reports are showing stale numbers.',
  bigquery: 'Verifies the property’s BigQuery links are still present and actually exporting (daily or streaming), so a silently broken pipeline is caught early.',
};

// Bold the key figure in an insight - a percentage ("55% higher", "down 12%") or a currency amount
// ("INR 378,400", "$1,204") - so it jumps out of the sentence. Purely presentational; wording is untouched.
const FIGURE = /((?:INR|Rs\.?|₹|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)/g;
const FIGURE_ONE = /^(?:(?:INR|Rs\.?|₹|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)$/;
function emphasize(text: string): React.ReactNode {
  return text.split(FIGURE).map((part, i) =>
    FIGURE_ONE.test(part)
      ? <b key={i} style={{ fontWeight: 700, color: 'var(--text)' }}>{part}</b>
      : <span key={i}>{part}</span>,
  );
}

/** The derived 0-100 health score as a compact gauge card, with the change vs the PREVIOUS recorded
 *  run. Honestly labeled: the score is computed from this run's alerts (see monitorHealthScore), not a
 *  metric GA4 reports. */
function HealthScoreCard({ score, history }: { score: number; history: Ga4MonitorHistoryEntry[] }): JSX.Element {
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const delta = prev ? score - prev.score : null;
  // Theme tokens only (WCAG-verified in both themes) — never raw hexes for colored text/graphics here.
  const color = score >= 85 ? 'var(--c-green)' : score >= 60 ? 'var(--c-amber, #b8860b)' : 'var(--c-red)';
  // SVG arc: a 3/4 circle from 135° to 405°, filled proportionally to the score.
  const R = 34;
  const C = 2 * Math.PI * R;
  const arc = C * 0.75;
  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, padding: 16 }}>
      <svg width="88" height="88" viewBox="0 0 88 88" role="img" aria-label={`Health score ${score} of 100`}>
        <g transform="rotate(135 44 44)">
          <circle cx="44" cy="44" r={R} fill="none" stroke="var(--border)" strokeWidth="8" strokeDasharray={`${arc} ${C}`} strokeLinecap="round" />
          {/* score 0 renders NO progress arc — a zero-length round-capped dash would still paint a dot. */}
          {score > 0 && <circle cx="44" cy="44" r={R} fill="none" stroke={color} strokeWidth="8" strokeDasharray={`${arc * (score / 100)} ${C}`} strokeLinecap="round" />}
        </g>
        <text x="44" y="42" textAnchor="middle" style={{ fontSize: 20, fontWeight: 800, fill: 'var(--text)', fontFamily: 'inherit' }}>{score}</text>
        <text x="44" y="56" textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text-faint)', fontFamily: 'inherit' }}>/100</text>
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)' }}>Health score</div>
        {delta !== null && delta !== 0 && (
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 3, color: delta < 0 ? 'var(--c-red)' : 'var(--c-green)' }}>
            {delta < 0 ? '↓' : '↑'} {Math.abs(delta)} pts vs previous check
          </div>
        )}
        {(delta === null || delta === 0) && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{delta === 0 ? 'unchanged vs previous check' : 'first recorded check'}</div>}
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.4 }}>Derived from this run&apos;s alerts</div>
      </div>
    </div>
  );
}

/** One big-number stat tile (the CRITICAL / WARNINGS / LAST SCAN column of the hero row). */
function StatTile({ value, label: lbl, color }: { value: React.ReactNode; label: string; color?: string }): JSX.Element {
  return (
    <div style={{ ...card, flex: 1, minWidth: 88, padding: '12px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-faint)', marginTop: 4 }}>{lbl}</div>
    </div>
  );
}

/** One health check as a GRID CARD (mockup format): status chip + icon + label, the finding clamped,
 *  and an expandable plain-language explainer. Content identical to the old table row. */
function CheckCard({ c }: { c: Ga4MonitorCheckView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const p = CHECK_PILL[c.status] ?? CHECK_PILL.skip;
  const explain = CHECK_EXPLAIN[c.id] ?? 'An additional health signal for this property.';
  const clamp: React.CSSProperties = open ? {} : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
  return (
    <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }}><CheckTypeIcon id={c.id} size={16} /></span>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: p.color, background: 'var(--surface-2)', border: `1px solid ${p.color}`, borderRadius: 999, padding: '2px 9px', flexShrink: 0 }}>{p.label}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <div style={{ ...clamp }}>{emphasize(c.detail)}</div>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--c-blue)' }}
      >
        <span aria-hidden="true" style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease' }}>▸</span>
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && <div style={{ paddingTop: 6, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{explain}</div>}
    </div>
  );
}

/** Recent alerts (mockup format): the run's alerts, worst first, each with its severity chip and — when
 *  the persisted issue log knows it — WHEN it opened. All fields real (title/detail/fix from the engine,
 *  openedAt from the issue log). */
function RecentAlerts({ run, issueLog }: { run: Ga4MonitorRun; issueLog: Array<{ id: string; openedAt: number }> }): JSX.Element {
  const newIds = new Set(run.newAlertIds);
  const openedAt = new Map(issueLog.map((e) => [e.id, e.openedAt] as const));
  const alerts = [...run.alerts].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  return (
    <div style={{ ...card, padding: 16, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Recent alerts</span>
        {alerts.length > 0 && (
          <span style={{ fontSize: 10.5, fontWeight: 800, color: '#fff', background: 'var(--danger)', borderRadius: 999, padding: '1px 8px' }}>{alerts.length} active</span>
        )}
      </div>
      {alerts.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No open alerts - everything this monitor checks looks normal.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {alerts.map((a, i) => {
            const opened = openedAt.get(a.id);
            return (
              <div key={a.id} style={{ padding: '10px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, color: SEV_COLOR[a.severity] ?? 'var(--text)', border: `1px solid ${SEV_COLOR[a.severity] ?? 'var(--border)'}`, borderRadius: 999, padding: '1px 8px' }}>{a.severity}</span>
                  {opened != null && <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--text-faint)' }}>{fmtAgo(opened)}</span>}
                  {newIds.has(a.id) && <span style={{ fontSize: 10, background: 'var(--c-blue-bg, rgba(59,130,246,.15))', color: 'var(--c-blue)', borderRadius: 999, padding: '1px 7px', fontWeight: 800 }}>NEW</span>}
                </div>
                <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4 }}>{a.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.5 }}>{emphasize(a.detail)}</div>
                {a.recommendation && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}><b>Fix:</b> {a.recommendation}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const fmtDuration = (ms: number): string => (ms < 1000 ? '<1s' : `${Math.round(ms / 1000)}s`);

/** Monitoring history (mockup format): one row per recorded run — status, derived score, alert counts,
 *  duration and what triggered it. Data comes from the persisted per-target run history. */
function HistoryTable({ history }: { history: Ga4MonitorHistoryEntry[] }): JSX.Element | null {
  const [filter, setFilter] = useState<'all' | 'healthy' | 'warning' | 'critical'>('all');
  if (!history.length) return null;
  const rows = [...history].reverse().filter((e) => filter === 'all' || e.health === filter);
  const th: React.CSSProperties = { textAlign: 'left', padding: '9px 14px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '9px 14px', borderBottom: '1px solid var(--border)', fontSize: 12.5, whiteSpace: 'nowrap' };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={sectionTitle}>Monitoring history</span>
        <span style={{ flex: 1 }} />
        {(['all', 'healthy', 'warning', 'critical'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ ...ghostBtn, padding: '3px 10px', fontSize: 11.5, ...(filter === f ? { background: 'var(--surface-3)', color: 'var(--text)', fontWeight: 700 } : {}) }}
          >
            {f === 'all' ? 'All' : HEALTH[f].label}
          </button>
        ))}
      </div>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Timestamp', 'Status', 'Health score', 'Critical', 'Warnings', 'Duration', 'Trigger'].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const h = HEALTH[e.health] ?? HEALTH.healthy;
              const barColor = e.score >= 85 ? 'var(--c-green)' : e.score >= 60 ? 'var(--c-amber, #b8860b)' : 'var(--c-red)';
              const last = i === rows.length - 1;
              const cell = last ? { ...td, borderBottom: 'none' } : td;
              return (
                <tr key={e.at}>
                  <td style={{ ...cell, fontFamily: MONO, fontSize: 11.5, color: 'var(--text-muted)' }} title={fmtTime(e.at)}>{fmtTime(e.at)}</td>
                  <td style={cell}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: h.color, background: h.bg, borderRadius: 999, padding: '2px 9px' }}>{h.icon} {h.label}</span>
                  </td>
                  <td style={cell}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 56, height: 5, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden', display: 'inline-block' }}>
                        <span style={{ display: 'block', height: '100%', width: `${e.score}%`, background: barColor, borderRadius: 999 }} />
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 12 }}>{e.score}</span>
                    </span>
                  </td>
                  <td style={{ ...cell, fontWeight: 700, color: e.critical ? 'var(--c-red)' : 'var(--text-faint)' }}>{e.critical || '–'}</td>
                  <td style={{ ...cell, fontWeight: 700, color: e.warnings ? 'var(--c-amber, #b8860b)' : 'var(--text-faint)' }}>{e.warnings || '–'}</td>
                  <td style={{ ...cell, fontFamily: MONO, fontSize: 11.5, color: 'var(--text-muted)' }}>{fmtDuration(e.durationMs)}</td>
                  <td style={cell}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 6, padding: '2px 8px', textTransform: 'capitalize' }}>{e.trigger}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>Score is derived from each run&apos;s alerts (critical -30 · high -15 · medium -7 · low -3). Critical column counts critical + high alerts; Warnings counts medium + low.</div>
    </div>
  );
}

/** The selected property's dashboard: identity + controls, then (when a run exists) the hero,
 *  KPI cards, AI summary, health-check tiles and full alert list, then this property's Slack channel. */
function PropertyPanel({ t, runningId, busy, onRun, onTogglePause, onRemove, onSaveChannel, onTestChannel, onRemoveChannel, onExport }: {
  t: Ga4MonitorTargetStatus;
  runningId: string | null;
  busy: boolean;
  onRun: () => void;
  onExport: (format: 'pdf' | 'csv') => void;
  onTogglePause: () => void;
  onRemove: () => void;
  onSaveChannel: (url: string, label: string, notify: NotifyPrefs) => Promise<boolean>;
  onTestChannel: () => void;
  onRemoveChannel: () => void;
}): JSX.Element {
  const [editingChan, setEditingChan] = useState(false);
  const [chanUrl, setChanUrl] = useState('');
  const [chanLbl, setChanLbl] = useState('');
  const [chanNotify, setChanNotify] = useState<NotifyPrefs>({ alerts: true, digest: false, audit: false, monthly: true });
  const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
  const isRunning = runningId === t.propertyId || runningId === '*';
  const runDisabled = runningId !== null;
  const run = t.lastRun;
  const counts = run ? tallyChecks(run.checks) : null;
  // Stat tiles: critical/high vs medium/low alerts — the same split the run history records.
  const criticalCount = run ? run.alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length : 0;
  const warningCount = run ? run.alerts.filter((a) => a.severity === 'medium' || a.severity === 'low').length : 0;

  // The property's Slack-channel card: rendered in the Configuration column beside Recent alerts when a
  // run exists, else standalone under the header — so connecting a channel is always reachable.
  const slackCard = (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 300px', minWidth: 280, alignSelf: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}><SlackMark size={14} /> Slack channel</span>
          {t.hasWebhook ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--c-green-bg, rgba(34,197,94,.12))', color: 'var(--c-green)', borderRadius: 999, padding: '3px 12px', fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
                {t.slackLabel || 'own channel connected'}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                sends: {NOTIFY_OPTS.filter((o) => (o.key === 'alerts' || o.key === 'monthly' ? t.notify?.[o.key] !== false : Boolean(t.notify?.[o.key]))).map((o) => o.label.toLowerCase()).join(' · ') || 'nothing selected'}
                {t.lastSlackAt ? ` · last posted ${fmtAgo(t.lastSlackAt)}` : ''}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
              no channel connected - this property will not alert Slack until you connect one
            </span>
          )}
          <span style={{ flex: 1 }} />
          {t.hasWebhook && <button style={ghostBtn} disabled={busy} onClick={onTestChannel}>Send test</button>}
          <button
            style={{ ...ghostBtn, color: 'var(--c-blue)' }}
            disabled={busy}
            onClick={() => { setEditingChan((v) => !v); setChanUrl(''); setChanLbl(t.slackLabel ?? ''); setChanNotify({ alerts: t.notify?.alerts !== false, digest: Boolean(t.notify?.digest), audit: Boolean(t.notify?.audit), monthly: t.notify?.monthly !== false }); }}
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
              One property, one channel: everything selected above posts here. The URL is stored encrypted in your OS keychain. (How to get a webhook URL - see the Slack alerts card below.)
            </span>
          </div>
        )}
    </div>
  );

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
          <button style={ghostBtn} disabled={busy || !run} title={run ? 'Download this report as a PDF' : 'Run a check first'} onClick={() => onExport('pdf')}>⬇ PDF</button>
          <button style={ghostBtn} disabled={busy || !run} title={run ? 'Download this report as a CSV' : 'Run a check first'} onClick={() => onExport('csv')}>⬇ CSV</button>
          <button style={ghostBtn} disabled={busy} title={t.enabled ? 'Pause background checks for this property' : 'Resume background checks'} onClick={onTogglePause}>{t.enabled ? '⏸ Pause' : '⏵ Resume'}</button>
          <button style={{ ...ghostBtn, color: 'var(--c-red)' }} disabled={busy} title="Stop monitoring this property" onClick={onRemove}>Remove</button>
        </div>
      </div>

      {run && counts ? (
        <>
          {/* ── Hero row (mockup format): the worst finding + the score / stat column ── */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{ flex: '2 1 460px', minWidth: 0 }}>
              <HeroCard run={run} isRunning={isRunning} disabled={runDisabled} onRun={onRun} />
            </div>
            <div style={{ flex: '1 1 260px', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {typeof run.score === 'number' && <HealthScoreCard score={run.score} history={t.history ?? []} />}
              <div style={{ display: 'flex', gap: 10 }}>
                <StatTile value={criticalCount} label="Critical / high" color={criticalCount ? 'var(--c-red)' : 'var(--text-faint)'} />
                <StatTile value={warningCount} label="Warnings" color={warningCount ? 'var(--c-amber, #b8860b)' : 'var(--text-faint)'} />
                <StatTile value={fmtAgo(run.at)} label="Last scan" />
              </div>
            </div>
          </div>

          {/* ── Why? ── */}
          <AiSummary run={run} />

          {/* ── Monitoring checks as a card grid (mockup format) ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={sectionTitle}>Monitoring checks</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {counts.pass} pass · {counts.fail} fail · {counts.warn} warning{counts.skip ? ` · ${counts.skip} skipped` : ''}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 10px', lineHeight: 1.5 }}>
              Realtime figures are live. Daily figures cover complete days in the property&apos;s reporting timezone{run.timeZone ? <> (<b>{run.timeZone}</b>)</> : null}; today is excluded until it completes.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {run.checks.map((c) => <CheckCard key={c.id} c={c} />)}
            </div>
          </div>

          {/* ── Recent alerts + this property's channel/configuration (mockup two-column row) ── */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <RecentAlerts run={run} issueLog={t.issueLog ?? []} />
            {slackCard}
          </div>
        </>
      ) : (
        <>
          {slackCard}
          <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '36px 20px', color: 'var(--text-muted)' }}>
            <span style={{ fontSize: 28 }}>🔍</span>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
              {(t.history?.length ?? 0) > 0 ? 'No check has run in this session yet' : 'No check has run for this property yet'}
            </div>
            <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
              Click <b>▶ Run check</b> above to verify data flow, key events, spikes/drops, conversion tracking and revenue integrity.
              {(t.history?.length ?? 0) > 0 ? ' Earlier runs are in the history below.' : ''}
            </div>
          </div>
        </>
      )}

      {/* ── Run history: OUTSIDE the has-run branch, because history is persisted across restarts while
             the latest run itself is in-memory — the table must show even before this session's first
             check. Renders nothing when there is no history. ── */}
      <HistoryTable history={t.history ?? []} />

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
  const [addNotify, setAddNotify] = useState<NotifyPrefs>({ alerts: true, digest: false, audit: false, monthly: true });
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

  /** Add a property - and, when the optional Slack fields were filled in the same step, connect its
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
      setAddId(''); setAddChanUrl(''); setAddChanLabel(''); setAddNotify({ alerts: true, digest: false, audit: false, monthly: true });
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

  async function exportRun(propertyId: string, format: 'pdf' | 'csv'): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const saved = await window.desktop.ga4monitoring.exportRun(propertyId, format);
      setNote(saved ? `✓ Saved to ${saved}` : 'Save cancelled.');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNow(propertyId?: string): Promise<void> {
    if (runningId) return;
    setRunningId(propertyId ?? '*'); onError(''); setNote('');
    try {
      const runs = await window.desktop.ga4monitoring.runNow(propertyId);
      if (!runs.length) setNote('Nothing to check - add a property and make sure the account is signed in to Google.');
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
      setNote(url ? 'Property channel saved (encrypted) - new issues for this property will post there.' : 'Channel name saved.');
      return true;
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  }
  async function removePropertyChannel(propertyId: string): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try { setStatus(await window.desktop.ga4monitoring.clearWebhook(propertyId)); setNote('Property channel removed - its alerts fall back to the default channel.'); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function testPropertyChannel(propertyId: string): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const r = await window.desktop.ga4monitoring.sendTest(propertyId);
      setNote(r.ok ? 'Test sent - check Slack to confirm which channel this property alerts.' : `Test failed: ${r.error ?? 'unknown error'}`);
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
      {/* ── Header: identity + overall health + background status ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700 }}>🔔 GA4 Monitoring</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>
            {targets.length
              ? <>Watching <b>{targets.length}</b> propert{targets.length === 1 ? 'y' : 'ies'} · <b style={{ color: openIssues ? 'var(--c-red)' : 'var(--c-green)' }}>{openIssues}</b> open issue{openIssues === 1 ? '' : 's'} across all.</>
              : 'Background health checks for your GA4 properties - data flow, key events, spikes/drops, conversion tracking and revenue integrity.'}
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
      {status?.lastError && <div style={{ fontSize: 12.5, color: 'var(--c-red)' }}>Last sweep error - {status.lastError}</div>}

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
                  <input style={{ ...input, flex: 2, minWidth: 220, fontSize: 12 }} type="password" placeholder="Slack webhook for this property (optional - connect later from its tab)" value={addChanUrl} onChange={(e) => setAddChanUrl(e.target.value)} />
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
            Pick a GA4 property in the <b>Monitor a GA4 property</b> panel above and click <b>＋ Add</b>. Each check verifies data flow, key events, spikes/drops, conversion tracking and revenue integrity - and can alert your Slack channel when something breaks.
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
                  title={`${t.propertyLabel || t.propertyId} (${t.propertyId.replace('properties/', '')})${t.enabled ? '' : ' - paused'}`}
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
              onExport={(format) => void exportRun(selected.propertyId, format)}
            />
          )}
        </div>
      )}

      {/* ── Slack alerts how-to: each property has its OWN channel (connect it from the property's
             dashboard above) - there is no shared default channel. ── */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600 }}><SlackMark size={16} /> Slack alerts</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
          One property, one channel: connect each property's Slack channel from its dashboard above (<b>＋ Connect channel</b> / <b>✎ Edit channel</b>) and pick <b>what it receives</b> there - new issue alerts, the weekly health digest, and/or the weekly audit summary. How to get a webhook URL for a channel:
        </div>
        <ol style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, paddingLeft: 18 }}>
          <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--c-blue)' }}>api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> (or pick an existing app), then choose your workspace.</li>
          <li>In the app’s left menu open <b>Incoming Webhooks</b> and toggle <b>Activate Incoming Webhooks</b> to <b>On</b>.</li>
          <li>Click <b>Add New Webhook to Workspace</b>, pick the <b>channel</b> the alerts should post to, then <b>Allow</b>. (The channel is baked into the URL - that’s how you pick where alerts land.)</li>
          <li>Copy the generated <b>Webhook URL</b> - it starts with <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>https://hooks.slack.com/services/</code>.</li>
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
