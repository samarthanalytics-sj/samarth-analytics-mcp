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
 * Latest-request gate. Each begin() returns a check that stays true only until the next begin(), so a
 * slower response for an earlier pick is dropped instead of overwriting the list (or clearing the
 * loading flag) of the current one.
 */
export class LatestRequest {
  private seq = 0;
  begin(): () => boolean {
    const mine = ++this.seq;
    return () => mine === this.seq;
  }
  /** Drop whatever is in flight without starting a new request: for a selection change that clears
   *  the list itself and loads nothing to replace it (yet). */
  invalidate(): void {
    this.seq += 1;
  }
}

/**
 * Which stored chat thread to switch the view to, or null to stay on the shown one. A streaming reply
 * appends to the shown thread's last assistant message, so while a turn is running the view stays
 * pinned to the thread that asked; a product / container change made mid-turn is applied once the
 * turn has ended (and the finished thread has been saved under its own key).
 */
export function chatThreadToShow(shownKey: string, wantedKey: string, streaming: boolean): string | null {
  return !streaming && shownKey !== wantedKey ? wantedKey : null;
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
