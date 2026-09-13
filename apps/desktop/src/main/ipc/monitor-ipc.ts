import { ipcMain } from 'electron';
import type { MonitorService } from '../services/monitor-service';
import type { MonitorConfig } from '../../shared/ipc';

// Renderer ↔ MonitorService bridge. Alert PUSH ('monitor:alert') is wired in
// index.ts via the service's emit closure (broadcast to all windows).
export function registerMonitorIpc(service: MonitorService): void {
  ipcMain.handle('monitor:status', () => service.status());
  ipcMain.handle('monitor:configure', (_e, patch: Partial<MonitorConfig>) =>
    service.configure(patch && typeof patch === 'object' ? patch : {})
  );
  ipcMain.handle('monitor:runNow', () => service.runOnce());
}
