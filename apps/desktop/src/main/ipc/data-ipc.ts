import { ipcMain } from 'electron';
import type { GoogleDataService } from '../google/data-service';

// Read-only data fetches for the active account. Errors (not signed in, API 403,
// etc.) reject the renderer's invoke() with the message.
export function registerDataIpc(service: GoogleDataService): void {
  ipcMain.handle('data:listGtmAccounts', () => service.listGtmAccounts());
  ipcMain.handle('data:listGtmContainers', (_e, accountId: string) =>
    service.listGtmContainers(String(accountId))
  );
  ipcMain.handle('data:listGtmWorkspaces', (_e, accountId: string, containerId: string) =>
    service.listGtmWorkspaces(String(accountId), String(containerId))
  );
  ipcMain.handle('data:listGa4Accounts', () => service.listGa4Accounts());
}
