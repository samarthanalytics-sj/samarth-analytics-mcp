// Tests for verification skips derived from saved notes. The invariant: a skip is NOT a pass. A tag
// held back must stay visible, carry the note that caused it, and never be countable as verified.
// Run: tsx src/shared/__tests__/verify-hints.test.ts
import {
  deriveVerifyHints, applyVerifyHints, describeVerifySkip, subjectTerms,
  type HintMemory, type HintTag,
} from '../verify-hints';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const mem = (text: string, over: Partial<HintMemory> = {}): HintMemory =>
  ({ id: over.id ?? 'm1', kind: over.kind ?? 'fact', text, enabled: over.enabled ?? true });
const tag = (over: Partial<HintTag> = {}): HintTag => ({
  id: over.id ?? 't1',
  tagName: over.tagName ?? 'GA4 - Event - Pricing Form Tag',
  eventName: over.eventName,
  page: over.page,
});

// ── The phrasings that state a subject AND a reason ────────────────────────────
for (const [label, text, reason] of [
  ['behind a login', 'the pricing form is behind a login', 'behind a login'],
  ['requires sign-in', 'the pricing form requires an account', 'requires sign-in'],
  ['cannot be tested', 'the pricing form cannot be tested', 'cannot be driven'],
  ['production only', 'the pricing form only works in production', 'production only'],
  ['explicit skip', 'do not verify the pricing form', 'you asked not to verify it'],
] as const) {
  const h = deriveVerifyHints([mem(text)]);
  check(`hint (${label}): parsed with its reason`, h.length === 1 && h[0].reason === reason, JSON.stringify(h));
  check(`hint (${label}): the subject is identified`, h[0]?.terms.includes('pricing'));
}
check('hint: the leading article is dropped from the subject', deriveVerifyHints([mem('the pricing form is behind a login')])[0].subject === 'pricing form');
check('hint: the originating note is kept for the report', !!deriveVerifyHints([mem('the pricing form is behind a login')])[0].source);

// ── Fail-closed ─────────────────────────────────────────────────────────────────
for (const [label, text] of [
  ['a subject with no reason', 'the pricing form is important to this client'],
  ['a reason with no subject', 'some things cannot be tested'],
  ['unrelated prose', 'we launched the pricing page in June'],
] as const) {
  check(`fail-closed: ${label} skips nothing`, deriveVerifyHints([mem(text)]).length === 0);
}
check('fail-closed: a subject of only generic words is refused', deriveVerifyHints([mem('the tag is behind a login')]).length === 0);
check('fail-closed: a muted note is ignored', deriveVerifyHints([mem('the pricing form is behind a login', { enabled: false })]).length === 0);
check('fail-closed: a glossary note does not steer verification', deriveVerifyHints([mem('the pricing form is behind a login', { kind: 'glossary' })]).length === 0);
check('a FACT counts here (it is a fact about the site, and the useful case)',
  deriveVerifyHints([mem('the pricing form is behind a login', { kind: 'fact' })]).length === 1);
check('no notes is safe', deriveVerifyHints([]).length === 0);
check('subjectTerms drops filler', (() => {
  const t = subjectTerms('the pricing form for this site');
  return t.includes('pricing') && !t.includes('form') && !t.includes('site');
})());

// ── Applying ────────────────────────────────────────────────────────────────────
{
  const hints = deriveVerifyHints([mem('the pricing form is behind a login')]);
  const a = applyVerifyHints([tag(), tag({ id: 't2', tagName: 'GA4 - Event - Contact Form Tag' })], hints);
  check('apply: the matching tag is held back', a.tags.length === 1 && a.tags[0].id === 't2');
  check('apply: it is REPORTED, not dropped', a.skipped.length === 1 && a.skipped[0].id === 't1');
  check('apply: the skip carries its reason and note', a.skipped[0].reason === 'behind a login' && !!a.skipped[0].source);
  check('apply: no tag is lost, every input is accounted for',
    a.tags.length + a.skipped.length === 2);
}
check('apply: a hint matches on the page too, not just the name', (() => {
  const hints = deriveVerifyHints([mem('the checkout flow is behind a login')]);
  const a = applyVerifyHints([tag({ id: 'p', tagName: 'GA4 - Event - Purchase Tag', page: '/checkout/step-2' })], hints);
  return a.skipped.length === 1;
})());
check('apply: every distinctive word must match, so one hint does not sweep the site', (() => {
  const hints = deriveVerifyHints([mem('the pricing form is behind a login')]);
  const a = applyVerifyHints([tag({ id: 'x', tagName: 'GA4 - Event - Newsletter Form Tag' })], hints);
  return a.skipped.length === 0 && a.tags.length === 1;
})());
check('apply: no hints leaves the run untouched', applyVerifyHints([tag(), tag({ id: 't2' })], []).tags.length === 2);
check('apply: an empty tag list is safe', applyVerifyHints([], deriveVerifyHints([mem('the pricing form is behind a login')])).tags.length === 0);

// ── A skip is NOT a pass ────────────────────────────────────────────────────────
{
  const line = describeVerifySkip({ reason: 'behind a login', subject: 'pricing form' });
  check('report: says it was never attempted', /not attempted/i.test(line));
  check('report: says explicitly it is NOT a pass', /NOT a pass/.test(line));
  check('report: says nothing is known about whether it fires', /nothing is known/i.test(line));
  check('report: never claims it passed, worked or is fine', !/\b(passed|verified ok|working|fine|healthy)\b/i.test(line));
  check('report: names the note and how to undo it', line.includes('pricing form') && /Settings > Memory/.test(line));
  check('report: no em dashes (house style)', !/[—–]/.test(line));
}

console.log(`\nverify-hints: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
