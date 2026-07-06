import { useEffect, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4MonitorTargetStatus, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab — MULTI-property dashboard. Layout: page header with a fleet-health rollup,
// one toolbar (add property + shared schedule + run-all), a responsive grid of property cards
// (health accent, alert chip, per-card actions), the selected property's full run detail, then the
// Slack settings as a secondary card. The heavy lifting is in main (Ga4MonitoringService sweeps the
// list sequentially + the pure monitorGa4 engine); this is a thin control panel over
// status()/configure()/runNow().

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const HEALTH: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))', label: 'Healthy', icon: '🟢' },
};
// Per-status pill for the checks table (a coloured chip reads better than an emoji list).
const CHECK_PILL: Record<string, { label: string; color: string; bg: string }> = {
  pass: { label: 'Pass', color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))' },
  warn: { label: 'Warning', color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))' },
  fail: { label: 'Issue', color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))' },
  skip: { label: 'Not run', color: 'var(--text-muted)', bg: 'var(--surface-3)' },
};

const box: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const btn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 11px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--c-blue)', color: '#fff', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function fmtTime(ms: number | null): string {
  if (!ms) return 'never';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}
/** Compact relative time for the cards ("just now", "12 min ago", "3 hr ago", then a date). */
function fmtAgo(ms: number | null): string {
  if (!ms) return 'not checked yet';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return '—'; }
}

/** One property's full run detail: header strip (health + summary + counts), alerts, checks table. */
function RunDetail({ run }: { run: Ga4MonitorRun }): JSX.Element {
  const health = HEALTH[run.health] ?? HEALTH.healthy;
  const newIds = new Set(run.newAlertIds);
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<string, number>;
  for (const c of run.checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return (
    <div style={{ ...box, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 700, color: health.color, fontSize: 15 }}>
          <span style={{ fontSize: 15 }}>{health.icon}</span>{health.label}
        </span>
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{run.summary}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {(['fail', 'warn', 'pass', 'skip'] as const).map((k) =>
            counts[k] > 0 ? (
              <span key={k} style={{ fontSize: 11, fontWeight: 600, color: CHECK_PILL[k].color, background: CHECK_PILL[k].bg, borderRadius: 999, padding: '2px 9px' }}>
                {counts[k]} {CHECK_PILL[k].label.toLowerCase()}
              </span>
            ) : null
          )}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{run.propertyLabel} · {fmtTime(run.at)}</span>
      </div>

      {run.alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px 4px' }}>
          {run.alerts.map((a) => (
            <div key={a.id} style={{ borderLeft: `3px solid ${SEV_COLOR[a.severity] ?? 'var(--border)'}`, background: 'var(--surface)', borderRadius: 6, padding: '8px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, color: SEV_COLOR[a.severity] ?? 'var(--text)', fontSize: 11, textTransform: 'uppercase' }}>{a.severity}</span>
                <span style={{ fontWeight: 600 }}>{a.title}</span>
                {newIds.has(a.id) && <span style={{ fontSize: 10, background: 'var(--c-blue-bg, rgba(59,130,246,.15))', color: 'var(--c-blue)', borderRadius: 999, padding: '1px 7px', fontWeight: 700 }}>NEW</span>}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.45 }}>{a.detail}</div>
              {a.recommendation && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}><b>Fix:</b> {a.recommendation}</div>}
            </div>
          ))}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, margin: '8px 0 0' }}>
        <thead>
          <tr>
            {['Status', 'Check', 'What we found'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 16px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.checks.map((c, i) => {
            const p = CHECK_PILL[c.status] ?? CHECK_PILL.skip;
            return (
              <tr key={c.id}>
                <td style={{ padding: '7px 16px', borderBottom: i === run.checks.length - 1 ? 'none' : '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'top', width: 90 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: p.color, background: p.bg, borderRadius: 999, padding: '2px 10px' }}>{p.label}</span>
                </td>
                <td style={{ padding: '7px 16px', borderBottom: i === run.checks.length - 1 ? 'none' : '1px solid var(--border)', fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{c.label}</td>
                <td style={{ padding: '7px 16px', borderBottom: i === run.checks.length - 1 ? 'none' : '1px solid var(--border)', color: 'var(--text-muted)', lineHeight: 1.5 }}>{c.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One property card in the fleet grid: health accent + label, alert chip, meta, per-card actions. */
function PropertyCard({ t, selected, runningId, busy, onSelect, onRun, onTogglePause, onRemove }: {
  t: Ga4MonitorTargetStatus;
  selected: boolean;
  runningId: string | null;
  busy: boolean;
  onSelect: () => void;
  onRun: () => void;
  onTogglePause: () => void;
  onRemove: () => void;
}): JSX.Element {
  const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
  const accent = !t.enabled ? 'var(--text-faint)' : h ? h.color : 'var(--border)';
  const alertCount = t.lastRun?.alerts.length ?? 0;
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<string, number>;
  for (const c of t.lastRun?.checks ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const isRunning = runningId === t.propertyId || runningId === '*';
  return (
    <div
      onClick={onSelect}
      role="button"
      aria-pressed={selected}
      style={{
        position: 'relative',
        background: 'var(--surface-2)',
        border: `1px solid ${selected ? 'var(--c-blue)' : 'var(--border)'}`,
        boxShadow: selected ? '0 0 0 1px var(--c-blue)' : 'none',
        borderRadius: 12,
        padding: '14px 14px 10px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        opacity: t.enabled ? 1 : 0.6,
        overflow: 'hidden',
      }}
    >
      {/* Health accent bar across the top of the card. */}
      <span style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {h ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: h.color, background: h.bg, borderRadius: 999, padding: '2px 10px' }}>
            {h.icon} {h.label}
          </span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 10px' }}>
            ⚪ No check yet
          </span>
        )}
        {!t.enabled && (
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 8px' }}>PAUSED</span>
        )}
        <span style={{ flex: 1 }} />
        {alertCount > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, color: h?.color ?? 'var(--text)', background: h?.bg ?? 'var(--surface-3)', borderRadius: 999, padding: '2px 9px' }}>
            {alertCount} alert{alertCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.propertyLabel || t.propertyId}>
          {t.propertyLabel || t.propertyId}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{t.propertyId.replace('properties/', '')}</span>
          {t.hasWebhook && (
            <span title="This property alerts its own Slack channel" style={{ fontFamily: 'inherit', color: 'var(--c-green)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              → {t.slackLabel || 'own Slack channel'}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        {t.lastRun ? (
          <span>
            <b style={{ color: 'var(--c-green)' }}>{counts.pass}</b> pass
            {counts.warn > 0 && <> · <b style={{ color: 'var(--c-amber, #b8860b)' }}>{counts.warn}</b> warn</>}
            {counts.fail > 0 && <> · <b style={{ color: 'var(--c-red)' }}>{counts.fail}</b> issue{counts.fail === 1 ? '' : 's'}</>}
          </span>
        ) : (
          <span>Run a first check to see its health.</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-faint)' }}>{t.lastError ? <span style={{ color: 'var(--c-red)' }} title={t.lastError}>check failed</span> : fmtAgo(t.lastRunAt)}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
        <button style={{ ...ghostBtn, color: 'var(--c-blue)', borderColor: 'var(--c-blue-bg, var(--border))' }} disabled={runningId !== null} onClick={(e) => { e.stopPropagation(); onRun(); }}>
          {isRunning ? 'Checking…' : '▶ Run'}
        </button>
        <button style={ghostBtn} disabled={busy} title={t.enabled ? 'Pause background checks for this property' : 'Resume background checks'} onClick={(e) => { e.stopPropagation(); onTogglePause(); }}>
          {t.enabled ? '⏸ Pause' : '⏵ Resume'}
        </button>
        <span style={{ flex: 1 }} />
        <button style={{ ...ghostBtn, color: 'var(--c-red)' }} disabled={busy} title="Stop monitoring this property" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          Remove
        </button>
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
  const [webhookInput, setWebhookInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [labelDirty, setLabelDirty] = useState(false);
  // Per-property channel editor: which property's inline form is open + its draft url/label.
  const [channelEdit, setChannelEdit] = useState<string | null>(null);
  const [chanUrl, setChanUrl] = useState('');
  const [chanLabel, setChanLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // Seed the label field from saved config until the user starts editing (then keep their draft).
  useEffect(() => {
    if (!labelDirty) setLabelInput(status?.slackLabel ?? '');
  }, [status?.slackLabel, labelDirty]);

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

  function addProperty(): void {
    const prop = properties?.find((p) => p.property === addId);
    if (!prop || !status) return;
    const next = [...status.targets, { propertyId: prop.property, propertyLabel: prop.displayName, enabled: true }];
    setAddId('');
    setSelectedId(prop.property);
    void configure({ targets: next });
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

  // Save the webhook URL (if one was entered) and/or the channel label. Lets the user update just the
  // label (leave the URL box empty) or connect a new webhook + label together.
  async function saveWebhook(): Promise<void> {
    const url = webhookInput.trim();
    if (!url && !labelDirty) return;
    setBusy(true); onError(''); setNote('');
    try {
      if (url) { await window.desktop.ga4monitoring.setWebhook(url); setWebhookInput(''); }
      setStatus(await window.desktop.ga4monitoring.configure({ slackLabel: labelInput.trim() }));
      setLabelDirty(false);
      setNote(url ? 'Slack webhook saved (encrypted).' : 'Slack channel label saved.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function clearWebhook(): Promise<void> {
    setBusy(true); onError('');
    try { setStatus(await window.desktop.ga4monitoring.clearWebhook()); setNote('Slack webhook removed.'); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  // ── Per-property channels (one property, one channel; default channel is the fallback) ──
  async function savePropertyChannel(propertyId: string): Promise<void> {
    const url = chanUrl.trim();
    if (!url || !status) return;
    setBusy(true); onError(''); setNote('');
    try {
      await window.desktop.ga4monitoring.setWebhook(url, propertyId);
      const lbl = chanLabel.trim();
      setStatus(await window.desktop.ga4monitoring.configure({
        targets: status.targets.map((t) => (t.propertyId === propertyId ? { ...t, slackLabel: lbl || undefined } : t)),
      }));
      setChannelEdit(null); setChanUrl(''); setChanLabel('');
      setNote('Property channel saved (encrypted) — its alerts now post there instead of the default.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
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
  async function sendTest(): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const r = await window.desktop.ga4monitoring.sendTest();
      setNote(r.ok ? 'Test message sent — check your Slack channel to confirm where alerts land.' : `Test failed: ${r.error ?? 'unknown error'}`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const addable = (properties ?? []).filter((p) => !targets.some((t) => t.propertyId === p.property));
  const selected = targets.find((t) => t.propertyId === selectedId) ?? null;
  const enabledCount = targets.filter((t) => t.enabled).length;
  // Fleet rollup for the header: worst-first chips, only the non-zero ones.
  const fleet = { critical: 0, warning: 0, healthy: 0, none: 0 };
  for (const t of targets) {
    if (!t.lastRun) fleet.none++;
    else fleet[t.lastRun.health]++;
  }

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Sign in to Google on this account to monitor GA4 properties.</div>;
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Page header + fleet rollup ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>🔔 GA4 Monitoring</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Background health checks for your GA4 properties: data flow, key events firing, sudden spikes/drops, conversion tracking, and revenue integrity. New issues can be posted to Slack.</div>
        </div>
        {targets.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 4 }}>
            {(['critical', 'warning', 'healthy'] as const).map((k) =>
              fleet[k] > 0 ? (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: HEALTH[k].color, background: HEALTH[k].bg, borderRadius: 999, padding: '4px 12px' }}>
                  {HEALTH[k].icon} {fleet[k]} {HEALTH[k].label.toLowerCase()}
                </span>
              ) : null
            )}
            {fleet.none > 0 && (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '4px 12px' }}>⚪ {fleet.none} not checked</span>
            )}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: status?.running ? 'var(--c-green)' : 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 12px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.running ? 'var(--c-green)' : 'var(--text-faint)', display: 'inline-block' }} />
              {status?.running ? `background · every ${status.intervalMinutes >= 60 ? `${status.intervalMinutes / 60} hr` : `${status.intervalMinutes} min`}` : 'background off'}
            </span>
          </div>
        )}
      </div>

      {/* ── Toolbar: add property + shared schedule + run all ── */}
      <div style={{ ...box, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260, flex: 1 }}>
          <span style={label}>Add a property to monitor</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={{ ...input, flex: 1 }} value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">{properties === null ? 'Loading…' : addable.length ? 'Select a property…' : targets.length ? 'All accessible properties are being monitored' : 'No properties found'}</option>
              {addable.map((p) => (
                <option key={p.property} value={p.property}>{p.displayName} ({p.property.replace('properties/', '')})</option>
              ))}
            </select>
            <button style={primaryBtn} onClick={addProperty} disabled={busy || !addId}>+ Add</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={label}>Check every</span>
          <select style={input} value={status?.intervalMinutes ?? 60} onChange={(e) => void configure({ intervalMinutes: Number(e.target.value) })}>
            {[15, 30, 60, 120, 240, 720, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr`}</option>)}
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

      {note && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{note}</div>}
      {status?.lastError && <div style={{ fontSize: 12.5, color: 'var(--c-red)' }}>Last sweep error — {status.lastError}</div>}

      {/* ── Property cards ── */}
      {targets.length === 0 ? (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 30 }}>📡</span>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>No properties monitored yet</div>
          <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 460, lineHeight: 1.5 }}>
            Pick a GA4 property above and click <b>+ Add</b>. Each check verifies data flow, key events, spikes/drops, conversion tracking and revenue integrity — and can alert your Slack channel when something breaks.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {targets.map((t) => (
            <PropertyCard
              key={t.propertyId}
              t={t}
              selected={t.propertyId === selectedId}
              runningId={runningId}
              busy={busy}
              onSelect={() => setSelectedId(t.propertyId)}
              onRun={() => void runNow(t.propertyId)}
              onTogglePause={() => togglePaused(t.propertyId)}
              onRemove={() => removeProperty(t.propertyId)}
            />
          ))}
        </div>
      )}

      {/* ── Selected property's latest run ── */}
      {selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)' }}>
            Latest check — {selected.propertyLabel || selected.propertyId}
          </div>
          {selected.lastRun ? (
            <RunDetail run={selected.lastRun} />
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No check has run for <b>{selected.propertyLabel || selected.propertyId}</b> yet — click <b>▶ Run</b> on its card (or Run all).
            </div>
          )}
        </div>
      )}

      {/* ── Slack (secondary settings) ── */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>
            Slack alerts{' '}
            {status?.hasWebhook
              ? <span style={{ color: 'var(--c-green)', fontSize: 12 }}>· connected</span>
              : <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>· not configured</span>}
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(status?.slackEnabled)} disabled={busy} onChange={(e) => void configure({ slackEnabled: e.target.checked })} />
            Send new issues to Slack
          </label>
        </div>
        {status?.hasWebhook ? (
          /* Connected default channel: verify or disconnect (per-property channels override it below). */
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Default channel</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '5px 14px', fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
              {status.slackLabel || 'Slack channel connected'}
            </span>
            <button style={btn} onClick={() => void sendTest()} disabled={busy} title="Post a confirmation message so you can see which channel receives alerts">Send test</button>
            <button style={btn} onClick={() => void clearWebhook()} disabled={busy}>Remove</button>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Any property without its own channel posts here. Give a property its own channel below — one property, one channel.</span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input style={{ ...input, flex: 1, minWidth: 260 }} type="password" placeholder="https://hooks.slack.com/services/…" value={webhookInput} onChange={(e) => setWebhookInput(e.target.value)} />
              <button style={btn} onClick={() => void saveWebhook()} disabled={busy || !webhookInput.trim()}>Save webhook</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
              <span style={label}>Channel &amp; workspace (label)</span>
              <input style={{ ...input, maxWidth: 420 }} type="text" placeholder="#ga4-alerts · Acme workspace" value={labelInput} onChange={(e) => { setLabelInput(e.target.value); setLabelDirty(true); }} />
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Slack doesn’t expose the channel or workspace from a webhook URL, so note them here — it’s shown as the connection status.</span>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: 'var(--c-blue)', cursor: 'pointer', userSelect: 'none' }}>How do I get a webhook URL? (choose the channel to alert)</summary>
              <ol style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '8px 0 0', paddingLeft: 18 }}>
                <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--c-blue)' }}>api.slack.com/apps</a> → <b>Create New App</b> → <b>From scratch</b> (or pick an existing app), then choose your workspace.</li>
                <li>In the app’s left menu open <b>Incoming Webhooks</b> and toggle <b>Activate Incoming Webhooks</b> to <b>On</b>.</li>
                <li>Click <b>Add New Webhook to Workspace</b>, pick the <b>channel</b> the alerts should post to, then <b>Allow</b>. (The channel is baked into the URL — that’s how you pick where alerts land.)</li>
                <li>Copy the generated <b>Webhook URL</b> — it starts with <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>https://hooks.slack.com/services/</code>.</li>
                <li>Paste it in the box above and click <b>Save webhook</b>.</li>
              </ol>
            </details>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>The URL is stored encrypted in your OS keychain (never synced or logged). An ongoing issue is posted once per property, not on every check.</div>
          </>
        )}

        {/* ── Per-property channels: one property, one channel (default = fallback) ── */}
        {targets.length > 0 && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-faint)', marginBottom: 8 }}>
              Per-property channels
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {targets.map((t) => (
                <div key={t.propertyId} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{t.propertyLabel || t.propertyId}</span>
                    {t.hasWebhook ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--c-green-bg, rgba(34,197,94,.12))', color: 'var(--c-green)', borderRadius: 999, padding: '3px 11px', fontWeight: 600 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
                        {t.slackLabel || 'own channel'}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{status?.hasWebhook ? 'uses the default channel' : 'no channel (default not set)'}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {t.hasWebhook ? (
                      <>
                        <button style={ghostBtn} disabled={busy} onClick={() => void testPropertyChannel(t.propertyId)}>Send test</button>
                        <button style={{ ...ghostBtn, color: 'var(--c-red)' }} disabled={busy} onClick={() => void removePropertyChannel(t.propertyId)}>Remove channel</button>
                      </>
                    ) : channelEdit === t.propertyId ? (
                      <button style={ghostBtn} disabled={busy} onClick={() => { setChannelEdit(null); setChanUrl(''); setChanLabel(''); }}>Cancel</button>
                    ) : (
                      <button style={{ ...ghostBtn, color: 'var(--c-blue)' }} disabled={busy} onClick={() => { setChannelEdit(t.propertyId); setChanUrl(''); setChanLabel(''); }}>Set channel…</button>
                    )}
                  </div>
                  {channelEdit === t.propertyId && !t.hasWebhook && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      <input style={{ ...input, flex: 2, minWidth: 240 }} type="password" placeholder="https://hooks.slack.com/services/… (this property's channel)" value={chanUrl} onChange={(e) => setChanUrl(e.target.value)} />
                      <input style={{ ...input, flex: 1, minWidth: 140 }} type="text" placeholder="#acme-alerts (label)" value={chanLabel} onChange={(e) => setChanLabel(e.target.value)} />
                      <button style={primaryBtn} disabled={busy || !chanUrl.trim()} onClick={() => void savePropertyChannel(t.propertyId)}>Save</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Footer status line ── */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>Background: <b style={{ color: status?.running ? 'var(--c-green)' : 'var(--text-faint)' }}>{status?.running ? 'on' : 'off'}</b></span>
        <span>Last check: {fmtTime(status?.lastRunAt ?? null)}</span>
      </div>
    </div>
  );
}
