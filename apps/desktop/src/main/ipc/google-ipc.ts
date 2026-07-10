import { ipcMain, app } from 'electron';
import { join } from 'node:path';
import type { GoogleAuthService } from '../services/google-auth-service';
import { taSignIn, taSignInStatus } from '../suggestions/ta-driver';

// Google sign-in IPC. connect() resolves with the new/updated AccountView (or
// rejects with an actionable message the renderer surfaces).
export function registerGoogleIpc(service: GoogleAuthService): void {
  ipcMain.handle('google:status', () => service.status());
  ipcMain.handle('google:connect', async () => {
    const account = await service.connect();
    // Piggyback the ONE-TIME Tag Assistant browser sign-in onto account connect (fire-and-forget): the
    // user is already in "connect Google" mode, so the extra sign-in window appears in context instead
    // of surprising them mid-verify later. Best-effort — verify also self-heals with an inline sign-in.
    const profileDir = join(app.getPath('userData'), 'ta-profile');
    void taSignInStatus(profileDir)
      .then((s) => (s.signedIn ? undefined : taSignIn(profileDir).then(() => undefined)))
      .catch(() => undefined);
    return account;
  });
  ipcMain.handle('google:cancelConnect', () => {
    service.cancelConnect();
  });
  ipcMain.handle('google:disconnect', (_event, id: string) => {
    service.disconnect(id);
  });
}
