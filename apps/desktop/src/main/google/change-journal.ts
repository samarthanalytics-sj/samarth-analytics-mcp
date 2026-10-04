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
}

class ChangeJournal {
  private turns: ChangeRef[][] = [];
  private readonly maxTurns = 30;
  /** The turn whose async call tree is running. record() files into THIS, not "the newest turn". */
  private readonly current = new AsyncLocalStorage<ChangeRef[]>();

  /** Run one chat query as a turn: open a new turn, then run `fn` with it bound to fn's async call
   *  tree, so every record() made by that query lands in its own turn. Nothing serializes chat turns
   *  (an account switch remounts the chat view while the old turn keeps writing), and with a single
   *  process-wide "current turn" a second query's beginTurn captured the first query's later writes
   *  into its own revert set. */
  runTurn<T>(fn: () => Promise<T>): Promise<T> {
    const turn: ChangeRef[] = [];
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.shift();
    return this.current.run(turn, fn);
  }

  /** Record an entity a write just touched, into the turn that made the write (no-op outside a turn,
   *  e.g. non-chat writes). */
  record(ref: ChangeRef): void {
    this.current.getStore()?.push(ref);
  }

  /** The MOST RECENT turn's writes (deduped), or null if the last query changed nothing.
   *  Targets exactly the previous query so Revert means "undo what I just did". */
  peekLast(): ChangeRef[] | null {
    const last = this.turns[this.turns.length - 1];
    return last && last.length ? dedupe(last) : null;
  }

  /** Take (and clear) the most recent turn's writes, for executing a revert. */
  takeLast(): ChangeRef[] | null {
    const last = this.turns[this.turns.length - 1];
    if (last && last.length) {
      const taken = dedupe(last);
      // Clear IN PLACE: a turn still running holds this same array, so its later writes stay revertable.
      last.length = 0;
      return taken;
    }
    return null;
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
