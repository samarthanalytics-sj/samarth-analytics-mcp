import { useEffect, useState } from 'react';
import type { AppInfo } from '../../preload';

const phases: Array<{ n: number; label: string; done: boolean }> = [
  { n: 0, label: 'Shell + IPC bridge', done: true },
  { n: 1, label: 'Account registry + secret store (safeStorage)', done: false },
  { n: 2, label: 'Per-account Google loopback OAuth', done: false },
  { n: 3, label: 'Embedded MCP server + per-account dispatch', done: false },
  { n: 4, label: 'Multi-provider LLM gateway', done: false },
  { n: 5, label: 'UI: account switcher, GTM/GA4 views, chat', done: false },
  { n: 6, label: 'Windows installer (electron-builder)', done: false },
];

export function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pong, setPong] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    window.desktop
      .getInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function handlePing(): Promise<void> {
    try {
      setPong(await window.desktop.ping(`hello @ ${new Date().toLocaleTimeString()}`));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Samarth Desktop</h1>
        <span style={styles.badge}>Phase 0 — scaffold</span>
      </header>

      <p style={styles.lede}>
        Local multi-account desktop app for the GTM / GA4 MCP. The shell is up and the
        secure renderer&nbsp;↔&nbsp;main IPC bridge is live.
      </p>

      <section style={styles.card}>
        <h2 style={styles.h2}>Environment (via IPC)</h2>
        {error && <pre style={styles.error}>{error}</pre>}
        {info ? (
          <dl style={styles.dl}>
            {Object.entries(info).map(([k, v]) => (
              <div key={k} style={styles.row}>
                <dt style={styles.dt}>{k}</dt>
                <dd style={styles.dd}>{String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          !error && <p style={styles.muted}>Loading…</p>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>IPC round-trip</h2>
        <button style={styles.button} onClick={handlePing}>
          Ping main process
        </button>
        {pong && <code style={styles.pong}>{pong}</code>}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Build roadmap</h2>
        <ul style={styles.list}>
          {phases.map((p) => (
            <li key={p.n} style={styles.listItem}>
              <span style={{ ...styles.dot, background: p.done ? '#34d399' : '#374151' }} />
              <span style={{ color: p.done ? '#e5e7eb' : '#9ca3af' }}>
                Phase {p.n} — {p.label}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    color: '#e5e7eb',
    background: '#0b0f17',
    minHeight: '100vh',
    margin: 0,
    padding: '32px 40px',
    boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'center', gap: 12 },
  h1: { fontSize: 24, fontWeight: 700, margin: 0 },
  badge: {
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 999,
    background: '#1f2937',
    color: '#93c5fd',
    border: '1px solid #334155',
  },
  lede: { color: '#9ca3af', maxWidth: 640, lineHeight: 1.5 },
  card: {
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 12,
    padding: 20,
    marginTop: 20,
    maxWidth: 640,
  },
  h2: { fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#9ca3af', margin: '0 0 12px' },
  dl: { margin: 0 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #1f2937' },
  dt: { color: '#9ca3af' },
  dd: { margin: 0, fontFamily: 'ui-monospace, monospace', color: '#e5e7eb' },
  muted: { color: '#6b7280' },
  error: { color: '#fca5a5', whiteSpace: 'pre-wrap' },
  button: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  pong: { display: 'inline-block', marginLeft: 12, fontFamily: 'ui-monospace, monospace', color: '#34d399' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  listItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block' },
};
