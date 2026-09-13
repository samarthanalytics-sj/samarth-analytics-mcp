import { ipcMain } from 'electron';
import type { TagWatchService } from '../services/tag-watch-service';

/** Renderer bridge for the Tag Watch panel. All reads/mutations return the fresh config so the UI
 *  re-renders from one source. Config is public gtag data - no account scoping. */
export function registerTagWatchIpc(service: TagWatchService): void {
  ipcMain.handle('tagwatch:get', () => service.getConfig());
  ipcMain.handle('tagwatch:add', (_e, measurementId: unknown, label: unknown) => service.addTarget(String(measurementId ?? ''), label ? String(label) : undefined));
  ipcMain.handle('tagwatch:remove', (_e, measurementId: unknown) => service.removeTarget(String(measurementId ?? '')));
  ipcMain.handle('tagwatch:setEnabled', (_e, enabled: unknown) => service.setEnabled(Boolean(enabled)));
  ipcMain.handle('tagwatch:setInterval', (_e, hours: unknown) => service.setInterval(Number(hours)));
  ipcMain.handle('tagwatch:setSlack', (_e, webhook: unknown) => service.setSlackWebhook(String(webhook ?? '')));
  ipcMain.handle('tagwatch:scanNow', async (_e, measurementId: unknown) => {
    await service.scanNow(String(measurementId ?? ''));
    return service.getConfig();
  });
  ipcMain.handle('tagwatch:scanAll', () => service.runOnce());
}
