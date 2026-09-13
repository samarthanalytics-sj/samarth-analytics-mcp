import { ipcMain, BrowserWindow } from 'electron';
import type { NetworkLocationView } from '../../shared/ipc';
import { getNetworkLocation, startNetworkWatch, type NetworkWatchHandle } from './network-location';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';

// Network & Location: expose the app's current outbound location to the renderer (Settings card + the
// "running from" banner) and an opt-in auto-detect watcher that pushes 'network:changed' when the
// location changes on its own (VPN connect/disconnect or server switch). Read-only — this only observes
// the network, never changes it.
export function registerNetworkIpc(opts: { configPath: string }): void {
  let watch: NetworkWatchHandle | null = null;

  // The auto-detect preference persists in a tiny JSON so it survives restarts. Default OFF because "on"
  // makes periodic external IP lookups; the user opts in. Uses the shared atomic writer (mkdir + temp-then-
  // rename) so a first opt-in on a fresh install can't fail on a missing data dir or a torn write.
  const readAuto = (): boolean => readJsonFile<{ autoDetect?: boolean }>(opts.configPath, {}).autoDetect === true;
  const writeAuto = (v: boolean): void => {
    try { writeJsonFileAtomic(opts.configPath, { autoDetect: v }); } catch { /* best effort */ }
  };

  const broadcast = (view: NetworkLocationView): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('network:changed', view);
    }
  };
  const start = (): void => { if (!watch) watch = startNetworkWatch({ onChange: broadcast }); };
  const stop = (): void => { watch?.stop(); watch = null; };

  // Cached (60s TTL) — cheap to call repeatedly (Settings mount, run start).
  ipcMain.handle('network:getLocation', (): Promise<NetworkLocationView> => getNetworkLocation());
  // Force a fresh check — the Refresh button, and run-start after the user may have switched VPN server.
  ipcMain.handle('network:refreshLocation', (): Promise<NetworkLocationView> => getNetworkLocation({ force: true }));

  // "Run Test": timed reachability of the service endpoints the app depends on (any HTTP response
  // counts - DNS + TCP + TLS + route is what is being proven).
  ipcMain.handle('network:runTest', async () => {
    const { runNetworkTest } = await import('./network-test');
    return runNetworkTest();
  });

  ipcMain.handle('network:getAutoDetect', (): boolean => readAuto());
  ipcMain.handle('network:setAutoDetect', (_e, enabled: unknown): boolean => {
    const v = enabled === true;
    writeAuto(v);
    if (v) start(); else stop();
    return v;
  });

  // Honor the persisted preference at boot.
  if (readAuto()) start();
}
