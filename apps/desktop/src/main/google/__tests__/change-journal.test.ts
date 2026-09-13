/** Change journal (Revert support): last-turn semantics + dedupe.
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

check('dedupe keeps one entry per kind:id, order preserved', (() => {
  const out = _dedupe([ref('1'), ref('1'), ref('2')]);
  return out.length === 2 && out[0].id === '1' && out[1].id === '2';
})());

// A turn that writes 3 refs (one duplicate) → peek/take dedupe to 2.
changeJournal.beginTurn();
changeJournal.record(ref('98'));
changeJournal.record(ref('100'));
changeJournal.record(ref('98'));
check('peekLast dedupes the current turn to 2', changeJournal.peekLast()?.length === 2);
check('peekLast does not consume', changeJournal.peekLast()?.length === 2);
const taken = changeJournal.takeLast();
check('takeLast returns the 2 deduped refs', taken?.length === 2);
check('after takeLast the turn is empty → peekLast null', changeJournal.peekLast() === null);

// A read-only turn (no writes) → nothing to revert.
changeJournal.beginTurn();
check('an empty (read-only) turn → peekLast null', changeJournal.peekLast() === null);

// A later write turn is what peek targets (the PREVIOUS query), not older turns.
changeJournal.beginTurn();
changeJournal.record(ref('5', 'trigger'));
check('peekLast targets the most recent turn only', changeJournal.peekLast()?.length === 1 && changeJournal.peekLast()?.[0].kind === 'trigger');

console.log(`\nchange-journal: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
