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

import { ipcMain } from 'electron';
import type { GoogleDataService } from '../google/data-service';
import { auditWorkspace } from '../google/audit-runner';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import { buildVariable, buildGoogleTag, findGa4BaseTag, ga4VariablePlan, BUILTIN_ALL_PAGES_TRIGGER_ID } from '../google/gtm-builders';

export function registerGtmAuditIpc(data: GoogleDataService): void {
  ipcMain.handle('gtm:audit', (_e, accountId: unknown, containerId: unknown, workspaceId: unknown) => {
    const a = String(accountId ?? '');
    const c = String(containerId ?? '');
    const w = String(workspaceId ?? '');
    if (!a || !c || !w) throw new Error('Pick a GTM account, container and workspace first.');
    return auditWorkspace(data, { accountId: a, containerId: c, workspaceId: w });
  });

  ipcMain.handle('gtm:applyFix', async (_e, fix: unknown) => {
    const f = (fix && typeof fix === 'object' ? fix : {}) as { tool?: string; args?: Record<string, unknown> };
    if (!f.tool || !f.args || typeof f.args !== 'object') throw new Error('Invalid fix.');
    const approve: ConfirmFn = async (p) => p.details; // renderer already confirmed
    const reg = buildToolRegistry(data, approve, 'gtm');
    return JSON.parse(await reg.execute(f.tool, f.args)) as unknown;
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
    const tagRes = JSON.parse(
      await reg.execute('create_gtm_tag', {
        accountId,
        containerId,
        workspaceId,
        tag: buildGoogleTag({ name: tagName, tagId: `{{${variableName}}}`, firingTriggerId: [BUILTIN_ALL_PAGES_TRIGGER_ID] }),
      }),
    ) as { name?: string };
    return { created: true, present: false, variableCreated, variableName, measurementId, tagName: tagRes?.name ?? tagName };
  });
}
