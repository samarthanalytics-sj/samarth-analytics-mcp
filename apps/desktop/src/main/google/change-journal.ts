/**
 * Records which GTM entities each chat turn (one user query) writes to, so the user can
 * REVERT the last query. Revert uses GTM's native per-entity revert (data-service
 * .revertLastChanges), which restores each touched entity to the last PUBLISHED version
 * — undoing the draft change. (A turn = one user message; read-only turns stay empty.)
 *
 * Semantics note: reverting an entity goes to its last published state, so if several
 * unpublished queries touched the SAME entity, revert undoes all of them on that entity,
 * not just the last. For the usual "I just made this change, undo it" flow that's the
 * expected result. Deletes are not journaled (they need a second confirmation to run).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type EntityKind = 'tag' | 'trigger' | 'variable';

export interface ChangeRef {
  kind: EntityKind;
  accountId: string;
  containerId: string;
  workspaceId: string;
  id: string;
  /** Human label for the confirmation/result, e.g. "GA4 Event - Email Click Tag (#98)". */
  label: string;
  /** The desktop (Google) account whose token made the write: the turn's pinned account. A revert
   *  must authenticate as THIS identity, not whichever account happens to be active when Revert is
   *  pressed (after an account switch that token may not even reach the container). */
  desktopAccountId: string;
}

/** The outcome of reverting one turn. Failed refs are back in the journal, so Revert can be retried. */
export interface RevertOutcome {
  reverted: ChangeRef[];
  failed: Array<{ ref: ChangeRef; error: string }>;
}

class ChangeJournal {
  private turns: ChangeRef[][] = [];
  private readonly maxTurns = 30;
  /** The turn whose async call tree is running. record() files into THIS, not "the newest turn". */
  private readonly current = new AsyncLocalStorage<{ refs: ChangeRef[]; desktopAccountId: string }>();

  /** Run one chat query as a turn: open a new turn, then run `fn` with it bound to fn's async call
   *  tree, so every record() made by that query lands in its own turn. Nothing serializes chat turns
   *  (an account switch remounts the chat view while the old turn keeps writing), and with a single
   *  process-wide "current turn" a second query's beginTurn captured the first query's later writes
   *  into its own revert set. `desktopAccountId` is the account the turn is pinned to (its tool calls
   *  refuse to run once the active account changes), stamped on every ref it records. */
  runTurn<T>(desktopAccountId: string, fn: () => Promise<T>): Promise<T> {
    const turn: ChangeRef[] = [];
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.shift();
    return this.current.run({ refs: turn, desktopAccountId }, fn);
  }

  /** Record an entity a write just touched, into the turn that made the write (no-op outside a turn,
   *  e.g. non-chat writes), stamped with that turn's desktop account. */
  record(ref: Omit<ChangeRef, 'desktopAccountId'>): void {
    const cur = this.current.getStore();
    if (cur) cur.refs.push({ ...ref, desktopAccountId: cur.desktopAccountId });
  }

  /** The MOST RECENT turn's writes (deduped), or null if the last query changed nothing.
   *  Targets exactly the previous query so Revert means "undo what I just did". */
  peekLast(): ChangeRef[] | null {
    const last = this.turns[this.turns.length - 1];
    return last && last.length ? dedupe(last) : null;
  }

  /** Revert the most recent turn's writes with `revertOne`, keeping every ref that did NOT revert.
   *  The turn used to be consumed up front (takeLast), so one transient error (a 5xx, a quota blip)
   *  lost that entity's undo for good. Now the refs are claimed for the duration (so a double-clicked
   *  Revert cannot run the same reverts twice) and the failures are handed back to the same turn,
   *  where peekLast shows them again and Revert can be retried. Cleared IN PLACE: a turn still running
   *  holds this same array, so its later writes stay revertable. */
  async revertLast(revertOne: (ref: ChangeRef) => Promise<void>): Promise<RevertOutcome> {
    const last = this.turns[this.turns.length - 1];
    if (!last || !last.length) return { reverted: [], failed: [] };
    const refs = dedupe(last.splice(0));
    const reverted: ChangeRef[] = [];
    const failed: RevertOutcome['failed'] = [];
    for (const r of refs) {
      try {
        await revertOne(r);
        reverted.push(r);
      } catch (e) {
        failed.push({ ref: r, error: e instanceof Error ? e.message : String(e) });
      }
    }
    last.push(...failed.map((f) => f.ref));
    return { reverted, failed };
  }
}

/** One revert per entity even if a turn touched it more than once. PURE. */
function dedupe(refs: ChangeRef[]): ChangeRef[] {
  const seen = new Set<string>();
  const out: ChangeRef[] = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

export const changeJournal = new ChangeJournal();
export const _dedupe = dedupe; // exported for tests
