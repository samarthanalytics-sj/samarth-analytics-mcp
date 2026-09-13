// Pure tests for long-task completion notifications: when one fires, and what it says.
// Run: tsx src/shared/__tests__/task-notification.test.ts
import { MIN_NOTIFY_MS, shouldNotify, formatDuration, notificationText, type TaskResultSummary } from '../task-notification';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const base: TaskResultSummary = {
  task: 'Tag suggestion scan',
  outcome: 'completed',
  elapsedMs: 4 * 60_000,
  done: 250,
  total: 250,
  found: 18,
  foundLabel: 'tag',
};

// -- when it fires ---------------------------------------------------------------
check('a long scan finishing while you are away notifies', shouldNotify(base, false));
// The whole point: do not interrupt someone who is already looking at the answer.
check('NOT while the window is focused', !shouldNotify(base, true));
check('NOT for work that finished before you could leave', !shouldNotify({ ...base, elapsedMs: 3_000 }, false));
check('exactly at the threshold notifies', shouldNotify({ ...base, elapsedMs: MIN_NOTIFY_MS }, false));
check('just under the threshold does not', !shouldNotify({ ...base, elapsedMs: MIN_NOTIFY_MS - 1 }, false));
// A fast failure is the case where you are about to sit waiting for nothing.
check('a FAST failure still notifies', shouldNotify({ ...base, outcome: 'failed', elapsedMs: 1_500, error: 'DNS lookup failed' }, false));
check('a failure while focused still does NOT notify', !shouldNotify({ ...base, outcome: 'failed', elapsedMs: 1_500 }, true));
check('a stopped run follows the same duration rule', shouldNotify({ ...base, outcome: 'stopped', elapsedMs: 60_000 }, false) && !shouldNotify({ ...base, outcome: 'stopped', elapsedMs: 900 }, false));

// -- duration ---------------------------------------------------------------------
check('seconds under a minute', formatDuration(45_000) === '45s');
check('whole minutes drop the seconds', formatDuration(120_000) === '2m');
check('minutes and seconds', formatDuration(252_000) === '4m 12s');
check('zero is 0s, never blank', formatDuration(0) === '0s');
check('negative clamps rather than printing a minus', formatDuration(-5_000) === '0s');
check('rounds to the nearest second', formatDuration(1_600) === '2s');

// -- what it says: completed ------------------------------------------------------
const done = notificationText(base);
check('completed title says complete', done.title === 'Tag suggestion scan complete');
check('completed body has the page count', done.body.includes('250 pages'));
check('completed body has what was found', done.body.includes('18 tags'));
check('completed body has the duration', done.body.includes('4m'));

// Nothing found is a real outcome. "250 pages scanned" alone reads as a win at a glance.
const empty = notificationText({ ...base, found: 0 });
check('zero found SAYS zero, not just a page count', /no tags found/.test(empty.body), empty.body);
check('zero found is still titled complete', empty.title.endsWith('complete'));

// -- what it says: stopped --------------------------------------------------------
const stopped = notificationText({ ...base, outcome: 'stopped', done: 42, total: 250, found: 6 });
check('stopped title says stopped, not complete', stopped.title === 'Tag suggestion scan stopped');
check('stopped body shows how far it got', stopped.body.includes('42 of 250 pages'), stopped.body);
check('stopped body says the result is partial', /only what was read/i.test(stopped.body));
check('stopped body still reports what was found', stopped.body.includes('6 tags'));
// A stopped run with no total known must still say something honest.
check('stopped with no total still reports progress', notificationText({ ...base, outcome: 'stopped', total: undefined, done: 9 }).body.includes('9 pages'));

// -- what it says: failed ---------------------------------------------------------
const failedText = notificationText({ ...base, outcome: 'failed', elapsedMs: 8_000, error: 'DNS lookup failed' });
check('failed title says failed', failedText.title === 'Tag suggestion scan failed');
check('failed body carries the real reason', failedText.body.includes('DNS lookup failed'));
check('failed body still gives the elapsed time', failedText.body.includes('8s'));
check('failed with no reason still says something', notificationText({ ...base, outcome: 'failed', error: undefined }).body.length > 0);
// A failure must never be dressed up as a result.
check('a failure never claims a page count', !/\d+ pages/.test(failedText.body), failedText.body);

// -- pluralisation ----------------------------------------------------------------
check('one page is singular', notificationText({ ...base, done: 1, found: 1 }).body.includes('1 page ·'));
check('one tag is singular', notificationText({ ...base, done: 1, found: 1 }).body.includes('1 tag'));
check('counts are thousands-separated', notificationText({ ...base, done: 1250 }).body.includes('1,250'));

// -- house style ------------------------------------------------------------------
const ALL = [done, empty, stopped, failedText].flatMap((t) => [t.title, t.body]).join(' ');
check('no em or en dashes in any notification text', !/[—–]/.test(ALL), ALL.match(/.{0,25}[—–].{0,25}/)?.[0]);
check('every outcome produces a non-empty title and body',
  (['completed', 'stopped', 'failed'] as const).every((o) => {
    const t = notificationText({ ...base, outcome: o });
    return t.title.trim().length > 0 && t.body.trim().length > 0;
  }));

if (failures.length) console.error(failures.join('\n'));
console.log(`task-notification: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
