import { app, shell, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { AccountRepository } from './storage/account-repository';
import { SecretStore } from './storage/secret-store';
import { SafeStorageCryptor } from './storage/safe-storage-cryptor';
import { ProviderKeyStore } from './storage/provider-keys';
import { AuditHistoryStore } from './storage/audit-history';
import { ManifestStore } from './storage/manifest-store';
import { RegistryService } from './services/registry-service';
import { registerRegistryIpc } from './ipc/registry-ipc';
import { registerProvidersIpc } from './ipc/providers-ipc';
import { GoogleAuthService } from './services/google-auth-service';
import { closeOpenTaWindow } from './suggestions/ta-driver';
import { registerGoogleIpc } from './ipc/google-ipc';
import { AccountClientManager } from './google/account-clients';
import { GoogleDataService } from './google/data-service';
import { registerDataIpc } from './ipc/data-ipc';
import { ChatService } from './services/chat-service';
import { buildToolRegistry } from './tools/registry';
import { registerChatIpc } from './ipc/chat-ipc';
import { MonitorService } from './services/monitor-service';
import { registerMonitorIpc } from './ipc/monitor-ipc';
import { registerSuggestionsIpc } from './suggestions/suggestion-ipc';
import { registerGtmAuditIpc } from './suggestions/gtm-audit-ipc';
import { registerGa4AuditIpc, runGa4AuditPipeline } from './google/ga4-audit-ipc';
import { probeConsentSignal } from './suggestions/consent-probe';
import { Ga4MonitoringService } from './services/ga4-monitoring-service';
import { registerGa4MonitoringIpc } from './ipc/ga4-monitoring-ipc';
import type { MonitorAlert, Ga4MonitorRun } from '../shared/ipc';

// Phase 0 scaffold: boot a window, wire a minimal, secure IPC bridge, and prove
// renderer <-> main messaging works. Later phases add the account registry,
// secret store (safeStorage), per-account Google OAuth, the embedded MCP server,
// and the multi-provider LLM gateway. See apps/desktop/README.md.

const isDev = !app.isPackaged;

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
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpcHandlers(): void {
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
  console.error(`[samarth-desktop] data dir: ${dataDir}`);
  const accounts = new AccountRepository(join(dataDir, 'registry.json'));
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), new SafeStorageCryptor());
  const providerKeys = new ProviderKeyStore(join(dataDir, 'app-settings.json'), secrets);
  const registry = new RegistryService(accounts, secrets, providerKeys);
  if (!secrets.available()) {
    console.warn('[samarth-desktop] safeStorage encryption unavailable — secret writes will fail.');
  }

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
  const auditHistory = new AuditHistoryStore(join(dataDir, 'audit-history.json'));
  const manifests = new ManifestStore(join(dataDir, 'manifests.json'));
  // When a chat tool switches the active GTM workspace/container, tell every window to
  // re-fetch accounts so the GTM-bar dropdown reflects the new context.
  const broadcastAccountsChanged = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('accounts:changed');
    }
  };
  const chatService = new ChatService(registry, dataService, providerKeys, auditHistory, broadcastAccountsChanged, manifests);

  // Startup diagnostic — proves THIS running process loaded the current build. If the
  // GA4-edit tools are missing here, the main process is stale (electron-vite did not
  // reload it): fully quit and `npm run dev` again. See [[desktop-dev-restart-gotcha]].
  try {
    const names = buildToolRegistry(dataService, async () => null).list().map((t) => t.name);
    const ga4Edit = ['set_ga4_measurement_id', 'set_ga4_measurement_id_on_all_tags', 'add_ga4_event_parameters', 'add_ga4_event_parameters_to_all_tags'];
    const present = ga4Edit.filter((n) => names.includes(n));
    console.error(
      `[samarth-desktop] ${names.length} GTM/GA4 tools loaded · GA4-edit tools: ${present.length === ga4Edit.length ? `ALL present (${present.join(', ')})` : `MISSING ${ga4Edit.filter((n) => !present.includes(n)).join(', ')} — STALE BUILD, fully restart npm run dev`}`
    );
  } catch (e) {
    console.error('[samarth-desktop] tool diagnostic failed:', e);
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

  registerIpcHandlers();
  registerRegistryIpc(registry);
  registerProvidersIpc(providerKeys);
  registerGoogleIpc(googleAuth);
  registerDataIpc(dataService);
  registerChatIpc(chatService);
  registerMonitorIpc(monitor);
  registerSuggestionsIpc(dataService);
  registerGtmAuditIpc(dataService);
  registerGa4AuditIpc(dataService);
  registerGa4MonitoringIpc(ga4Monitoring);
  createWindow();

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
