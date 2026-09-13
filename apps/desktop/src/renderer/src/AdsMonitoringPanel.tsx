import { useEffect, useState } from 'react';
import type { AccountView, AdsAccountView, AdsMonitorStatus, AdsMonitorTargetStatus, AdsMonitorHistoryEntry } from '../../shared/ipc';

// Google Ads Monitoring tab - the Ads sibling of GA4 Monitoring, leaner by design. Top to bottom:
// the "Monitor an Ads account" card (add an account + schedule), then one tab per monitored account
// with: health + score, the per-area check tiles, the full alert list, recent alerts (issue log)
// and the run-history table. Every value traces to a real field on the monitor run
// (AdsMonitoringService in main); the checks are CONFIG-PLANE only and the UI says so.

const HEALTH: Record<string, { color: string; label: string }> = {
  critical: { color: 'var(--error)', label: 'Critical' },
  warning: { color: 'var(--warning)', label: 'Warning' },
  healthy: { color: 'var(--success)', label: 'Healthy' },
};
const CHECK_PILL: Record<string, { label: string; color: string }> = {
  pass: { label: 'Pass', color: 'var(--success)' },
  warn: { label: 'Warning', color: 'var(--warning)' },
  fail: { label: 'Issue', color: 'var(--error)' },
};
const SEV_COLOR: Record<string, string> = { critical: 'var(--error)', warning: 'var(--warning)', info: 'var(--text-muted)' };

function Dot({ color, size = 7 }: { color: string; size?: number }): JSX.Element {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />;
}
function StatusText({ color, label: text, size = 12.5 }: { color: string; label: string; size?: number }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: size, fontWeight: 500, color }}>
      <Dot color={color} />{text}
    </span>
  );
}

const card: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-m)', padding: 18 };
const sectionTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)', margin: '0 0 10px' };
const meta: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 400 };
const btn: React.CSSProperties = { background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-s)', padding: '7px 14px', cursor: 'pointer', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 'var(--radius-s)', padding: '5px 11px', cursor: 'pointer', fontSize: 12.5, fontWeight: 500 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'transparent', fontWeight: 600 };
const input: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const fmtTime = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString() : 'never');
const fmtId = (id: string): string => (/^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

export function AdsMonitoringPanel({ active, onError }: { active: AccountView | undefined; onError: (m: string) => void }): JSX.Element {
  const signedIn = Boolean(active?.hasGoogleToken);
  const [ready, setReady] = useState<{ ready: boolean; message?: string; remedy?: string } | null>(null);
  const [accounts, setAccounts] = useState<AdsAccountView[] | null>(null);
  const [status, setStatus] = useState<AdsMonitorStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addId, setAddId] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null); // customerId, or '*' for a full sweep
  const [busy, setBusy] = useState(false);
  const [webhookDraft, setWebhookDraft] = useState('');
  const [webhookLabelDraft, setWebhookLabelDraft] = useState('');
  const [editingWebhook, setEditingWebhook] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function refreshStatus(): Promise<void> {
    try { setStatus(await window.desktop.adsmonitoring.status()); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => {
    void refreshStatus();
    if (signedIn) {
      window.desktop.ads.status().then(setReady).catch(() => setReady({ ready: false, message: 'Google Ads readiness could not be checked.' }));
    }
    const off = window.desktop.adsmonitoring.onRun(() => { void refreshStatus(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, signedIn]);

  // Accounts load lazily, only when the user opens the add dropdown (an MCC listAccounts read).
  async function loadAccounts(): Promise<void> {
    if (accounts !== null) return;
    try { setAccounts(await window.desktop.ads.listAccounts()); } catch (e) { onError(e instanceof Error ? e.message : String(e)); setAccounts([]); }
  }

  async function configure(patch: Parameters<typeof window.desktop.adsmonitoring.configure>[0]): Promise<void> {
    setBusy(true);
    try { setStatus(await window.desktop.adsmonitoring.configure(patch)); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function runNow(customerId?: string): Promise<void> {
    setRunningId(customerId ?? '*');
    try { await window.desktop.adsmonitoring.runNow(customerId); await refreshStatus(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setRunningId(null); }
  }

  const targets = status?.targetStatuses ?? [];
  const selected: AdsMonitorTargetStatus | undefined = targets.find((t) => t.customerId === selectedId) ?? targets[0];

  const addable = (accounts ?? []).filter((a) => !a.manager && !a.hidden && !targets.some((t) => t.customerId === a.id));

  async function addTarget(): Promise<void> {
    const acc = (accounts ?? []).find((a) => a.id === addId);
    if (!acc) return;
    const next = [
      ...targets.map(({ lastRunAt: _a, lastError: _b, lastRun: _c, hasWebhook: _d, lastSlackAt: _e, ...t }) => t),
      { customerId: acc.id, label: acc.name || acc.id, enabled: true, ...(acc.loginCustomerId ? { loginCustomerId: acc.loginCustomerId } : {}) },
    ];
    await configure({ targets: next });
    setSelectedId(acc.id);
    setAddId('');
  }

  async function removeTarget(customerId: string): Promise<void> {
    const next = targets.filter((t) => t.customerId !== customerId).map(({ lastRunAt: _a, lastError: _b, lastRun: _c, hasWebhook: _d, lastSlackAt: _e, ...t }) => t);
    await configure({ targets: next });
    if (selectedId === customerId) setSelectedId(null);
  }

  async function toggleTarget(customerId: string, enabled: boolean): Promise<void> {
    const next = targets.map(({ lastRunAt: _a, lastError: _b, lastRun: _c, hasWebhook: _d, lastSlackAt: _e, ...t }) => (t.customerId === customerId ? { ...t, enabled } : t));
    await configure({ targets: next });
  }

  async function saveWebhook(customerId: string): Promise<void> {
    setBusy(true);
    setTestResult(null);
    try {
      if (webhookDraft.trim()) await window.desktop.adsmonitoring.setWebhook(webhookDraft.trim(), customerId);
      if (webhookLabelDraft.trim() || webhookDraft.trim()) {
        const next = targets.map(({ lastRunAt: _a, lastError: _b, lastRun: _c, hasWebhook: _d, lastSlackAt: _e, ...t }) =>
          t.customerId === customerId ? { ...t, slackLabel: webhookLabelDraft.trim() || t.slackLabel } : t);
        await window.desktop.adsmonitoring.configure({ targets: next });
      }
      await refreshStatus();
      setEditingWebhook(false);
      setWebhookDraft('');
      setWebhookLabelDraft('');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function testWebhook(customerId: string): Promise<void> {
    setTestResult('Sending...');
    const r = await window.desktop.adsmonitoring.sendTest(customerId);
    setTestResult(r.ok ? 'Test message sent - check the channel.' : r.error ?? 'Send failed.');
  }

  if (!signedIn) {
    return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13.5 }}>Connect a Google account first - Ads monitoring runs against the signed-in account's Google Ads access.</div>;
  }
  if (ready && !ready.ready) {
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <div style={card}>
          <h3 style={sectionTitle}>Google Ads access is not ready</h3>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55, margin: 0 }}>
            {ready.message ?? 'Google Ads access is not configured.'} {ready.remedy ?? ''}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 24px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1060 }}>
      {/* Add + schedule card (top, like GA4 Monitoring) */}
      <div style={card}>
        <h3 style={sectionTitle}>Monitor a Google Ads account</h3>
        <p style={{ ...meta, margin: '0 0 12px', lineHeight: 1.5 }}>
          Scheduled conversion-health sweeps: click tagging (GCLID/UTM), conversion action config (double counting, zero-value forcing, missing labels),
          conversion volume (silent actions, spend without conversions), audience lists stuck at zero, and who changed conversion measurement recently.
          Config-plane only - whether tags actually fire on the site is the GTM tab's tag verification.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={{ ...input, minWidth: 260 }}
            value={addId}
            onFocus={() => void loadAccounts()}
            onMouseDown={() => void loadAccounts()}
            onChange={(e) => setAddId(e.target.value)}
          >
            <option value="">{accounts === null ? 'Pick an Ads account...' : addable.length ? 'Pick an Ads account...' : 'No further accounts available'}</option>
            {addable.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id} ({fmtId(a.id)}){a.testAccount ? ' - test account' : ''}</option>
            ))}
          </select>
          <button style={primaryBtn} disabled={!addId || busy || targets.length >= 5} onClick={() => void addTarget()}>Add</button>
          <span style={meta}>{targets.length}/5 accounts</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(status?.enabled)} disabled={busy} onChange={(e) => void configure({ enabled: e.target.checked })} />
            Background monitoring
          </label>
          <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', fontSize: 13 }}>
            Every
            <select style={input} value={status?.intervalMinutes ?? 360} disabled={busy} onChange={(e) => void configure({ intervalMinutes: Number(e.target.value) })}>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
              <option value={360}>6 hours</option>
              <option value={720}>12 hours</option>
              <option value={1440}>24 hours</option>
            </select>
          </label>
          <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', fontSize: 13 }}>
            Window
            <select style={input} value={status?.days ?? 30} disabled={busy} onChange={(e) => void configure({ days: Number(e.target.value) })}>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <button style={btn} disabled={runningId !== null || !targets.length} onClick={() => void runNow()}>
            {runningId === '*' ? 'Checking...' : 'Run all now'}
          </button>
          {status?.lastError ? <span style={{ fontSize: 12, color: 'var(--error)' }}>{status.lastError}</span> : null}
        </div>
      </div>

      {targets.length > 0 && (
        <>
          {/* Target tabs */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist">
            {targets.map((t) => (
              <button
                key={t.customerId}
                role="tab"
                aria-selected={selected?.customerId === t.customerId}
                onClick={() => setSelectedId(t.customerId)}
                style={{
                  ...ghostBtn,
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  ...(selected?.customerId === t.customerId ? { borderColor: 'var(--primary)', color: 'var(--text)' } : {}),
                  opacity: t.enabled ? 1 : 0.55,
                }}
              >
                <Dot color={t.lastRun ? HEALTH[t.lastRun.health]?.color ?? 'var(--text-muted)' : 'var(--text-faint)'} />
                {t.label || fmtId(t.customerId)}
              </button>
            ))}
          </div>

          {selected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Target header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{selected.label || fmtId(selected.customerId)}</span>
                  <span style={{ ...meta, fontFamily: MONO }}>{fmtId(selected.customerId)}{selected.loginCustomerId ? ` via manager ${fmtId(selected.loginCustomerId)}` : ''}</span>
                </div>
                <span style={{ flex: 1 }} />
                {selected.lastRun ? (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: HEALTH[selected.lastRun.health]?.color }}>{selected.lastRun.score}</span>
                    <span style={meta}>/100</span>
                    <StatusText color={HEALTH[selected.lastRun.health]?.color ?? 'var(--text-muted)'} label={HEALTH[selected.lastRun.health]?.label ?? selected.lastRun.health} />
                  </div>
                ) : null}
                <button style={btn} disabled={runningId !== null} onClick={() => void runNow(selected.customerId)}>
                  {runningId === selected.customerId ? 'Checking...' : 'Run check'}
                </button>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.enabled} disabled={busy} onChange={(e) => void toggleTarget(selected.customerId, e.target.checked)} />
                  Scheduled
                </label>
                <button style={ghostBtn} disabled={busy} onClick={() => void removeTarget(selected.customerId)}>Remove</button>
              </div>
              <div style={meta}>
                Last check: {fmtTime(selected.lastRunAt)}{selected.lastError ? <span style={{ color: 'var(--error)' }}> - {selected.lastError}</span> : null}
              </div>

              {/* Slack channel */}
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h3 style={{ ...sectionTitle, margin: 0 }}>Slack alerts</h3>
                  <span style={{ flex: 1 }} />
                  {selected.hasWebhook && !editingWebhook ? (
                    <>
                      <StatusText color="var(--success)" label={`Connected${selected.slackLabel ? ` - ${selected.slackLabel}` : ''}`} />
                      <button style={ghostBtn} onClick={() => void testWebhook(selected.customerId)}>Send test</button>
                      <button style={ghostBtn} onClick={() => { setEditingWebhook(true); setWebhookLabelDraft(selected.slackLabel ?? ''); }}>Change</button>
                      <button style={ghostBtn} disabled={busy} onClick={async () => { setStatus(await window.desktop.adsmonitoring.clearWebhook(selected.customerId)); }}>Disconnect</button>
                    </>
                  ) : null}
                </div>
                {(!selected.hasWebhook || editingWebhook) && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                    <input style={{ ...input, minWidth: 320 }} placeholder="https://hooks.slack.com/services/..." value={webhookDraft} onChange={(e) => setWebhookDraft(e.target.value)} />
                    <input style={{ ...input, minWidth: 160 }} placeholder="Channel label, e.g. #ads-alerts" value={webhookLabelDraft} onChange={(e) => setWebhookLabelDraft(e.target.value)} />
                    <button style={primaryBtn} disabled={busy || !webhookDraft.trim()} onClick={() => void saveWebhook(selected.customerId)}>Save</button>
                    {editingWebhook ? <button style={ghostBtn} onClick={() => { setEditingWebhook(false); setWebhookDraft(''); }}>Cancel</button> : null}
                  </div>
                )}
                {testResult ? <div style={{ ...meta, marginTop: 8 }}>{testResult}</div> : null}
                <p style={{ ...meta, margin: '10px 0 0', lineHeight: 1.5 }}>
                  New issues post to this channel the moment a sweep finds them; an issue never repeats while it stays open. The webhook URL is stored encrypted on this machine.
                </p>
              </div>

              {selected.lastRun ? (
                <>
                  {/* Summary */}
                  <div style={card}>
                    <h3 style={sectionTitle}>Summary</h3>
                    <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55, margin: 0 }}>{selected.lastRun.summary}</p>
                  </div>

                  {/* Check tiles */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
                    {selected.lastRun.checks.map((c) => (
                      <div key={c.id} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{c.label}</span>
                          <span style={{ flex: 1 }} />
                          <StatusText color={CHECK_PILL[c.status]?.color ?? 'var(--text-muted)'} label={CHECK_PILL[c.status]?.label ?? c.status} size={11.5} />
                        </div>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.detail}</span>
                      </div>
                    ))}
                  </div>

                  {/* Alerts */}
                  <div style={card}>
                    <h3 style={sectionTitle}>Open findings ({selected.lastRun.alerts.length})</h3>
                    {selected.lastRun.alerts.length === 0 ? (
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Nothing open. The last sweep found no config-level conversion problems.</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {selected.lastRun.alerts.map((a) => (
                          <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <span style={{ marginTop: 5 }}><Dot color={SEV_COLOR[a.severity] ?? 'var(--text-muted)'} /></span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ ...meta, textTransform: 'none' }}>{a.severity} · {a.area}{selected.lastRun!.newAlertIds.includes(a.id) ? ' · new this sweep' : ''}</span>
                              <span style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>{a.title}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>No check has run yet for this account - click Run check.</div>
              )}

              {/* Recent alerts (issue log) - rendered even before the first run of this session */}
              {(selected.issueLog ?? []).length > 0 && (
                <div style={card}>
                  <h3 style={sectionTitle}>Recent alerts</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(selected.issueLog ?? []).slice().reverse().slice(0, 12).map((e, i) => (
                      <div key={`${e.id}:${e.openedAt}:${i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <StatusText color={SEV_COLOR[e.severity] ?? 'var(--text-muted)'} label={e.severity} size={11.5} />
                        <span style={{ fontSize: 12.5, color: 'var(--text-dim)', flex: '1 1 320px', lineHeight: 1.45 }}>{e.title}</span>
                        <span style={meta}>{fmtTime(e.openedAt)}{e.closedAt ? ` - resolved ${fmtTime(e.closedAt)}` : ' - still open'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Run history */}
              {(selected.history ?? []).length > 0 && (
                <div style={card}>
                  <h3 style={sectionTitle}>Monitoring history</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                      <thead>
                        <tr>
                          {['When', 'Health', 'Score', 'Critical', 'Warnings', 'Duration', 'Trigger'].map((h) => (
                            <th key={h} style={{ textAlign: 'left', padding: '6px 10px 6px 0', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(selected.history ?? []).slice().reverse().map((h: AdsMonitorHistoryEntry, i: number) => (
                          <tr key={`${h.at}:${i}`}>
                            <td style={{ padding: '6px 10px 6px 0', whiteSpace: 'nowrap' }}>{fmtTime(h.at)}</td>
                            <td style={{ padding: '6px 10px 6px 0' }}><StatusText color={HEALTH[h.health]?.color ?? 'var(--text-muted)'} label={HEALTH[h.health]?.label ?? h.health} size={12} /></td>
                            <td style={{ padding: '6px 10px 6px 0', fontVariantNumeric: 'tabular-nums' }}>{h.score}</td>
                            <td style={{ padding: '6px 10px 6px 0', fontVariantNumeric: 'tabular-nums', color: h.critical ? 'var(--error)' : undefined }}>{h.critical}</td>
                            <td style={{ padding: '6px 10px 6px 0', fontVariantNumeric: 'tabular-nums', color: h.warnings ? 'var(--warning)' : undefined }}>{h.warnings}</td>
                            <td style={{ padding: '6px 10px 6px 0', fontVariantNumeric: 'tabular-nums' }}>{(h.durationMs / 1000).toFixed(1)}s</td>
                            <td style={{ padding: '6px 10px 6px 0' }}>{h.trigger}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
