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
 * Decides whether a write stops for the user, and how hard.
 *
 * Three tiers, matching the desktop assistant so both surfaces behave the same way:
 *
 * 1. A change inside a GTM workspace APPLIES DIRECTLY. It is a draft, the live configuration is
 *    still the previous one, nothing here publishes, and discarding the workspace throws it away.
 *    Prompting on each one trains people to click Approve without reading, which costs more safety
 *    than it buys.
 * 2. A DELETE stops for a typed confirmation. Nothing in this toolset reverts one, so undo means
 *    rebuilding by hand. This tier is never relaxed by configuration.
 * 3. A write that is immediately live with no draft behind it stops for a plain approval. GA4 Admin
 *    has no draft concept, and container, version, environment, and permission changes skip the
 *    workspace entirely. Additive but live still deserves an explicit yes.
 *
 * Returns null when the write should simply run.
 */
export function approvalGate(
  tool: { isDelete: boolean; surface?: string },
  approveLiveWrites: boolean,
): { confirmWord?: string } | null {
  if (tool.isDelete) return { confirmWord: 'DELETE' };
  // An unclassified write is treated as live. The opposite default would describe something
  // irreversible to the user as a discardable draft.
  if (approveLiveWrites && tool.surface !== 'gtm_draft') return {};
  return null;
}

/** One line on what this change can and cannot be taken back, for the approval card. */
export function describeReversibility(surface: WriteSurface, isDelete: boolean): string {
  if (surface === 'gtm_draft') {
    return isDelete
      ? 'This happens in a draft workspace, so your live site is unaffected, but nothing here restores it: recovery means rebuilding it by hand or discarding the workspace.'
      : 'This lands in a draft workspace and is not published, so your live site is unaffected until someone publishes it.';
  }
  if (surface === 'ga4_live') {
    return 'GA4 has no draft. This takes effect on the property as soon as it succeeds, and nothing here undoes it.';
  }
  return isDelete
    ? 'This is not workspace-scoped, so there is no draft to discard. It takes effect immediately and nothing here undoes it.'
    : 'This changes the container, version, environment, or permissions directly. There is no draft step, so it takes effect as soon as it succeeds.';
}
