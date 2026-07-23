// Pure tests for GA4 report completeness. The rule that matters: on a truncated report, a missing
// row means "below the cut-off", NOT "no data" - reporting it as zero turns an event that is still
// firing into a critical "stopped firing" alert.
// Run: tsx src/shared/__tests__/ga4-truncation.test.ts
import { reportCompleteness, absenceMeansZero, truncationNote } from '../ga4-truncation';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// -- detecting truncation ---------------------------------------------------------
check('more matched than returned is truncated', reportCompleteness(500, 1200).truncated);
check('equal counts are complete', !reportCompleteness(500, 500).truncated);
check('fewer matched than returned is complete', !reportCompleteness(500, 12).truncated);
check('zero rows and zero matches is complete', !reportCompleteness(0, 0).truncated);
// An empty result is a real answer ("nothing matched"), not an unknown.
check('an empty complete report still permits the zero conclusion', absenceMeansZero(reportCompleteness(0, 0)));

// GA4 sends rowCount as a string in some responses.
check('a numeric string rowCount is read', reportCompleteness(100, '250').truncated);
check('a numeric string that matches is not truncated', !reportCompleteness(100, '100').truncated);
check('matched is normalised to a number', reportCompleteness(10, '99').matched === 99);
check('a fractional rowCount is rounded, not dropped', reportCompleteness(10, 20.4).matched === 20);

// -- absent rowCount ---------------------------------------------------------------
// Claiming truncation we cannot prove would suppress real drop-to-zero findings, which are the
// signal this whole path exists to surface. Unknown resolves to "complete".
for (const [label, v] of [['undefined', undefined], ['null', null], ['NaN', NaN], ['a word', 'lots'], ['negative', -5], ['an object', {}]] as Array<[string, unknown]>) {
  const c = reportCompleteness(100, v);
  check(`rowCount ${label}: matched is null`, c.matched === null);
  check(`rowCount ${label}: not treated as truncated`, !c.truncated);
  check(`rowCount ${label}: absence still means zero`, absenceMeansZero(c));
}

// -- the conclusion gate -----------------------------------------------------------
check('a COMPLETE report permits the zero conclusion', absenceMeansZero(reportCompleteness(50, 50)));
// The whole point of the change.
check('a TRUNCATED report FORBIDS the zero conclusion', !absenceMeansZero(reportCompleteness(500, 900)));
check('one row over the cap is enough to forbid it', !absenceMeansZero(reportCompleteness(500, 501)));

// -- negative row counts -----------------------------------------------------------
check('a negative returned count clamps to zero', reportCompleteness(-3, 5).returned === 0);

// -- the note ----------------------------------------------------------------------
check('a complete report gets no note', truncationNote(reportCompleteness(10, 10), 'event names') === null);
const note = truncationNote(reportCompleteness(500, 1234), 'event names') ?? '';
check('a truncated report gets a note', note.length > 0);
check('the note gives both numbers', note.includes('500') && note.includes('1,234'));
check('the note names what was cut off', note.includes('event names'));
// Without this sentence the reader has no way to know a short list is not a clean bill of health.
check('the note says absence is not "no data"', /not "no data"|means "not in the top/i.test(note), note);
check('no em or en dashes in the note', !/[—–]/.test(note));

if (failures.length) console.error(failures.join('\n'));
console.log(`ga4-truncation: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
