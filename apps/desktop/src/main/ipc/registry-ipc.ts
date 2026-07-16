import { ipcMain } from 'electron';
import type { RegistryService } from '../services/registry-service';
import type { AddAccountInput, Ga4Context, GtmContext, LlmProvider } from '../../shared/ipc';

// Registers the account/secret IPC handlers. Each handler validates its input
// and returns renderer-safe AccountViews (never secret bytes/refs). A thrown
// error here rejects the renderer's invoke() promise with the message.
export function registerRegistryIpc(service: RegistryService): void {
  ipcMain.handle('accounts:list', () => service.listViews());

  ipcMain.handle('accounts:getActive', () => service.getActiveView());

  ipcMain.handle('accounts:add', (_event, input: AddAccountInput) => {
    if (!input || typeof input.email !== 'string' || !input.email.includes('@')) {
      throw new Error('a valid email is required');
    }
    return service.addAccount({
      email: input.email.trim(),
      displayName: input.displayName?.trim() || undefined,
    });
  });

  ipcMain.handle('accounts:remove', (_event, id: string) => {
    service.removeAccount(id);
  });

  ipcMain.handle('accounts:setActive', (_event, id: string) => {
    service.setActive(id);
  });

  ipcMain.handle('accounts:rename', (_event, id: string, name: unknown) =>
    service.renameAccount(id, String(name ?? ''))
  );

  ipcMain.handle(
    'accounts:setLlmConfig',
    (_event, id: string, provider: LlmProvider, model: string) => {
      if (typeof model !== 'string' || model.trim().length === 0) {
        throw new Error('an LLM model is required');
      }
      return service.setLlmConfig(id, provider, model.trim());
    }
  );

  ipcMain.handle('accounts:setGtmContext', (_event, id: string, ctx: GtmContext) =>
    service.setGtmContext(id, ctx && typeof ctx === 'object' ? ctx : {})
  );

  ipcMain.handle('accounts:setGa4Context', (_event, id: string, ctx: Ga4Context) =>
    service.setGa4Context(id, ctx && typeof ctx === 'object' ? ctx : {})
  );

  ipcMain.handle('secrets:available', () => service.secretSelfTest().encryptionAvailable);

  ipcMain.handle('secrets:selfTest', () => service.secretSelfTest());
}
