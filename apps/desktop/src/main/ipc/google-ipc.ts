import { ipcMain } from 'electron';
import type { GoogleAuthService } from '../services/google-auth-service';
import { adsAuthScopes } from '../google/oauth';

// Google sign-in IPC. connect() resolves with the new/updated AccountView (or
// rejects with an actionable message the renderer surfaces). connect() runs the
// consent inside the Tag Assistant browser profile (see GoogleAuthService), so a
// single sign-in captures both the API token and the TA web session — no separate
// Tag Assistant sign-in step.
export function registerGoogleIpc(service: GoogleAuthService): void {
  ipcMain.handle('google:status', () => service.status());
  ipcMain.handle('google:connect', () => service.connect());
  // Opt-in Google Ads consent. Requests the UNION of the default scopes plus adwords, so the returned
  // token (which REPLACES the vaulted one) keeps the Tag Manager and Analytics grants.
  ipcMain.handle('google:connectAds', () => service.connect(adsAuthScopes()));
  ipcMain.handle('google:cancelConnect', () => {
    service.cancelConnect();
  });
  ipcMain.handle('google:disconnect', (_event, id: string) => {
    service.disconnect(id);
  });
}
