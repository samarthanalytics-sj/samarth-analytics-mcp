import { useEffect, useRef, useState } from 'react';
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

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

type View = 'chat' | 'settings';

/* Friendly labels for GTM type codes, so approvals read in plain English. */
const GTM_TYPE_LABELS: Record<string, string> = {
  gaawe: 'GA4 Event',
  gaawc: 'GA4 Configuration',
  awct: 'Google Ads Conversion',
  sp: 'Google Ads Remarketing',
  html: 'Custom HTML',
  img: 'Custom Image',
  linkClick: 'Click — Just Links',
  click: 'Click — All Elements',
  pageview: 'Page View',
  domReady: 'DOM Ready',
  windowLoaded: 'Window Loaded',
  formSubmission: 'Form Submission',
  c: 'Constant',
  jsm: 'Custom JavaScript',
  v: 'Data Layer Variable',
  smm: 'Lookup Table',
};
const gtmTypeLabel = (t: string): string => GTM_TYPE_LABELS[t] ?? t;

const OP_LABELS: Record<string, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matchRegex: 'matches regex',
  cssSelector: 'matches CSS selector',
  greater: '>',
  less: '<',
};

function gtmParam(node: Record<string, unknown> | undefined, key: string): string | undefined {
  const arr = (node?.parameter ?? []) as Array<{ key?: string; value?: string }>;
  return arr.find((p) => p.key === key)?.value;
}

function describeCondition(filter: unknown): string {
  const arr = Array.isArray(filter) ? filter : [];
  return arr
    .map((f: { type?: string; parameter?: Array<{ key?: string; value?: string }> }) => {
      const left = (f.parameter?.find((p) => p.key === 'arg0')?.value ?? '').replace(/^\{\{|\}\}$/g, '');
      const right = f.parameter?.find((p) => p.key === 'arg1')?.value ?? '';
      const op = OP_LABELS[f.type ?? ''] ?? f.type ?? '';
      return `${left} ${op} ${right}`.trim();
    })
    .filter(Boolean)
    .join(' AND ');
}

/* Turn a proposed write's raw args into labeled, human-readable rows. */
function summarizeProposal(tool: string, details: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

  if (tool === 'delete_gtm_tag') {
    rows.push({ label: 'Action', value: 'Delete tag' });
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    return rows;
  }
  if (tool.includes('tag')) {
    const tag = obj(details.tag);
    if (details.tagId) rows.push({ label: 'Tag ID', value: String(details.tagId) });
    if (tag.name) rows.push({ label: 'Tag name', value: String(tag.name) });
    if (tag.type) rows.push({ label: 'Tag type', value: gtmTypeLabel(String(tag.type)) });
    const ev = gtmParam(tag, 'eventName');
    if (ev) rows.push({ label: 'Event name', value: ev });
    const mid = gtmParam(tag, 'measurementId') ?? gtmParam(tag, 'measurementIdOverride');
    if (mid) rows.push({ label: 'Measurement ID', value: mid });
    return rows;
  }
  if (tool.includes('trigger')) {
    const t = obj(details.trigger);
    if (t.name) rows.push({ label: 'Trigger name', value: String(t.name) });
    if (t.type) rows.push({ label: 'Trigger type', value: gtmTypeLabel(String(t.type)) });
    const cond = describeCondition(t.filter);
    if (cond) rows.push({ label: 'Condition', value: cond });
    return rows;
  }
  if (tool.includes('variable')) {
    const v = obj(details.variable);
    if (v.name) rows.push({ label: 'Variable name', value: String(v.name) });
    if (v.type) rows.push({ label: 'Variable type', value: gtmTypeLabel(String(v.type)) });
    return rows;
  }
  if (tool.includes('workspace')) {
    if (details.name) rows.push({ label: 'Workspace name', value: String(details.name) });
    return rows;
  }
  return rows;
}

export function App(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [google, setGoogle] = useState<GoogleClientStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [selfTest, setSelfTest] = useState<SecretSelfTest | null>(null);
  const [view, setView] = useState<View>('chat');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const active = accounts.find((a) => a.isActive);

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
    <div style={styles.app}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <div style={styles.logo}>S</div>
          <div>
            <div style={styles.brandName}>Samarth</div>
            <div style={styles.brandSub}>GTM / GA4 Desktop</div>
          </div>
        </div>

        <div style={styles.sideLabel}>Accounts</div>
        <div style={styles.accountList}>
          {accounts.length === 0 && <div style={styles.sideMuted}>No accounts yet</div>}
          {accounts.map((a) => (
            <button
              key={a.id}
              style={{ ...styles.acctBtn, ...(a.isActive ? styles.acctBtnActive : {}) }}
              onClick={() => run(() => window.desktop.accounts.setActive(a.id))}
              title={a.email}
            >
              <span style={{ ...styles.dot, background: a.hasGoogleToken ? '#34d399' : '#6b7280' }} />
              <span style={styles.acctEmail}>{a.displayName || a.email}</span>
            </button>
          ))}
        </div>

        <button
          style={styles.connectBtn}
          onClick={connect}
          disabled={connecting || !google?.configured}
        >
          {connecting ? 'Signing in…' : '+ Connect account'}
        </button>
        {google && !google.configured && (
          <div style={styles.sideWarn}>OAuth client not set — see Settings.</div>
        )}

        <div style={styles.sideNav}>
          <button
            style={{ ...styles.navItem, ...(view === 'chat' ? styles.navActive : {}) }}
            onClick={() => setView('chat')}
          >
            💬 Chat
          </button>
          <button
            style={{ ...styles.navItem, ...(view === 'settings' ? styles.navActive : {}) }}
            onClick={() => setView('settings')}
          >
            ⚙ Settings
          </button>
        </div>
        <div style={styles.sideVersion}>v{info?.version ?? '0.0.0'}</div>
      </aside>

      <main style={styles.main}>
        {error && (
          <div style={styles.errorBar}>
            <span>{error}</span>
            <button style={styles.errorClose} onClick={() => setError('')}>
              ✕
            </button>
          </div>
        )}

        {view === 'chat' ? (
          <ChatView key={active?.id ?? 'none'} active={active} onError={setError} />
        ) : (
          <SettingsView
            active={active}
            google={google}
            info={info}
            selfTest={selfTest}
            onError={setError}
            run={run}
            refresh={refresh}
          />
        )}
      </main>
    </div>
  );
}

/* ───────────────────────────── Chat ───────────────────────────── */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
}

function ChatView({
  active,
  onError,
}: {
  active: AccountView | undefined;
  onError: (m: string) => void;
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<'gtm' | 'ga4'>('gtm');
  const [pendingConfirm, setPendingConfirm] = useState<
    {
      confirmId: string;
      tool: string;
      summary: string;
      details: Record<string, unknown>;
      destructive?: boolean;
    } | null
  >(null);

  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [input]);

  const ready = Boolean(active?.hasGoogleToken && active?.llm?.hasApiKey);
  const hint = !active
    ? 'Connect a Google account to start.'
    : !active.hasGoogleToken
      ? 'Sign this account into Google (Settings).'
      : !active.llm
        ? 'Pick an LLM provider + model (Settings).'
        : !active.llm.hasApiKey
          ? 'Add an API key for this account (Settings).'
          : '';

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    onError('');
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '', tools: [] }]);
    setInput('');
    setBusy(true);
    try {
      await window.desktop.llm.chatStream(history, text, product, (ev) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role !== 'assistant') return copy;
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, text: last.text + ev.delta };
          else if (ev.type === 'tool')
            copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), ev.name] };
          return copy;
        });
        if (ev.type === 'confirm') {
          setPendingConfirm({
            confirmId: ev.confirmId,
            tool: ev.tool,
            summary: ev.summary,
            details: ev.details,
            destructive: ev.destructive,
          });
        }
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setMessages((m) => (m[m.length - 1]?.role === 'assistant' && !m[m.length - 1].text ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.chatWrap}>
      <div style={styles.chatHeader}>
        <div>
          <div style={styles.chatTitle}>{active ? active.email : 'No account'}</div>
          <div style={styles.chatSub}>
            {active?.llm ? `${active.llm.provider} · ${active.llm.model}` : 'No model configured'}
            {active?.hasGoogleToken ? ' · Google ✓' : ' · not signed in'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={styles.toggle}>
            <button
              style={product === 'gtm' ? styles.toggleActive : styles.toggleBtn}
              onClick={() => {
                setProduct('gtm');
                setMessages([]);
              }}
            >
              GTM
            </button>
            <button
              style={product === 'ga4' ? styles.toggleActive : styles.toggleBtn}
              onClick={() => {
                setProduct('ga4');
                setMessages([]);
              }}
            >
              GA4
            </button>
          </div>
          {messages.length > 0 && (
            <button style={styles.ghostBtn} onClick={() => setMessages([])}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div style={styles.chatLog}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
            Ask about your GTM &amp; GA4 — “list my GTM accounts”, “run a GA4 report for last 28
            days”, or “create an email-click event tag”.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={m.role === 'user' ? styles.userMsg : styles.asstMsg}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text || '…'}</div>
          </div>
        ))}
        {busy && !pendingConfirm && <div style={styles.asstMsg}>Thinking…</div>}
      </div>

      {pendingConfirm && (
        <div style={pendingConfirm.destructive ? styles.confirmDanger : styles.confirm}>
          <div style={styles.confirmHead}>
            {pendingConfirm.destructive ? '🗑 Delete — approve this action?' : '⚠ Approve this change to your GTM?'}
          </div>
          <div style={styles.proposalRows}>
            {summarizeProposal(pendingConfirm.tool, pendingConfirm.details).map((r) => (
              <div key={r.label} style={styles.proposalRow}>
                <span style={styles.proposalLabel}>{r.label}</span>
                <span style={styles.proposalValue}>{r.value}</span>
              </div>
            ))}
            {summarizeProposal(pendingConfirm.tool, pendingConfirm.details).length === 0 && (
              <div style={{ color: '#9ca3af' }}>{pendingConfirm.summary}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={pendingConfirm.destructive ? styles.dangerSolid : styles.primaryBtn}
              onClick={async () => {
                const pc = pendingConfirm;
                setPendingConfirm(null);
                await window.desktop.llm.confirm(pc.confirmId, true);
              }}
            >
              {pendingConfirm.destructive ? 'Yes, delete' : 'Approve & apply'}
            </button>
            <button
              style={styles.ghostBtn}
              onClick={async () => {
                const pc = pendingConfirm;
                setPendingConfirm(null);
                await window.desktop.llm.confirm(pc.confirmId, false);
              }}
            >
              Cancel
            </button>
          </div>
          <div style={styles.confirmNote}>
            {pendingConfirm.destructive
              ? 'Delete needs two approvals. Applies to a draft workspace — not published.'
              : 'Applies to a draft workspace only — not published.'}
          </div>
        </div>
      )}

      <div style={styles.composer}>
        <textarea
          ref={taRef}
          style={styles.composerInput}
          placeholder={ready ? 'Message…  (Enter to send, Shift+Enter for a new line)' : hint}
          value={input}
          disabled={!ready || busy}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button style={styles.sendBtn} onClick={send} disabled={!ready || busy}>
          Send
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Settings ─────────────────────────── */

function SettingsView({
  active,
  google,
  info,
  selfTest,
  onError,
  run,
  refresh,
}: {
  active: AccountView | undefined;
  google: GoogleClientStatus | null;
  info: AppInfo | null;
  selfTest: SecretSelfTest | null;
  onError: (m: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}): JSX.Element {
  return (
    <div style={styles.settings}>
      <h1 style={styles.settingsTitle}>Settings</h1>

      {google && !google.configured && (
        <section style={styles.warn}>
          <strong>Google OAuth client not configured.</strong> Create a Google “Desktop app” OAuth
          client, then drop a file at:
          <pre style={styles.codeBlock}>{google.configPath}</pre>
          <code>{'{ "clientId": "…apps.googleusercontent.com", "clientSecret": "…" }'}</code>
        </section>
      )}
      {active ? (
        <>
          <section style={styles.card}>
            <h2 style={styles.h2}>Active account</h2>
            <div style={styles.kv}><span>Email</span><b>{active.email}</b></div>
            <div style={styles.kv}><span>Google</span><b>{active.hasGoogleToken ? '✓ signed in' : '— not connected'}</b></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {active.hasGoogleToken && (
                <button style={styles.ghostBtn} onClick={() => run(() => window.desktop.google.disconnect(active.id))}>
                  Disconnect Google
                </button>
              )}
              <button style={styles.dangerGhost} onClick={() => run(() => window.desktop.accounts.remove(active.id))}>
                Remove account
              </button>
            </div>
          </section>

          <section style={styles.card}>
            <h2 style={styles.h2}>Language model</h2>
            <LlmEditor account={active} onChange={refresh} onError={onError} />
          </section>

          <section style={styles.card}>
            <h2 style={styles.h2}>Data tools (read-only)</h2>
            <DataTools active={active} onError={onError} />
          </section>
        </>
      ) : (
        <section style={styles.card}>
          <p style={styles.muted}>Connect a Google account to configure it.</p>
        </section>
      )}

      <section style={styles.card}>
        <h2 style={styles.h2}>Providers (API keys)</h2>
        <ProvidersEditor onChange={refresh} onError={onError} />
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Diagnostics</h2>
        {selfTest && (
          <div style={{ color: selfTest.ok ? '#34d399' : '#fca5a5', marginBottom: 8 }}>
            Secret store (DPAPI): {selfTest.ok ? '✓ working' : `✗ ${selfTest.detail}`}
          </div>
        )}
        {info && (
          <div style={styles.muted}>
            Electron {info.electron} · Node {info.node} · {info.platform}
          </div>
        )}
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
  const [provider, setProvider] = useState<LlmProvider>(account.llm?.provider ?? 'openai');
  const [model, setModel] = useState(account.llm?.model ?? DEFAULT_MODEL.openai);
  const [saved, setSaved] = useState('');

  async function save(): Promise<void> {
    try {
      await window.desktop.accounts.setLlmConfig(account.id, provider, model);
      await onChange();
      setSaved('Saved');
      setTimeout(() => setSaved(''), 1500);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={styles.formRow}>
        <select
          style={styles.select}
          value={provider}
          onChange={(e) => {
            const p = e.target.value as LlmProvider;
            setProvider(p);
            setModel(DEFAULT_MODEL[p]);
          }}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>
        <input style={styles.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
        <button style={styles.ghostBtn} onClick={save}>
          Save
        </button>
      </div>
      <div style={styles.muted}>
        API key: {account.llm?.hasApiKey ? `✓ using the app-level ${account.llm.provider} key` : '✗ not set — add it under Providers below'}
        {saved && <span style={{ color: '#34d399' }}> · {saved}</span>}
      </div>
    </div>
  );
}

function ProvidersEditor({
  onChange,
  onError,
}: {
  onChange: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const providers: LlmProvider[] = ['openai', 'anthropic', 'gemini'];
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    window.desktop.providers.status().then(setStatus).catch((e) => onError(String(e)));
  }, []);

  async function save(p: LlmProvider): Promise<void> {
    try {
      const next = await window.desktop.providers.setKey(p, keys[p] ?? '');
      setStatus(next);
      setKeys((k) => ({ ...k, [p]: '' }));
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear(p: LlmProvider): Promise<void> {
    try {
      setStatus(await window.desktop.providers.clearKey(p));
      await onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <p style={styles.muted}>One key per provider, shared by all accounts. Stored encrypted (DPAPI).</p>
      {providers.map((p) => (
        <div key={p} style={styles.formRow}>
          <span style={{ width: 90, fontSize: 13, alignSelf: 'center', textTransform: 'capitalize' }}>
            {p} {status[p] ? '✓' : ''}
          </span>
          <input
            style={styles.input}
            type="password"
            value={keys[p] ?? ''}
            onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
            placeholder={status[p] ? 'key saved — enter to replace' : 'API key'}
          />
          <button style={styles.ghostBtn} onClick={() => save(p)}>
            Save
          </button>
          {status[p] && (
            <button style={styles.dangerGhost} onClick={() => clear(p)}>
              Clear
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function DataTools({
  active,
  onError,
}: {
  active: AccountView;
  onError: (m: string) => void;
}): JSX.Element {
  const [rows, setRows] = useState<string[]>([]);
  const [loading, setLoading] = useState('');

  async function load(kind: 'gtm' | 'ga4'): Promise<void> {
    setLoading(kind);
    onError('');
    try {
      if (kind === 'gtm') {
        const r: GtmAccountView[] = await window.desktop.data.listGtmAccounts();
        setRows(r.map((a) => `${a.name} (${a.accountId})`));
      } else {
        const r: Ga4AccountView[] = await window.desktop.data.listGa4Accounts();
        setRows(r.map((a) => `${a.displayName} — ${a.propertyCount} properties`));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading('');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={styles.ghostBtn} disabled={!active.hasGoogleToken || !!loading} onClick={() => load('gtm')}>
          {loading === 'gtm' ? 'Loading…' : 'List GTM accounts'}
        </button>
        <button style={styles.ghostBtn} disabled={!active.hasGoogleToken || !!loading} onClick={() => load('ga4')}>
          {loading === 'ga4' ? 'Loading…' : 'List GA4 accounts'}
        </button>
      </div>
      {rows.length > 0 && (
        <ul style={styles.resultList}>
          {rows.map((r, i) => (
            <li key={i} style={styles.resultRow}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── Styles ─────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    margin: 0,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    color: '#e5e7eb',
    background: '#0b0f17',
  },
  sidebar: {
    width: 248,
    flexShrink: 0,
    background: '#0d1320',
    borderRight: '1px solid #1f2937',
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    boxSizing: 'border-box',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 },
  logo: { width: 34, height: 34, borderRadius: 9, background: '#2563eb', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 },
  brandName: { fontWeight: 700 },
  brandSub: { fontSize: 11, color: '#6b7280' },
  sideLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: '#6b7280', margin: '4px 0 8px' },
  accountList: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 },
  sideMuted: { color: '#6b7280', fontSize: 13, padding: '6px 4px' },
  acctBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid transparent', borderRadius: 8, padding: '8px 10px', color: '#cbd5e1', cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  acctBtnActive: { background: '#16223a', border: '1px solid #2c3e5e', color: '#fff' },
  acctEmail: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  connectBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer', marginTop: 8 },
  sideWarn: { color: '#fcd9a5', fontSize: 11, marginTop: 8 },
  sideNav: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16, borderTop: '1px solid #1f2937', paddingTop: 12 },
  navItem: { background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 10px', color: '#cbd5e1', cursor: 'pointer', textAlign: 'left', fontSize: 14 },
  navActive: { background: '#16223a', color: '#fff' },
  sideVersion: { color: '#4b5563', fontSize: 11, marginTop: 10 },

  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  errorBar: { background: '#1f1416', borderBottom: '1px solid #7f1d1d', color: '#fca5a5', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  errorClose: { background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer' },

  chatWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  chatHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #1f2937' },
  toggle: { display: 'flex', background: '#0d1320', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' },
  toggleBtn: { background: 'transparent', color: '#9ca3af', border: 'none', padding: '6px 14px', fontSize: 12, cursor: 'pointer' },
  toggleActive: { background: '#2563eb', color: '#fff', border: 'none', padding: '6px 14px', fontSize: 12, cursor: 'pointer' },
  chatTitle: { fontWeight: 600 },
  chatSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  chatLog: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: '#6b7280', textAlign: 'center', maxWidth: 420, margin: '60px auto', lineHeight: 1.6 },
  userMsg: { alignSelf: 'flex-end', background: '#2563eb', color: '#fff', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14 },
  asstMsg: { alignSelf: 'flex-start', background: '#161e2e', color: '#e5e7eb', padding: '9px 13px', borderRadius: 14, maxWidth: '75%', fontSize: 14, border: '1px solid #1f2937' },
  toolTrace: { color: '#93c5fd', fontSize: 11, marginBottom: 4 },
  composer: { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid #1f2937', alignItems: 'flex-end' },
  composerInput: {
    flex: 1,
    background: '#0d1320',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 12,
    padding: '11px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    lineHeight: 1.45,
    resize: 'none',
    overflowY: 'auto',
    maxHeight: 160,
    boxSizing: 'border-box',
  },
  sendBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 12, padding: '11px 18px', fontSize: 14, cursor: 'pointer', height: 44 },

  confirm: { background: '#251c10', border: '1px solid #92651a', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: '#fcd9a5' },
  confirmDanger: { background: '#2a1416', border: '1px solid #b91c1c', borderRadius: 10, padding: 12, margin: '0 16px 8px', color: '#fca5a5' },
  confirmHead: { fontWeight: 700 },
  proposalRows: { background: '#0b0f17', borderRadius: 8, padding: '4px 12px', margin: '6px 0 10px' },
  proposalRow: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid #1f2937', fontSize: 13 },
  proposalLabel: { color: '#9ca3af' },
  proposalValue: { color: '#e5e7eb', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' },
  confirmNote: { color: '#9ca3af', fontSize: 11, marginTop: 8 },

  settings: { flex: 1, overflowY: 'auto', padding: 24, maxWidth: 720 },
  settingsTitle: { fontSize: 22, fontWeight: 700, margin: '0 0 16px' },
  card: { background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: 18, marginBottom: 16 },
  h2: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: '#9ca3af', margin: '0 0 12px' },
  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1f2937', fontSize: 14 },
  warn: { background: '#251c10', border: '1px solid #92651a', borderRadius: 10, padding: 14, marginBottom: 16, color: '#fcd9a5', lineHeight: 1.5 },
  diag: { background: '#0f1722', border: '1px solid #1f2937', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#9ca3af', fontSize: 12 },
  codeBlock: { background: '#0b0f17', padding: '6px 8px', borderRadius: 6, color: '#e5e7eb', overflowX: 'auto' },
  formRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  select: { background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  input: { flex: 1, minWidth: 120, background: '#0d1320', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  ghostBtn: { background: '#1f2937', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  dangerGhost: { background: 'transparent', color: '#fca5a5', border: '1px solid #7f1d1d', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  dangerSolid: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, cursor: 'pointer' },
  resultList: { listStyle: 'none', margin: '12px 0 0', padding: 0 },
  resultRow: { padding: '6px 0', borderBottom: '1px solid #1f2937', fontSize: 13, fontFamily: 'ui-monospace, monospace' },
  muted: { color: '#6b7280', fontSize: 13 },
  dot: { width: 9, height: 9, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
};
