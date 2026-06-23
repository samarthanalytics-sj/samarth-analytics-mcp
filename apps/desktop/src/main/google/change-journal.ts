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

  /** Open a new turn. Called once per chat query before any writes. */
  beginTurn(): void {
    this.turns.push([]);
    if (this.turns.length > this.maxTurns) this.turns.shift();
  }

  /** Record an entity a write just touched (no-op if no turn is open, e.g. non-chat writes). */
  record(ref: ChangeRef): void {
    const cur = this.turns[this.turns.length - 1];
    if (cur) cur.push(ref);
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
      this.turns[this.turns.length - 1] = [];
      return dedupe(last);
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
