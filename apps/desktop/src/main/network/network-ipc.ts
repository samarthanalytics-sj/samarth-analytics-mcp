import { ipcMain } from 'electron';
import type { NetworkLocationView } from '../../shared/ipc';
import { getNetworkLocation } from './network-location';

// Network & Location: expose the app's current outbound location to the renderer (Settings card + the
// "running from" banner shown before/during an audit). Read-only — no network state is ever changed here.
export function registerNetworkIpc(): void {
  // Cached (60s TTL) — cheap to call repeatedly (Settings mount, run start).
  ipcMain.handle('network:getLocation', (): Promise<NetworkLocationView> => getNetworkLocation());

  // Force a fresh check — the Refresh button, and run-start after the user may have switched VPN server.
  ipcMain.handle('network:refreshLocation', (): Promise<NetworkLocationView> => getNetworkLocation({ force: true }));
}
