// Runs ONE audit finding's ready-made fix for the Container audit panel (the gtm:applyFix IPC).
//
// The panel confirms in the renderer before it calls this (a two-click confirm per delete, or one
// confirm for a reviewed bulk delete), so the fix runs through the tool registry with a confirm fn
// that stands in for that confirmation. That stand-in used to be "approve every card" for ANY tool
// name the renderer sent, so a renderer bug or injection could run batch deletes, container creates
// or the live-GA4 runtime probe with every approval card silently answered. Now:
//   - only the tools the audit engine emits as fixes run (AUDIT_FIX_TOOLS, which types AuditFix.tool),
//     and anything else is refused before the registry is even built;
//   - a destructive fix still goes through the registry's two-step delete confirmation, the same
//     plan card + type-"delete" sequence the chat shows, and the stand-in answers exactly that
//     sequence for exactly that tool. Any other card (a one-click `approval` card for a live write,
//     a single-card batch, a card for some other tool) is declined, and the fix fails with an error
//     rather than being reported as applied.
// Nothing here publishes: every fix tool writes to a draft workspace.

import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import { AUDIT_FIX_TOOLS, isAuditFixTool, type AuditFixTool } from '../google/gtm-builders';
import { withQuotaRetry } from '../google/quota-retry';
import type { GoogleDataService } from '../google/data-service';

/** The confirm fn for one audit fix: answers ONLY the registry's two-step destructive confirmation
 *  (plan card, then the type-"delete" final card, in that order) for `tool`, and declines every
 *  other card. A non-destructive fix tool shows no card at all, so it is never asked. PURE. */
export function auditFixConfirm(tool: AuditFixTool): ConfirmFn {
  let step = 0;
  return async (p) => {
    if (p.tool !== tool || p.destructive !== true) return null;
    if (step === 0 && !p.requireTextConfirm) { step = 1; return p.details; }
    if (step === 1 && p.requireTextConfirm === 'delete') { step = 2; return p.details; }
    return null;
  };
}

/** Validate and run one renderer-supplied audit fix. Throws on anything that is not an audit fix,
 *  and when the fix needed an approval the audit panel cannot give. */
export async function runAuditFix(data: GoogleDataService, fix: unknown, opts: { maxRetries?: number } = {}): Promise<unknown> {
  const f = (fix && typeof fix === 'object' ? fix : {}) as { tool?: unknown; args?: unknown };
  if (typeof f.tool !== 'string' || !f.tool || !f.args || typeof f.args !== 'object') throw new Error('Invalid fix.');
  const tool = f.tool;
  if (!isAuditFixTool(tool)) {
    throw new Error(`"${tool}" is not an audit fix, so the audit panel will not run it. Audit fixes are limited to ${AUDIT_FIX_TOOLS.join(', ')}; anything else has to go through the chat, which shows its own approval card.`);
  }
  const args = f.args as Record<string, unknown>;
  // GTM's per-minute write quota trips during big batches: retry the transient 429 / "Quota
  // exceeded" with backoff (5 retries - a saturated quota can need several). Each attempt gets a
  // fresh registry and confirm fn, so a retried delete walks the same two-step sequence again.
  const raw = await withQuotaRetry(
    () => buildToolRegistry(data, auditFixConfirm(tool), 'gtm').execute(tool, args),
    { maxRetries: opts.maxRetries ?? 5 },
  );
  const out = JSON.parse(raw) as unknown;
  if (out && typeof out === 'object' && (out as { declined?: unknown }).declined === true) {
    throw new Error(`The audit panel cannot approve this ${tool} fix (it asked for a confirmation the panel does not give). Nothing was changed.`);
  }
  return out;
}
