/**
 * Pure guards for renderer state that outlives a selection change. An async result (an audit, a
 * coverage compare, a container / workspace list, a streamed chat reply) must land only in the view
 * of the selection it was requested for, never under the one the user has switched to since.
 * No React / DOM here, so they are unit-testable with tsx.
 */

/** Identity of a GTM working scope: the account / container / workspace ids (names are labels and
 *  are deliberately left out, so a rename is not a scope change). */
export function gtmScopeKey(s?: { accountId?: string; containerId?: string; workspaceId?: string } | null): string {
  return `${s?.accountId ?? ''}/${s?.containerId ?? ''}/${s?.workspaceId ?? ''}`;
}

/**
 * Whether the container audit may (re-)run. A run replaces the report and resets the per-row fix map,
 * and a batch or single-row write still in flight records its result by the OLD report's row index,
 * so a re-run must wait for those to finish.
 */
export function canRunAudit(s: {
  ready: boolean;
  running: boolean;
  applyingAll: boolean;
  fix: Record<number, { state: string } | undefined>;
}): boolean {
  return s.ready && !s.running && !s.applyingAll && !Object.values(s.fix).some((f) => f?.state === 'fixing');
}
