/**
 * Interactive form discovery — pure helper tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/interactive-forms.node.test.ts
 */
import { formSignature, MAX_INTERACTIVE_CLICKS } from '../interactive-forms.js';
import type { FormAnalysis } from '../../forms.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const form = (over: Partial<FormAnalysis> = {}): FormAnalysis => ({
  index: 0, action: '', method: 'js', formId: '', formClasses: '', title: 'Start your free trial',
  purpose: 'contact', fieldCount: 2,
  fields: [{ type: 'email', name: 'email', label: '', required: true }, { type: 'text', name: 'name', label: '', required: false }],
  piiFields: [], marketingCheckboxes: [], hasConsentCheckbox: false, hasPrivacyLink: false, issues: [],
  ...over,
});

// Same shape → same signature (so a revealed form already in the baseline is deduped, not re-added).
check('formSignature: identical forms share a signature', formSignature(form()) === formSignature(form()));
// Field ORDER must not matter (a re-scan can return fields in a different order).
check('formSignature: field order does not change the signature',
  formSignature(form()) === formSignature(form({ fields: [
    { type: 'text', name: 'name', label: '', required: false }, { type: 'email', name: 'email', label: '', required: true },
  ] })));
// Different purpose / field set → different signature (a genuinely new modal form is kept).
check('formSignature: a different purpose is distinct', formSignature(form()) !== formSignature(form({ purpose: 'newsletter' })));
check('formSignature: a different field set is distinct', formSignature(form()) !== formSignature(form({ fieldCount: 1, fields: [{ type: 'email', name: 'email', label: '', required: true }] })));
check('formSignature: a different title is distinct', formSignature(form()) !== formSignature(form({ title: 'Book a demo' })));
// The click cap is a small, positive bound.
check('MAX_INTERACTIVE_CLICKS is a small positive cap', Number.isInteger(MAX_INTERACTIVE_CLICKS) && MAX_INTERACTIVE_CLICKS > 0 && MAX_INTERACTIVE_CLICKS <= 12, String(MAX_INTERACTIVE_CLICKS));

console.log(`\nInteractive-forms: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
