// Tests for scan rules derived from saved notes. Two properties matter above all: a note this cannot
// parse must change NOTHING (guessing a rename direction silently renames the wrong event), and every
// rule that fires must be reported (a quietly reshaped scan is indistinguishable from a broken one).
// Run: tsx src/shared/__tests__/suggestion-rules.test.ts
import {
  deriveSuggestionRules, applySuggestionRules, describeAppliedRules, distinctiveTerms,
  type RuleMemory, type RuleSuggestion,
} from '../suggestion-rules';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const mem = (text: string, kind = 'rule', enabled = true): RuleMemory => ({ kind, text, enabled });
const sug = (over: Partial<RuleSuggestion> = {}): RuleSuggestion => ({
  id: over.id ?? 's1',
  tagName: over.tagName ?? 'GA4 - Event - Purchase Tag',
  eventName: over.eventName ?? 'purchase',
  label: over.label,
});

// ── Renames: only when the note states its direction ────────────────────────────
for (const [label, text] of [
  ['instead of', 'we use order_completed instead of purchase'],
  ['not', 'use order_completed not purchase'],
  ['comma + never', 'order_completed, never purchase'],
  ['use X for Y', 'we use order_completed for purchase'],
  ['replaces', 'order_completed replaces purchase'],
] as const) {
  const r = deriveSuggestionRules([mem(text)]);
  check(`rename (${label}): parsed with the RIGHT direction`,
    r.renames.length === 1 && r.renames[0].from === 'purchase' && r.renames[0].to === 'order_completed',
    JSON.stringify(r.renames));
}
check('rename: the originating note is kept for the explanation', deriveSuggestionRules([mem('use order_completed instead of purchase')]).renames[0].source.includes('order_completed'));

// ── Fail-closed: ambiguous or unparseable notes must do NOTHING ────────────────
for (const [label, text] of [
  ['bare equals (which side wins?)', 'purchase = order_completed'],
  ['bare arrow', 'purchase -> order_completed'],
  ['prose with no direction', 'the purchase event matters a lot to this client'],
  ['not an event name', 'use the Order Completed page instead of the Purchase page'],
] as const) {
  check(`fail-closed: "${label}" yields no rename`, deriveSuggestionRules([mem(text)]).renames.length === 0);
}
check('fail-closed: a note renaming an event to itself is ignored', deriveSuggestionRules([mem('use purchase instead of purchase')]).renames.length === 0);
check('fail-closed: contradictory notes do not flip the rule (first wins)', (() => {
  const r = deriveSuggestionRules([mem('use order_completed instead of purchase'), mem('use transaction instead of purchase')]);
  return r.renames.length === 1 && r.renames[0].to === 'order_completed';
})());

// ── Which note kinds may steer a scan ───────────────────────────────────────────
check('rule / preference / glossary are honoured', ['rule', 'preference', 'glossary']
  .every((k) => deriveSuggestionRules([mem('use order_completed instead of purchase', k)]).renames.length === 1));
check('a FACT is an observation, not an instruction, so it steers nothing',
  deriveSuggestionRules([mem('use order_completed instead of purchase', 'fact')]).renames.length === 0);
check('a DECISION likewise', deriveSuggestionRules([mem('use order_completed instead of purchase', 'decision')]).renames.length === 0);
check('a muted note is skipped, exactly as the chat skips it',
  deriveSuggestionRules([mem('use order_completed instead of purchase', 'rule', false)]).renames.length === 0);
check('no notes at all is safe', deriveSuggestionRules([]).renames.length === 0 && deriveSuggestionRules([]).suppress.length === 0);

// ── Applying a rename ───────────────────────────────────────────────────────────
{
  const rules = deriveSuggestionRules([mem('we use order_completed instead of purchase')]);
  const a = applySuggestionRules([sug(), sug({ id: 's2', eventName: 'add_to_cart', tagName: 'GA4 - Event - Add To Cart Tag' })], rules);
  check('rename: the event is replaced', a.suggestions[0].eventName === 'order_completed');
  check('rename: the TAG NAME follows, so the row is never named for a different event',
    a.suggestions[0].tagName === 'GA4 - Event - Order Completed Tag', a.suggestions[0].tagName);
  check('rename: unrelated suggestions are untouched', a.suggestions[1].eventName === 'add_to_cart' && a.suggestions.length === 2);
  check('rename: it is reported with the row and the note', a.renamed.length === 1 && a.renamed[0].id === 's1' && !!a.renamed[0].source);
}
check('rename: nothing matching means nothing changes', (() => {
  const rules = deriveSuggestionRules([mem('use order_completed instead of purchase')]);
  const a = applySuggestionRules([sug({ eventName: 'generate_lead', tagName: 'GA4 - Event - Generate Lead Tag' })], rules);
  return a.renamed.length === 0 && a.suggestions.length === 1;
})());

// ── Suppression ─────────────────────────────────────────────────────────────────
{
  const rules = deriveSuggestionRules([mem("don't suggest scroll tracking again")]);
  check('suppress: parsed', rules.suppress.length === 1 && rules.suppress[0].terms.includes('scroll'));
  check('suppress: generic filler is not treated as distinguishing',
    !rules.suppress[0].terms.includes('tracking') && !rules.suppress[0].terms.includes('again'));
  const a = applySuggestionRules([
    sug({ id: 'a', eventName: 'scroll', tagName: 'GA4 - Event - Scroll Tag' }),
    sug({ id: 'b', eventName: 'purchase', tagName: 'GA4 - Event - Purchase Tag' }),
  ], rules);
  check('suppress: the matching row is dropped', a.suggestions.length === 1 && a.suggestions[0].id === 'b');
  check('suppress: the drop is reported with the row and phrase', a.dropped.length === 1 && a.dropped[0].id === 'a' && a.dropped[0].phrase.includes('scroll'));
}
for (const phrasing of ['do not suggest video tracking', 'never propose video tracking', 'stop suggesting video tracking', 'no more video tracking tags']) {
  check(`suppress: "${phrasing}" is understood`, deriveSuggestionRules([mem(phrasing)]).suppress.length === 1);
}
check('suppress: a note that only mentions a topic does NOT suppress it',
  deriveSuggestionRules([mem('scroll tracking is important on the pricing page')]).suppress.length === 0);
check('distinctiveTerms drops filler and short words', (() => {
  const t = distinctiveTerms('scroll tracking tags for this client again');
  return t.includes('scroll') && !t.includes('tags') && !t.includes('for');
})());

// ── Reporting: a rule that fires is never silent ───────────────────────────────
{
  const rules = deriveSuggestionRules([mem('use order_completed instead of purchase'), mem("don't suggest scroll tracking")]);
  const a = applySuggestionRules([
    sug(),
    sug({ id: 'x', eventName: 'scroll', tagName: 'GA4 - Event - Scroll Tag' }),
    sug({ id: 'y', eventName: 'scroll', tagName: 'GA4 - Event - Scroll Depth Tag' }),
  ], rules);
  const lines = describeAppliedRules(a);
  check('report: one line for the rename, one for the grouped drops', lines.length === 2, JSON.stringify(lines));
  check('report: the rename line names both events', lines[0].includes('order_completed') && lines[0].includes('purchase'));
  check('report: the drop line counts them and names the phrase', /2 suggestion\(s\) hidden/.test(lines[1]) && lines[1].includes('scroll'));
  check('report: it says how to undo it', /Settings > Memory/.test(lines[1]));
  check('report: nothing applied means nothing said', describeAppliedRules({ suggestions: [], renamed: [], dropped: [] }).length === 0);
  check('report: no em dashes (house style)', !lines.some((l) => /[—–]/.test(l)));
}

console.log(`\nsuggestion-rules: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
