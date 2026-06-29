// IPC for the "GA4 Audit" panel: list GA4 properties (the picker) and run a
// READ-ONLY config + data-quality audit on a chosen property/window. Mirrors
// gtm-audit-ipc.ts, but GA4 has no fixes (every finding is advisory).

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { GoogleDataService } from './data-service';
import { auditGa4 } from './ga4-audit';
import { auditGa4DataQuality } from './ga4-data-quality';
import { buildGa4AuditReport } from './ga4-report';
import { reportHtmlDocument } from './ga4-report-export';
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

  // Run the audit: the CONFIG pass (auditGa4) is window-independent; the DATA-QUALITY pass runs
  // over the chosen window — either trailing N days (clamped to [1, 365], default 28) or an
  // explicit { startDate, endDate } custom range (YYYY-MM-DD, start <= end). Read-only.
  ipcMain.handle('ga4:audit', async (_e, property: unknown, window: unknown): Promise<Ga4PropertyAuditResult> => {
    const p = String(property ?? '');
    if (!p) throw new Error('Pick a GA4 property first.');
    let win: number | { startDate: string; endDate: string };
    if (window && typeof window === 'object') {
      const w = window as { startDate?: unknown; endDate?: unknown };
      const sd = String(w.startDate ?? '');
      const ed = String(w.endDate ?? '');
      const ymd = /^\d{4}-\d{2}-\d{2}$/;
      if (!ymd.test(sd) || !ymd.test(ed)) throw new Error('Custom range needs a valid start and end date (YYYY-MM-DD).');
      if (sd > ed) throw new Error('The start date must be on or before the end date.');
      win = { startDate: sd, endDate: ed };
    } else {
      const n = Math.floor(Number(window));
      win = window != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
    }
    const [snap, dqCounts] = await Promise.all([
      withQuotaRetry(() => data.getGa4PropertySnapshot(p)),
      withQuotaRetry(() => data.getGa4DataQuality(p, win)),
    ]);
    const config = auditGa4(snap);
    const dataQuality = auditGa4DataQuality(dqCounts);
    // Best-effort enrichments for the report doc — a failure just degrades that section to
    // Not Verified, it never fails the audit (config + data quality always return).
    const baseline = await withQuotaRetry(() => data.getGa4Baseline(p, dqCounts.startDate ?? '', dqCounts.endDate ?? '')).catch(() => null);
    const attribution = await data.getGa4AttributionSettings(p).catch(() => null);
    const audienceCount = await data.listGa4Audiences(p).then((a) => a.length).catch(() => null);
    const markdown = buildGa4AuditReport({
      property: p,
      displayName: snap.displayName,
      generatedAt: new Date().toISOString(),
      snapshot: snap,
      config,
      dataQuality,
      dqCounts,
      baseline,
      attribution,
      audienceCount,
    });
    return { config, dataQuality, markdown };
  });

  // Save the (renderer-displayed) GA4 audit report to a user-chosen file in the requested format:
  //   md  → the raw Markdown
  //   doc → a styled HTML document with the MS-Office namespaces (Word / Google Docs open it)
  //   pdf → the same HTML rendered in a hidden, script-free window via Electron printToPDF
  // A save dialog picks the path; returns the path or null if cancelled.
  ipcMain.handle('ga4:exportReport', async (e, format: unknown, defaultName: unknown, markdown: unknown): Promise<string | null> => {
    const fmt = format === 'pdf' ? 'pdf' : format === 'doc' ? 'doc' : 'md';
    const md = String(markdown ?? '');
    const base = String(defaultName ?? 'GA4 audit report')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(md|pdf|docx?|txt)$/i, '')
      .trim() || 'GA4 audit report';
    const win = BrowserWindow.fromWebContents(e.sender);
    const filterName = fmt === 'pdf' ? 'PDF' : fmt === 'doc' ? 'Word document' : 'Markdown';
    const opts = { title: 'Save GA4 audit report', defaultPath: `${base}.${fmt}`, filters: [{ name: filterName, extensions: [fmt] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;

    if (fmt === 'md') {
      await writeFile(filePath, md, 'utf8');
    } else if (fmt === 'doc') {
      await writeFile(filePath, reportHtmlDocument(base, md, { word: true }), 'utf8');
    } else {
      // PDF — render the report HTML in a hidden, script-disabled window and print it to PDF.
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reportHtmlDocument(base, md)));
        const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
        await writeFile(filePath, pdf);
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
      }
    }
    return filePath;
  });
}
