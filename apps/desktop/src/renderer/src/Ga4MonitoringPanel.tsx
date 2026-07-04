import { useEffect, useMemo, useState } from 'react';
import type { AccountView, Ga4MonitorStatus, Ga4MonitorRun, Ga4PropertyListItem } from '../../shared/ipc';

// GA4 Monitoring tab. Picks a GA4 property to watch, configures the background schedule + Slack
// webhook, runs an on-demand check, and shows the latest run (health, alerts, checks). The heavy
// lifting is in main (Ga4MonitoringService + the pure monitorGa4 engine); this is a thin control panel.

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--c-red)', high: 'var(--c-red)', medium: 'var(--c-amber, #b8860b)', low: 'var(--c-amber, #b8860b)', info: 'var(--text-muted)',
};
const HEALTH: Record<string, { color: string; label: string; icon: string }> = {
  critical: { color: 'var(--c-red)', label: 'Critical', icon: '🔴' },
  warning: { color: 'var(--c-amber, #b8860b)', label: 'Warning', icon: '🟠' },
  healthy: { color: 'var(--c-green)', label: 'Healthy', icon: '🟢' },
};
const CHECK_ICON: Record<string, string> = { pass: '✅', warn: '🟠', fail: '🔴', skip: '⚪' };

const box: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 };
const btn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--c-blue)', color: '#fff', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };

function fmtTime(ms: number | null): string {
  if (!ms) return 'never';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}

export function Ga4MonitoringPanel({ active, onError }: { active: AccountView | undefined; onError: (m: string) => void }): JSX.Element {
  const signedIn = Boolean(active?.hasGoogleToken);
  const [properties, setProperties] = useState<Ga4PropertyListItem[] | null>(null);
  const [status, setStatus] = useState<Ga4MonitorStatus | null>(null);
  const [lastRun, setLastRun] = useState<Ga4MonitorRun | null>(null);
  const [running, setRunning] = useState(false);
  const [webhookInput, setWebhookInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [labelDirty, setLabelDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const apply = (st: Ga4MonitorStatus): void => { setStatus(st); if (st.lastRun) setLastRun(st.lastRun); };
  // Seed the label field from saved config until the user starts editing (then keep their draft).
  useEffect(() => {
    if (!labelDirty) setLabelInput(status?.slackLabel ?? '');
  }, [status?.slackLabel, labelDirty]);

  async function refreshStatus(): Promise<void> {
    try { apply(await window.desktop.ga4monitoring.status()); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => {
    void refreshStatus();
    if (signedIn) window.desktop.ga4.listProperties().then(setProperties).catch((e) => { onError(e instanceof Error ? e.message : String(e)); setProperties([]); });
    // Live runs (background + on-demand) push straight into the panel.
    const off = window.desktop.ga4monitoring.onRun((run) => { setLastRun(run); void refreshStatus(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  async function configure(patch: Partial<Ga4MonitorStatus>): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try { apply(await window.desktop.ga4monitoring.configure(patch)); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function runNow(): Promise<void> {
    if (running) return;
    setRunning(true); onError(''); setNote('');
    try {
      const run = await window.desktop.ga4monitoring.runNow();
      if (run) { setLastRun(run); setNote(run.slackError ? `Slack: ${run.slackError}` : run.slackSent ? 'Posted new issues to Slack.' : ''); }
      else setNote('Nothing to check — pick a property and make sure the account is signed in to Google.');
      void refreshStatus();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setRunning(false); }
  }

  // Save the webhook URL (if one was entered) and/or the channel label. Lets the user update just the
  // label (leave the URL box empty) or connect a new webhook + label together.
  async function saveWebhook(): Promise<void> {
    const url = webhookInput.trim();
    if (!url && !labelDirty) return;
    setBusy(true); onError(''); setNote('');
    try {
      let st = status ?? undefined;
      if (url) { st = await window.desktop.ga4monitoring.setWebhook(url); setWebhookInput(''); }
      st = await window.desktop.ga4monitoring.configure({ slackLabel: labelInput.trim() });
      setLabelDirty(false);
      if (st) apply(st);
      setNote(url ? 'Slack webhook saved (encrypted).' : 'Slack channel label saved.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function clearWebhook(): Promise<void> {
    setBusy(true); onError('');
    try { apply(await window.desktop.ga4monitoring.clearWebhook()); setNote('Slack webhook removed.'); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function sendTest(): Promise<void> {
    setBusy(true); onError(''); setNote('');
    try {
      const r = await window.desktop.ga4monitoring.sendTest();
      setNote(r.ok ? 'Test message sent — check your Slack channel to confirm where alerts land.' : `Test failed: ${r.error ?? 'unknown error'}`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const selectedProperty = status?.propertyId ?? '';
  const health = lastRun ? HEALTH[lastRun.health] : null;
  const newIds = useMemo(() => new Set(lastRun?.newAlertIds ?? []), [lastRun]);

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Sign in to Google on this account to monitor a GA4 property.</div>;
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>🔔 GA4 Monitoring</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Background health checks for a GA4 property: data flow, key events firing, sudden spikes/drops, conversion tracking, and revenue integrity. New issues can be posted to Slack.</div>
      </div>

      {/* ── Configure ── */}
      <div style={{ ...box, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260, flex: 1 }}>
          <span style={label}>Property to monitor</span>
          <select
            style={input}
            value={selectedProperty}
            onChange={(e) => {
              const prop = properties?.find((p) => p.property === e.target.value);
              void configure({ propertyId: e.target.value || null, propertyLabel: prop?.displayName ?? '' });
            }}
          >
            <option value="">{properties === null ? 'Loading…' : 'Select a property…'}</option>
            {(properties ?? []).map((p) => (
              <option key={p.property} value={p.property}>{p.displayName} ({p.property.replace('properties/', '')})</option>
            ))}
          </select>
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
          <input type="checkbox" checked={Boolean(status?.enabled)} disabled={busy || !status?.propertyId} onChange={(e) => void configure({ enabled: e.target.checked })} />
          Run in the background
        </label>
        <button style={primaryBtn} onClick={() => void runNow()} disabled={running || !status?.propertyId}>{running ? 'Checking…' : 'Run now'}</button>
      </div>

      {/* ── Slack ── */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>
            Slack alerts{' '}
            {status?.hasWebhook
              ? <span style={{ color: 'var(--c-green)', fontSize: 12 }}>· connected{status?.slackLabel ? ` to ${status.slackLabel}` : ''}</span>
              : <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>· not configured</span>}
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(status?.slackEnabled)} disabled={busy} onChange={(e) => void configure({ slackEnabled: e.target.checked })} />
            Send new issues to Slack
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 260 }} type="password" placeholder="https://hooks.slack.com/services/…" value={webhookInput} onChange={(e) => setWebhookInput(e.target.value)} />
          <button style={btn} onClick={() => void saveWebhook()} disabled={busy || (!webhookInput.trim() && !labelDirty)}>Save webhook</button>
          {status?.hasWebhook && <button style={btn} onClick={() => void sendTest()} disabled={busy} title="Post a confirmation message so you can see which channel receives alerts">Send test</button>}
          {status?.hasWebhook && <button style={btn} onClick={() => void clearWebhook()} disabled={busy}>Remove</button>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
          <span style={label}>Channel &amp; workspace (label)</span>
          <input style={{ ...input, maxWidth: 420 }} type="text" placeholder="#ga4-alerts · Acme workspace" value={labelInput} onChange={(e) => { setLabelInput(e.target.value); setLabelDirty(true); }} />
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Slack doesn’t expose the channel or workspace from a webhook URL, so note them here — it’s shown as the connection status. Use “Send test” to confirm where alerts actually land.</span>
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
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>The URL is stored encrypted in your OS keychain (never synced or logged). To alert a different channel, create another webhook for that channel and paste it here. An ongoing issue is posted once, not on every check.</div>
      </div>

      {note && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{note}</div>}

      {/* ── Status + last run ── */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>Background: <b style={{ color: status?.running ? 'var(--c-green)' : 'var(--text-faint)' }}>{status?.running ? 'on' : 'off'}</b></span>
        <span>Last check: {fmtTime(status?.lastRunAt ?? null)}</span>
        {status?.lastError && <span style={{ color: 'var(--c-red)' }}>Last error: {status.lastError}</span>}
      </div>

      {lastRun && health && (
        <div style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 18 }}>{health.icon}</span>
            <span style={{ fontWeight: 700, color: health.color, fontSize: 16 }}>{health.label}</span>
            <span style={{ color: 'var(--text-dim)' }}>{lastRun.summary}</span>
          </div>

          {lastRun.alerts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
              {lastRun.alerts.map((a) => (
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

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
            <div style={{ ...label, marginBottom: 4 }}>Checks</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {lastRun.checks.map((c) => (
                <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'baseline' }}>
                  <span>{CHECK_ICON[c.status] ?? '•'}</span>
                  <span style={{ fontWeight: 600, minWidth: 150 }}>{c.label}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{c.detail}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>{lastRun.propertyLabel} · checked {fmtTime(lastRun.at)}</div>
        </div>
      )}
    </div>
  );
}
