// Pure tests for the raw-forms → fill-plan bridge (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/form-fill-plan.test.ts

import { toFormFillViews, localeOptions } from '../form-fill-plan';
import type { RawForm, RawFormField } from '../../../../../web-audit-mcp/src/agent/forms.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const field = (o: Partial<RawFormField>): RawFormField =>
  ({ tag: 'input', type: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '', required: false, ...o });
const form = (o: Partial<RawForm>): RawForm => {
  const fields = o.fields ?? [];
  return { index: 0, action: '', method: 'post', formId: '', formName: '', formClasses: '', title: '', fieldCount: fields.length, fields, hasPrivacyLink: false, text: '', ...o };
};

// ── a contact form: names + email + category select + textarea + a hidden field ──────────────────
{
  const f = form({
    index: 0, title: 'Get In Touch', action: 'https://site.com/submit', method: 'post',
    fields: [
      field({ type: 'email', name: 'email', label: 'Email', required: true }),
      field({ label: 'First Name', name: 'fname', required: true }),
      field({ label: 'Last Name', name: 'lname' }),
      field({ tag: 'select', type: 'select-one', name: 'topic', label: 'Topic', options: ['Please select', 'Sales', 'Support'] }),
      field({ tag: 'textarea', type: 'textarea', name: 'message', label: 'Message' }),
      field({ type: 'hidden', name: 'csrf' }),
    ],
  });
  const views = toFormFillViews([f], 'https://site.com/contact', 'us', 'run9');
  check('one form in → one form out', views.length === 1);
  const v = views[0];
  const byName = (n: string): (typeof v.fields)[number] | undefined => v.fields.find((x) => x.name === n);
  check('title carried through', v.title === 'Get In Touch');
  check('purpose classified (contact)', v.purpose === 'contact');
  check('hidden field excluded from the plan', !v.fields.some((x) => x.name === 'csrf'));
  check('email filled with the traceable alias', byName('email')?.value === 'gtm-verify+run9@example.com');
  check('first/last names split correctly', byName('fname')?.value === 'Gtm' && byName('lname')?.value === 'Verify');
  check('category select picks first real option + carries options', byName('topic')?.value === 'Sales' && (byName('topic')?.options ?? []).includes('Support'));
  check('required flags carried', byName('email')?.required === true && byName('lname')?.required === false);
  check('selector is name-based', byName('email')?.selector === '[name="email"]');
  check('message got the disclaimer text', /test submission/i.test(byName('message')?.value ?? ''));
}

// ── a form with NO fillable fields (only a hidden control) is dropped ─────────────────────────────
{
  const empty = form({ index: 1, fields: [field({ type: 'hidden', name: 'x' })] });
  check('form with no fillable fields → dropped', toFormFillViews([empty], 'https://site.com', 'us', 't').length === 0);
}

// ── title falls back to formId when there's no heading ───────────────────────────────────────────
{
  const noTitle = form({ index: 2, formId: 'mc-embed', fields: [field({ type: 'email', name: 'EMAIL' })] });
  check('title falls back to formId', toFormFillViews([noTitle], 'https://site.com', 'us', 't')[0].title === 'mc-embed');
}

// ── locale picker + unknown-locale fallback ──────────────────────────────────────────────────────
check('localeOptions includes US', localeOptions().some((l) => l.id === 'us'));
{
  const f = form({ index: 0, fields: [field({ type: 'email', name: 'email' })] });
  check('unknown locale id falls back (still fills)', toFormFillViews([f], 'https://site.com', 'zz', 't')[0].fields[0].value.includes('gtm-verify+'));
}

console.log(`\nform-fill-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 13) { console.error(`expected >= 13 checks, got ${passed}`); process.exit(1); }
