import { useEffect, useState } from 'react';
import type { AppInfo } from '../../preload';
import type {
  AccountView,
  ChatTurn,
  Ga4AccountView,
  GoogleClientStatus,
  GtmAccountView,
  LlmProvider,
  SecretSelfTest,
} from '../../shared/ipc';

const phases: Array<{ n: number; label: string; done: boolean }> = [
  { n: 0, label: 'Shell + IPC bridge', done: true },
  { n: 1, label: 'Account registry + secret store (safeStorage)', done: true },
  { n: 2, label: 'Per-account Google loopback OAuth', done: true },
  { n: 3, label: 'Per-account API access + GTM/GA4 data fetch', done: true },
  { n: 4, label: 'LLM chat (Anthropic/OpenAI) + GTM/GA4 tools', done: true },
  { n: 5, label: 'UI: account switcher, GTM/GA4 views, chat', done: false },
  { n: 6, label: 'Windows installer (electron-builder)', done: false },
];

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
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

      {google && google.configured && (
        <div style={google.clientIdLooksValid ? styles.diag : styles.warn}>
          OAuth client loaded from <strong>{google.source}</strong> · id:{' '}
          <code>{google.clientId}</code>
          {!google.clientIdLooksValid && (
            <div style={{ marginTop: 6 }}>
              ⚠ This client_id doesn’t end with <code>.apps.googleusercontent.com</code> — that’s
              why Google returns <code>invalid_client</code> / “OAuth client was not found”. Paste
              the <strong>Client ID</strong> (not the secret/project number) from a Desktop-app
              client.
            </div>
          )}
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

      <ChatPanel active={accounts.find((a) => a.isActive)} onError={setError} />

      <DataPanel active={accounts.find((a) => a.isActive)} onError={setError} />

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

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
}

function ChatPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = Boolean(active?.hasGoogleToken && active?.llm?.hasApiKey);
  const hint = !active
    ? 'Connect a Google account.'
    : !active.hasGoogleToken
      ? 'Sign this account into Google.'
      : !active.llm
        ? 'Pick an LLM provider + model above.'
        : !active.llm.hasApiKey
          ? 'Save an API key for this account above.'
          : '';

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    onError('');
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    // Append the user turn + an empty assistant bubble we stream into.
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '', tools: [] }]);
    setInput('');
    setBusy(true);
    try {
      await window.desktop.llm.chatStream(history, text, (ev) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (ev.type === 'text') {
            copy[copy.length - 1] = { ...last, text: last.text + ev.delta };
          } else if (ev.type === 'tool') {
            copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), ev.name] };
          }
          return copy;
        });
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      // Drop the empty assistant bubble on error.
      setMessages((m) => (m[m.length - 1]?.role === 'assistant' && !m[m.length - 1].text ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.card}>
      <div style={styles.cardHead}>
        <h2 style={styles.h2}>
          Chat {active?.llm ? `· ${active.llm.provider}/${active.llm.model}` : ''}
        </h2>
        {messages.length > 0 && (
          <button style={styles.linkBtn} onClick={() => setMessages([])}>
            clear
          </button>
        )}
      </div>

      {messages.length === 0 && (
        <p style={styles.muted}>
          Ask about your GTM/GA4 setup, e.g. “list my GTM accounts” or “how many GA4 properties do I
          have?”
        </p>
      )}

      <div style={styles.chatLog}>
        {messages.map((m, i) => (
          <div key={i} style={m.role === 'user' ? styles.userMsg : styles.asstMsg}>
            {m.tools && m.tools.length > 0 && (
              <div style={styles.toolTrace}>🔧 {m.tools.join(', ')}</div>
            )}
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || '…'}</div>
          </div>
        ))}
        {busy && <div style={styles.asstMsg}>Thinking…</div>}
      </div>

      <div style={styles.addRow}>
        <input
          style={styles.input}
          placeholder={ready ? 'Ask about your GTM / GA4…' : hint}
          value={input}
          disabled={!ready || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <button style={styles.button} onClick={send} disabled={!ready || busy}>
          Send
        </button>
      </div>
    </section>
  );
}

function DataPanel({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [product, setProduct] = useState<'gtm' | 'ga4'>('gtm');
  const [gtm, setGtm] = useState<GtmAccountView[] | null>(null);
  const [ga4, setGa4] = useState<Ga4AccountView[] | null>(null);
  const [loading, setLoading] = useState(false);

  const ready = Boolean(active?.hasGoogleToken);

  async function fetchData(): Promise<void> {
    onError('');
    setLoading(true);
    setGtm(null);
    setGa4(null);
    try {
      if (product === 'gtm') setGtm(await window.desktop.data.listGtmAccounts());
      else setGa4(await window.desktop.data.listGa4Accounts());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={styles.card}>
      <div style={styles.cardHead}>
        <h2 style={styles.h2}>Data — {active ? active.email : 'no active account'}</h2>
      </div>
      <div style={styles.llmRow}>
        <select
          style={styles.select}
          value={product}
          onChange={(e) => setProduct(e.target.value as 'gtm' | 'ga4')}
        >
          <option value="gtm">Google Tag Manager</option>
          <option value="ga4">Google Analytics 4</option>
        </select>
        <button style={styles.button} onClick={fetchData} disabled={!ready || loading}>
          {loading ? 'Fetching…' : product === 'gtm' ? 'List GTM accounts' : 'List GA4 accounts'}
        </button>
        {!ready && <span style={styles.muted}>Connect/activate a Google account first.</span>}
      </div>

      {gtm && (
        <ul style={styles.list}>
          {gtm.length === 0 && <li style={styles.muted}>No GTM accounts for this user.</li>}
          {gtm.map((a) => (
            <li key={a.accountId} style={styles.dataRow}>
              <strong>{a.name}</strong>
              <span style={styles.muted}>id {a.accountId}</span>
            </li>
          ))}
        </ul>
      )}
      {ga4 && (
        <ul style={styles.list}>
          {ga4.length === 0 && <li style={styles.muted}>No GA4 accounts for this user.</li>}
          {ga4.map((a) => (
            <li key={a.account} style={styles.dataRow}>
              <strong>{a.displayName}</strong>
              <span style={styles.muted}>
                {a.account} · {a.propertyCount} propert{a.propertyCount === 1 ? 'y' : 'ies'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  diag: { background: '#0f1722', border: '1px solid #1f2937', borderRadius: 10, padding: '10px 14px', marginTop: 16, maxWidth: 760, color: '#9ca3af', fontSize: 12, lineHeight: 1.5 },
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
  dataRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #1f2937' },
  chatLog: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto', margin: '4px 0 12px' },
  userMsg: { alignSelf: 'flex-end', background: '#1d4ed8', color: '#fff', padding: '8px 12px', borderRadius: 12, maxWidth: '80%', fontSize: 13 },
  asstMsg: { alignSelf: 'flex-start', background: '#1f2937', color: '#e5e7eb', padding: '8px 12px', borderRadius: 12, maxWidth: '80%', fontSize: 13 },
  toolTrace: { color: '#93c5fd', fontSize: 11, marginBottom: 4 },
  llmRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block' },
  muted: { color: '#6b7280', fontSize: 13 },
  error: { color: '#fca5a5', whiteSpace: 'pre-wrap', background: '#1f1416', border: '1px solid #7f1d1d', borderRadius: 8, padding: 10, maxWidth: 760, marginTop: 16 },
  dl: { margin: 0 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1f2937' },
  dd: { margin: 0, fontFamily: 'ui-monospace, monospace' },
};
