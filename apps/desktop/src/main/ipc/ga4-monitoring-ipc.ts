import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { Ga4MonitoringService } from '../services/ga4-monitoring-service';
import type { Ga4MonitorConfig } from '../../shared/ipc';
import { monitorRunToCsv, monitorRunToHtml } from '../services/ga4-monitor-export';

// Renderer ↔ Ga4MonitoringService bridge. The run PUSH ('ga4monitoring:run') is wired in index.ts via
// the service's emit closure (broadcast to all windows). Config/webhook mutations return the fresh
// status so the tab updates without a second round-trip.
export function registerGa4MonitoringIpc(service: Ga4MonitoringService): void {
  ipcMain.handle('ga4monitoring:status', () => service.status());
  ipcMain.handle('ga4monitoring:configure', (_e, patch: Partial<Ga4MonitorConfig>) =>
    service.configure(patch && typeof patch === 'object' ? patch : {})
  );
  // Optional propertyId: run one target on demand (even a paused one); omitted -> sweep all enabled.
  // Always a MANUAL trigger (a user click) — the background timer/boot sweeps stamp 'scheduled'.
  ipcMain.handle('ga4monitoring:runNow', (_e, propertyId?: unknown) =>
    service.runOnce(typeof propertyId === 'string' && propertyId ? propertyId : undefined, 'manual')
  );
  // Optional propertyId on all three: a property's OWN channel vs the account default.
  ipcMain.handle('ga4monitoring:setWebhook', (_e, url: unknown, propertyId?: unknown) =>
    service.setWebhook(String(url ?? ''), typeof propertyId === 'string' && propertyId ? propertyId : undefined)
  );
  ipcMain.handle('ga4monitoring:clearWebhook', (_e, propertyId?: unknown) =>
    service.clearWebhook(typeof propertyId === 'string' && propertyId ? propertyId : undefined)
  );
  ipcMain.handle('ga4monitoring:sendTest', (_e, propertyId?: unknown) =>
    service.sendTest(typeof propertyId === 'string' && propertyId ? propertyId : undefined)
  );

  // Download the property's LATEST monitoring run (the exact run the tab shows) as a CSV or a
  // print-styled PDF - same save-dialog + hidden-window printToPDF pipeline as the audit exports.
  ipcMain.handle('ga4monitoring:exportRun', async (e, propertyId: unknown, format: unknown) => {
    const pid = String(propertyId ?? '');
    const fmt = format === 'pdf' ? 'pdf' : 'csv';
    const t = service.status().targetStatuses.find((x) => x.propertyId === pid);
    if (!t?.lastRun) throw new Error('No monitoring run for this property yet - click Run check first.');
    const run = t.lastRun;
    const base =
      `${(t.propertyLabel || pid).replace(/[\\/:*?"<>|]/g, '_').replace(/\s{2,}/g, ' ').trim() || 'GA4 property'} - GA4 monitoring`;
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Export monitoring report',
      defaultPath: `${base}.${fmt}`,
      filters: [fmt === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'CSV', extensions: ['csv'] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    if (fmt === 'csv') {
      await writeFile(filePath, monitorRunToCsv(run), 'utf8');
      return filePath;
    }
    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(monitorRunToHtml(run)));
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
      await writeFile(filePath, pdf);
      return filePath;
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
    }
  });
}
