// IPC for the "Container audit" panel — surfaces the EXISTING audit engine
// (auditWorkspace → auditContainer) and its ready-to-run fixes as a UI, instead
// of only via chat. Two channels:
//   gtm:audit     (read)  snapshot the container + return findings (+ fixes)
//   gtm:applyFix  (write) run one finding's fix (pause/unpause tag, delete unused
//                         trigger, …) through the existing approval-gated tools.
//
// The fix already carries its workspace ids (auditWorkspace injects them last),
// so applyFix just runs it. The confirm fn auto-approves because the RENDERER
// performed an explicit confirmation (a stronger one for destructive deletes)
// before invoking this — write tools still only exist because a confirm fn is
// supplied, and nothing is ever published.

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleDataService } from '../google/data-service';
import { auditWorkspace } from '../google/audit-runner';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import { buildVariable, findGa4BaseTag, ga4VariablePlan } from '../google/gtm-builders';
import { withQuotaRetry } from '../google/quota-retry';
import { reportHtmlDocument, dedupedReportPath } from '../google/ga4-report-export';
import { gtmAuditHtml, type GtmAuditHtmlMeta } from '../../shared/gtm-audit-html';
import type { AuditReportView, WorkspaceCompareResultView, VerifyExportPayload } from '../../shared/ipc';

// A prior download of the same report may still be open in a PDF viewer, which locks the file
// (EBUSY/EPERM/EACCES on Windows). Fall back to a suffixed name so a re-download always succeeds.
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function writeReportFile(filePath: string, data: string | Uint8Array): Promise<string> {
  for (let i = 0; i <= 50; i++) {
    const target = dedupedReportPath(filePath, i);
    try {
      await writeFile(target, data);
      return target;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!LOCK_CODES.has(code) || i === 50) throw err;
    }
  }
  throw new Error('unreachable');
}

export function registerGtmAuditIpc(data: GoogleDataService): void {
  ipcMain.handle('gtm:audit', (_e, accountId: unknown, containerId: unknown, workspaceId: unknown) => {
    const a = String(accountId ?? '');
    const c = String(containerId ?? '');
    const w = String(workspaceId ?? '');
    if (!a || !c || !w) throw new Error('Pick a GTM account, container and workspace first.');
    // The audit READ (list tags/triggers/variables) also trips GTM's per-minute quota
    // during heavy sessions — retry it with backoff so the panel doesn't crash on a 429.
    return withQuotaRetry(() => auditWorkspace(data, { accountId: a, containerId: c, workspaceId: w }));
  });

  // WORKSPACE COMPARISON (read): diff 2+ workspaces in the same container side by side. Fetches each
  // workspace's snapshot (tags/triggers/variables) + folders, flattens them, and returns the base-vs-each
  // diff + summary. Pure diff engine (workspace-diff.ts) does the comparison; this only gathers the data.
  // Read-only — never writes. Capped at 10 workspaces per run to bound the GTM read quota.
  ipcMain.handle('gtm:compareWorkspaces', async (_e, accountId: unknown, containerId: unknown, workspaceIds: unknown) => {
    const a = String(accountId ?? '');
    const c = String(containerId ?? '');
    const ids = (Array.isArray(workspaceIds) ? workspaceIds : []).map((w) => String(w ?? '').trim()).filter(Boolean);
    const uniqueIds = [...new Set(ids)];
    if (!a || !c) throw new Error('Pick a GTM account and container first.');
    if (uniqueIds.length < 2) throw new Error('Pick at least two workspaces to compare.');
    if (uniqueIds.length > 10) throw new Error('Compare at most 10 workspaces at a time.');
    const { toWorkspaceInput, compareWorkspaces } = await import('../google/workspace-diff');
    // Resolve workspace names once (the picker sends ids; the report/labels want names).
    const wsList = await withQuotaRetry(() => data.listGtmWorkspaces(a, c));
    const nameById = new Map(wsList.map((w) => [w.workspaceId, w.name] as const));
    // Fetch each workspace's snapshot + folders. Sequential (not Promise.all) to be gentle on the per-minute
    // read quota; each call already retries a 429. Order follows the picker so the FIRST id is the base.
    const inputs = [];
    for (const wid of uniqueIds) {
      const [snap, folders] = await Promise.all([
        withQuotaRetry(() => data.getGtmContainerSnapshot(a, c, wid)),
        withQuotaRetry(() => data.listGtmFolders(a, c, wid)).catch(() => [] as Array<{ name: string }>),
      ]);
      inputs.push(toWorkspaceInput(wid, nameById.get(wid) ?? `Workspace ${wid}`, snap, folders));
    }
    return compareWorkspaces(c, inputs);
  });

  // Export a workspace COMPARISON — separate from the container-audit report. CSV or Markdown built by the
  // renderer (this just writes the file the user picks). Read-only, no GTM access. Returns the saved path.
  ipcMain.handle('gtm:exportWorkspaceDiff', async (e, defaultName: unknown, content: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = String(defaultName ?? 'workspace-comparison.csv').replace(/[\\/:*?"<>|]/g, '_');
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const filter =
      ext === 'md' ? { name: 'Markdown', extensions: ['md'] }
      : ext === 'csv' ? { name: 'CSV', extensions: ['csv'] }
      : { name: 'All Files', extensions: ['*'] };
    const opts = { title: 'Export workspace comparison', defaultPath: name, filters: [filter] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await writeFile(filePath, String(content ?? ''), 'utf8');
    return filePath;
  });

  // Export the workspace comparison as a styled PDF (mirrors the on-screen diff). The renderer sends the
  // full compare result; workspaceDiffHtml() renders the same summary cards + per-entity diff table, printed
  // in a hidden, script-disabled window — same pipeline as the GA4 / audit reports.
  ipcMain.handle('gtm:exportWorkspaceDiffPdf', async (e, defaultName: unknown, result: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const base = String(defaultName ?? 'GTM workspace comparison')
      .replace(/[\\/:*?"<>|]/g, '_').replace(/\.pdf$/i, '').trim() || 'GTM workspace comparison';
    const r = result as WorkspaceCompareResultView;
    if (!r || !Array.isArray(r.pairs) || !Array.isArray(r.workspaces)) throw new Error('Invalid comparison result.');
    const { workspaceDiffHtml } = await import('../../shared/gtm-workspace-diff-html');
    const opts = { title: 'Export workspace comparison', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      const html = reportHtmlDocument(base, '', { execHtml: workspaceDiffHtml(r) });
      await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
      return await writeReportFile(filePath, pdf);
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
    }
  });

  // Save the container-audit findings to a file the user picks (CSV or Markdown — the renderer
  // builds the content; this just writes it). Read-only export, no GTM access. Returns the saved
  // path, or null if cancelled. The dialog filter is inferred from the default filename's extension.
  ipcMain.handle('gtm:exportAudit', async (e, defaultName: unknown, content: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = String(defaultName ?? 'container-audit.csv').replace(/[\\/:*?"<>|]/g, '_');
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const filter =
      ext === 'md'
        ? { name: 'Markdown', extensions: ['md'] }
        : ext === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : { name: 'All Files', extensions: ['*'] };
    const opts = { title: 'Export container audit', defaultPath: name, filters: [filter] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await writeFile(filePath, String(content ?? ''), 'utf8');
    return filePath;
  });

  // Save the container-audit as a styled PDF that mirrors the panel: the renderer sends the FULL
  // structured report + scope meta; gtmAuditHtml() renders the same severity cards / icons / type
  // labels the UI shows, and the document is printed in a hidden, script-disabled window — the same
  // pipeline as the GA4 report.
  ipcMain.handle('gtm:exportAuditPdf', async (e, defaultName: unknown, report: unknown, meta: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const base = String(defaultName ?? 'GTM container audit')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.pdf$/i, '')
      .trim() || 'GTM container audit';
    const r = report as AuditReportView;
    if (!r || !Array.isArray(r.findings) || !r.counts || !r.summary) throw new Error('Invalid audit report.');
    const m: GtmAuditHtmlMeta = meta && typeof meta === 'object' ? (meta as GtmAuditHtmlMeta) : {};
    const opts = { title: 'Export container audit', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      const html = reportHtmlDocument(base, '', { execHtml: gtmAuditHtml(r, m) });
      await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
      return await writeReportFile(filePath, pdf);
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
    }
  });

  // Export the TAG-VERIFICATION results (the Tag-verification tab's table) to a file the user picks:
  //   csv → a text spreadsheet (Status · Tag · GA4 event name · Trigger event · Fired via · Signal)
  //   pdf → the styled results report (scorecard + table) with each tag's PROOF SCREENSHOT embedded
  //   doc → the same HTML written as .doc (Word/Docs open it) — screenshots embedded as data-URIs
  // The renderer sends the derived rows + counts (VerifyExportPayload); the pure builders format them.
  // Read-only export — no GTM access. Returns the saved path, or null if cancelled.
  ipcMain.handle('verify:exportResults', async (e, format: unknown, defaultName: unknown, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const fmt = String(format ?? '').toLowerCase();
    if (fmt !== 'csv' && fmt !== 'pdf' && fmt !== 'doc') throw new Error('Unsupported export format.');
    const p = payload as VerifyExportPayload;
    if (!p || !Array.isArray(p.rows) || !p.counts) throw new Error('Invalid verification results.');
    const base = String(defaultName ?? 'Tag verification')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(csv|pdf|doc)$/i, '')
      .trim() || 'Tag verification';
    const filter =
      fmt === 'csv' ? { name: 'CSV', extensions: ['csv'] }
      : fmt === 'doc' ? { name: 'Word', extensions: ['doc'] }
      : { name: 'PDF', extensions: ['pdf'] };
    const opts = { title: 'Export tag verification', defaultPath: `${base}.${fmt}`, filters: [filter] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;

    const { verifyResultsCsv, verifyResultsHtml } = await import('../../shared/verify-results-html');
    // Prepend a UTF-8 BOM so Excel decodes the file as UTF-8 (without it Excel assumes the legacy ANSI
    // codepage and renders the em dash "—" and other non-ASCII as mojibake like "â€"").
    const BOM = String.fromCharCode(0xfeff);
    if (fmt === 'csv') return await writeReportFile(filePath, BOM + verifyResultsCsv(p));

    // PDF + DOC share the same styled HTML; DOC adds the MS-Office namespaces (word:true). The proof
    // screenshots are inline data-URIs, so the document is self-contained.
    const html = reportHtmlDocument(base, '', { word: fmt === 'doc', execHtml: verifyResultsHtml(p) });
    if (fmt === 'doc') return await writeReportFile(filePath, html);

    // PDF: render the HTML in a hidden, script-disabled window and print it. The document can be several
    // MB once the JPEG proofs are embedded, which can exceed the data:-URL navigation limit — so write it
    // to a temp file and loadFile() it (robust for any size) instead of a data: URL.
    const tmpHtml = join(tmpdir(), `samarth-verify-${process.pid}-${Date.now()}.html`);
    await writeFile(tmpHtml, html, 'utf8');
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await pdfWin.loadFile(tmpHtml);
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
      return await writeReportFile(filePath, pdf);
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
      await unlink(tmpHtml).catch(() => {});
    }
  });

  // Verifiable tags for the Container-audit "Verify firing" flow: snapshot the
  // container + map each GA4/base tag's native trigger to the verify engine's shape.
  ipcMain.handle('gtm:verifiableTags', async (_e, accountId: unknown, containerId: unknown, workspaceId: unknown) => {
    const a = String(accountId ?? ''), c = String(containerId ?? ''), w = String(workspaceId ?? '');
    if (!a || !c || !w) throw new Error('Pick a GTM account, container and workspace first.');
    const snap = await withQuotaRetry(() => data.getGtmContainerSnapshot(a, c, w));
    const { snapshotToVerifyInputs } = await import('./container-verify');
    return snapshotToVerifyInputs(snap);
  });

  // Repair a created tag's firing trigger to a corrected shape (the "Verify firing → auto-heal" fix):
  // rewrite the trigger's conditions in place, or rebind this tag to a corrected trigger if shared.
  // Draft-only write; the renderer confirms before invoking. Retries the per-minute quota.
  ipcMain.handle('gtm:retargetTrigger', async (_e, ctx: unknown) => {
    const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    const accountId = String(o.accountId ?? ''), containerId = String(o.containerId ?? ''), workspaceId = String(o.workspaceId ?? '');
    const tagName = String(o.tagName ?? '').trim();
    const corrected = o.trigger;
    if (!accountId || !containerId || !workspaceId) throw new Error('Pick a GTM account, container and draft workspace first.');
    if (!tagName) throw new Error('Which tag to repair?');
    if (!corrected || typeof corrected !== 'object') throw new Error('No corrected trigger provided.');
    return withQuotaRetry(
      () => data.retargetTagTrigger(accountId, containerId, workspaceId, tagName, corrected as Parameters<typeof data.retargetTagTrigger>[4]),
      { maxRetries: 3 }
    );
  });

  // Align a GA4 Event tag's Event Name to an observed value (the "align event name" verify fix).
  // Draft-only write; the renderer confirms before invoking. Retries the per-minute quota.
  ipcMain.handle('gtm:setTagEventName', async (_e, ctx: unknown) => {
    const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    const accountId = String(o.accountId ?? ''), containerId = String(o.containerId ?? ''), workspaceId = String(o.workspaceId ?? '');
    const tagName = String(o.tagName ?? '').trim();
    const eventName = String(o.eventName ?? '').trim();
    if (!accountId || !containerId || !workspaceId) throw new Error('Pick a GTM account, container and draft workspace first.');
    if (!tagName) throw new Error('Which tag to align?');
    if (!eventName) throw new Error('Provide the event name to set.');
    return withQuotaRetry(() => data.setGa4TagEventName(accountId, containerId, workspaceId, tagName, eventName), { maxRetries: 3 });
  });

  ipcMain.handle('gtm:applyFix', async (_e, fix: unknown) => {
    const f = (fix && typeof fix === 'object' ? fix : {}) as { tool?: string; args?: Record<string, unknown> };
    if (!f.tool || !f.args || typeof f.args !== 'object') throw new Error('Invalid fix.');
    const approve: ConfirmFn = async (p) => p.details; // renderer already confirmed
    const reg = buildToolRegistry(data, approve, 'gtm');
    // GTM's per-minute write quota trips during big batches — retry the transient
    // 429 / "Quota exceeded" with exponential backoff (default 3 retries) instead of
    // failing the fix. f.tool/f.args are constants here, so a retry is idempotent.
    const tool = f.tool;
    const args = f.args;
    // 5 retries (more than the default) — a saturated per-minute quota during a big batch
    // can need several backoffs before a single write gets through.
    return JSON.parse(await withQuotaRetry(() => reg.execute(tool, args), { maxRetries: 5 })) as unknown;
  });

  // Create a complete SERVER container FROM a web container in one step: derive the web container's
  // GA4 Measurement ID, bootstrap the server container (container + GA4 client + trigger + GA4 relay
  // tag), and — when a server URL is supplied — record it on the server container and point the web
  // Google tag at it. The renderer confirms first (this is a write); nothing is published.
  ipcMain.handle('gtm:createServerContainer', async (_e, ctx: unknown) => {
    const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    const accountId = String(o.accountId ?? '');
    const webContainerId = String(o.webContainerId ?? '');
    const name = String(o.name ?? '').trim();
    const serverUrl = o.serverUrl != null ? String(o.serverUrl).trim() : '';
    if (!accountId || !webContainerId) throw new Error('Pick a GTM account and the web container to base the server container on.');
    if (!name) throw new Error('Give the new server container a name.');
    // The bootstrap fires several writes (container + client + trigger + tag + URL wiring) and can
    // trip the per-minute quota; retry the whole flow with backoff (it is name-idempotent).
    return withQuotaRetry(() => data.createServerContainerFromWeb(accountId, webContainerId, name, serverUrl || undefined), { maxRetries: 3 });
  });

  // Ensure a GA4 base/config tag exists. If none is present, store the Measurement
  // ID in a Constant variable and create a Google Tag that references {{<var>}},
  // firing on the built-in All Pages trigger. Draft-only; the renderer confirms
  // first. No-op (no write) when a GA4 base tag already exists.
  ipcMain.handle('gtm:ensureGa4Config', async (_e, ctx: unknown) => {
    const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    const accountId = String(o.accountId ?? '');
    const containerId = String(o.containerId ?? '');
    const workspaceId = String(o.workspaceId ?? '');
    if (!accountId || !containerId || !workspaceId) throw new Error('Pick a GTM account, container and draft workspace first.');
    const measurementId = String(o.measurementId ?? '').trim() || 'G-123456789';
    const variableName = String(o.variableName ?? '').trim() || 'GA4 - Variable';
    const tagName = String(o.tagName ?? '').trim() || 'GA4 Configuration';

    const snap = await data.getGtmContainerSnapshot(accountId, containerId, workspaceId);
    const existing = findGa4BaseTag(snap);
    if (existing) {
      return { created: false, present: true, existingTag: existing.name, variableName, measurementId, tagName };
    }

    // Only reuse an existing same-named variable if it's a Constant — otherwise the
    // base tag's {{name}} would resolve to a wrong-purpose variable (a dataLayer
    // lookup, a custom-JS value, …) and silently misconfigure GA4.
    const plan = ga4VariablePlan(snap, variableName);
    if (plan.action === 'conflict') {
      throw new Error(
        `A variable named "${variableName}" already exists but is not a Measurement-ID constant (type "${plan.existingType}"). Rename it, or use a different variable name, so the GA4 tag binds to a constant.`,
      );
    }

    const approve: ConfirmFn = async (p) => p.details; // renderer already confirmed
    const reg = buildToolRegistry(data, approve, 'gtm');

    const variableCreated = plan.action === 'create';
    if (variableCreated) {
      await reg.execute('create_gtm_variable', {
        accountId,
        containerId,
        workspaceId,
        variable: buildVariable({ kind: 'constant', name: variableName, value: measurementId }),
      });
    }
    // Use the create_gtm_tracking_tag path so the firing trigger is a real, created
    // Page View "All Pages" trigger (reused by name) — not the built-in id, which
    // the API may not accept on tag creation.
    const tagRes = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId,
        containerId,
        workspaceId,
        platform: 'google_tag',
        tagName,
        tagId: `{{${variableName}}}`,
        trigger: { name: 'All Pages', kind: 'pageview' },
      }),
    ) as { tag?: { name?: string } };
    return { created: true, present: false, variableCreated, variableName, measurementId, tagName: tagRes?.tag?.name ?? tagName };
  });
}
