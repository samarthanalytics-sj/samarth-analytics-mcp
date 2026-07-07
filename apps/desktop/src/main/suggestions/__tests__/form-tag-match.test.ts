// Pure tests for container-tag-driven form matching + field dedup (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/form-tag-match.test.ts

import { matchFormsToTags, dedupeSharedFields, dedupKey, type PagedForm, type FormTagIdentity } from '../form-tag-match';
import type { FormFillFieldView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const fld = (over: Partial<FormFillFieldView>): FormFillFieldView =>
  ({ selector: '', name: '', label: '', type: 'text', role: 'other', required: false, value: '', ...over });
const form = (over: Partial<PagedForm>): PagedForm => ({
  index: 0, page: 'https://site.com/', title: '', formId: '', formClasses: '', action: '', method: 'post', purpose: 'contact', hidden: false, fields: [], ...over,
} as PagedForm);
const tag = (tagName: string, eventName: string, formName?: string): FormTagIdentity => ({ tagName, eventName, platform: 'ga4_event', ...(formName ? { formName } : {}) });

// ── matching by title / tag name / form_name ─────────────────────────────────────
{
  const forms = [
    form({ page: 'https://site.com/contact', title: 'Get In Touch', formId: 'gform_1', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
    form({ page: 'https://site.com/careers', title: 'Apply for Web Analyst', formId: 'gform_2', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
  ];
  const tags = [
    tag('GA4 - Event - Get In Touch Form Tag', 'get_in_touch_form', 'Get In Touch'),
    tag('GA4 - Event - Apply for Web Analyst Form Tag', 'apply_for_web_analyst_form'),
    tag('GA4 - Event - Newsletter Signup Tag', 'newsletter_signup'), // no matching form
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('matches the Get In Touch form to its tag', matched.some((m) => m.formTitle === 'Get In Touch' && m.expectedTags.some((t) => /Get In Touch/.test(t.tagName))));
  check('matches the careers form by tag name', matched.some((m) => m.formTitle === 'Apply for Web Analyst'));
  check('a tag with no matching form → unmatched', unmatchedTags.includes('GA4 - Event - Newsletter Signup Tag'));
  check('only tagged forms are returned (2)', matched.length === 2);
  check('expectedTags carries the event name', matched[0].expectedTags[0].eventName.length > 0);
}

// ── two tags → one form ──────────────────────────────────────────────────────────
{
  const forms = [form({ title: 'Contact us', formId: 'contact', fields: [fld({ name: 'email', role: 'email', selector: '[name="email"]' })] })];
  const tags = [tag('Contact us Form Tag', 'contact_us_form'), tag('Contact us Lead Tag', 'generate_lead', 'Contact us')];
  const { matched } = matchFormsToTags(forms, tags);
  check('one form carries BOTH expected tags', matched.length === 1 && matched[0].expectedTags.length === 2);
}

// ── no match when identities don't overlap ───────────────────────────────────────
{
  const forms = [form({ title: 'Search', formId: 'search', fields: [fld({ name: 'q', role: 'other', selector: '[name="q"]' })] })];
  const { matched, unmatchedTags } = matchFormsToTags(forms, [tag('Pricing Calculator Tag', 'pricing_calc')]);
  check('no overlap → no matched form', matched.length === 0 && unmatchedTags.length === 1);
}

// ── field dedup across TWO matched forms (each its own tag) ──────────────────────
{
  const forms = [
    form({ title: 'Get In Touch', formId: 'a', page: 'https://site.com/contact', fields: [
      fld({ name: 'email', type: 'email', role: 'email', label: 'Email', selector: '[name="email"]', value: 'x@example.com' }),
      fld({ name: 'fname', role: 'given_name', label: 'First Name', selector: '[name="fname"]', value: 'Gtm' }),
    ] }),
    form({ title: 'Book a Demo', formId: 'b', page: 'https://site.com/demo', fields: [
      fld({ name: 'email', type: 'email', role: 'email', label: 'Email address', selector: '[name="email"]', value: 'x@example.com' }),
      fld({ name: 'topic', type: 'select-one', role: 'select', label: 'Topic', selector: '[name="topic"]', value: 'Sales', options: ['Sales', 'Support'] }),
    ] }),
  ];
  const tags = [tag('Get In Touch Form Tag', 'get_in_touch_form', 'Get In Touch'), tag('Book a Demo Form Tag', 'book_a_demo_form', 'Book a Demo')];
  const { matched } = matchFormsToTags(forms, tags);
  check('both forms matched (2)', matched.length === 2);
  const shared = dedupeSharedFields(matched);
  check('email appears ONCE across the two forms', shared.filter((s) => s.role === 'email').length === 1);
  check('given_name kept', shared.some((s) => s.role === 'given_name'));
  check('a select is keyed by role+label (kept distinct)', shared.some((s) => s.key === 'select|topic'));
}

// ── dedupKey ─────────────────────────────────────────────────────────────────────
check('dedupKey: non-select is the role', dedupKey({ role: 'email', label: 'Email' }) === 'email');
check('dedupKey: select is role|label', dedupKey({ role: 'select', label: 'Category' }) === 'select|category');

console.log(`\nform-tag-match: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
