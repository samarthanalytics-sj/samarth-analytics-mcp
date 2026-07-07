// Pure tests for the custom_event dataLayer payload builder (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-driver-payload.test.ts
//
// This is the stale-dataLayer RESET logic — the highest-risk new code in the condition-aware push.
// A GTM Data Layer Variable reads the LAST value pushed for its key, so when several tags share one
// `form_submission` event on the same page, a prior tag's `form_name` must NOT leak into a later
// tag's evaluation and falsely credit it. The builder blanks prior keys the current tag isn't setting.

import { buildCustomEventPayload } from '../verify-driver';

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

console.log(`\nverify-driver-payload: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 11) { console.error(`expected >= 11 checks, got ${passed}`); process.exit(1); }
