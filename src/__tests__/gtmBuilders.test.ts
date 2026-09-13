/**
 * The pure GTM builders (src/shared/gtm-builders.ts).
 *
 * The desktop's suite at apps/desktop/src/main/google/__tests__/gtm-builders.test.ts is the broad
 * contract for this code. These cases guard the SILENT failures found in review: a builder that
 * quietly produced a valid-looking resource with the wrong firing behaviour, where the tool then
 * reported success and only the container showed the damage. Each one fails against the old code.
 *
 * Run: tsx src/__tests__/gtmBuilders.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildTrigger, condition, triggerBuiltInVars, type TriggerKind } from '../shared/gtm-builders.js';

/** arg0 (the variable) of every condition in a trigger's filter. */
const filterVars = (t: { filter?: unknown[] }): unknown[] =>
  (t.filter ?? []).map(
    (f) => ((f as { parameter: Array<Record<string, unknown>> }).parameter.find((p) => p.key === 'arg0') ?? {}).value,
  );

test('an off-enum trigger kind throws instead of building an All Pages pageview', () => {
  // Both callers cast an unvalidated string into TriggerKind, so "click" / "form_submission" (the
  // real GTM type names) used to fall through to an UNSCOPED pageview: the tag was created firing on
  // every page load, and the tool reported success naming the trigger the caller asked for.
  for (const kind of ['click', 'form_submission', 'page_view', 'linkClick']) {
    assert.throws(
      () => buildTrigger({ name: 'CTA Click', kind: kind as TriggerKind, clickTextValue: 'Buy now' }),
      /Unknown trigger kind/,
      `kind "${kind}" must be refused, not silently turned into a pageview`,
    );
  }
  // The accepted kinds still build.
  assert.equal(buildTrigger({ name: 'x', kind: 'all_clicks' }).type, 'click');
  assert.equal(buildTrigger({ name: 'x', kind: 'pageview' }).type, 'pageview');
});

test('an unrecognised condition operator throws instead of silently becoming "contains"', () => {
  // 'regex' matched the pattern as literal text (the tag never fired) and the not- spellings that are
  // NOT in OP_TO_CONDITION dropped the negation, firing on exactly what the caller excluded.
  assert.throws(() => condition('{{Click URL}}', 'regex', '\\.(pdf|zip)$'), /Unknown condition operator "regex"/);
  for (const op of ['doesNotContain', 'notEqual', 'does_not_equal']) {
    assert.throws(() => condition('{{Click Text}}', op, 'spam'), /Unknown condition operator/, op);
  }
  // It reaches the caller through buildTrigger rather than producing a wrong trigger.
  assert.throws(
    () => buildTrigger({ name: 'Download', kind: 'link_click', clickUrlValue: '\\.pdf$', clickUrlOperator: 'regex' }),
    /Unknown condition operator/,
  );
  // A blank operator still means "not supplied" (the per-kind defaults live at the call sites).
  assert.equal((condition('{{Click Text}}', '', 'Buy') as { type: string }).type, 'contains');
  // Known operators, negation and ignore_case are untouched.
  const neg = condition('{{Click Text}}', 'notContains', 'spam') as {
    type: string;
    parameter: Array<Record<string, unknown>>;
  };
  assert.equal(neg.type, 'contains');
  assert.equal(neg.parameter.find((p) => p.key === 'negate')?.value, 'true');
  assert.equal((condition('{{Click URL}}', 'matchRegex', 'v') as { type: string }).type, 'matchRegex');
});

test('pageUrlValue scopes click and form_submit triggers instead of being dropped', () => {
  // Page URL was honoured by pageview / dom_ready / visibility / scroll but silently discarded here,
  // so a form trigger asked for one page was created firing on that form site-wide.
  const click = buildTrigger({
    name: 'Apply Click',
    kind: 'link_click',
    clickTextValue: 'Apply',
    pageUrlValue: 'example.com/careers',
  });
  assert.ok(filterVars(click).includes('{{Page URL}}'), 'link_click must AND the {{Page URL}} condition');

  const form = buildTrigger({
    name: 'Contact Form',
    kind: 'form_submit',
    formClassesValue: 'wpcf7-form',
    pageUrlValue: 'example.com/contact',
  });
  assert.ok(filterVars(form).includes('{{Page URL}}'), 'form_submit must AND the {{Page URL}} condition');
  // Default operator is contains, matching every other kind that reads Page URL.
  const cond = (form.filter ?? []).find(
    (f) => (f as { parameter: Array<Record<string, unknown>> }).parameter.some((p) => p.value === 'example.com/contact'),
  ) as { type: string };
  assert.equal(cond.type, 'contains');

  // The built-in must be enabled or the condition reads undefined and the trigger never fires.
  assert.ok(triggerBuiltInVars({ name: 'x', kind: 'all_clicks', pageUrlValue: 'a' }).includes('pageUrl'));
  assert.ok(triggerBuiltInVars({ name: 'x', kind: 'form_submit', pageUrlValue: 'a' }).includes('pageUrl'));
});

test('a pageview scoped by Page Path asks for the pagePath built-in', () => {
  // The pageview branch emits {{Page Path}} contains X, but only pageUrl was returned for enabling,
  // so in a container with the Page Path built-in switched off the trigger never fired.
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'pageview', pagePathValue: '/pricing' }), ['pagePath']);
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'pageview', pageUrlValue: 'q=' }), ['pageUrl']);
  assert.deepEqual(triggerBuiltInVars({ name: 'x', kind: 'pageview', pageUrlValue: 'q=', pagePathValue: '/s' }), [
    'pageUrl',
    'pagePath',
  ]);
});
