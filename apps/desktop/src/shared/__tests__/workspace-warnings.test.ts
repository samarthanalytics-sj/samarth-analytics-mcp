// Tests for the GTM workspace-lifecycle warnings. The confirm exists because the consequence is
// irreversible (a submitted workspace never comes back), so the wording is treated as a contract:
// it must name the workspace, state the version, state the replacement, and promise nothing false.
// Run: tsx src/shared/__tests__/workspace-warnings.test.ts
import { autoHealConfirmMessage } from '../workspace-warnings';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const msg = autoHealConfirmMessage('Default Workspace');

// ── The four facts the user needs BEFORE clicking ────────────────────────────────
check('names the workspace being consumed', msg.includes('"Default Workspace"'));
check('states that a container VERSION is created', /container version/i.test(msg));
check('states the workspace goes read-only', /read-only/i.test(msg));
check('states GTM replaces it', /replace/i.test(msg));
check('says the drafts carry over (or the warning reads as data loss)', /carry over/i.test(msg));
check('says nothing is published', /nothing is published/i.test(msg));
check('says it repeats per round (one confirm covers the whole loop)', /each heal round/i.test(msg));
check('ends by asking, so a confirm dialog reads correctly', msg.trim().endsWith('Continue?'));

// ── Wording guarantees ───────────────────────────────────────────────────────────
check('no em or en dashes (house style, every output surface)', !/[—–]/.test(msg), msg.match(/[—–].{0,20}/)?.[0]);
check('never claims the workspace is recoverable', !/undo|revert|restore/i.test(msg));
check('never calls it a publish', !/\bpublish(ed|es)?\b/i.test(msg.replace(/nothing is published/i, '')));

// ── Missing/blank name must not produce a dangling quote ────────────────────────
for (const [label, input] of [['undefined', undefined], ['empty', ''], ['whitespace', '   ']] as const) {
  const m = autoHealConfirmMessage(input);
  check(`falls back to a readable phrase when the name is ${label}`, m.includes('the current workspace') && !m.includes('""'), m.split('\n')[0]);
}

// A name with quotes/newlines must not break the layout of a native confirm box.
check('a workspace name is placed inline without breaking the line structure', (() => {
  const m = autoHealConfirmMessage('Weird "Name"');
  return m.split('\n')[0].includes('Weird "Name"') && m.split('\n').length === autoHealConfirmMessage('x').split('\n').length;
})());

console.log(`\nworkspace-warnings: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
