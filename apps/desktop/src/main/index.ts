import { app, shell, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { AccountRepository } from './storage/account-repository';
import { SecretStore } from './storage/secret-store';
import { SafeStorageCryptor } from './storage/safe-storage-cryptor';
import { RegistryService } from './services/registry-service';
import { registerRegistryIpc } from './ipc/registry-ipc';

// Phase 0 scaffold: boot a window, wire a minimal, secure IPC bridge, and prove
// renderer <-> main messaging works. Later phases add the account registry,
// secret store (safeStorage), per-account Google OAuth, the embedded MCP server,
// and the multi-provider LLM gateway. See apps/desktop/README.md.

const isDev = !app.isPackaged;

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
  // safeStorage/DPAPI). Lives under the per-user app data dir.
  const dataDir = join(app.getPath('userData'), 'data');
  const accounts = new AccountRepository(join(dataDir, 'registry.json'));
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), new SafeStorageCryptor());
  const registry = new RegistryService(accounts, secrets);
  if (!secrets.available()) {
    console.warn('[samarth-desktop] safeStorage encryption unavailable — secret writes will fail.');
  }

  registerIpcHandlers();
  registerRegistryIpc(registry);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
