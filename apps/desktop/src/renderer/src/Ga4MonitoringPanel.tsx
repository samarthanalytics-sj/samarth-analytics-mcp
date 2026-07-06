import { useEffect, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4MonitorTargetStatus, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab — SIMPLE, tab-per-property layout. Reading order:
//   1. header + shared schedule toolbar (add property, interval, window, background, run all)
//   2. one TAB per monitored property (health dot + name + alert badge)
//   3. the open property's panel: its controls (run/pause/remove), its Slack channel
//      (name, edit link, test, remove), and its latest run (alerts + checks)
//   4. the account's DEFAULT Slack channel card + footer
// The heavy lifting is in main (Ga4MonitoringService + monitorGa4); this is a thin control panel.

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const HEALTH: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))', label: 'Healthy', icon: '🟢' },
};
const CHECK_PILL: Record<string, { label: string; color: string; bg: string }> = {
  pass: { label: 'Pass', color: 'var(--c-green)', bg: 'var(--c-green-bg, rgba(34,197,94,.12))' },
  warn: { label: 'Warning', color: 'var(--c-amber, #b8860b)', bg: 'var(--c-amber-bg, rgba(245,158,11,.14))' },
  fail: { label: 'Issue', color: 'var(--c-red)', bg: 'var(--c-red-bg, rgba(239,68,68,.12))' },
  skip: { label: 'Not run', color: 'var(--text-muted)', bg: 'var(--surface-3)' },
};

const box: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const btn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--c-blue)', color: '#fff', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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

/** One property's latest-run body: alerts then the checks table. */
function RunDetail({ run }: { run: Ga4MonitorRun }): JSX.Element {
  const newIds = new Set(run.newAlertIds);
  return (
    <>
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
    </>
  );
}

/** The open property's full panel: header (name, health, timings, controls), its Slack channel
 *  section (channel name + edit link + test + remove), then its latest run. */
function PropertyPanel({ t, runningId, busy, onRun, onTogglePause, onRemove, onSaveChannel, onTestChannel, onRemoveChannel }: {
  t: Ga4MonitorTargetStatus;
  runningId: string | null;
  busy: boolean;
  onRun: () => void;
  onTogglePause: () => void;
  onRemove: () => void;
  onSaveChannel: (url: string, label: string) => Promise<boolean>;
  onTestChannel: () => void;
  onRemoveChannel: () => void;
}): JSX.Element {
  const [editingChan, setEditingChan] = useState(false);
  const [chanUrl, setChanUrl] = useState('');
  const [chanLbl, setChanLbl] = useState('');
  const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
  const isRunning = runningId === t.propertyId || runningId === '*';

  return (
    <div style={{ ...box, padding: 0, overflow: 'hidden' }}>
      {/* ── Property header: identity + health + timings + controls ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{t.propertyLabel || t.propertyId}</span>
            {h ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: h.color, background: h.bg, borderRadius: 999, padding: '2px 10px' }}>
                {h.icon} {h.label}
              </span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 10px' }}>⚪ No check yet</span>
            )}
            {!t.enabled && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 8px' }}>PAUSED</span>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{t.propertyId.replace('properties/', '')}</span>
            <span title={t.lastRunAt ? `Last check: ${fmtTime(t.lastRunAt)}` : undefined}>checked: {fmtAgo(t.lastRunAt)}</span>
            <span title={t.lastSlackAt ? `Last Slack alert: ${fmtTime(t.lastSlackAt)}` : 'No alert has been posted for this property yet'}>📣 last alert: {t.lastSlackAt ? fmtAgo(t.lastSlackAt) : 'none yet'}</span>
            {t.lastError && <span style={{ color: 'var(--c-red)', fontFamily: 'inherit' }} title={t.lastError}>last check failed</span>}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...ghostBtn, color: 'var(--c-blue)' }} disabled={runningId !== null} onClick={onRun}>{isRunning ? 'Checking…' : '▶ Run check'}</button>
          <button style={ghostBtn} disabled={busy} title={t.enabled ? 'Pause background checks for this property' : 'Resume background checks'} onClick={onTogglePause}>{t.enabled ? '⏸ Pause' : '⏵ Resume'}</button>
          <button style={{ ...ghostBtn, color: 'var(--c-red)' }} disabled={busy} title="Stop monitoring this property" onClick={onRemove}>Remove</button>
        </div>
      </div>

      {/* ── This property's Slack channel ── */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)' }}>Slack channel</span>
          {t.hasWebhook ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--c-green-bg, rgba(34,197,94,.12))', color: 'var(--c-green)', borderRadius: 999, padding: '3px 12px', fontWeight: 600 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
              {t.slackLabel || 'own channel connected'}
            </span>
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
            onClick={() => { setEditingChan((v) => !v); setChanUrl(''); setChanLbl(t.slackLabel ?? ''); }}
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
                onClick={() => { void onSaveChannel(chanUrl.trim(), chanLbl.trim()).then((ok) => { if (ok) { setEditingChan(false); setChanUrl(''); } }); }}
              >
                Save
              </button>
              {t.hasWebhook && (
                <button style={{ ...ghostBtn, color: 'var(--c-red)', alignSelf: 'center' }} disabled={busy} onClick={() => { onRemoveChannel(); setEditingChan(false); setChanUrl(''); setChanLbl(''); }}>
                  Remove channel
                </button>
              )}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.4 }}>
              One property, one channel: this property's alerts post here. The URL is stored encrypted in your OS keychain. (How to get a webhook URL — see the Slack alerts card below.)
            </span>
          </div>
        )}
      </div>

      {/* ── Latest run: summary strip + alerts + checks ── */}
      {t.lastRun ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t.lastRun.summary}</span>
            <span style={{ flex: 1 }} />
            {(() => {
              const counts = { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<string, number>;
              for (const c of t.lastRun.checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
              return (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  {(['fail', 'warn', 'pass', 'skip'] as const).map((k) =>
                    counts[k] > 0 ? (
                      <span key={k} style={{ fontSize: 11, fontWeight: 600, color: CHECK_PILL[k].color, background: CHECK_PILL[k].bg, borderRadius: 999, padding: '2px 9px' }}>
                        {counts[k]} {CHECK_PILL[k].label.toLowerCase()}
                      </span>
                    ) : null
                  )}
                </span>
              );
            })()}
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{fmtTime(t.lastRun.at)}</span>
          </div>
          <RunDetail run={t.lastRun} />
        </>
      ) : (
        <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--text-muted)' }}>
          No check has run for this property yet — click <b>▶ Run check</b> above.
        </div>
      )}
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
  // Optional Slack channel captured WHILE adding a property (link + name in the same step).
  const [addChanUrl, setAddChanUrl] = useState('');
  const [addChanLabel, setAddChanLabel] = useState('');
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
        targets: [...status.targets, { propertyId: prop.property, propertyLabel: prop.displayName, enabled: true, slackLabel: lbl || undefined }],
      }));
      setAddId(''); setAddChanUrl(''); setAddChanLabel('');
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
  async function savePropertyChannel(propertyId: string, url: string, lbl: string): Promise<boolean> {
    if (!status) return false;
    setBusy(true); onError(''); setNote('');
    try {
      if (url) await window.desktop.ga4monitoring.setWebhook(url, propertyId);
      setStatus(await window.desktop.ga4monitoring.configure({
        targets: status.targets.map((t) => (t.propertyId === propertyId ? { ...t, slackLabel: lbl || undefined } : t)),
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

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Sign in to Google on this account to monitor GA4 properties.</div>;
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>🔔 GA4 Monitoring</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Background health checks for your GA4 properties. Open a property tab to see its alerts, checks and Slack channel.</div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: status?.running ? 'var(--c-green)' : 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 12px', marginTop: 4 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.running ? 'var(--c-green)' : 'var(--text-faint)', display: 'inline-block' }} />
          {status?.running ? `background on · every ${status.intervalMinutes >= 60 ? `${status.intervalMinutes / 60} hr` : `${status.intervalMinutes} min`}` : 'background off'}
        </span>
      </div>

      {/* ── Toolbar: add property (+ its optional Slack channel) + shared schedule ── */}
      <div style={{ ...box, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260, flex: 1 }}>
          <span style={label}>Add a property to monitor</span>
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
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
              <input style={{ ...input, flex: 2, minWidth: 220, fontSize: 12 }} type="password" placeholder="Slack webhook for this property (optional — connect later from its tab)" value={addChanUrl} onChange={(e) => setAddChanUrl(e.target.value)} />
              <input style={{ ...input, flex: 1, minWidth: 130, fontSize: 12 }} type="text" placeholder="#channel name" value={addChanLabel} onChange={(e) => setAddChanLabel(e.target.value)} />
            </div>
          )}
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

      {/* ── Property tabs + the open property's panel ── */}
      {targets.length === 0 ? (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 30 }}>📡</span>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>No properties monitored yet</div>
          <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 460, lineHeight: 1.5 }}>
            Pick a GA4 property above and click <b>+ Add</b>. Each check verifies data flow, key events, spikes/drops, conversion tracking and revenue integrity — and can alert your Slack channel when something breaks.
          </div>
        </div>
      ) : (
        <div>
          <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
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
              onSaveChannel={(url, lbl) => savePropertyChannel(selected.propertyId, url, lbl)}
              onTestChannel={() => void testPropertyChannel(selected.propertyId)}
              onRemoveChannel={() => void removePropertyChannel(selected.propertyId)}
            />
          )}
        </div>
      )}

      {/* ── Slack alerts: the global on/off switch + the webhook how-to guide. Each property has its
             OWN channel (connect it from the property's tab) — there is no shared default channel. ── */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>Slack alerts</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(status?.slackEnabled)} disabled={busy} onChange={(e) => void configure({ slackEnabled: e.target.checked })} />
            Send new issues to Slack
          </label>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
          One property, one channel: connect each property's Slack channel from its tab above (<b>＋ Connect channel</b>). How to get a webhook URL for a channel:
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
