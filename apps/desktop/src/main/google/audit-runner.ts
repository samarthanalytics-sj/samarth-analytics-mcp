import type { GoogleDataService } from './data-service';
import { auditContainer, auditServerContainer, type AuditReport } from './gtm-builders';
import { diffAudits, type AuditDrift } from './gtm-monitor';
import { AuditHistoryStore } from '../storage/audit-history';

// Shared audit flow used by BOTH the chat tool (audit_gtm_container /
// audit_gtm_container_changes) and the background MonitorService, so the audit
// + fix-injection + drift logic has exactly one implementation.

export interface WorkspaceCtx {
  accountId: string;
  containerId: string;
  workspaceId: string;
}

/**
 * Audit a workspace and return a report whose auto-fixable findings carry a
 * directly-runnable `fix` — the validated workspace ids are written LAST so a
 * fix can never be retargeted at another container.
 */
export async function auditWorkspace(data: GoogleDataService, ctx: WorkspaceCtx): Promise<AuditReport> {
  const report = auditContainer(
    await data.getGtmContainerSnapshot(ctx.accountId, ctx.containerId, ctx.workspaceId)
  );
  for (const f of report.findings) {
    if (f.fix) {
      f.fix.args = {
        ...f.fix.args,
        accountId: ctx.accountId,
        containerId: ctx.containerId,
        workspaceId: ctx.workspaceId,
      };
    }
  }
  return report;
}

/**
 * Audit a SERVER container workspace and, like {@link auditWorkspace}, write the validated
 * workspace ids LAST onto every auto-fixable finding's `fix.args` so a fix (e.g. clearing a
 * Meta CAPI Test Event Code, unpausing a server tag) can be applied directly and can never be
 * retargeted at another container.
 */
export async function auditServerWorkspace(data: GoogleDataService, ctx: WorkspaceCtx): Promise<AuditReport> {
  const report = auditServerContainer(
    await data.getServerContainerSnapshot(ctx.accountId, ctx.containerId, ctx.workspaceId)
  );
  for (const f of report.findings) {
    if (f.fix) {
      f.fix.args = {
        ...f.fix.args,
        accountId: ctx.accountId,
        containerId: ctx.containerId,
        workspaceId: ctx.workspaceId,
      };
    }
  }
  return report;
}

export interface AuditChanges {
  report: AuditReport;
  /** Timestamp (ms) of the previous run, or null on the first ever run. */
  since: number | null;
  firstRun: boolean;
  drift: AuditDrift;
}

/**
 * Audit the workspace, diff the findings against the last stored run, persist
 * this run, and return what changed (new vs resolved issues). The heart of
 * continuous monitoring. `now` is injected so callers control the timestamp.
 */
export async function auditChanges(
  data: GoogleDataService,
  history: AuditHistoryStore,
  ctx: WorkspaceCtx,
  now: number
): Promise<AuditChanges> {
  const report = await auditWorkspace(data, ctx);
  const key = AuditHistoryStore.key(ctx.accountId, ctx.containerId, ctx.workspaceId);
  const prev = history.last(key);
  const drift = diffAudits(prev?.report.findings ?? null, report.findings);
  history.append(key, { at: now, report });
  return { report, since: prev?.at ?? null, firstRun: !prev, drift };
}
