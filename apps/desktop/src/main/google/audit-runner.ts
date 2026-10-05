import type { GoogleDataService } from './data-service';
import { auditContainer, auditServerContainer, type AuditFinding, type AuditReport } from './gtm-builders';
import { isPairFinding, pairDriftFindings, withPairFindings, type WebPair } from './server-pair';
import { withQuotaRetry } from './quota-retry';
import { log } from '../logger';
import { buildContainerInventory, type ContainerInventory } from './gtm-inventory';
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

/** An audit report optionally carrying the human-readable inventory tables (chat only). */
export type AuditReportWithInventory = AuditReport & { inventory?: ContainerInventory };

/**
 * Audit a workspace and return a report whose auto-fixable findings carry a
 * directly-runnable `fix` — the validated workspace ids are written LAST so a
 * fix can never be retargeted at another container.
 *
 * `opts.includeInventory` attaches the three inventory tables (Tag / Trigger /
 * Variable Audit) for the chat to render. The background monitor omits it, so
 * the stored audit history stays lean.
 */
/**
 * Which engine a container needs. A SERVER container audited by the WEB engine is pure noise: every
 * reference to a server built-in ({{Client Name}}, {{Request Path}}) reads as an undefined variable,
 * so a 33-tag server container came back with 125 findings and not one true one. Both the Audit
 * tab and the chat's audit_gtm_container reach auditWorkspace without checking the type, so the
 * check lives here, once. Reads the cached container list; on any failure it returns null and the
 * caller keeps today's behaviour rather than inventing a type.
 */
export async function containerKind(
  data: GoogleDataService,
  ctx: Pick<WorkspaceCtx, 'accountId' | 'containerId'>,
): Promise<'web' | 'server' | null> {
  try {
    const c = (await data.listGtmContainers(ctx.accountId)).find((x) => x.containerId === ctx.containerId);
    if (!c) return null;
    return (c.usageContext ?? []).some((u) => String(u ?? '').toLowerCase() === 'server') ? 'server' : 'web';
  } catch {
    return null;
  }
}

export async function auditWorkspace(
  data: GoogleDataService,
  ctx: WorkspaceCtx,
  opts?: { includeInventory?: boolean },
): Promise<AuditReportWithInventory> {
  // A server container gets the server engine, whatever surface asked. Its report satisfies the
  // same shape; it carries no web inventory because a server container has none of those objects.
  if ((await containerKind(data, ctx)) === 'server') return auditServerWorkspace(data, ctx);
  const snapshot = await data.getGtmContainerSnapshot(ctx.accountId, ctx.containerId, ctx.workspaceId);
  const report: AuditReportWithInventory = auditContainer(snapshot);
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
  if (opts?.includeInventory) report.inventory = buildContainerInventory(snapshot);
  return report;
}

/**
 * Audit a SERVER container workspace and, like {@link auditWorkspace}, write the validated
 * workspace ids LAST onto every auto-fixable finding's `fix.args` so a fix (e.g. clearing a
 * Meta CAPI Test Event Code, unpausing a server tag) can be applied directly and can never be
 * retargeted at another container.
 */
export async function auditServerWorkspace(data: GoogleDataService, ctx: WorkspaceCtx): Promise<AuditReport> {
  // The mirror image: the server engine on a WEB container would report "no client claims requests"
  // on every web container in existence. Refuse with the right tool named instead.
  if ((await containerKind(data, ctx)) === 'web') {
    throw new Error(
      `Container ${ctx.containerId} is a WEB container, so the server audit does not apply. Use audit_gtm_container (the Audit tab) for it.`,
    );
  }
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
  /** True when the web + server pair could not be read this run: the previous run's pair findings
   *  were carried forward unchanged, so they are neither "resolved" nor "new" here. */
  pairUnavailable: boolean;
}

/**
 * Audit the workspace, diff the findings against the last stored run, persist
 * this run, and return what changed (new vs resolved issues). The heart of
 * continuous monitoring. `now` is injected so callers control the timestamp.
 */
/**
 * For a SERVER container, the findings only the web + server PAIR reveals: a wired web tag whose
 * relay is gone, a relay whose web tag went direct, both legs feeding one property. Every web
 * container in the account is read so pairing can be decided from the tagging host. Returns [] for
 * a web container, and NULL when the pairing could not be read (a failed read, or a container whose
 * type cannot be determined): "unknown" must never look like "no pair problems", or the drift diff
 * records every pair finding as resolved and re-alerts on it as new on the next good read.
 */
export async function pairFindingsFor(data: GoogleDataService, ctx: WorkspaceCtx, report: AuditReport): Promise<AuditFinding[] | null> {
  try {
    const kind = await containerKind(data, ctx);
    if (kind === null) return null;
    if (kind !== 'server') return [];
    const server = await data.getServerContainerSnapshot(ctx.accountId, ctx.containerId, ctx.workspaceId);
    const containers = await data.listGtmContainers(ctx.accountId);
    const webs: WebPair[] = [];
    for (const c of containers) {
      if (c.containerId === ctx.containerId) continue;
      // Web containers only (no usageContext = web, as in containerKind): server, AMP and mobile
      // containers hold no Google tag to pair, and skipping them saves reads against the GTM quota.
      const usage = (c.usageContext ?? []).map((u) => String(u ?? '').toLowerCase());
      if (usage.includes('server') || (usage.length > 0 && !usage.includes('web'))) continue;
      // A short per-minute 429 waits for the quota to reset instead of dropping the whole pair leg.
      const wss = await withQuotaRetry(() => data.listGtmWorkspaces(ctx.accountId, c.containerId));
      const ws = wss.find((w) => /default/i.test(w.name)) ?? wss[0];
      if (!ws) continue;
      webs.push({ containerId: c.containerId, name: c.name, snapshot: await withQuotaRetry(() => data.getGtmContainerSnapshot(ctx.accountId, c.containerId, ws.workspaceId)) });
    }
    return pairDriftFindings(server, webs, report.summary);
  } catch (e) {
    log.warn(`[audit] pair read for container ${ctx.containerId} failed - keeping last run's pair findings: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function auditChanges(
  data: GoogleDataService,
  history: AuditHistoryStore,
  ctx: WorkspaceCtx,
  now: number
): Promise<AuditChanges> {
  // The pair findings ride along as ordinary findings, so history, drift and the alert need no
  // new shape: a regression in the pair is simply a NEW finding on the next scheduled run.
  const base = await auditWorkspace(data, ctx);
  const key = AuditHistoryStore.key(ctx.accountId, ctx.containerId, ctx.workspaceId);
  const prev = history.last(key);
  const pair = await pairFindingsFor(data, ctx, base);
  // null = the pair could not be read this run: keep last run's pair findings rather than recording
  // them as resolved (and re-alerting on them as new when the next read succeeds).
  const report = withPairFindings(base, pair ?? (prev?.report.findings ?? []).filter(isPairFinding));
  const drift = diffAudits(prev?.report.findings ?? null, report.findings);
  history.append(key, { at: now, report });
  return { report, since: prev?.at ?? null, firstRun: !prev, drift, pairUnavailable: pair === null };
}
