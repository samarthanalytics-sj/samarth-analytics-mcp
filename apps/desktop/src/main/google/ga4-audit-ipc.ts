// IPC for the "GA4 Audit" panel: list GA4 properties (the picker) and run a
// READ-ONLY config + data-quality audit on a chosen property/window. Mirrors
// gtm-audit-ipc.ts, but GA4 has no fixes (every finding is advisory).

import { ipcMain } from 'electron';
import type { GoogleDataService } from './data-service';
import { auditGa4 } from './ga4-audit';
import { auditGa4DataQuality } from './ga4-data-quality';
import { withQuotaRetry } from './quota-retry';
import type { Ga4PropertyAuditResult, Ga4PropertyListItem } from '../../shared/ipc';

export function registerGa4AuditIpc(data: GoogleDataService): void {
  // Flat list of every GA4 property (id + name + parent account) the active user can
  // reach, for the panel's search/select picker — one accountSummaries call (no per-account
  // fan-out). An auth/scope/transport failure propagates so the panel shows the real error
  // instead of a misleading empty "no properties" state.
  ipcMain.handle('ga4:listProperties', async (): Promise<Ga4PropertyListItem[]> => {
    const list = await withQuotaRetry(() => data.listGa4PropertySummaries());
    return [...list].sort((x, y) => x.displayName.localeCompare(y.displayName));
  });

  // Run the audit: the CONFIG pass (auditGa4) is window-independent; the DATA-QUALITY
  // pass runs over the chosen window (days clamped to [1, 365], default 28). Read-only.
  ipcMain.handle('ga4:audit', async (_e, property: unknown, days: unknown): Promise<Ga4PropertyAuditResult> => {
    const p = String(property ?? '');
    if (!p) throw new Error('Pick a GA4 property first.');
    const n = Math.floor(Number(days));
    const d = days != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
    const [snap, dq] = await Promise.all([
      withQuotaRetry(() => data.getGa4PropertySnapshot(p)),
      withQuotaRetry(() => data.getGa4DataQuality(p, d)),
    ]);
    return { config: auditGa4(snap), dataQuality: auditGa4DataQuality(dq) };
  });
}
