import { ipcMain } from 'electron';
import type { AdsMonitoringService } from '../services/ads-monitoring-service';
import type { AdsMonitorConfig } from '../../shared/ipc';

// Renderer <-> AdsMonitoringService bridge. The run PUSH ('adsmonitoring:run') is wired in index.ts
// via the service's emit closure (broadcast to all windows). Config/webhook mutations return the
// fresh status so the tab updates without a second round-trip.
export function registerAdsMonitoringIpc(service: AdsMonitoringService): void {
  ipcMain.handle('adsmonitoring:status', () => service.status());
  ipcMain.handle('adsmonitoring:configure', (_e, patch: Partial<AdsMonitorConfig>) =>
    service.configure(patch && typeof patch === 'object' ? patch : {})
  );
  // Optional customerId: run one target on demand (even a paused one); omitted -> sweep all enabled.
  ipcMain.handle('adsmonitoring:runNow', (_e, customerId?: unknown) =>
    service.runOnce(typeof customerId === 'string' && customerId ? customerId : undefined, 'manual')
  );
  ipcMain.handle('adsmonitoring:setWebhook', (_e, url: unknown, customerId: unknown) =>
    service.setWebhook(String(url ?? ''), String(customerId ?? ''))
  );
  ipcMain.handle('adsmonitoring:clearWebhook', (_e, customerId: unknown) =>
    service.clearWebhook(String(customerId ?? ''))
  );
  ipcMain.handle('adsmonitoring:sendTest', (_e, customerId: unknown) =>
    service.sendTest(String(customerId ?? ''))
  );
}
