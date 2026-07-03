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
import { writeFile } from 'node:fs/promises';
import type { GoogleDataService } from '../google/data-service';
import { auditWorkspace } from '../google/audit-runner';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import { buildVariable, findGa4BaseTag, ga4VariablePlan } from '../google/gtm-builders';
import { withQuotaRetry } from '../google/quota-retry';

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
