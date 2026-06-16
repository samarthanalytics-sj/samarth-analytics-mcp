import { useEffect, useState } from 'react';
import type { AppInfo } from '../../preload';
import type { AccountView, GoogleClientStatus, LlmProvider, SecretSelfTest } from '../../shared/ipc';

const phases: Array<{ n: number; label: string; done: boolean }> = [
  { n: 0, label: 'Shell + IPC bridge', done: true },
  { n: 1, label: 'Account registry + secret store (safeStorage)', done: true },
  { n: 2, label: 'Per-account Google loopback OAuth', done: true },
  { n: 3, label: 'Embedded MCP server + per-account dispatch', done: false },
  { n: 4, label: 'Multi-provider LLM gateway', done: false },
  { n: 5, label: 'UI: account switcher, GTM/GA4 views, chat', done: false },
  { n: 6, label: 'Windows installer (electron-builder)', done: false },
];

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-1.5-pro',
};

export function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [google, setGoogle] = useState<GoogleClientStatus | null>(null);
  const [selfTest, setSelfTest] = useState<SecretSelfTest | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

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
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Samarth Desktop</h1>
        <span style={styles.badge}>Phase 2 — Google sign-in</span>
      </header>
      <p style={styles.lede}>
        Connect one or more Google accounts. Each sign-in uses your browser&apos;s account
        chooser; the token is vaulted locally (DPAPI). Pick GTM/GA4 and chat in later phases.
      </p>

      {error && <pre style={styles.error}>{error}</pre>}

      {google && !google.configured && (
        <div style={styles.warn}>
          <strong>Google OAuth client not configured.</strong> Create a Google “Desktop app”
          OAuth client, then either set <code>GOOGLE_DESKTOP_CLIENT_ID</code> /{' '}
          <code>GOOGLE_DESKTOP_CLIENT_SECRET</code> before launching, or drop a file at:
          <pre style={styles.path}>{google.configPath}</pre>
          <code>{'{ "clientId": "…apps.googleusercontent.com", "clientSecret": "…" }'}</code>
        </div>
      )}

      <section style={styles.card}>
        <div style={styles.cardHead}>
          <h2 style={styles.h2}>Accounts</h2>
          <span style={styles.muted}>{accounts.length} connected</span>
        </div>

        <button style={styles.button} onClick={connect} disabled={connecting || !google?.configured}>
          {connecting ? 'Waiting for browser sign-in…' : '+ Connect Google account'}
        </button>

        {accounts.length === 0 ? (
          <p style={styles.muted}>No accounts yet — connect one above.</p>
        ) : (
          <ul style={styles.list}>
            {accounts.map((a) => (
              <li key={a.id} style={styles.account}>
                <div style={styles.accountTop}>
                  <span style={{ ...styles.dot, background: a.isActive ? '#34d399' : '#374151' }} />
                  <strong>{a.displayName ? `${a.displayName} · ` : ''}{a.email}</strong>
                  {a.isActive && <span style={styles.activeTag}>active</span>}
                  <span style={styles.spacer} />
                  {!a.isActive && (
                    <button style={styles.linkBtn} onClick={() => run(() => window.desktop.accounts.setActive(a.id))}>
                      make active
                    </button>
                  )}
                  {a.hasGoogleToken && (
                    <button style={styles.linkBtn} onClick={() => run(() => window.desktop.google.disconnect(a.id))}>
                      disconnect
                    </button>
                  )}
                  <button style={styles.dangerBtn} onClick={() => run(() => window.desktop.accounts.remove(a.id))}>
                    remove
                  </button>
                </div>
                <div style={styles.accountMeta}>
                  <span>google: {a.hasGoogleToken ? '✓ signed in' : '— not connected'}</span>
                  <span>
                    llm: {a.llm ? `${a.llm.provider}/${a.llm.model}${a.llm.hasApiKey ? ' · key ✓' : ' · no key'}` : '— unset'}
                  </span>
                </div>
                <LlmEditor account={a} onChange={refresh} onError={setError} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Secret store (safeStorage / DPAPI)</h2>
        {selfTest && (
          <p style={{ color: selfTest.ok ? '#34d399' : '#fca5a5' }}>
            {selfTest.ok ? '✓ ' : '✗ '}
            {selfTest.detail}
          </p>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Environment (via IPC)</h2>
        {info && (
          <dl style={styles.dl}>
            {Object.entries(info).map(([k, v]) => (
              <div key={k} style={styles.row}>
                <dt style={styles.muted}>{k}</dt>
                <dd style={styles.dd}>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
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

function LlmEditor({
  account,
  onChange,
  onError,
}: {
  account: AccountView;
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const [provider, setProvider] = useState<LlmProvider>(account.llm?.provider ?? 'anthropic');
  const [model, setModel] = useState(account.llm?.model ?? DEFAULT_MODEL.anthropic);
  const [apiKey, setApiKey] = useState('');

  async function guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={styles.llmRow}>
      <select
        style={styles.select}
        value={provider}
        onChange={(e) => {
          const p = e.target.value as LlmProvider;
          setProvider(p);
          setModel(DEFAULT_MODEL[p]);
        }}
      >
        <option value="anthropic">anthropic</option>
        <option value="openai">openai</option>
        <option value="gemini">gemini</option>
      </select>
      <input style={styles.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
      <button style={styles.smallBtn} onClick={() => guard(() => window.desktop.accounts.setLlmConfig(account.id, provider, model))}>
        save model
      </button>
      <input
        style={styles.input}
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="api key (stored encrypted)"
      />
      <button
        style={styles.smallBtn}
        onClick={() => guard(async () => {
          await window.desktop.accounts.setLlmApiKey(account.id, apiKey);
          setApiKey('');
        })}
      >
        save key
      </button>
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
    padding: '28px 36px',
    boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'center', gap: 12 },
  h1: { fontSize: 22, fontWeight: 700, margin: 0 },
  badge: { fontSize: 12, padding: '3px 10px', borderRadius: 999, background: '#1f2937', color: '#93c5fd', border: '1px solid #334155' },
  lede: { color: '#9ca3af', maxWidth: 680, lineHeight: 1.5 },
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: 18, marginTop: 16, maxWidth: 760 },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 },
  h2: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: '#9ca3af', margin: '0 0 12px' },
  warn: { background: '#251c10', border: '1px solid #92651a', borderRadius: 10, padding: 14, marginTop: 16, maxWidth: 760, color: '#fcd9a5', lineHeight: 1.5 },
  path: { background: '#0b0f17', padding: '6px 8px', borderRadius: 6, color: '#e5e7eb', overflowX: 'auto' },
  input: { flex: 1, minWidth: 80, background: '#0b0f17', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '7px 10px', fontSize: 13 },
  select: { background: '#0b0f17', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '7px 8px', fontSize: 13 },
  button: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, cursor: 'pointer' },
  smallBtn: { background: '#374151', color: '#e5e7eb', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  linkBtn: { background: 'none', color: '#93c5fd', border: 'none', cursor: 'pointer', fontSize: 12 },
  dangerBtn: { background: 'none', color: '#fca5a5', border: 'none', cursor: 'pointer', fontSize: 12 },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  listItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' },
  account: { border: '1px solid #1f2937', borderRadius: 10, padding: 12, marginTop: 10 },
  accountTop: { display: 'flex', alignItems: 'center', gap: 8 },
  activeTag: { fontSize: 11, color: '#34d399', border: '1px solid #14532d', borderRadius: 999, padding: '1px 8px' },
  spacer: { flex: 1 },
  accountMeta: { display: 'flex', gap: 20, color: '#9ca3af', fontSize: 12, margin: '8px 0' },
  llmRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block' },
  muted: { color: '#6b7280', fontSize: 13 },
  error: { color: '#fca5a5', whiteSpace: 'pre-wrap', background: '#1f1416', border: '1px solid #7f1d1d', borderRadius: 8, padding: 10, maxWidth: 760, marginTop: 16 },
  dl: { margin: 0 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1f2937' },
  dd: { margin: 0, fontFamily: 'ui-monospace, monospace' },
};
