import { app, shell, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { installConsoleBridge, installHttpLogging, installIpcLogging, setDevLogSink } from './devtools/dev-logger';
import { installReactDevtools } from './devtools/react-devtools';
import { AccountRepository } from './storage/account-repository';
import { SecretStore } from './storage/secret-store';
import { SafeStorageCryptor } from './storage/safe-storage-cryptor';
import { ProviderKeyStore } from './storage/provider-keys';
import { AuditHistoryStore } from './storage/audit-history';
import { ManifestStore } from './storage/manifest-store';
import { MemoryStore } from './storage/memory-store';
import { RegistryService } from './services/registry-service';
import { registerRegistryIpc } from './ipc/registry-ipc';
import { registerProvidersIpc } from './ipc/providers-ipc';
import { registerAdsIpc } from './ipc/ads-ipc';
import { registerNotifyIpc } from './ipc/notify-ipc';
import { GoogleAdsService, type AdsRequest } from './google/ads-service';
import { GoogleAuthService } from './services/google-auth-service';
import { closeOpenTaWindow } from './suggestions/ta-driver';
import { registerGoogleIpc } from './ipc/google-ipc';
import { AccountClientManager } from './google/account-clients';
import { GoogleDataService } from './google/data-service';
import { registerDataIpc } from './ipc/data-ipc';
import { ChatService } from './services/chat-service';
import { buildToolRegistry } from './tools/registry';
import { registerChatIpc } from './ipc/chat-ipc';
import { registerMemoryIpc } from './ipc/memory-ipc';
import { MonitorService } from './services/monitor-service';
import { registerMonitorIpc } from './ipc/monitor-ipc';
import { registerSuggestionsIpc } from './suggestions/suggestion-ipc';
import { registerGtmAuditIpc } from './suggestions/gtm-audit-ipc';
import { registerGa4AuditIpc, runGa4AuditPipeline } from './google/ga4-audit-ipc';
import { probeConsentSignal } from './suggestions/consent-probe';
import { Ga4MonitoringService } from './services/ga4-monitoring-service';
import { registerGa4MonitoringIpc } from './ipc/ga4-monitoring-ipc';
import { AdsMonitoringService } from './services/ads-monitoring-service';
import { registerAdsMonitoringIpc } from './ipc/ads-monitoring-ipc';
import { TagWatchService } from './services/tag-watch-service';
import { registerTagWatchIpc } from './ipc/tag-watch-ipc';
import { registerNetworkIpc } from './network/network-ipc';
import type { MonitorAlert, Ga4MonitorRun, AdsMonitorRun } from '../shared/ipc';
import { EmbeddingStore } from './storage/embedding-store';
import { CorpusSemanticIndex } from './corpus/semantic-index';
import { readFileSync } from 'node:fs';
import { installReadableConsole } from '../shared/log-format';
import { log } from './logger';

// Keep the terminal logs legible: transliterate Unicode glyphs (-> [ok] [x] - ...) that a legacy
// Windows console renders as mojibake, and collapse repeated identical lines. Console-only; the data
// and reports that reach the UI never pass through here. Installed first, before anything logs.
installReadableConsole();

// Phase 0 scaffold: boot a window, wire a minimal, secure IPC bridge, and prove
// renderer <-> main messaging works. Later phases add the account registry,
// secret store (safeStorage), per-account Google OAuth, the embedded MCP server,
// and the multi-provider LLM gateway. See apps/desktop/README.md.

const isDev = !app.isPackaged;

/** The release version for the startup banner. In dev the app's own package is 0.0.0 (semantic-release
 *  bumps the repo-root package.json instead), so read that; packaged builds carry the real version. */
function appVersion(): string {
  if (isDev) {
    for (const p of [join(process.cwd(), 'package.json'), join(process.cwd(), '..', '..', 'package.json')]) {
      try {
        const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version;
        if (v && v !== '0.0.0') return `v${v}`;
      } catch { /* try the next candidate */ }
    }
  }
  return `v${app.getVersion()}`;
}

/** A friendly OS label ("Windows 10 Pro"), falling back to type + kernel release. */
/** Local wall-clock timestamp "YYYY-MM-DD HH:mm:ss" for the banner. */
function nowStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Quiet Electron's dev-only "Insecure Content-Security-Policy" console warning.
// It fires in unpackaged builds (electron-vite preview) for the renderer and for
// each hidden tag-scan window, which is intentionally CSP-free so a scanned
// page's own scripts render for form detection. Packaged builds never emit it, so
// this is scoped to dev and changes nothing in production.
if (isDev) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

/**
 * Where local data lives (registry.json, secrets.json, oauth-client.json).
 *   - SAMARTH_DESKTOP_DATA_DIR env overrides everything (explicit path).
 *   - Dev: the repo-root `data/` dir (app.getAppPath() is apps/desktop), so the
 *     files are easy to find/edit during development — e.g. data/oauth-client.json.
 *   - Packaged: the per-user app data dir (AppData on Windows).
 * The repo-root `data/` is gitignored — never commit oauth-client.json/secrets.
 */
function resolveDataDir(): string {
  const override = process.env.SAMARTH_DESKTOP_DATA_DIR?.trim();
  if (override) return override;
  if (!app.isPackaged) return join(app.getAppPath(), '..', '..', 'data');
  return join(app.getPath('userData'), 'data');
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Samarth Desktop',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline: isolate the preload world from the page, no Node in
      // the renderer. The renderer only ever touches the curated `window.desktop`
      // API exposed via contextBridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // External links open in the real browser, never in an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    // DevTools is opt-in: auto-opening it spams the terminal with Chrome's unimplemented
    // Autofill.enable / setAddresses protocol errors. Set OPEN_DEVTOOLS=1 to bring it back.
    if (process.env['OPEN_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Open a URL in the user's REAL Google Chrome (their everyday running instance / default profile), not the
// OS default browser. Used by the verify tab's "Open in my Chrome" button so a pasted Tag Assistant link
// lands in the SAME Chrome where the operator has injected their container (via Adswerve or similar) and is
// signed in - so the site and Tag Assistant connect. Chrome dedupes to the running instance, opening a new
// tab in the current profile. Falls back to the default browser if no Chrome binary is found. Returns true
// only when Chrome was actually launched.
function openInChrome(url: string): boolean {
  const safe = /^https?:\/\//i.test(url) ? url : ''; // http(s) only: never let a value become a chrome flag
  if (!safe) return false;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]) {
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  const exe = candidates.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!exe) { void shell.openExternal(safe); return false; }
  try {
    const child = spawn(exe, [safe], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    void shell.openExternal(safe);
    return false;
  }
}

interface DetectedBrowser { id: string; name: string; exe: string }

// Standard install paths for the common browsers, per platform. Best-effort: a hit is only kept if the
// exe actually exists (checked in detectBrowsers). The LAST path segment is the exe, not the name.
function browserProbeList(): Array<{ name: string; exe: string }> {
  const out: Array<{ name: string; exe: string }> = [];
  const add = (name: string, base: string | undefined, ...parts: string[]): void => {
    if (base) out.push({ name, exe: join(base, ...parts) });
  };
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'];
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const la = process.env['LOCALAPPDATA'];
    add('Google Chrome', pf, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Google Chrome', pf86, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Google Chrome', la, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Microsoft Edge', pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add('Microsoft Edge', pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add('Brave', pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    add('Brave', la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    add('Firefox', pf, 'Mozilla Firefox', 'firefox.exe');
    add('Opera', la, 'Programs', 'Opera', 'opera.exe');
    add('Vivaldi', la, 'Vivaldi', 'Application', 'vivaldi.exe');
    add('Comet', la, 'Perplexity', 'Comet', 'Application', 'comet.exe');
    add('Comet', la, 'Comet', 'Application', 'comet.exe');
  } else if (process.platform === 'darwin') {
    for (const [name, exe] of [
      ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
      ['Comet', '/Applications/Comet.app/Contents/MacOS/Comet'],
    ] as Array<[string, string]>) out.push({ name, exe });
  } else {
    for (const [name, exe] of [
      ['Google Chrome', '/usr/bin/google-chrome'],
      ['Chromium', '/usr/bin/chromium'],
      ['Firefox', '/usr/bin/firefox'],
      ['Brave', '/usr/bin/brave-browser'],
      ['Microsoft Edge', '/usr/bin/microsoft-edge'],
    ] as Array<[string, string]>) out.push({ name, exe });
  }
  return out;
}

// Windows only: enumerate every registered browser from the StartMenuInternet registry keys, so a
// browser we don't hard-code (e.g. Comet) is still offered. Best-effort - a reg failure returns [].
function browsersFromRegistry(): Array<{ name: string; exe: string }> {
  if (process.platform !== 'win32') return [];
  const out: Array<{ name: string; exe: string }> = [];
  for (const root of ['HKLM', 'HKCU']) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', `${root}\\SOFTWARE\\Clients\\StartMenuInternet`, '/s'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    } catch { continue; }
    let name = '';
    let inCommand = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) {
        const key = line.match(/StartMenuInternet\\([^\\]+)/i);
        name = key ? key[1] : '';
        inCommand = /\\shell\\open\\command\s*$/i.test(line);
        continue;
      }
      if (inCommand && name) {
        const v = line.match(/REG_SZ\s+"?([A-Za-z]:\\[^"]+?\.exe)"?/i);
        if (v) out.push({ name: name.replace(/\.exe$/i, ''), exe: v[1] });
      }
    }
  }
  return out;
}

// Every installed browser we can offer to open a link in - the OS default always first, then each
// detected browser once (deduped by exe path). Hard-coded probes run before the registry sweep so a
// known browser keeps its clean name.
function detectBrowsers(): DetectedBrowser[] {
  const out: DetectedBrowser[] = [{ id: 'default', name: 'Default browser', exe: '' }];
  const seen = new Set<string>();
  for (const b of [...browserProbeList(), ...browsersFromRegistry()]) {
    const key = b.exe.toLowerCase();
    // Skip Internet Explorer - it just redirects to Edge and clutters the picker.
    if (!b.exe || seen.has(key) || /iexplore\.exe$/i.test(key)) continue;
    try { if (!existsSync(b.exe)) continue; } catch { continue; }
    seen.add(key);
    out.push({ id: key, name: b.name, exe: b.exe });
  }
  return out;
}

// Open a URL in a SPECIFIC browser exe (empty exe = the OS default). http(s) only, so a value can never
// become a browser flag. Falls back to the default browser if the exe is missing or won't launch.
function openInBrowser(url: string, exe: string): boolean {
  const safe = /^https?:\/\//i.test(url) ? url : '';
  if (!safe) return false;
  if (!exe) { void shell.openExternal(safe); return true; }
  try { if (!existsSync(exe)) { void shell.openExternal(safe); return false; } } catch { void shell.openExternal(safe); return false; }
  try {
    const child = spawn(exe, [safe], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    void shell.openExternal(safe);
    return false;
  }
}

function registerIpcHandlers(): void {
  // shell:openInChrome — open a URL in the user's real Chrome specifically (verify "Open in my Chrome").
  ipcMain.handle('shell:openInChrome', (_e, url: string) => ({ chrome: openInChrome(String(url ?? '')) }));

  // shell:listBrowsers - installed browsers we can open a link in (default first). shell:openInBrowser -
  // opens a URL in a chosen browser exe (empty exe = OS default). Backs the "Open in [browser]" picker.
  ipcMain.handle('shell:listBrowsers', () => detectBrowsers());
  ipcMain.handle('shell:openInBrowser', (_e, url: string, exe: string) => ({ opened: openInBrowser(String(url ?? ''), String(exe ?? '')) }));

  // app:getInfo — basic environment readout, also a liveness probe for the bridge.
  ipcMain.handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  // app:ping — round-trips a string so the renderer can confirm IPC end to end.
  ipcMain.handle('app:ping', (_event, message: unknown) => {
    const text = typeof message === 'string' ? message : String(message);
    return `pong: ${text}`;
  });
}

app.whenReady().then(() => {
  // Dev-only: mirror main-process activity into the renderer DevTools Console. Installed at the very
  // top so it captures startup logs and the first API calls (buffered until the window exists), and
  // BEFORE the IPC handlers register (below) so the IPC wrapper sees every channel. The sink that
  // fans entries out to the window is wired after createWindow(). No-op in packaged builds.
  if (isDev) {
    installConsoleBridge();
    installIpcLogging(ipcMain);
    void installHttpLogging();
    // Load the React DevTools extension (Components / Profiler tabs). Best-effort: it downloads on
    // first run, so failures just log and are skipped. Fired before createWindow so it is registered
    // when the renderer loads.
    void installReactDevtools((ok, detail) =>
      ok ? log.success('React DevTools loaded', detail) : log.warn('React DevTools not loaded', detail),
    );
  }

  // Lock down the renderer's CSP in packaged builds. Left open in dev so the
  // Vite dev server (HMR over ws + injected scripts) keeps working.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'"],
        },
      });
    });
  }

  // Local data layer: account registry (metadata) + secret store (encrypted via
  // safeStorage/DPAPI). Dev uses the repo-root data/ dir; packaged uses AppData.
  const dataDir = resolveDataDir();
  log.banner('Samarth Analytics MCP Desktop', [
    ['Version', appVersion()],
    ['Environment', app.isPackaged ? 'Production' : 'Development'],
    ['Started At', nowStamp()],
  ]);
  const accounts = new AccountRepository(join(dataDir, 'registry.json'));
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), new SafeStorageCryptor());
  const providerKeys = new ProviderKeyStore(join(dataDir, 'app-settings.json'), secrets);
  const registry = new RegistryService(accounts, secrets, providerKeys);
  if (!secrets.available()) log.warn('safeStorage encryption unavailable', 'Secret writes will fail on this machine');

  // Per-account Google sign-in (loopback OAuth) + the auto-refreshing client
  // manager + read-only GTM/GA4 data fetches. Client id/secret come from env or
  // oauth-client.json in the data dir.
  const oauthConfigPath = join(dataDir, 'oauth-client.json');
  // When an account's refresh token is dead (invalid_grant), clear the vaulted token and
  // tell every window: 'accounts:changed' flips the account to disconnected, and
  // 'account:auth-expired' raises a one-time "Re-connect Google" banner for that account.
  const clientManager = new AccountClientManager(registry, oauthConfigPath, undefined, (id) => {
    try { registry.clearGoogleToken(id); } catch { /* already cleared */ }
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send('account:auth-expired', { id });
      w.webContents.send('accounts:changed');
    }
  });
  const googleAuth = new GoogleAuthService(registry, oauthConfigPath, (id) =>
    clientManager.invalidate(id)
  );
  const dataService = new GoogleDataService(registry, clientManager);
  // Google Ads. `auth` resolves the ACTIVE account on every call (matching GoogleDataService.activeAuth)
  // and hands back that account's patched client.request, so a dead refresh token still travels the one
  // chokepoint that clears the vault and raises the Re-connect banner. The scope string is read off the
  // vaulted token so a missing `adwords` grant is caught BEFORE a call: it surfaces as a 403, which is
  // not invalid_grant, so nothing downstream would classify it.
  const adsService = new GoogleAdsService({
    auth: async () => {
      const active = registry.getActiveView();
      if (!active) throw new Error('No active account. Connect a Google account first.');
      if (!active.hasGoogleToken) throw new Error('The active account is not signed in to Google.');
      const client = clientManager.getClient(active.id);
      let scope: string | null = null;
      try {
        scope = (JSON.parse(registry.getGoogleToken(active.id) ?? '{}') as { scope?: string }).scope ?? null;
      } catch {
        scope = null; // an unreadable token is treated as "no Ads scope", which prompts a re-connect
      }
      return { request: client.request.bind(client) as unknown as AdsRequest, scope };
    },
    // Resolved per call against the ACTIVE account, not captured once: an account with its own
    // token (it reaches Ads through a different manager's API access) must be called with that one,
    // and the active account changes while the app runs. Falls back to the shared token.
    developerToken: () => providerKeys.getAdsDeveloperToken(registry.getActiveView()?.id),
  });
  const auditHistory = new AuditHistoryStore(join(dataDir, 'audit-history.json'));
  const manifests = new ManifestStore(join(dataDir, 'manifests.json'));
  const memory = new MemoryStore(join(dataDir, 'memory-store.json'));
  // When a chat tool switches the active GTM workspace/container, tell every window to
  // re-fetch accounts so the GTM-bar dropdown reflects the new context.
  const broadcastAccountsChanged = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('accounts:changed');
    }
  };
  // adsService is threaded into the chat so the GTM assistant can read a real Conversion ID + Label
  // itself when it builds a Google Ads conversion tag, instead of asking the user to paste them.
  // Opt-in semantic corpus search: the index and its vector cache exist regardless, but nothing is
  // embedded (and nothing leaves the machine) unless the setting is on, which it is not by default.
  const embeddings = new EmbeddingStore(join(dataDir, 'embeddings.json'));
  const semanticIndex = new CorpusSemanticIndex(embeddings);
  const chatService = new ChatService(registry, dataService, providerKeys, auditHistory, broadcastAccountsChanged, manifests, memory, adsService, semanticIndex);

  // Startup diagnostic — proves THIS running process loaded the current build. If the
  // GA4-edit tools are missing here, the main process is stale (electron-vite did not
  // reload it): fully quit and `npm run dev` again. See [[desktop-dev-restart-gotcha]].
  // Tool diagnostic proves THIS process loaded the current build; only SPEAK UP when it's broken.
  let toolCount = 0;
  try {
    const names = buildToolRegistry(dataService, async () => null).list().map((t) => t.name);
    toolCount = names.length;
    const ga4Edit = ['set_ga4_measurement_id', 'set_ga4_measurement_id_on_all_tags', 'add_ga4_event_parameters', 'add_ga4_event_parameters_to_all_tags'];
    const missing = ga4Edit.filter((n) => !names.includes(n));
    if (missing.length) log.warn('GA4 edit tools MISSING - STALE BUILD, fully restart npm run dev', ...missing.map((n) => `[missing] ${n}`));
  } catch (e) {
    log.error('Tool diagnostic failed', e instanceof Error ? e.message : String(e));
  }

  // Continuous monitoring: re-audits the active container on a timer and pushes
  // a 'monitor:alert' to every open window when NEW issues appear.
  const broadcastAlert = (alert: MonitorAlert): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('monitor:alert', alert);
    }
  };
  const monitor = new MonitorService({
    registry,
    data: dataService,
    history: auditHistory,
    emit: broadcastAlert,
    configPath: join(dataDir, 'monitor-config.json'),
  });

  // GA4 Monitoring: background health checks of a chosen GA4 property; pushes each completed run to
  // every open window and (for new issues) posts to the account's Slack webhook.
  const broadcastGa4Run = (run: Ga4MonitorRun): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ga4monitoring:run', run);
    }
  };
  const ga4Monitoring = new Ga4MonitoringService({
    registry,
    data: dataService,
    secrets,
    emit: broadcastGa4Run,
    configPath: join(dataDir, 'ga4-monitor-config.json'),
    // Weekly scheduled audits reuse the EXACT panel pipeline; the scheduler posts the exec summary.
    runAudit: (property, days) => runGa4AuditPipeline(dataService, property, days).then((r) => r.exec),
    // Live Consent Mode signal probe (headless, SSRF-guarded, throttled to 24h/target in the service).
    probeConsent: (url) => probeConsentSignal(url),
  });

  // Google Ads Monitoring: background conversion-health sweeps of chosen Ads accounts; pushes each
  // completed run to every open window and (for new issues) posts to the target's Slack webhook.
  const broadcastAdsRun = (run: AdsMonitorRun): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('adsmonitoring:run', run);
    }
  };
  const adsMonitoring = new AdsMonitoringService({
    registry,
    ads: adsService,
    secrets,
    emit: broadcastAdsRun,
    configPath: join(dataDir, 'ads-monitor-config.json'),
  });

  registerIpcHandlers();
  registerRegistryIpc(registry);
  registerProvidersIpc(providerKeys, { index: semanticIndex, cache: embeddings, registry });
  registerAdsIpc(adsService, providerKeys, dataService);
  registerNotifyIpc();
  registerGoogleIpc(googleAuth);
  registerDataIpc(dataService);
  registerChatIpc(chatService);
  registerMemoryIpc(memory, registry, chatService, dataService);
  registerMonitorIpc(monitor);
  registerSuggestionsIpc(dataService, memory, registry);
  registerGtmAuditIpc(dataService, memory, registry);
  registerGa4AuditIpc(dataService);
  registerGa4MonitoringIpc(ga4Monitoring);
  registerAdsMonitoringIpc(adsMonitoring);

  const tagWatch = new TagWatchService({
    fetchGtagJs: (id) => dataService.fetchGtagJs(id),
    configPath: join(dataDir, 'tag-watch-config.json'),
    emit: (config) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('tagwatch:changed', config);
    },
  });
  registerTagWatchIpc(tagWatch);
  registerNetworkIpc({ configPath: join(dataDir, 'network-config.json') });

  createWindow();
  // Now a window exists: point the DevLog bridge at it and flush the buffered startup entries. Every
  // entry was already redacted in the main process before this send.
  if (isDev) {
    setDevLogSink((entry) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('devlog:entry', entry);
    });
  }
  // One compact readiness line + the working context (account/container/workspace SELECTED), instead
  // of the old multi-section banner + summary. Runtime work (tags created/failed) logs as it happens.
  log.success('Ready', `${toolCount} tools \u00b7 GTM / GA4 / Ads clients`);
  const active = registry.getActiveView();
  if (!active) {
    log.info('No active account', 'connect a Google account to begin');
  } else {
    log.info('Active account', `${active.email}${active.hasGoogleToken ? ' (Google connected)' : ' (not signed in)'}`);
    const c = active.gtmContext;
    if (c && (c.accountName || c.containerName)) {
      const parts = [
        c.accountName ? `account "${c.accountName}"` : '',
        c.containerName ? `container ${c.containerPublicId ? `${c.containerPublicId} ` : ''}"${c.containerName}"` : '',
        c.workspaceName ? `workspace "${c.workspaceName}"` : '',
      ].filter(Boolean);
      log.info('GTM context', parts.join(' \u00b7 '));
    } else {
      log.info('GTM context', 'none selected - pick a container in the GTM bar');
    }
    if (active.ga4Context?.propertyName || active.ga4Context?.property) {
      log.info('GA4 property', `${active.ga4Context.propertyName ?? active.ga4Context.property}${active.ga4Context.property ? ` (${active.ga4Context.property})` : ''}`);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// A successful "Verify with Tag Assistant" run LEAVES its Chrome window open for the user to inspect the
// live Tag Assistant panel. Close it on quit so we don't orphan a browser after the app exits.
app.on('before-quit', () => {
  void closeOpenTaWindow().catch(() => undefined);
});
