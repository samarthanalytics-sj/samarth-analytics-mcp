// Pure tests for the custom_event dataLayer payload builder (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-driver-payload.test.ts
//
// This is the stale-dataLayer RESET logic — the highest-risk new code in the condition-aware push.
// A GTM Data Layer Variable reads the LAST value pushed for its key, so when several tags share one
// `form_submission` event on the same page, a prior tag's `form_name` must NOT leak into a later
// tag's evaluation and falsely credit it. The builder blanks prior keys the current tag isn't setting.

import { buildCustomEventPayload, formLocatorFor, formLocatorForSubmit, specForShot, waitForLocate } from '../verify-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── bare event (no data, no prior keys) ──────────────────────────────────────────
{
  const p = buildCustomEventPayload('form_submission', undefined, new Set());
  check('bare push carries the event', p.event === 'form_submission');
  check('bare push has no extra keys', Object.keys(p).length === 1);
}

// ── with this tag's resolved form data ───────────────────────────────────────────
{
  const p = buildCustomEventPayload('form_submission', { form_name: 'Get In Touch' }, new Set());
  check('data key is included with its value', p.form_name === 'Get In Touch');
  check('event still present alongside data', p.event === 'form_submission');
}

// ── a PRIOR key this tag isn't setting is BLANKED (stale-value defense) ───────────
{
  const prior = new Set(['form_name']);
  const p = buildCustomEventPayload('form_submission', { form_id: 'gform_5' }, prior);
  check('prior key not in this data → blanked to ""', p.form_name === '');
  check('this tag\'s own key keeps its value', p.form_id === 'gform_5');
}

// ── a prior key that IS in this tag's data keeps the data value (not blanked) ─────
{
  const prior = new Set(['form_name']);
  const p = buildCustomEventPayload('form_submission', { form_name: 'Contact' }, prior);
  check('prior key present in data → keeps data value, not ""', p.form_name === 'Contact');
}

// ── multiple prior keys, partial overlap ─────────────────────────────────────────
{
  const prior = new Set(['form_name', 'form_id', 'lead_source']);
  const p = buildCustomEventPayload('form_submission', { form_name: 'Sales' }, prior);
  check('overlapping prior key keeps value', p.form_name === 'Sales');
  check('non-overlapping prior key form_id blanked', p.form_id === '');
  check('non-overlapping prior key lead_source blanked', p.lead_source === '');
}

// ── the reset rides in the SAME push as the event (one atomic dataLayer entry) ───
{
  const p = buildCustomEventPayload('form_submission', {}, new Set(['form_name']));
  check('reset + event are one object (no separate reset event)', p.event === 'form_submission' && p.form_name === '');
}

// ── formLocatorFor: which <form> the proof screenshot should ring for a custom-event tag ─────────
// A form tag's proof screenshot must show the RIGHT form (not the top of the page). formLocatorFor
// turns the tag's trigger into { formId?, tokens? } used to locate that form in-page.
{
  // A form-shaped event name → tokens (form/submit/etc. stripped, "get"/"in"/"touch" kept).
  const loc = formLocatorFor({ kind: 'custom_event', eventName: 'get_in_touch_form' });
  check('form event → locator built', loc !== null);
  check('form event tokens strip boilerplate', JSON.stringify(loc?.tokens) === JSON.stringify(['get', 'in', 'touch']));
  check('form event with no form_id has no formId', loc?.formId === undefined);
}
{
  // form_name in customEventData wins over the event name for the tokens.
  const loc = formLocatorFor({ kind: 'custom_event', eventName: 'form_submission', customEventData: { form_name: 'Get In Touch' } });
  check('form_name drives the tokens', JSON.stringify(loc?.tokens) === JSON.stringify(['get', 'in', 'touch']));
}
{
  // An explicit form id is carried through for an exact match.
  const loc = formLocatorFor({ kind: 'custom_event', eventName: 'form_submission', customEventData: { form_id: 'gform_5' } });
  check('form_id carried as formId', loc?.formId === 'gform_5');
}
{
  // A NON-form custom event → null (nothing to ring → no misleading screenshot).
  check('faqs_click (no form) → null locator', formLocatorFor({ kind: 'custom_event', eventName: 'faqs_click' }) === null);
  check('scroll_depth (no form) → null locator', formLocatorFor({ kind: 'custom_event', eventName: 'scroll_depth' }) === null);
}
{
  // An event that is only the word "form" (all tokens are stopwords) still yields a locator via id,
  // but with no usable tokens returns null when there's also no id/name.
  check('bare "form" event with no id/name → null', formLocatorFor({ kind: 'custom_event', eventName: 'form' }) === null);
}

// ── specForShot: build a locate-ONLY DriveSpec from a suggested tag's trigger (suggestion screenshots) ─
{
  // A click tag → clickText carried, always locateOnly (never clicked in the screenshot pass).
  const s = specForShot({ kind: 'link_click', clickTextValue: 'Get a Free Audit', clickTextOperator: 'equals' });
  check('specForShot: locateOnly is always true', s.locateOnly === true);
  check('specForShot: click text + op carried', s.clickText === 'Get a Free Audit' && s.clickTextOp === 'equals');
  check('specForShot: no click, no submit fields leak', s.formId === undefined && s.cssSelector === undefined);
}
{
  // A form tag stores selector-style scopes ("#contact-form" / ".hs-form") — strip the leading #/. .
  const s = specForShot({ kind: 'form_submit', formIdValue: '#contact-form', formClassesValue: '.hs-form' });
  check('specForShot: form id # stripped', s.formId === 'contact-form');
  check('specForShot: form classes . stripped', s.formClasses === 'hs-form');
}
{
  // An FAQ accordion → {{Click Element}} cssSelector: mapped to spec.cssSelector, not clickText.
  const s = specForShot({ kind: 'all_clicks', clickElementValue: '.faq-item .faq-question', clickElementOperator: 'cssSelector' });
  check('specForShot: cssSelector mapped from clickElement', s.cssSelector === '.faq-item .faq-question');
  check('specForShot: cssSelector does not become clickText', s.clickText === undefined);
}
{
  // A click-URL cssSelector (rare) also maps to cssSelector and is NOT re-sent as a clickUrl filter.
  const s = specForShot({ kind: 'all_clicks', clickUrlValue: 'a.download', clickUrlOperator: 'cssSelector' });
  check('specForShot: clickUrl cssSelector → cssSelector', s.cssSelector === 'a.download');
  check('specForShot: clickUrl cssSelector not re-sent as clickUrl', s.clickUrl === undefined);
}

// ── formLocatorForSubmit: locate the <form> for a NATIVE form_submit tag (page-path-scoped, no form id) ─
{
  // A page-scoped consultation form_submit tag: tokens from the GA4 event (get/free/your stripped →
  // cro, consultation) drive the form match; the primary-form fallback in locateFormInPage catches the rest.
  const cro = formLocatorForSubmit({ id: 'cro', eventName: 'get_your_free_cro_consultation_form', trigger: { kind: 'form_submit', pagePathValue: '/services/cro-audits' } as never });
  check('formLocatorForSubmit: tokens from the event name, boilerplate stripped', JSON.stringify(cro.tokens) === JSON.stringify(['cro', 'consultation']));
  check('formLocatorForSubmit: no form id when the trigger has none', cro.formId === undefined);

  // A form_submit tag WITH a {{Form ID}} scope carries it through (leading # stripped).
  const byId = formLocatorForSubmit({ id: 'x', eventName: 'contact_form', trigger: { kind: 'form_submit', formIdValue: '#contact-form' } as never });
  check('formLocatorForSubmit: {{Form ID}} scope carried (# stripped)', byId.formId === 'contact-form');

  // Always returns an object (never null) → locateFormInPage's primary-form fallback always fires, so a
  // form_submit tag with no id/event tokens still gets a proof shot.
  const bare = formLocatorForSubmit({ id: 'b', trigger: { kind: 'form_submit' } as never });
  check('formLocatorForSubmit: never null (always routes to a form locate → primary-form fallback)', typeof bare === 'object' && bare !== null);
}

// ── waitForLocate: poll a pure in-page locate until found (capture immediately), bounded, never hangs ─
// (async — kept off the module top level so the transform stays plain ESM; summary runs in .then).
async function waitForLocateChecks(): Promise<void> {
  type P = Parameters<typeof waitForLocate>[0];
  const makePage = (foundOnCall: number, throwOnCall = -1): { page: P; calls: () => number } => {
    let calls = 0;
    const page = {
      evaluate: async (): Promise<unknown> => {
        calls += 1;
        if (calls === throwOnCall) throw new Error('detached during hydration');
        return { targetFound: calls >= foundOnCall };
      },
      waitForTimeout: async (): Promise<void> => {},
    };
    return { page: page as unknown as P, calls: () => calls };
  };
  const gotFound = (r: unknown): boolean => (r as { targetFound?: boolean }).targetFound === true;

  const p1 = makePage(3); // renders on the 3rd probe
  const r1 = await waitForLocate(p1.page, null, null, gotFound, { tries: 16, intervalMs: 0 });
  check('waitForLocate: returns true and STOPS as soon as found (3 probes)', r1 === true && p1.calls() === 3);

  const p2 = makePage(999); // never renders
  const r2 = await waitForLocate(p2.page, null, null, gotFound, { tries: 5, intervalMs: 0 });
  check('waitForLocate: returns false after `tries`, never hangs', r2 === false && p2.calls() === 5);

  const p3 = makePage(3, 1); // throws on probe 1 (transient), finds on probe 3
  const r3 = await waitForLocate(p3.page, null, null, gotFound, { tries: 16, intervalMs: 0 });
  check('waitForLocate: survives a transient throw and still finds', r3 === true);
}

void waitForLocateChecks().then(() => {
  console.log(`\nverify-driver-payload: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 35) { console.error(`expected >= 35 checks, got ${passed}`); process.exit(1); }
});
