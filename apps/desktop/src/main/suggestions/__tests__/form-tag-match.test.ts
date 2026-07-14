// Pure tests for container-tag-driven form matching + field dedup (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/form-tag-match.test.ts

import { matchFormsToTags, dedupeSharedFields, dedupKey, isFormEventName, type PagedForm, type FormTagIdentity } from '../form-tag-match';
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

// ── CORE-NAME ↔ TITLE match rescues generic tags the token gate can't ────────────────────
{
  // Every form shares the "solution_contact_form" id (so "contact" is NON-distinctive), and these tags
  // tokenize to empty ("Get a Free Consultation") or a lone generic word — only tag NAME == form TITLE saves
  // them. Site-wide form_submission tags (no page scope), so page-path pairing can't help either.
  const forms = [
    form({ page: 'https://site.com/a', title: 'Get a Free Consultation', formId: 'solution_contact_form', fields: [fld({ role: 'email', type: 'email' })] }),
    form({ page: 'https://site.com/', title: 'Stay Updated', formId: 'solution_contact_form', fields: [fld({ role: 'email', type: 'email' })] }),
    form({ page: 'https://site.com/services/x', title: 'Get a Free Analytics Consultation', formId: 'solution_contact_form', fields: [fld({ role: 'email', type: 'email' })] }),
  ];
  const tags = [
    tag('GA4 - Event - Get a Free Consultation Form Tag', 'form_submission'), // tokens → empty
    tag('GA4 - Event - Stay Updated Form Tag', 'form_submission'),            // tokens → {stay, updated}
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('core-name: an all-STOP-word tag matches the form whose title IS its core name', matched.some((m) => m.formTitle === 'Get a Free Consultation' && m.expectedTags.some((t) => /Get a Free Consultation/.test(t.tagName))));
  check('core-name: "Stay Updated" tag matches the "Stay Updated" form', matched.some((m) => m.formTitle === 'Stay Updated' && m.expectedTags.some((t) => /Stay Updated/.test(t.tagName))));
  check('core-name: does NOT mis-pair "Get a Free Consultation" onto the longer "…Analytics Consultation" form', !matched.some((m) => m.formTitle === 'Get a Free Analytics Consultation' && m.expectedTags.some((t) => /Get a Free Consultation Form Tag/.test(t.tagName))));
  check('core-name: both generic tags matched (none unmatched)', unmatchedTags.length === 0);
}

// ── core-name must NOT over-match when no form title matches ──────────────────────────────
{
  const forms = [form({ page: 'https://site.com/x', title: 'Newsletter', formId: 'nl', fields: [fld({ role: 'email', type: 'email' })] })];
  const tags = [tag('GA4 - Event - Apply for Web Analyst Form Tag', 'form_submission')];
  const { unmatchedTags } = matchFormsToTags(forms, tags);
  check('core-name: no title match → tag stays unmatched (no false positive)', unmatchedTags.includes('GA4 - Event - Apply for Web Analyst Form Tag'));
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

// ── over-matching guard: a single shared GENERIC token must NOT pile every tag onto one form ──────
// The real bug: a site exposes ONE "Get Your Free Custom Consultation" form, but ~18 "Get Your Free X
// Consultation Form" tags all shared the generic token "consultation" and got attached to it — 17 then
// falsely reported "not firing". Full-coverage matching keeps only the tag whose form name is covered.
{
  const forms = [form({ title: 'Get Your Free Custom Consultation', formId: 'wf-form-custom', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] })];
  const tags = [
    tag('Meta - Event - Get Your Free Custom Consultation Form Tag', 'get_your_free_custom_consultation_form', 'get_your_free_custom_consultation'),
    tag('Meta - Event - Get Your Free CRO Consultation Form Tag', 'get_your_free_cro_consultation_form', 'get_your_free_cro_consultation'),
    tag('Meta - Event - Get Your Free GTM Audit Form Tag', 'get_your_free_gtm_audit_form', 'get_your_free_gtm_audit'),
    tag('Meta - Event - Stay Updated Form Tag', 'stay_updated_form', 'stay_updated'),
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('over-match: only the Custom Consultation tag matches the Custom Consultation form', matched.length === 1 && matched[0].expectedTags.length === 1 && /Custom Consultation/.test(matched[0].expectedTags[0].tagName));
  check('over-match: CRO/GTM/Stay tags are unmatched (their forms were not found), not piled on', unmatchedTags.length === 3 && unmatchedTags.some((n) => /CRO/.test(n)) && unmatchedTags.some((n) => /GTM Audit/.test(n)) && unmatchedTags.some((n) => /Stay Updated/.test(n)));
}

// ── page path disambiguates near-identical service forms ─────────────────────────────────────────
// A bare "Get a Free Audit" form on /services/cro-audits carries {cro, audits} from its URL, so the CRO
// tag matches it where the visible title alone (just "audit") would not. The Store Audit tag (a different
// service, not in this page/title) correctly stays unmatched.
{
  const forms = [form({ title: 'Get a Free Audit', formId: 'af', page: 'https://site.com/services/cro-audits', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] })];
  const tags = [
    tag('Meta - Event - CRO Audit Form Tag', 'cro_audit_form', 'cro_audit'),
    tag('Meta - Event - Store Audit Form Tag', 'store_audit_form', 'store_audit'),
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('page path: CRO tag matches the audit form on /services/cro-audits', matched.length === 1 && matched[0].expectedTags.length === 1 && /CRO/.test(matched[0].expectedTags[0].tagName));
  check('page path: a different-service (Store) tag stays unmatched', unmatchedTags.some((n) => /Store/.test(n)));
}

// ── partial-but-strong match: a MAJORITY of tokens (not all) is now enough ────────────────────────
// The over-strict full-coverage rule dropped a "Server Side Tracking Consultation" tag whose form on
// /services/server-side-tracking has a generic title ("Get Started") and shares {server,side,tracking}
// (3 of 4 tokens; "consultation" absent). >=60% + >=2 tokens → a confident match, no longer a false gap.
{
  const forms = [form({ title: 'Get Started', formId: 'sf', page: 'https://site.com/services/server-side-tracking', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] })];
  const tags = [tag('GA4 - Event - Server Side Tracking Consultation Form Tag', 'server_side_tracking_consultation_form', 'server_side_tracking_consultation')];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('partial-strong: 3-of-4-token tag matches its page form', matched.length === 1 && /Server Side Tracking/.test(matched[0].expectedTags[0].tagName));
  check('partial-strong: not left unmatched', unmatchedTags.length === 0);
}
// ── generic OFFER words ("consultation"/"audit") don't block the service token from matching ──────────
// The real "37 forms with no matching form": tags named "Get Your Free <service> Consultation Form Tag"
// vs generic on-page forms. "consultation"/"audit" are stop-words, so the SERVICE token carries the match.
{
  const forms = [
    form({ title: 'Get Started', formId: 'f1', page: 'https://site.com/services/ga4-implementation', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
    form({ title: 'Get Started', formId: 'f2', page: 'https://site.com/services/conversion-tracking', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
  ];
  const tags = [
    tag('GA4 - Event - Get Your Free GA4 Implementation Consultation Form Tag', 'get_your_free_ga4_implementation_consultation_form', 'get_your_free_ga4_implementation_consultation'),
    tag('GA4 - Event - Get Your Free Conversion Tracking Consultation Form Tag', 'get_your_free_conversion_tracking_consultation_form', 'get_your_free_conversion_tracking_consultation'),
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('consultation tag matches its service-page form (implementation)', matched.some((m) => /ga4-implementation/.test(m.page) && m.expectedTags.some((t) => /Implementation/.test(t.tagName))));
  check('consultation tag matches its service-page form (conversion)', matched.some((m) => /conversion-tracking/.test(m.page) && m.expectedTags.some((t) => /Conversion/.test(t.tagName))));
  check('each consultation tag matched (none left unmatched)', unmatchedTags.length === 0);
  // ...and they do NOT cross-match onto the wrong service page.
  check('implementation tag not on the conversion form', !matched.some((m) => /conversion-tracking/.test(m.page) && m.expectedTags.some((t) => /Implementation/.test(t.tagName))));
}

// ── a GENERIC/shared form_name condition doesn't hide the service token in the tag NAME ─────────────
// Real site: every /services/* page has a DOM-identical ANONYMOUS form (no id/name/title), and the tags
// all condition on ONE shared form_name ("solution_contact_form"). The only distinguishing token lives in
// the tag NAME + the page path — so multi-identity matching (form_name → tag name → event) must pair them.
{
  const forms = [
    form({ title: '', formId: '', page: 'https://site.com/services/ga4-implementation', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
    form({ title: '', formId: '', page: 'https://site.com/services/conversion-tracking', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
  ];
  const tags = [
    tag('GA4 - Event - Get Your Free GA4 Implementation Consultation Form Tag', 'form_submission', 'solution_contact_form'),
    tag('GA4 - Event - Get Your Free Conversion Tracking Consultation Form Tag', 'form_submission', 'solution_contact_form'),
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('generic form_name: implementation tag still pairs to its service-page form', matched.some((m) => /ga4-implementation/.test(m.page) && m.expectedTags.some((t) => /Implementation/.test(t.tagName))));
  check('generic form_name: conversion tag pairs to its service-page form', matched.some((m) => /conversion-tracking/.test(m.page) && m.expectedTags.some((t) => /Conversion/.test(t.tagName))));
  check('generic form_name: none left unmatched', unmatchedTags.length === 0);
}

// A single shared token is STILL not enough for a multi-token tag (pile-on regression guard).
{
  const forms = [form({ title: 'Get Started', formId: 'sf', page: 'https://site.com/services/server-side-tracking', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] })];
  const tags = [tag('GA4 - Event - Ecommerce Analytics Tracking Form Tag', 'ecommerce_analytics_tracking_form', 'ecommerce_analytics_tracking')];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('one-of-three shared token → unmatched (no pile-on)', matched.length === 0 && unmatchedTags.length === 1);
}

// ── page-path SCOPE pairing: a page-scoped tag pairs deterministically, regardless of names ─────────
// A generic "Contact us Form Tag" scoped (Page Path condition) to /contact pairs with the /contact form
// even when the form's title/name share no distinctive token — {contact} alone is too common to pass the
// distinctiveness gate, but the page scope is unambiguous. It must NOT stray to an off-path form.
{
  const forms = [
    form({ title: '', formId: '', page: 'https://site.com/contact', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
    form({ title: 'Newsletter', formId: 'nl', page: 'https://site.com/blog', fields: [fld({ name: 'email', type: 'email', role: 'email', selector: '[name="email"]' })] }),
  ];
  const tags: FormTagIdentity[] = [
    { tagName: 'GA4 - Event - Contact us Form Tag', eventName: 'form_submission', platform: 'ga4_event', page: '/contact' },
  ];
  const { matched, unmatchedTags } = matchFormsToTags(forms, tags);
  check('page-scope: a /contact-scoped tag pairs with the /contact form (no token help)', matched.some((m) => /\/contact$/.test(m.page) && m.expectedTags.some((t) => /Contact us/.test(t.tagName))));
  check('page-scope: it is NOT left unmatched', unmatchedTags.length === 0);
  check('page-scope: it does NOT pair with the off-path /blog form', !matched.some((m) => /\/blog$/.test(m.page)));
}

// ── isFormEventName: only true form-submit custom events count as form tags ───────────────────────
check('isFormEventName: form_submission → true', isFormEventName('form_submission'));
check('isFormEventName: submit_form → true', isFormEventName('submit_form'));
check('isFormEventName: custom_scroll_depth → false', !isFormEventName('custom_scroll_depth'));
check('isFormEventName: cta_click → false', !isFormEventName('cta_click'));
check('isFormEventName: platform_view (contains "form") → false', !isFormEventName('platform_view'));

// ── dedupKey ─────────────────────────────────────────────────────────────────────
check('dedupKey: non-select is the role', dedupKey({ role: 'email', label: 'Email' }) === 'email');
check('dedupKey: select is role|label', dedupKey({ role: 'select', label: 'Category' }) === 'select|category');

console.log(`\nform-tag-match: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
