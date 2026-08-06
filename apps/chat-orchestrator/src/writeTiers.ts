/**
 * Which writes stop for the user, and what the user is told about them.
 *
 * PURE, with no MCP connection and no config object, so the whole matrix is testable without
 * spawning a child process or binding a socket. The same reasoning as the MCP's own guardrailMode
 * module: the rules that decide whether something can be undone should not require a running server
 * to verify.
 *
 * The distinction that matters is not create versus delete, it is whether there is anything to fall
 * back on. A tag lands in a draft workspace, so the live container is untouched and discarding the
 * workspace throws the change away. A GA4 property setting has no draft at all.
 */
import type { WriteSurface } from './types.js';

/**
 * Where a write lands, read off the schema rather than a name list.
 *
 * `workspaceId` is the tell. Every GTM tool that operates inside a workspace declares it, and a
 * workspace-scoped change is a draft. Anything without it acts on the container, account, version,
 * environment, or permission set directly, with no draft step in between.
 *
 * Deriving this from the schema means a tool added upstream is classified the first time it appears,
 * rather than defaulting to whichever description happens to sound safest.
 */
export function classifyWriteSurface(
  name: string,
  properties: Record<string, unknown>,
): WriteSurface {
  // Checked before the workspace key, not after: GA4 has no workspace concept, so if that key ever
  // shows up on a GA4 tool it is not evidence of a draft.
  if (/^ga4_/i.test(name)) return 'ga4_live';
  return Object.prototype.hasOwnProperty.call(properties, 'workspaceId') ? 'gtm_draft' : 'gtm_live';
}

/**
 * The word a removal makes the user type.
 *
 * An archive is not a delete and should not be confirmed as one. GA4 archiving has no undo anywhere
 * in this toolset, while a GA4 property delete goes to a trash it can be recovered from, so the two
 * are not interchangeable and the prompt should not pretend they are. Typing the word that matches
 * the operation is also what stops the confirmation becoming muscle memory.
 */
export function confirmWordFor(toolName: string): string {
  return /(^|_)archive(_|$)/i.test(toolName) ? 'ARCHIVE' : 'DELETE';
}

/**
 * Decides whether a write stops for the user, and how hard.
 *
 * Ordinary CRUD across both products applies directly: create, read and update run when the model
 * calls them. Removal is the exception, and it stops for a typed confirmation.
 *
 * The reasoning is that a confirmation is only worth asking for when it is not routine. Prompting on
 * every create teaches people to click Approve without reading, which spends the attention that the
 * one irreversible prompt needs. Removals are where the asymmetry is real: nothing in this toolset
 * reverts one, so undo means rebuilding by hand or, for a GA4 archive, not at all.
 *
 * `approveLiveWrites` restores the middle tier, where a create or update with no draft behind it
 * (all GA4 Admin config, and GTM container, version, environment and permission changes) shows a
 * plain approval card. It is off by default because the uniform CRUD model was asked for
 * deliberately, and on it is the stricter setting, never the looser one.
 *
 * Returns null when the write should simply run.
 */
export function approvalGate(
  tool: { isDelete: boolean; surface?: string; name?: string },
  approveLiveWrites: boolean,
): { confirmWord?: string } | null {
  // Checked first and never relaxed by configuration: no flag can turn a removal into a silent one.
  if (tool.isDelete) return { confirmWord: confirmWordFor(tool.name ?? '') };
  if (approveLiveWrites && tool.surface !== 'gtm_draft') return {};
  return null;
}

/**
 * One line on what this change can and cannot be taken back, for the approval card.
 *
 * `toolName` matters because an archive is the worst case on this list and reads like the mildest.
 */
export function describeReversibility(
  surface: WriteSurface,
  isDelete: boolean,
  toolName = '',
): string {
  if (isDelete && /(^|_)archive(_|$)/i.test(toolName)) {
    return 'Archiving is effectively permanent. There is no un-archive in the GA4 API, so this cannot be undone here or in the GA4 interface.';
  }
  if (surface === 'gtm_draft') {
    return isDelete
      ? 'This happens in a draft workspace, so your live site is unaffected, but nothing here restores it: recovery means rebuilding it by hand or discarding the workspace.'
      : 'This lands in a draft workspace and is not published, so your live site is unaffected until someone publishes it.';
  }
  if (surface === 'ga4_live') {
    return isDelete
      ? 'GA4 has no draft. This removes the resource from the live property as soon as it succeeds. Some GA4 deletes go to a trash that can be restored for a limited time; nothing here restores them for you.'
      : 'GA4 has no draft. This takes effect on the property as soon as it succeeds, and nothing here undoes it.';
  }
  return isDelete
    ? 'This is not workspace-scoped, so there is no draft to discard. It takes effect immediately and nothing here undoes it.'
    : 'This changes the container, version, environment, or permissions directly. There is no draft step, so it takes effect as soon as it succeeds.';
}
