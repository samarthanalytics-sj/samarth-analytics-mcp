/** Change journal (Revert support): last-turn semantics + dedupe + per-turn isolation + retryable,
 *  identity-correct revert. Run: tsx src/main/google/__tests__/change-journal.test.ts */
import { changeJournal, _dedupe, type ChangeRef } from '../change-journal';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean): void => {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}`); }
};
const ref = (id: string, kind: ChangeRef['kind'] = 'tag'): ChangeRef => ({ kind, accountId: '1', containerId: '2', workspaceId: '3', id, label: `t#${id}`, desktopAccountId: 'acct-1' });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const revertAll = async (): Promise<void> => undefined;
const ids = (refs: ChangeRef[] | null | undefined): string => (refs ?? []).map((r) => r.id).join(',');

// The desktop package is CommonJS, so top-level await is unavailable.
async function main(): Promise<void> {
  check('dedupe keeps one entry per kind:id, order preserved', (() => {
    const out = _dedupe([ref('1'), ref('1'), ref('2')]);
    return out.length === 2 && out[0].id === '1' && out[1].id === '2';
  })());

  // A turn that writes 3 refs (one duplicate) → peek/revert dedupe to 2.
  await changeJournal.runTurn('acct-1', async () => {
    changeJournal.record(ref('98'));
    changeJournal.record(ref('100'));
    changeJournal.record(ref('98'));
  });
  check('peekLast dedupes the current turn to 2', changeJournal.peekLast()?.length === 2);
  check('peekLast does not consume', changeJournal.peekLast()?.length === 2);
  const all = await changeJournal.revertLast(revertAll);
  check('revertLast reverts the 2 deduped refs', all.reverted.length === 2 && all.failed.length === 0);
  check('after a fully successful revert the turn is empty → peekLast null', changeJournal.peekLast() === null);

  // A read-only turn (no writes) → nothing to revert.
  await changeJournal.runTurn('acct-1', async () => undefined);
  check('an empty (read-only) turn → peekLast null', changeJournal.peekLast() === null);

  // A later write turn is what peek targets (the PREVIOUS query), not older turns.
  await changeJournal.runTurn('acct-1', async () => { changeJournal.record(ref('5', 'trigger')); });
  check('peekLast targets the most recent turn only', changeJournal.peekLast()?.length === 1 && changeJournal.peekLast()?.[0].kind === 'trigger');

  // A write made OUTSIDE any chat turn (e.g. a UI action) is not journaled into the last turn.
  changeJournal.record(ref('ui-1'));
  check('record() outside a turn is a no-op', changeJournal.peekLast()?.length === 1 && changeJournal.peekLast()?.[0].id === '5');

  // Regression: two OVERLAPPING turns. Nothing serializes chat turns (an account switch remounts the
  // chat view while the old turn keeps running), and with one process-wide "current turn" turn B's
  // beginTurn made turn A's later writes land in B's revert set.
  {
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => { releaseA = r; });
    let aBucket: ChangeRef[] | null = null;
    const turnA = changeJournal.runTurn('acct-A', async () => {
      changeJournal.record(ref('a1'));
      await aGate; // turn B starts and writes while A is mid-flight
      changeJournal.record(ref('a2'));
      aBucket = changeJournal.peekLast(); // newest turn is B, so this must NOT be A's
    });
    await tick();
    await changeJournal.runTurn('acct-B', async () => {
      changeJournal.record(ref('b1'));
      await tick();
    });
    releaseA();
    await turnA;
    const last = changeJournal.peekLast() ?? [];
    check('overlap: the newest turn (B) holds ONLY its own write', last.length === 1 && last[0].id === 'b1');
    check('overlap: A\'s write made after B began did not leak into B', !last.some((r) => r.id === 'a2'));
    check('overlap: peek during A sees the newest turn (B), not a mix', ids(aBucket as ChangeRef[] | null) === 'b1');
    check('overlap: each ref carries ITS turn\'s desktop account', last[0].desktopAccountId === 'acct-B');
  }

  // A turn still running when its writes are reverted keeps journaling into the SAME turn.
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = changeJournal.runTurn('acct-1', async () => {
      changeJournal.record(ref('r1'));
      await gate;
      changeJournal.record(ref('r2'));
    });
    await tick();
    check('in-flight: revertLast reverts what is there so far', ids((await changeJournal.revertLast(revertAll)).reverted) === 'r1');
    release();
    await running;
    check('in-flight: a write after the revert is still revertable', ids(changeJournal.peekLast()) === 'r2');
  }

  // Regression: revert consumed the turn BEFORE any revert ran, so one transient error lost that
  // entity's undo for good. A failed ref now stays in the journal and a second Revert retries it.
  {
    await changeJournal.runTurn('acct-1', async () => {
      changeJournal.record(ref('ok-1'));
      changeJournal.record(ref('flaky', 'trigger'));
      changeJournal.record(ref('ok-2', 'variable'));
    });
    let flakyFails = true;
    const first = await changeJournal.revertLast(async (r) => {
      if (r.id === 'flaky' && flakyFails) throw new Error('503 backend error');
    });
    check('partial: the others revert', ids(first.reverted) === 'ok-1,ok-2');
    check('partial: the failure is reported with its error', first.failed.length === 1 && first.failed[0].ref.id === 'flaky' && /503/.test(first.failed[0].error));
    check('partial: ONLY the failed ref is left to revert', ids(changeJournal.peekLast()) === 'flaky');
    flakyFails = false;
    const retry = await changeJournal.revertLast(revertAll);
    check('partial: Revert again retries just the failed ref', ids(retry.reverted) === 'flaky' && retry.failed.length === 0);
    check('partial: nothing left after the retry succeeds', changeJournal.peekLast() === null);
  }

  // A double-clicked Revert must not run the same reverts twice.
  {
    await changeJournal.runTurn('acct-1', async () => { changeJournal.record(ref('once')); });
    let calls = 0;
    const slow = async (): Promise<void> => { calls += 1; await tick(); };
    const [x, y] = await Promise.all([changeJournal.revertLast(slow), changeJournal.revertLast(slow)]);
    check('double revert: each entity is reverted exactly once', calls === 1 && x.reverted.length + y.reverted.length === 1);
  }

  // End to end through GoogleDataService.revertLastChanges, with GTM answered by a fake auth client
  // (googleapis sends every request through auth.request). Regression: revert authenticated as the
  // ACTIVE account, so after an account switch it ran under the wrong Google identity.
  {
    const { GoogleDataService } = await import('../data-service');
    type Ctor = ConstructorParameters<typeof GoogleDataService>;
    const calls: Array<{ account: string; url: string }> = [];
    let triggerFails = true;
    const fakeAuth = (account: string): unknown => ({
      request: async (opts: { url?: unknown }) => {
        const url = String(opts.url);
        calls.push({ account, url });
        if (triggerFails && /triggers\/7:revert/.test(url)) throw new Error('Backend Error (503)');
        return { data: {}, status: 200, headers: {}, config: opts };
      },
    });
    const svc = new GoogleDataService(
      { getActiveView: () => ({ id: 'acct-B', email: 'b@x.com', hasGoogleToken: true }) } as unknown as Ctor[0],
      { getClient: (id: string) => fakeAuth(id) } as unknown as Ctor[1],
    );
    // The writes were made in a turn pinned to acct-A; the user has since switched to acct-B.
    await changeJournal.runTurn('acct-A', async () => {
      changeJournal.record({ kind: 'tag', accountId: '1', containerId: '2', workspaceId: '3', id: '6', label: 'Tag 6' });
      changeJournal.record({ kind: 'trigger', accountId: '1', containerId: '2', workspaceId: '3', id: '7', label: 'Trigger 7' });
    });
    const first = await svc.revertLastChanges();
    check('service: the healthy entity reverts, the 503 one is reported failed',
      first.reverted.join('|') === 'Tag 6' && first.failed.map((f) => f.label).join('|') === 'Trigger 7');
    check('service: every revert call authenticated as the account that MADE the change (acct-A), not the active one',
      calls.length === 2 && calls.every((c) => c.account === 'acct-A'));
    check('service: revert hits the GTM per-entity revert path', calls.some((c) => /workspaces\/3\/tags\/6:revert/.test(c.url)));
    const left = svc.peekLastChanges();
    check('service: the failed entity is still offered for Revert', left.count === 1 && left.labels[0] === 'Trigger 7');
    triggerFails = false;
    const retry = await svc.revertLastChanges();
    check('service: retrying Revert reverts the remaining entity', retry.reverted.join('|') === 'Trigger 7' && retry.failed.length === 0);
    check('service: nothing left afterwards', svc.peekLastChanges().count === 0);
  }

  console.log(`\nchange-journal: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
}

void main();
