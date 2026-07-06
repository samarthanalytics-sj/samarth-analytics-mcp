import { useEffect, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4MonitorTargetStatus, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab — MULTI-property. Maintains a list of monitored GA4 properties, configures the
// shared background schedule + Slack webhook, runs on-demand checks (per property or all), and shows
// each property's latest run (health, alerts, checks). The heavy lifting is in main
// (Ga4MonitoringService sweeps the list sequentially + the pure monitorGa4 engine); this is a thin
// control panel over status()/configure()/runNow().

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const HEALTH: Record<string, { color: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', label: 'Healthy', icon: '🟢' },
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
const smallBtn: React.CSSProperties = { ...btn, padding: '4px 10px', fontSize: 12 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--c-blue)', color: '#fff', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };

function fmtTime(ms: number | null): string {
  if (!ms) return 'never';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
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
  async function sendTest(): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const r = await window.desktop.ga4monitoring.sendTest();
      setNote(r.ok ? 'Test message sent — check your Slack channel to confirm where alerts land.' : `Test failed: ${r.error ?? 'unknown error'}`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const addable = (properties ?? []).filter((p) => !targets.some((t) => t.propertyId === p.property));
  const selected = targets.find((t) => t.propertyId === selectedId) ?? null;

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Sign in to Google on this account to monitor GA4 properties.</div>;
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>🔔 GA4 Monitoring</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Background health checks for your GA4 properties: data flow, key events firing, sudden spikes/drops, conversion tracking, and revenue integrity. Each check sweeps every monitored property; new issues can be posted to Slack.</div>
      </div>

      {/* ── Schedule + add property ── */}
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={Boolean(status?.enabled)} disabled={busy || !targets.length} onChange={(e) => void configure({ enabled: e.target.checked })} />
          Run in the background
        </label>
        <button style={primaryBtn} onClick={() => void runNow()} disabled={runningId !== null || !targets.some((t) => t.enabled)}>
          {runningId === '*' ? 'Checking all…' : `Run all now${targets.filter((t) => t.enabled).length > 1 ? ` (${targets.filter((t) => t.enabled).length})` : ''}`}
        </button>
      </div>

      {/* ── Monitored properties ── */}
      {targets.length > 0 && (
        <div style={{ ...box, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
            Monitored properties <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {targets.length}{targets.length >= 2 ? ' — click a row to see its checks' : ''}</span>
          </div>
          {targets.map((t, i) => {
            const h = t.lastRun ? HEALTH[t.lastRun.health] : null;
            const isSelected = t.propertyId === selectedId;
            const alertCount = t.lastRun?.alerts.length ?? 0;
            return (
              <div
                key={t.propertyId}
                onClick={() => setSelectedId(t.propertyId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 16px', cursor: 'pointer',
                  borderBottom: i === targets.length - 1 ? 'none' : '1px solid var(--border)',
                  background: isSelected ? 'var(--surface)' : 'transparent',
                  borderLeft: isSelected ? '3px solid var(--c-blue)' : '3px solid transparent',
                  opacity: t.enabled ? 1 : 0.55,
                }}
              >
                <span style={{ fontSize: 14, width: 18, textAlign: 'center' }} title={h ? h.label : 'No check yet'}>{h ? h.icon : '⚪'}</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{t.propertyLabel || t.propertyId}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{t.propertyId.replace('properties/', '')}</span>
                {!t.enabled && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 999, padding: '1px 8px' }}>PAUSED</span>}
                {alertCount > 0 && t.lastRun && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: SEV_COLOR[t.lastRun.health === 'critical' ? 'critical' : 'medium'], background: t.lastRun.health === 'critical' ? 'var(--c-red-bg, rgba(239,68,68,.12))' : 'var(--c-amber-bg, rgba(245,158,11,.14))', borderRadius: 999, padding: '1px 9px' }}>
                    {alertCount} alert{alertCount === 1 ? '' : 's'}
                  </span>
                )}
                {t.lastError && <span style={{ fontSize: 11.5, color: 'var(--c-red)' }} title={t.lastError}>check failed</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{fmtTime(t.lastRunAt)}</span>
                <button style={smallBtn} disabled={runningId !== null} onClick={(e) => { e.stopPropagation(); void runNow(t.propertyId); }}>
                  {runningId === t.propertyId ? 'Checking…' : 'Run'}
                </button>
                <button style={smallBtn} disabled={busy} title={t.enabled ? 'Pause background checks for this property' : 'Resume background checks'} onClick={(e) => { e.stopPropagation(); togglePaused(t.propertyId); }}>
                  {t.enabled ? 'Pause' : 'Resume'}
                </button>
                <button style={{ ...smallBtn, color: 'var(--c-red)' }} disabled={busy} title="Stop monitoring this property" onClick={(e) => { e.stopPropagation(); removeProperty(t.propertyId); }}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Slack ── */}
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
          /* Connected: one channel only — no add/replace form, just verify or disconnect. */
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '5px 14px', fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--c-green)', display: 'inline-block' }} />
              {status.slackLabel || 'Slack channel connected'}
            </span>
            <button style={btn} onClick={() => void sendTest()} disabled={busy} title="Post a confirmation message so you can see which channel receives alerts">Send test</button>
            <button style={btn} onClick={() => void clearWebhook()} disabled={busy}>Remove</button>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Alerts for every monitored property go to this one channel (each message names its property). To switch, remove it and connect the new channel’s webhook.</span>
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
      </div>

      {note && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{note}</div>}

      {/* ── Status line ── */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>Background: <b style={{ color: status?.running ? 'var(--c-green)' : 'var(--text-faint)' }}>{status?.running ? 'on' : 'off'}</b></span>
        <span>Last check: {fmtTime(status?.lastRunAt ?? null)}</span>
        {status?.lastError && <span style={{ color: 'var(--c-red)' }}>Last error: {status.lastError}</span>}
      </div>

      {/* ── Selected property's latest run ── */}
      {selected?.lastRun && <RunDetail run={selected.lastRun} />}
      {selected && !selected.lastRun && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No check has run for <b>{selected.propertyLabel || selected.propertyId}</b> yet — click <b>Run</b> on its row (or Run all now).
        </div>
      )}
    </div>
  );
}
