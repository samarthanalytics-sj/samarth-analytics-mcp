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
  // browserExe (optional) = which installed browser to open the consent URL in (empty/undefined = OS
  // default). The renderer passes the operator's chosen sign-in browser so consent lands where they're
  // signed into Google, not always the default browser.
  ipcMain.handle('google:connect', (_e, browserExe?: string) => service.connect(undefined, browserExe));
  // Opt-in Google Ads consent. Requests the UNION of the default scopes plus adwords, so the returned
  // token (which REPLACES the vaulted one) keeps the Tag Manager and Analytics grants.
  ipcMain.handle('google:connectAds', (_e, browserExe?: string) => service.connect(adsAuthScopes(), browserExe));
  ipcMain.handle('google:cancelConnect', () => {
    service.cancelConnect();
  });
  ipcMain.handle('google:disconnect', (_event, id: string) => {
    service.disconnect(id);
  });
}
