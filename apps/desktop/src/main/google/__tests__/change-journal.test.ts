/** Change journal (Revert support): last-turn semantics + dedupe + per-turn isolation.
 *  Run: tsx src/main/google/__tests__/change-journal.test.ts */
import { changeJournal, _dedupe, type ChangeRef } from '../change-journal';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean): void => {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}`); }
};
const ref = (id: string, kind: ChangeRef['kind'] = 'tag'): ChangeRef => ({ kind, accountId: '1', containerId: '2', workspaceId: '3', id, label: `t#${id}` });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// The desktop package is CommonJS, so top-level await is unavailable.
async function main(): Promise<void> {
  check('dedupe keeps one entry per kind:id, order preserved', (() => {
    const out = _dedupe([ref('1'), ref('1'), ref('2')]);
    return out.length === 2 && out[0].id === '1' && out[1].id === '2';
  })());

  // A turn that writes 3 refs (one duplicate) → peek/take dedupe to 2.
  await changeJournal.runTurn(async () => {
    changeJournal.record(ref('98'));
    changeJournal.record(ref('100'));
    changeJournal.record(ref('98'));
  });
  check('peekLast dedupes the current turn to 2', changeJournal.peekLast()?.length === 2);
  check('peekLast does not consume', changeJournal.peekLast()?.length === 2);
  const taken = changeJournal.takeLast();
  check('takeLast returns the 2 deduped refs', taken?.length === 2);
  check('after takeLast the turn is empty → peekLast null', changeJournal.peekLast() === null);

  // A read-only turn (no writes) → nothing to revert.
  await changeJournal.runTurn(async () => undefined);
  check('an empty (read-only) turn → peekLast null', changeJournal.peekLast() === null);

  // A later write turn is what peek targets (the PREVIOUS query), not older turns.
  await changeJournal.runTurn(async () => { changeJournal.record(ref('5', 'trigger')); });
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
    const turnA = changeJournal.runTurn(async () => {
      changeJournal.record(ref('a1'));
      await aGate; // turn B starts and writes while A is mid-flight
      changeJournal.record(ref('a2'));
      aBucket = changeJournal.peekLast(); // newest turn is B, so this must NOT be A's
    });
    await tick();
    await changeJournal.runTurn(async () => {
      changeJournal.record(ref('b1'));
      await tick();
    });
    releaseA();
    await turnA;
    const last = changeJournal.peekLast() ?? [];
    check('overlap: the newest turn (B) holds ONLY its own write', last.length === 1 && last[0].id === 'b1');
    check('overlap: A\'s write made after B began did not leak into B', !last.some((r) => r.id === 'a2'));
    check('overlap: peek during A sees the newest turn (B), not a mix', (aBucket as ChangeRef[] | null)?.map((r) => r.id).join(',') === 'b1');
  }

  // A turn still running when its writes are taken keeps journaling into the SAME turn.
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = changeJournal.runTurn(async () => {
      changeJournal.record(ref('r1'));
      await gate;
      changeJournal.record(ref('r2'));
    });
    await tick();
    check('in-flight: takeLast returns what is there so far', changeJournal.takeLast()?.map((r) => r.id).join(',') === 'r1');
    release();
    await running;
    check('in-flight: a write after takeLast is still revertable', changeJournal.peekLast()?.map((r) => r.id).join(',') === 'r2');
  }

  console.log(`\nchange-journal: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
}

void main();
