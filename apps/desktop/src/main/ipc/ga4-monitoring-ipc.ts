import { ipcMain } from 'electron';
import type { Ga4MonitoringService } from '../services/ga4-monitoring-service';
import type { Ga4MonitorConfig } from '../../shared/ipc';

// Renderer ↔ Ga4MonitoringService bridge. The run PUSH ('ga4monitoring:run') is wired in index.ts via
// the service's emit closure (broadcast to all windows). Config/webhook mutations return the fresh
// status so the tab updates without a second round-trip.
export function registerGa4MonitoringIpc(service: Ga4MonitoringService): void {
  ipcMain.handle('ga4monitoring:status', () => service.status());
  ipcMain.handle('ga4monitoring:configure', (_e, patch: Partial<Ga4MonitorConfig>) =>
    service.configure(patch && typeof patch === 'object' ? patch : {})
  );
  // Optional propertyId: run one target on demand (even a paused one); omitted -> sweep all enabled.
  ipcMain.handle('ga4monitoring:runNow', (_e, propertyId?: unknown) =>
    service.runOnce(typeof propertyId === 'string' && propertyId ? propertyId : undefined)
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
}
