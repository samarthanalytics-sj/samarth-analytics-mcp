/**
 * Tag-suggestion engine — pure-logic tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/suggest.node.test.ts
 */
import { detectFormProvider, detectEmbeddedForm } from '../providers.js';
import { buildSuggestions, eventFromLabel, flagOverlappingClickTexts } from '../suggest.js';
import { isYouTubeEmbed } from '../video.js';
import type { PageSignals, SuggestInput, DetectedForm, SuggestedTag } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sig = (o: Partial<PageSignals>): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], ...o });
// GTM matchRegex is RE2 with (?i) honoured; JS RegExp can't parse inline (?i), so
// strip it and pass the 'i' flag to test the pattern body the way GTM would.
const reTest = (pattern: string, text: string): boolean => new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i').test(text);

// ── provider detection ──────────────────────────────────────────────────────
check('provider: HubSpot via script', detectFormProvider(sig({ scriptSrcs: ['https://js.hsforms.net/forms/embed/v2.js'] })).vendor === 'hubspot');
check('provider: HubSpot via class', detectFormProvider(sig({ classNames: ['hs-form'] })).vendor === 'hubspot');
check('provider: Typeform via data attr', detectFormProvider(sig({ selectorsPresent: ['[data-tf-widget]'] })).vendor === 'typeform');
check('provider: Typeform via action', detectFormProvider(sig({}), 'https://acme.typeform.com/to/abc').vendor === 'typeform');
check('provider: Mailchimp via action', detectFormProvider(sig({}), 'https://x.us1.list-manage.com/subscribe/post').vendor === 'mailchimp');
check('provider: Gravity Forms via class', detectFormProvider(sig({ classNames: ['gform_wrapper'] })).vendor === 'gravityforms');
check('provider: CF7 via class', detectFormProvider(sig({ classNames: ['wpcf7'] })).vendor === 'contactform7');
check('provider: WPForms via class', detectFormProvider(sig({ classNames: ['wpforms-form'] })).vendor === 'wpforms');
check('provider: Ninja Forms via class', detectFormProvider(sig({ classNames: ['nf-form-cont'] })).vendor === 'ninjaforms');
check('provider: Elementor via class', detectFormProvider(sig({ classNames: ['elementor-form'] })).vendor === 'elementor');
check('provider: Marketo via id', detectFormProvider(sig({ selectorsPresent: ['#mktoForm_42'] })).vendor === 'marketo');
check('provider: Pardot via script', detectFormProvider(sig({ scriptSrcs: ['https://pi.pardot.com/pd.js'] })).vendor === 'pardot');
check('provider: unknown when no signal', detectFormProvider(sig({ classNames: ['btn', 'container'] })).vendor === 'unknown');
check('provider: carries evidence', detectFormProvider(sig({ classNames: ['hs-form'] })).evidence.includes('hs-form'));

// ── embedded (cross-origin) form detection via iframe src ────────────────────
check('embed: HubSpot via iframe src', detectEmbeddedForm(sig({ iframeSrcs: ['https://share.hsforms.com/abc123'] }))?.vendor === 'hubspot');
check('embed: Typeform via iframe src', detectEmbeddedForm(sig({ iframeSrcs: ['https://form.typeform.com/to/xyz'] }))?.vendor === 'typeform');
check('embed: NOT triggered by generic HubSpot TRACKING script (no form)', detectEmbeddedForm(sig({ scriptSrcs: ['https://js.hs-scripts.com/123.js'] })) === null);
check('embed: null when there is no form signal at all', detectEmbeddedForm(sig({ classNames: ['btn', 'container'] })) === null);
check('provider: Paperform via script', detectFormProvider(sig({ scriptSrcs: ['https://paperform.co/__embed.min.js'] })).vendor === 'paperform');
check('provider: Paperform via [data-paperform-id]', detectFormProvider(sig({ selectorsPresent: ['[data-paperform-id]'] })).vendor === 'paperform');
check('embed: Paperform via iframe src', detectEmbeddedForm(sig({ iframeSrcs: ['https://acme.paperform.co/'] }))?.vendor === 'paperform');

// ── form → suggestion ───────────────────────────────────────────────────────
const contactForm: DetectedForm = { page: '/contact', purpose: 'contact', action: 'https://js.hsforms.net/x', provider: { vendor: 'hubspot', confidence: 'high', evidence: 'script js.hsforms.net' } };
const out1 = buildSuggestions({ siteHost: 'acme.com', forms: [contactForm], elements: [] });
check('form: contact (HubSpot embed) → contact_form on a Custom Event trigger (native form_submit would never fire)',
  out1.length === 1 && out1[0].eventName === 'contact_form' && out1[0].trigger.kind === 'custom_event' && out1[0].trigger.eventName === 'hubspot-form-success');
check('form: label names the provider', out1[0].label.includes('hubspot'));

// ── WordPress AJAX form plugins → Custom Event trigger (NOT native form_submit), per the recipes ──
const wpAjaxCases: Array<{ vendor: 'contactform7' | 'gravityforms' | 'ninjaforms' | 'wpforms' | 'elementor'; ev: string }> = [
  { vendor: 'contactform7', ev: 'cf7submission' },
  { vendor: 'gravityforms', ev: 'gravityFormSubmission' },
  { vendor: 'ninjaforms', ev: 'ninjaFormSubmission' },
  { vendor: 'wpforms', ev: 'wpformsSubmission' },
  { vendor: 'elementor', ev: 'elementorFormSubmission' },
];
for (const { vendor, ev } of wpAjaxCases) {
  const out = buildSuggestions({
    siteHost: 'wp.com',
    forms: [{ page: '/contact', purpose: 'contact', action: '/wp-comments-post.php', method: 'post', provider: { vendor, confidence: 'high', evidence: 'class' }, fields: [{ type: 'email', name: 'email', required: true }] }],
    elements: [],
  });
  const t = out[0]?.trigger;
  check(`form: ${vendor} (AJAX) → Custom Event "${ev}" trigger, NOT native form_submit`,
    out.length === 1 && t?.kind === 'custom_event' && t?.eventName === ev && !t?.formIdValue);
  check(`form: ${vendor} note explains AJAX + listener`, /AJAX/i.test(out[0]?.note ?? '') && /Custom (HTML|Event)/i.test(out[0]?.note ?? ''));
}
// A CF7 (AJAX / custom_event) form WITH a form id → scoped by {{dlv - form_id}} equals the id (reading
// the form_id its listener pushes), since {{Form ID}} does not resolve on a pushed event.
{
  const cf7WithId = buildSuggestions({
    siteHost: 'wp.com',
    forms: [{ page: '/contact', purpose: 'contact', action: '/wp-comments-post.php', method: 'post', provider: { vendor: 'contactform7', confidence: 'high', evidence: 'class' }, formId: 'wpcf7-f123-p1' }],
    elements: [],
  });
  const t = cf7WithId[0]?.trigger;
  // A PROVIDER form (CF7) must NOT get a {{dlv - form_id}} condition: CF7's own listener pushes CF7's
  // internal numeric id, never the DOM id, so an equals-DOM-id condition could never match. It stays
  // page-scoped (which still fires).
  check('form: CF7 (AJAX, provider) → NO dataLayerConditions (page-scoped, no impossible {{dlv - form_id}} match)',
    cf7WithId.length === 1 && t?.kind === 'custom_event' && !t?.formIdValue && !t?.dataLayerConditions);
  check('form: CF7 note does NOT falsely claim a {{dlv - form_id}} scope',
    !/Scoped to this form via \{\{dlv - form_id\}\}/.test(cf7WithId[0]?.note ?? ''));

  // The COHERENT case: a generic JS form with a real <form> + id → the generic submit delegate pushes
  // form_id = the DOM id, so the trigger DOES scope by {{dlv - form_id}} equals that id.
  const jsFormWithId = buildSuggestions({
    siteHost: 'a.com',
    forms: [{ page: '/contact', purpose: 'contact', action: '', method: 'js', provider: { vendor: 'unknown', confidence: 'low', evidence: '' }, formId: 'contact-form', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] }],
    elements: [],
  });
  const jt = jsFormWithId[0]?.trigger;
  check('form: generic JS <form> WITH id → dataLayerConditions {{dlv - form_id}} equals the DOM id (coherent with its listener push)',
    jt?.kind === 'custom_event' && Array.isArray(jt?.dataLayerConditions) && jt!.dataLayerConditions!.length === 1
      && jt!.dataLayerConditions![0].key === 'form_id' && jt!.dataLayerConditions![0].value === 'contact-form');
  check('form: generic JS form note mentions the {{dlv - form_id}} scope', /Scoped to this form via \{\{dlv - form_id\}\}/.test(jsFormWithId[0]?.note ?? ''));
}
check('form: directly creatable (platform + measurementId)', out1[0].platform === 'ga4_event' && out1[0].measurementId === '{{GA4 Measurement ID}}');
check('naming: tag "GA4 Event - Contact Form Tag", trigger "Contact Form Trigger"', out1[0].tagName === 'GA4 - Event - Contact Form Tag' && out1[0].trigger.name === 'Contact Form Trigger');
const provLow = { vendor: 'unknown' as const, confidence: 'low' as const, evidence: '' };
const searchForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'search', action: '', provider: provLow }], elements: [] });
check('form: GET search bar → view_search_results Page View ({{Page URL}} contains ?q=) + search_term = {{URL - q}}', searchForm.length === 1 && searchForm[0].eventName === 'view_search_results' && searchForm[0].tagName === 'GA4 - Event - Site Search Tag' && searchForm[0].trigger.kind === 'pageview' && searchForm[0].trigger.pageUrlValue === '?q=' && (searchForm[0].eventParameters ?? []).some((p) => p.name === 'search_term' && p.value === '{{URL - q}}'));
// A search bar on MANY pages (its action varies per page) is ONE header component → ONE site-wide tag.
const multiSearch = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/a', purpose: 'search', action: '/a/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
  { page: '/b', purpose: 'search', action: '/b/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
  { page: '/c', purpose: 'search', action: '/c/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
], elements: [] });
const siteSearches = multiSearch.filter((s) => s.eventName === 'view_search_results');
check('form: a search bar on many pages (varying actions) collapses to ONE site-wide search tag', siteSearches.length === 1 && siteSearches[0].page === 'site-wide' && siteSearches[0].trigger.kind === 'pageview' && siteSearches[0].trigger.pageUrlValue === '?search=');
// The trigger is chosen from HOW search runs: GET → Page View (above); AJAX/JS → site_search Custom Event; POST → Form Submission.
const jsSearch = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'search', action: '', provider: provLow, method: 'js', fields: [{ type: 'text', name: 'q', required: false }] }], elements: [] });
check('form: AJAX/JS search → view_search_results on a "site_search" Custom Event trigger', jsSearch.length === 1 && jsSearch[0].trigger.kind === 'custom_event' && jsSearch[0].trigger.eventName === 'site_search');
const postSearch = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'search', action: '/results', provider: provLow, method: 'post', fields: [{ type: 'text', name: 'q', required: false }] }], elements: [] });
check('form: POST search → view_search_results on a Form Submission trigger', postSearch.length === 1 && postSearch[0].trigger.kind === 'form_submit');
// Mixed-method search on ONE site → distinct tags with DISTINCT names + ids (no GTM duplicate-name collision).
const mixedSearch = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/', purpose: 'search', action: '', provider: provLow, method: 'get', fields: [{ type: 'text', name: 'q', required: false }] },
  { page: '/', purpose: 'search', action: '', provider: provLow, method: 'js', fields: [{ type: 'text', name: 'q', required: false }] },
  { page: '/', purpose: 'search', action: '/r', provider: provLow, method: 'post', fields: [{ type: 'text', name: 'q', required: false }] },
], elements: [] }).filter((s) => s.eventName === 'view_search_results');
check('form: mixed-method search (get/js/post) → distinct tag names + ids, no collision', mixedSearch.length === 3 && new Set(mixedSearch.map((s) => s.tagName)).size === 3 && new Set(mixedSearch.map((s) => s.id)).size === 3 && new Set(mixedSearch.map((s) => s.trigger.name)).size === 3);
const loginFormS = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'login', action: '', provider: provLow }], elements: [] });
check('form: login form → login event + "GA4 Event - Login Form Tag"', loginFormS.length === 1 && loginFormS[0].eventName === 'login' && loginFormS[0].tagName === 'GA4 - Event - Login Form Tag');
check('form: checkout STILL produces no suggestion (ecommerce, deferred)', buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'checkout', action: '', provider: provLow }], elements: [] }).length === 0);
const nlForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'newsletter', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: newsletter → "GA4 Event - Newsletter Form Tag" + newsletter_form', nlForm[0].tagName === 'GA4 - Event - Newsletter Form Tag' && nlForm[0].eventName === 'newsletter_form' && nlForm[0].trigger.name === 'Newsletter Form Trigger');
const otherFormName = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/x', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: an untitled "other" form yields NO generic tag (Form Submission catch-all removed)', otherFormName.length === 0);
// A TITLED "other" form still gets its own title-derived tag (only the generic catch-all was removed).
const titledOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/x', purpose: 'other', action: '', title: 'Request a Callback', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: a TITLED "other" form still gets its own tag (title-derived, not "Form Submission")', titledOther.length === 1 && titledOther[0].eventName !== 'form_submission' && /request a callback/i.test(titledOther[0].tagName));

// FIX C: an untitled "other" form with NO heading, on a NAMED page, with >=2 fields → a PAGE-PATH-derived
// title so a real quote/booking/feedback form on a named page still gets a meaningful tag (not dropped).
const pathTitledOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/get-a-quote', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' }, method: 'post', fields: [{ type: 'text', name: 'name', required: true }, { type: 'email', name: 'email', required: true }, { type: 'text', name: 'company', required: false }] }], elements: [] });
check('form: untitled "other" with 3 fields on /get-a-quote → "Get A Quote Form" tag + get_a_quote_form event',
  pathTitledOther.length === 1 && pathTitledOther[0].tagName === 'GA4 - Event - Get A Quote Form Tag' && pathTitledOther[0].eventName === 'get_a_quote_form');
// The home page ('/') has no meaningful segment → still dropped (preserves the anti-noise intent).
const homeOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' }, method: 'post', fields: [{ type: 'text', name: 'name', required: true }, { type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: untitled "other" on / (home) → still NO tag (no page-path signal)', homeOther.length === 0);
// A stray single-input untitled "other" form (only 1 field) is not worth a tag even on a named page.
const oneFieldOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/booking', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' }, method: 'post', fields: [{ type: 'text', name: 'x', required: false }] }], elements: [] });
check('form: untitled "other" with 1 field on /booking → still NO tag (<2 fields)', oneFieldOther.length === 0);

// ── field/provider-aware form tracking ───────────────────────────────────────
const prov0 = { vendor: 'unknown' as const, confidence: 'low' as const, evidence: '' };
const formWithId = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'contact', action: 'https://a.com/x', provider: prov0, method: 'post', formId: 'contact-form', formClasses: 'contact-form', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] }], elements: [] });
check('form: scoped to its id → {{Form ID}} equals, no caveat', formWithId[0].trigger.formIdValue === 'contact-form' && formWithId[0].trigger.formIdOperator === 'equals' && !formWithId[0].note);

// ── form NAME from its heading/title (not just the purpose) ──────────────────
const titled = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'lead', title: 'Get a Free Consultation', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: titled form → tag "GA4 Event - Get a Free Consultation Form Tag" + matching trigger',
  titled[0].tagName === 'GA4 - Event - Get A Free Consultation Form Tag' && titled[0].trigger.name === 'Get A Free Consultation Form Trigger');
check('form: titled form → event derived from the title so it matches the tag name', titled[0].eventName === 'get_a_free_consultation_form');
// A title that already says "Form" isn't doubled up; no title → purpose label.
const titledForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'n1', title: 'Newsletter Form' }], elements: [] });
check('form: title already ending "Form" is not doubled ("Newsletter Form", not "Newsletter Form Form")', titledForm[0].tagName === 'GA4 - Event - Newsletter Form Tag');
const untitled = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'c2' }], elements: [] });
check('form: no title → falls back to the purpose label ("Contact Form")', untitled[0].tagName === 'GA4 - Event - Contact Form Tag');
check('form: evidence lists the field signature', /fields: email, message/.test(formWithId[0].evidence) && /id=#contact-form/.test(formWithId[0].evidence));

// Instance-unique class (numeric instance, e.g. gform_1) → {{Form Classes}} contains.
const formInstanceClass = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row gform_1 gform_wrapper', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: instance class gform_1 → {{Form Classes}} contains (skips "row"/"gform_wrapper")', formInstanceClass[0].trigger.formClassesValue === 'gform_1' && formInstanceClass[0].trigger.formClassesOperator === 'contains');

// A SHARED framework wrapper class (wpcf7-form, bare "form") is NOT used to scope. The SAME form (no
// usable id/class) on MULTIPLE pages becomes ONE tag scoped by a {{Page Path}} RegEx over exactly its
// pages (not the site-wide every-form catch-all), and every per-page instance dedups into it.
const formWrapperClass = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'wpcf7-form form', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/d', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'wpcf7-form form', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
const fwc = formWrapperClass.find((s) => s.eventName === 'contact_form')!;
check('form: wrapper class NOT used; same form on 2 pages → ONE tag scoped by {{Page Path}} matchRegex over its pages',
  formWrapperClass.filter((s) => s.eventName === 'contact_form').length === 1 && !fwc.trigger.formClassesValue && fwc.trigger.pagePathOperator === 'matchRegex' && /\/c/.test(fwc.trigger.pagePathValue ?? '') && /\/d/.test(fwc.trigger.pagePathValue ?? ''));

const formNoScope = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row container', fields: [] },
  { page: '/d', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row container', fields: [] },
], elements: [] });
const fns = formNoScope.find((s) => s.eventName === 'contact_form')!;
check('form: no id/class on multiple pages → ONE tag on a {{Page Path}} RegEx over those pages (not the every-form catch-all)',
  formNoScope.filter((s) => s.eventName === 'contact_form').length === 1 && !fns.trigger.formIdValue && !fns.trigger.formClassesValue && fns.trigger.pagePathOperator === 'matchRegex');

// THE reported case: the SAME titled form ("Get a Free Audit") on MANY pages → ONE tag whose form_name
// is a {{Page Path}} Lookup Table variable (per-page name), firing on all its pages via the Page-Path
// RegEx — NOT N page-scoped duplicates that skip on create.
const auditPages = ['/guides/a', '/guides/b', '/guides/c'];
const sameForm = buildSuggestions({ siteHost: 'a.com', forms: auditPages.map((p) => (
  { page: p, purpose: 'other' as const, action: `${p}/submit`, provider: prov0, method: 'post', title: 'Get a Free Audit', fields: [{ type: 'email', name: 'email', required: true }] }
)), elements: [] });
const audit = sameForm.filter((s) => /Get A Free Audit/i.test(s.tagName));
check('form: same titled form on N pages → exactly ONE tag (not N duplicates)', audit.length === 1);
check('form: that tag fires on all its pages via a {{Page Path}} matchRegex', audit[0]?.trigger.pagePathOperator === 'matchRegex' && auditPages.every((p) => (audit[0]!.trigger.pagePathValue ?? '').includes(p)));
check('form: its form_name is the shared {{Form Name}} variable (no per-form lookup)',
  audit[0]?.eventParameters?.find((pm) => pm.name === 'form_name')?.value === '{{Form Name}}' && !audit[0]?.eventParamLookups);

// REGRESSION (adversarial review, HIGH): a MIXED group — the same titled form with a unique Form ID on
// ONE page but not the others — must NOT split into an id-scoped tag + a page-regex tag that share the
// SAME name (which would skip-on-create). The whole group falls through to ONE {{Page Path}}-regex tag.
const mixedId = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/g/a', purpose: 'other', action: '', provider: prov0, method: 'post', title: 'Get a Free Audit', formId: 'audit-1', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/g/b', purpose: 'other', action: '', provider: prov0, method: 'post', title: 'Get a Free Audit', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/g/c', purpose: 'other', action: '', provider: prov0, method: 'post', title: 'Get a Free Audit', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
const mixed = mixedId.filter((s) => /Get A Free Audit/i.test(s.tagName));
check('form: mixed id-uniqueness (id on only some pages) → exactly ONE tag (no duplicate-name split), page-regex scoped',
  mixed.length === 1 && mixed[0].trigger.pagePathOperator === 'matchRegex' && !mixed[0].trigger.formIdValue);

// A case variant of the SAME title ("GET A FREE AUDIT" vs "Get a Free Audit") groups case-insensitively
// into the same ONE tag (not two).
const caseVar = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/p1', purpose: 'other', action: '', provider: prov0, method: 'post', title: 'Get a Free Audit', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/p2', purpose: 'other', action: '', provider: prov0, method: 'post', title: 'GET A FREE AUDIT', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
check('form: title case variants group case-insensitively → ONE tag', caseVar.filter((s) => /free audit/i.test(s.tagName)).length === 1);

// Embed/AJAX + JS forms get the corpus' "Best"-rated route: the SUGGESTED TRIGGER *is* a Custom Event
// (not a native Form Submission that would never fire, with only a note about the workaround).
const hubForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: { vendor: 'hubspot', confidence: 'high', evidence: 'js.hsforms.net' }, method: 'js', formId: 'hsForm_123' }], elements: [] });
check('form: HubSpot (embedded) → the trigger IS a Custom Event on the corpus event "hubspot-form-success"',
  hubForm[0].trigger.kind === 'custom_event' && hubForm[0].trigger.eventName === 'hubspot-form-success' && !hubForm[0].trigger.formIdValue);
// HubSpot's own listener pushes hs_form_id = HubSpot's internal GUID (not the host div's DOM id), so the
// suggestion must NOT emit a {{dlv - form_id}} equals <DOM id> condition that could never match. It stays
// page-scoped (which still fires); the note explains why + how to make it form-specific.
check('form: HubSpot (with formId, provider) → NO dataLayerConditions (provider pushes its own id, not the DOM id)',
  !hubForm[0].trigger.dataLayerConditions);
check('form: HubSpot note explains the dataLayer push + the Element Visibility fallback, and does NOT claim a {{dlv - form_id}} scope',
  /custom event/i.test(hubForm[0].note ?? '') && /hubspot/i.test(hubForm[0].note ?? '') && /dataLayer\.push/.test(hubForm[0].note ?? '') && /element visibility/i.test(hubForm[0].note ?? '')
    && !/Scoped to this form via \{\{dlv - form_id\}\}/.test(hubForm[0].note ?? ''));
// The STRUCTURED install-plan companion: a HubSpot suggestion carries an auto-creatable Custom HTML
// listener tag whose pushed event === the tag's custom_event trigger eventName.
{
  const hubInstall = hubForm[0].install;
  const hubListener = hubInstall?.requires.find((r) => r.kind === 'listener-tag') as
    | { kind: 'listener-tag'; event: string; tag: { html: string; fires: string } }
    | undefined;
  check('form: HubSpot suggestion carries install.requires with a listener-tag', !!hubInstall && !!hubListener);
  check('form: HubSpot listener-tag event === the tag custom_event trigger eventName',
    !!hubListener && hubListener.event === hubForm[0].trigger.eventName);
  check('form: HubSpot listener html is a <script> that pushes dataLayer with hsFormCallback',
    !!hubListener && /^<script>/.test(hubListener.tag.html) && /dataLayer/.test(hubListener.tag.html) && /hsFormCallback/.test(hubListener.tag.html));
}

const jsForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'js', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: JS/div form → note the native Form Submission trigger may not fire', /native <form> submit|may not fire/i.test(jsForm[0].note ?? ''));
check('form: JS/div form → the trigger IS a Custom Event on "form_submit", page-scoped via {{Page Path}} (ANDed condition)',
  jsForm[0].trigger.kind === 'custom_event' && jsForm[0].trigger.eventName === 'form_submit' && jsForm[0].trigger.pagePathValue === '/' && /All-Clicks|element visibility/i.test(jsForm[0].note ?? ''));

// Pardot FORM HANDLER (native <form> POST) → native trigger DOES fire: scoped by id, no "won't fire" note.
const pardotHandler = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: 'https://go.pardot.com/l/1/2/form-handler', provider: { vendor: 'pardot', confidence: 'high', evidence: 'action pardot.com' }, method: 'post', formId: 'pardot-form' }], elements: [] });
check('form: Pardot form-handler (native POST) → scoped by id, NO iframe/Custom-Event note', pardotHandler[0].trigger.formIdValue === 'pardot-form' && !/iframe|custom event/i.test(pardotHandler[0].note ?? ''));

// Two untitled contact forms share the "Contact Form" name (they'd collide as two same-named tags at
// create). Each has a UNIQUE id → they consolidate into ONE tag scoped by a {{Form ID}} RegEx over
// both ids (fires on exactly those two forms, no page over-fire), form_name distinguished per page.
const twoForms = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'contact-main' },
  { page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'footer-contact' },
], elements: [] });
const tf = twoForms.filter((s) => s.eventName === 'contact_form');
check('form: two same-name contact forms with distinct unique ids → ONE tag scoped by {{Form ID}} matchRegex over both ids',
  tf.length === 1 && tf[0].trigger.formIdOperator === 'matchRegex' && /contact-main/.test(tf[0].trigger.formIdValue ?? '') && /footer-contact/.test(tf[0].trigger.formIdValue ?? ''));

// FIX A: two UNTITLED same-purpose forms with STRUCTURALLY-DIFFERENT fields on ONE page must NOT collapse
// to one tag. The field-signature disambiguator gives the second a "Contact Form 2" title (distinct
// label + event + tagName), so BOTH survive every dedup.
const twoUntitledDiff = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', fields: [{ type: 'email', name: 'email', required: true }, { type: 'text', name: 'name', required: false }] },
  { page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', fields: [{ type: 'email', name: 'work_email', required: true }, { type: 'tel', name: 'phone', required: false }, { type: 'text', name: 'company', required: false }] },
], elements: [] });
const tud = twoUntitledDiff.filter((s) => s.trigger.kind === 'form_submit');
check('form (Fix A): two field-different untitled contact forms on one page → TWO tags ("Contact Form" + "Contact Form 2")',
  tud.length === 2 &&
  tud.some((s) => s.tagName === 'GA4 - Event - Contact Form Tag' && s.eventName === 'contact_form') &&
  tud.some((s) => s.tagName === 'GA4 - Event - Contact Form 2 Tag' && s.eventName === 'contact_form_2'));
// The SAME untitled contact form (identical field signature) on TWO pages STILL collapses to ONE
// site-wide tag — the same-form-across-pages dedup that Fix A must not break.
const sameUntitledMultiPage = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/a', purpose: 'contact', action: '', provider: prov0, method: 'post', fields: [{ type: 'email', name: 'email', required: true }, { type: 'text', name: 'name', required: false }] },
  { page: '/b', purpose: 'contact', action: '', provider: prov0, method: 'post', fields: [{ type: 'email', name: 'email', required: true }, { type: 'text', name: 'name', required: false }] },
], elements: [] });
const sump = sameUntitledMultiPage.filter((s) => s.trigger.kind === 'form_submit');
check('form (Fix A): the SAME untitled form on /a and /b → ONE tag (index shared → still collapses multi-page)',
  sump.length === 1 && sump[0].eventName === 'contact_form' && sump[0].tagName === 'GA4 - Event - Contact Form Tag' && sump[0].trigger.pagePathOperator === 'matchRegex');
// A SINGLE untitled form is unchanged — no "1" suffix on the name or event (zero change for the common case).
const singleUntitled = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', fields: [{ type: 'email', name: 'email', required: true }, { type: 'text', name: 'name', required: false }] },
], elements: [] }).filter((s) => s.trigger.kind === 'form_submit');
check('form (Fix A): a single untitled form is unchanged — "Contact Form" / contact_form, no "1" suffix',
  singleUntitled.length === 1 && singleUntitled[0].tagName === 'GA4 - Event - Contact Form Tag' && singleUntitled[0].eventName === 'contact_form');

// A NON-UNIQUE id (same id on two DIFFERENT forms) can't scope by id. When the forms are also
// SITE-WIDE (each signature spans several pages) they can't be page-scoped either → collision note.
const sharedId = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] },
  { page: '/about', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] },
  { page: '/', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/blog', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
check('form: shared non-unique id across DIFFERENT same-name groups → each group is ONE {{Page Path}}-RegEx tag, NOT id-scoped',
  sharedId.every((s) => !s.trigger.formIdValue) &&
  sharedId.filter((s) => s.eventName === 'contact_form').length === 1 &&
  sharedId.find((s) => s.eventName === 'contact_form')?.trigger.pagePathOperator === 'matchRegex');

// REGRESSION (note-branch ordering): a shared/non-unique id on a form that lives on ONE page is
// correctly PAGE-scoped, so it must get the page-scope note — NOT the "shares this id / double-counting"
// note (which would contradict the trigger's own {{Page Path}} scope).
const sharedIdOnePage = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] },
  { page: '/news', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
const sharedScoped = sharedIdOnePage.find((s) => s.eventName === 'contact_form');
check('form: shared id but single-page → page-scoped, note is the page note NOT a false collision note',
  !!sharedScoped && !sharedScoped.trigger.formIdValue && sharedScoped.trigger.pagePathValue === '/contact' &&
  /scoped to submits on \/contact/i.test(sharedScoped.note ?? '') && !/shares this id|double-counting/i.test(sharedScoped.note ?? ''));

// ── social media links → a dedicated named tag ───────────────────────────────
const socialOut = buildSuggestions({ siteHost: 'acme.com', forms: [], elements: [{ page: '/', kind: 'social', text: 'Facebook', href: 'https://facebook.com/acme', region: 'footer' }] });
check('social: → "GA4 Event - Social Media Click Tag" / social_click / link_click+regex',
  socialOut[0].tagName === 'GA4 - Event - Social Media Click Tag' && socialOut[0].eventName === 'social_click' &&
  socialOut[0].trigger.kind === 'link_click' && socialOut[0].trigger.name === 'Social Media Click Trigger' && socialOut[0].trigger.clickUrlOperator === 'matchRegex');
check('social: NOT flagged EM overlap (dedicated named event)', socialOut[0].enhancedMeasurementOverlap === false);
// The social trigger regex must fire on real social hosts and NOT on ordinary
// links that merely contain a social token in the path/query/another-label.
const socialPat = socialOut[0].trigger.clickUrlValue ?? '';
check('social trigger: short corpus-style pattern matches real social hosts (facebook.com, m.youtube.com, x.com, youtu.be, lnkd.in)',
  ['https://facebook.com/acme', 'https://m.youtube.com/watch?v=1', 'https://x.com/acme', 'https://youtu.be/xyz', 'https://lnkd.in/abc'].every((u) => reTest(socialPat, u)));
// Short domain alternation still avoids the obvious non-social URLs (a domain
// substring is required: microsoft.com / a /facebook.html path / retext.com don't
// contain a social domain). (?ref=…/subdomain-spoof do match — the corpus-style
// brevity trade-off the user chose.)
check('social trigger: does NOT fire on microsoft.com / a /facebook.html path / retext.com',
  ['https://www.microsoft.com/', 'https://mysite.com/facebook.html', 'https://retext.com/', 'https://contact.company.com/x'].every((u) => !reTest(socialPat, u)));
check('social trigger: corpus-style domain alternation (no ://, no ([/:?#] anchoring, no (?i))', !socialPat.includes('://') && !socialPat.includes('([/:?#]') && !socialPat.includes('(?i)'));

// PRESENT-ONLY: the trigger matches ONLY the EXACT domains scraped from the page.
const fbOnly = buildSuggestions({ siteHost: 'acme.com', forms: [], elements: [{ page: '/', kind: 'social', text: 'Facebook', href: 'https://facebook.com/acme', socialNetwork: 'facebook', socialDomain: 'facebook.com' }] });
const fbPat = fbOnly[0].trigger.clickUrlValue ?? '';
check('social present-only: facebook.com scraped → matches facebook, NOT linkedin/youtube/x',
  reTest(fbPat, 'https://facebook.com/acme') && !reTest(fbPat, 'https://linkedin.com/x') && !reTest(fbPat, 'https://youtube.com/x') && !reTest(fbPat, 'https://x.com/a'));
check('social present-only: pattern is JUST the scraped domain (not the whole network domain list)', fbPat === 'facebook\\.com');
const fbLi = buildSuggestions({ siteHost: 'acme.com', forms: [], elements: [
  { page: '/', kind: 'social', text: 'Fb', href: 'https://facebook.com/a', socialNetwork: 'facebook', socialDomain: 'facebook.com' },
  { page: '/', kind: 'social', text: 'Li', href: 'https://lnkd.in/x', socialNetwork: 'linkedin', socialDomain: 'lnkd.in' },
] });
check('social present-only: scraped facebook.com + lnkd.in → ONE tag matching both, not twitter', fbLi.filter((s) => s.eventName === 'social_click').length === 1 && (() => { const p = fbLi[0].trigger.clickUrlValue ?? ''; return p === 'facebook\\.com|lnkd\\.in' && reTest(p, 'https://facebook.com/a') && reTest(p, 'https://lnkd.in/x') && !reTest(p, 'https://twitter.com/a'); })());

// ── element → suggestion + Enhanced Measurement flagging ─────────────────────
const elInput: SuggestInput = {
  siteHost: 'acme.com',
  forms: [],
  elements: [
    { page: '/', kind: 'email', text: 'hi@acme.com', href: 'mailto:hi@acme.com', region: 'footer' },
    { page: '/contact', kind: 'phone', text: 'Call us', href: 'tel:+15551234567' },
    { page: '/resources', kind: 'download', text: 'Guide.pdf', href: 'https://acme.com/g.pdf' },
    { page: '/blog', kind: 'outbound', text: 'partner', href: 'https://partner.com' },
  ],
};
const els = buildSuggestions(elInput);
const byEvent = (e: string) => els.find((s) => s.eventName === e);
check('email: mailto → email_click, startsWith mailto:', byEvent('email_click')?.trigger.clickUrlValue === 'mailto:' && byEvent('email_click')?.trigger.clickUrlOperator === 'startsWith');
check('phone: tel → phone_click', byEvent('phone_click')?.trigger.clickUrlValue === 'tel:');
check('naming: email tag "GA4 Event - Email Click Tag", trigger "Email Trigger"', byEvent('email_click')?.tagName === 'GA4 - Event - Email Click Tag' && byEvent('email_click')?.trigger.name === 'Email Click Trigger');

// ── event parameters: GA4-standard, valued by GTM built-in variables ─────────
const emailParams = byEvent('email_click')?.eventParameters ?? [];
check('email: carries click_url={{Click URL}} + click_text={{Click Text}} (corpus param names)',
  emailParams.some((p) => p.name === 'click_url' && p.value === '{{Click URL}}') &&
  emailParams.some((p) => p.name === 'click_text' && p.value === '{{Click Text}}'));
check('download/outbound also carry click_url/click_text params',
  (byEvent('file_download')?.eventParameters?.length ?? 0) >= 2 && (byEvent('outbound_click')?.eventParameters?.length ?? 0) >= 2);
const leadParams = out1[0].eventParameters ?? [];
check('form: contact_form carries form_id={{Form ID}} + form_name={{Form Name}} (the shared variable)',
  leadParams.some((p) => p.name === 'form_id' && p.value === '{{Form ID}}') &&
  leadParams.some((p) => p.name === 'form_name' && p.value === '{{Form Name}}'));
check('form: NO per-form lookup variable is emitted (form_name is the shared {{Form Name}})', !out1[0].eventParamLookups);

// The SAME form (same Form ID) on MULTIPLE pages → ONE tag scoped by {{Form ID}}; form_name is still
// the shared {{Form Name}} variable (the page-scoping lives in the trigger, not in form_name).
const consultForm = (page: string): DetectedForm => ({ page, purpose: 'contact', action: '', method: 'post', formId: 'consult-form', provider: prov0, fields: [{ type: 'email', name: 'email', required: true }] });
const mp = buildSuggestions({ siteHost: 'a.com', forms: [consultForm('/'), consultForm('/services/ga4-consulting'), consultForm('/services/conversion-tracking')], elements: [] });
const mpForm = mp.filter((s) => s.trigger.kind === 'form_submit');
check('form: same-Form-ID form on 3 pages → ONE tag scoped by {{Form ID}} equals, page site-wide',
  mpForm.length === 1 && mpForm[0].trigger.formIdValue === 'consult-form' && mpForm[0].trigger.formIdOperator === 'equals' && mpForm[0].page === 'site-wide');
check('form: multi-page form_name is the shared {{Form Name}} variable, no lookup emitted',
  (mpForm[0]?.eventParameters ?? []).find((p) => p.name === 'form_name')?.value === '{{Form Name}}' && !mpForm[0]?.eventParamLookups);
check('page context: every event carries page_url={{Page URL}} + previous_page={{Referrer}}',
  [byEvent('email_click'), out1[0]].every((s) =>
    (s?.eventParameters ?? []).some((p) => p.name === 'page_url' && p.value === '{{Page URL}}') &&
    (s?.eventParameters ?? []).some((p) => p.name === 'previous_page' && p.value === '{{Referrer}}')));
check('download: flagged as Enhanced-Measurement overlap', byEvent('file_download')?.enhancedMeasurementOverlap === true);
check('outbound: flagged as Enhanced-Measurement overlap', byEvent('outbound_click')?.enhancedMeasurementOverlap === true);
check('email/phone are NOT EM overlap (real gaps)', byEvent('email_click')?.enhancedMeasurementOverlap === false && byEvent('phone_click')?.enhancedMeasurementOverlap === false);

// ── site-wide dedup + ranking ────────────────────────────────────────────────
const everyPageEmail = buildSuggestions({
  siteHost: 'acme.com',
  forms: [],
  elements: ['/', '/about', '/pricing'].map((page) => ({ page, kind: 'email' as const, text: 'x', href: 'mailto:hi@acme.com' })),
});
check('dedup: footer email on 3 pages → 1 site-wide suggestion', everyPageEmail.length === 1 && everyPageEmail[0].page === 'site-wide');

const ranked = buildSuggestions({
  siteHost: 'acme.com',
  forms: [contactForm],
  elements: [
    { page: '/r', kind: 'download', text: 'd', href: 'https://acme.com/x.pdf' }, // medium + EM
    { page: '/', kind: 'email', text: 'e', href: 'mailto:hi@acme.com' }, // high
  ],
});
check('rank: high-confidence non-EM first (form/email before download)', ranked[0].confidence === 'high' && ranked[ranked.length - 1].eventName === 'file_download');

// ── review-fix regressions ───────────────────────────────────────────────────
check('provider: Pardot via form action (handler endpoint)', detectFormProvider(sig({}), 'https://go.pardot.com/l/1/2/form-handler').vendor === 'pardot');
// Marketo without the #mktoForm_<n> id (the get.chownow.com shape): class .mktoForm or the forms2 script.
check('provider: Marketo via class .mktoForm (no #mktoForm_<n> id)', detectFormProvider(sig({ classNames: ['mktoForm', 'tal'] })).vendor === 'marketo');
check('provider: Marketo via the forms2 loader script', detectFormProvider(sig({ scriptSrcs: ['https://app-ab12.marketo.com/js/forms2/js/forms2.min.js'] })).vendor === 'marketo');
check('provider: munchkin.js (tracking-only, loads site-wide without a form) does NOT flip forms to marketo', detectFormProvider(sig({ scriptSrcs: ['https://munchkin.marketo.net/munchkin.js'] })).vendor !== 'marketo');
check('embed: class .mktoForm marks an embedded Marketo form; a bare marketo script does NOT synthesize one',
  detectEmbeddedForm(sig({ classNames: ['mktoForm'] }))?.vendor === 'marketo' && detectEmbeddedForm(sig({ scriptSrcs: ['https://app-ab12.marketo.com/js/forms2/js/forms2.min.js'] })) === null);

const otherForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/x', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: an untitled "other" form is not tracked (no generic form_submission tag)', otherForm.length === 0);

// ── eventFromLabel: GA4-valid event derived from a tag label ─────────────────
check('eventFromLabel: snake_case + click suffix', eventFromLabel('VibroFlex NeoPDF / 1.3 MBDatasheet', 'click') === 'vibroflex_neopdf_1_3_mbdatasheet_click');
check('eventFromLabel: does not double an already-present suffix', eventFromLabel('Email Click', 'click') === 'email_click');
check('eventFromLabel: no suffix → plain snake_case', eventFromLabel('Download Form') === 'download_form');
check('eventFromLabel: must start with a letter (leading digits stripped)', /^[a-z]/.test(eventFromLabel('1.3 Datasheet', 'click')));
check('eventFromLabel: capped at GA4 40-char limit, trimmed at a word boundary', (() => { const e = eventFromLabel('Thank You For Your Interest In Optical Measurement Solutions Form'); return e.length <= 40 && !e.endsWith('_'); })());
check('eventFromLabel: strips GA4 reserved prefixes (google_/ga_/firebase_ are silently dropped by GA4)', eventFromLabel('Google Maps', 'click') === 'maps_click' && eventFromLabel('GA Dashboard', 'click') === 'dashboard_click' && !/^(ga|google|firebase)_/.test(eventFromLabel('Firebase Console', 'click')));

// ── CTA INTENT naming + dedup ─────────────────────────────────────────────────
const ctaInput = buildSuggestions({
  siteHost: 'a.com', forms: [],
  elements: [
    { page: '/', kind: 'cta', text: 'Subscribe now', intent: 'subscribe' },
    { page: '/blog', kind: 'cta', text: 'Subscribe', intent: 'subscribe' }, // variant → collapses with the above
    { page: '/', kind: 'cta', text: 'Learn more', intent: 'learn_more' },
    { page: '/p', kind: 'cta', text: 'Add to cart', intent: 'add_to_cart' },
    { page: '/', kind: 'cta', text: 'Request a demo', intent: 'book_demo' },
    { page: '/', kind: 'cta', text: 'Buy now', intent: 'generic' },
    { page: '/pricing', kind: 'cta', text: 'Buy now', intent: 'generic' }, // same generic text → collapses
  ],
});
// Each distinct button TEXT becomes its own tag, named for that text, with a plain
// "{{Click Text}} equals <text>" trigger (no intent regex). Different text → different tag (the
// user prefers per-button clarity); the SAME text on multiple pages still collapses site-wide.
// "contains" (not "equals") so the trigger still fires when GTM's rendered Click Text differs from
// the scanned textContent (icon / hidden a11y span / scan-time truncation).
const subs = ctaInput.filter((s) => /GA4 - Event - Subscribe/.test(s.tagName));
check('cta: each distinct subscribe text → its OWN tag + a label-derived event that matches the tag name',
  subs.length === 2 &&
  subs.some((s) => s.tagName === 'GA4 - Event - Subscribe Now Click Tag' && s.eventName === 'subscribe_now_click' && s.trigger.name === 'Subscribe Now Click Trigger') &&
  subs.some((s) => s.tagName === 'GA4 - Event - Subscribe Click Tag' && s.eventName === 'subscribe_click'));
check('cta: named-intent trigger is a plain {{Click Text}} equals <text> (not matchRegex)',
  subs.every((s) => s.trigger.clickTextOperator === 'equals') &&
  ctaInput.find((s) => s.tagName === 'GA4 - Event - Subscribe Now Click Tag')?.trigger.clickTextValue === 'Subscribe now');
const demo = ctaInput.find((s) => s.tagName === 'GA4 - Event - Request A Demo Click Tag');
check('cta: tag + event named for the actual button text "Request a demo" (event matches tag)',
  demo?.eventName === 'request_a_demo_click' && demo?.trigger.name === 'Request A Demo Click Trigger' &&
  demo?.trigger.clickTextValue === 'Request a demo' && demo?.trigger.clickTextOperator === 'equals');
check('cta: Learn More tag named for the button text + own event', ctaInput.find((s) => s.eventName === 'learn_more_click')?.tagName === 'GA4 - Event - Learn More Click Tag');
check('cta: Add to Cart uses non-reserved add_to_cart_click event (not the GA4 ecommerce add_to_cart)',
  ctaInput.find((s) => s.eventName === 'add_to_cart_click')?.tagName === 'GA4 - Event - Add To Cart Click Tag' && !ctaInput.some((s) => s.eventName === 'add_to_cart'));
const genericCtas = ctaInput.filter((s) => s.eventName === 'buy_now_click');
check('cta: generic "Buy now" → label-derived event buy_now_click, {{Click Text}} equals "Buy now", same text collapses site-wide', genericCtas.length === 1 && genericCtas[0].page === 'site-wide' && genericCtas[0].trigger.clickTextValue === 'Buy now' && genericCtas[0].trigger.clickTextOperator === 'equals' && genericCtas[0].trigger.name === 'Buy Now Click Trigger');
check('cta: every CTA carries dynamic click_text={{Click Text}}', ctaInput.every((s) => s.eventParameters?.some((p) => p.name === 'click_text' && p.value === '{{Click Text}}')));
check('cta: ALL CTA triggers use a plain "equals" condition (no regex)', ctaInput.every((s) => s.trigger.clickTextOperator === 'equals'));
// The hrefless CTAs above (buttons / JS controls) all pick "Click - All Elements".
check('cta: a hrefless CTA (button / JS control) uses all_clicks (Click - All Elements)', ctaInput.every((s) => s.trigger.kind === 'all_clicks'));

// ── CTA trigger TYPE follows the element: <a href> → Just Links, button/control → All Elements ──
const trigType = buildSuggestions({ siteHost: 'shop.example', forms: [], elements: [
  { page: '/', kind: 'cta', text: 'Buy now', intent: 'generic' },                                                    // <button> → all_clicks
  { page: '/p', kind: 'cta', text: 'View size chart', intent: 'learn_more', href: 'https://shop.example/p#size-chart' }, // <a href> → link_click
  { page: '/', kind: 'cta', text: 'Free Audit', intent: 'get_started', href: 'https://shop.example/free-audit' },     // <a href> → link_click
  { page: '/', kind: 'cta', text: 'Add to cart', intent: 'add_to_cart' },                                            // JS control, no href → all_clicks
] });
const byName = (n: string) => trigType.find((s) => s.tagName === n);
check('cta type: <button> "Buy now" (no href) → all_clicks (Click - All Elements)', byName('GA4 - Event - Buy Now Click Tag')?.trigger.kind === 'all_clicks');
check('cta type: <a href> "View size chart" (#size-chart) → link_click (Click - Just Links)', byName('GA4 - Event - View Size Chart Click Tag')?.trigger.kind === 'link_click');
check('cta type: <a href> "Free Audit" → link_click', byName('GA4 - Event - Free Audit Click Tag')?.trigger.kind === 'link_click');
check('cta type: hrefless "Add to cart" control → all_clicks', byName('GA4 - Event - Add To Cart Click Tag')?.trigger.kind === 'all_clicks');
check('cta type: switching the type does NOT change the tag/trigger name or the {{Click Text}} equals condition',
  byName('GA4 - Event - Free Audit Click Tag')?.trigger.name === 'Free Audit Click Trigger' &&
  byName('GA4 - Event - Free Audit Click Tag')?.trigger.clickTextValue === 'Free Audit' &&
  byName('GA4 - Event - Free Audit Click Tag')?.trigger.clickTextOperator === 'equals');

// Newly tracked CTAs: login + search.
const moreCtas = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/', kind: 'cta', text: 'Login', intent: 'login' },
  { page: '/', kind: 'cta', text: 'Search', intent: 'search' },
] });
const loginCta = moreCtas.find((s) => s.eventName === 'login_click');
check('cta: login button → "GA4 Event - Login Tag" (named for the text), {{Click Text}} equals "Login"', loginCta?.tagName === 'GA4 - Event - Login Click Tag' && loginCta?.trigger.clickTextValue === 'Login' && loginCta?.trigger.clickTextOperator === 'equals');
const searchCta = moreCtas.find((s) => s.eventName === 'search_click');
// search CTA uses 'search_click' (NOT bare 'search') so a "Search" submit button
// can't double-count with the search FORM tag (which keeps the GA4 'search' event).
check('cta: search button → "GA4 Event - Search Tag", event search_click, {{Click Text}} equals "Search"', searchCta?.tagName === 'GA4 - Event - Search Click Tag' && searchCta?.eventName === 'search_click' && searchCta?.trigger.clickTextValue === 'Search' && searchCta?.trigger.clickTextOperator === 'equals');
check('cta: search button event (search_click) is DISTINCT from the site-search event (view_search_results) — no double-count', searchForm[0].eventName === 'view_search_results' && searchCta?.eventName === 'search_click');
// Title-case preserves intercaps/acronym tokens in the tag name (iOS not "Ios", PDF stays PDF).
const iosCta = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'cta', text: 'Download for iOS', intent: 'generic' }] });
check('naming: title-case keeps intercaps ("Download For iOS", not "Ios")', iosCta.some((s) => s.tagName === 'GA4 - Event - Download For iOS Click Tag' && s.trigger.name === 'Download For iOS Click Trigger'));

// ── YouTube video → GA4 video tag (built-in YouTube Video trigger) ───────────
check('video: isYouTubeEmbed matches /embed/ players, not watch/share/vimeo',
  isYouTubeEmbed('https://www.youtube.com/embed/abc123') && isYouTubeEmbed('https://www.youtube-nocookie.com/embed/xyz') &&
  !isYouTubeEmbed('https://www.youtube.com/watch?v=abc') && !isYouTubeEmbed('https://youtu.be/abc') && !isYouTubeEmbed('https://player.vimeo.com/video/1'));
const vid = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [], videoEmbeds: [{ page: '/', provider: 'youtube' }] });
const ytTag = vid.find((s) => s.trigger.kind === 'youtube_video');
check('video: YouTube embed → ONE "GA4 Event - YouTube Video Tag" on a "YouTube Video Trigger"', vid.length === 1 && ytTag?.tagName === 'GA4 - Event - YouTube Video Tag' && ytTag?.trigger.name === 'YouTube Video Trigger');
check('video: event resolves to GA4 video_start/_progress/_complete via {{Video Status}}', ytTag?.eventName === 'video_{{Video Status}}');
check('video: carries the standard video_* params valued by the Video built-ins', ['video_title', 'video_url', 'video_provider', 'video_percent', 'video_duration', 'video_current_time'].every((n) => ytTag?.eventParameters?.some((p) => p.name === n && /^\{\{Video /.test(p.value))));
check('video: flagged as EM-overlap (GA4 Video engagement) but still suggested', ytTag?.enhancedMeasurementOverlap === true);
check('video: no embed → no video tag', buildSuggestions({ siteHost: 'a.com', forms: [], elements: [] }).length === 0);

// ── full mode: GA4 Configuration prepended (no form catch-all) ────────────────
const fullForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, formId: 'c' }], elements: [] }, { full: true });
check('full: GA4 Configuration (google_tag) is always FIRST, on All Pages', fullForm[0].platform === 'google_tag' && fullForm[0].tagName === 'GA4 Configuration' && fullForm[0].trigger.kind === 'pageview' && fullForm[0].tagId === '{{GA4 Measurement ID}}');
check('full: NO "All Form Submissions" catch-all is added even when a form exists', !fullForm.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag'));
const fullPdf = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Guide', href: 'https://a.com/g.pdf' }] }, { full: true });
check('full: PDF download tag uses a readable {{Click URL}} ends with .pdf — and there is NO separate "All PDF Downloads" catch-all (the per-file tag already fires site-wide)',
  fullPdf.some((s) => s.eventName === 'file_download' && s.tagName === 'GA4 - Event - PDF Download Click Tag' && s.trigger.clickUrlValue === '.pdf' && s.trigger.clickUrlOperator === 'endsWith') &&
  !fullPdf.some((s) => s.tagName === 'GA4 - Event - All PDF Downloads'));
check('full: no PDF → no "All PDF Downloads" tag; no form → no "All Form Submissions"', (() => { const x = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [] }, { full: true }); return !x.some((s) => s.tagName === 'GA4 - Event - All PDF Downloads') && !x.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag'); })());
check('full: GA4 Configuration is still present even with nothing found', buildSuggestions({ siteHost: 'a.com', forms: [], elements: [] }, { full: true }).some((s) => s.platform === 'google_tag'));
check('default (no opts): NO google_tag / catch-alls added (scan output unchanged)', !buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, formId: 'c' }], elements: [] }).some((s) => s.platform === 'google_tag' || s.tagName.startsWith('GA4 - Event - All ')));
// Review fixes: real-id placeholder, case-insensitive regex, no double-fire.
check('full: GA4 Configuration defaults to a valid-shaped Measurement ID (G-1234567890) the user can keep or edit', fullForm[0].measurementId === 'G-1234567890');
check('full: the PDF download trigger is a plain "ends with" condition, NOT a regex', fullPdf.find((s) => s.eventName === 'file_download')?.trigger.clickUrlOperator === 'endsWith');
// Non-PDF extensions get their own readable per-type tag (ZIP), and "ends with" anchors so .doc
// can't over-match .docx; a download URL with no clear extension falls back to the multi-ext regex.
const zipDl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Bundle', href: 'https://a.com/pack.zip' }] }).find((s) => s.eventName === 'file_download');
check('download: .zip → "GA4 Event - ZIP Download Tag", {{Click URL}} ends with .zip', zipDl?.tagName === 'GA4 - Event - ZIP Download Click Tag' && zipDl?.trigger.clickUrlValue === '.zip' && zipDl?.trigger.clickUrlOperator === 'endsWith');
const docDl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Doc', href: 'https://a.com/f.doc' }] }).find((s) => s.eventName === 'file_download');
check('download: ".doc" ends-with does NOT over-match ".docx"', docDl?.trigger.clickUrlValue === '.doc' && docDl?.trigger.clickUrlOperator === 'endsWith');
const noExtDl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Get file', href: 'https://a.com/download' }] }).find((s) => s.eventName === 'file_download');
check('download: no clear extension → multi-ext regex fallback ("File Download")', noExtDl?.tagName === 'GA4 - Event - File Download Click Tag' && noExtDl?.trigger.clickUrlOperator === 'matchRegex' && /pdf\|zip/.test(noExtDl?.trigger.clickUrlValue ?? ''));
// The fallback regex must NEVER carry an inline (?i) — gtm.js (browser JS RegExp) cannot parse it and
// the condition would silently never match. Case-insensitivity rides on the ignore-case flag instead.
check('download: fallback regex is plain (no inline (?i)) + clickUrlIgnoreCase ON', !(noExtDl?.trigger.clickUrlValue ?? '').includes('(?i)') && noExtDl?.trigger.clickUrlIgnoreCase === true);
// A labeled DOWNLOAD-CTA link ("Download brochure") to a file surfaces DISTINCTLY (scoped to its
// {{Click Text}}), not folded into the generic extension tag — still EM-overlap (de-selected until opt-in).
const brochureDl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Download brochure', href: 'https://a.com/OM_PB_Vibrometry.pdf' }] });
const brochure = brochureDl.find((s) => s.trigger.clickTextValue === 'Download brochure');
check('download: labeled "Download brochure" → own tag on {{Click Text}} equals, file_download + EM overlap',
  !!brochure && brochure.eventName === 'file_download' && brochure.trigger.kind === 'link_click' && brochure.trigger.clickTextOperator === 'equals' && brochure.enhancedMeasurementOverlap === true && /download brochure/i.test(brochure.tagName));
check('download: the labeled brochure link does NOT also emit the generic "PDF Download" (folding avoided)', !brochureDl.some((s) => s.tagName === 'GA4 - Event - PDF Download Click Tag'));
// A generic filename ("Guide") has no download intent → stays the generic extension tag (unchanged).
const guideDl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'download', text: 'Guide', href: 'https://a.com/g.pdf' }] });
check('download: generic label "Guide" still folds into "PDF Download" (URL-scoped, not click-text)',
  guideDl.some((s) => s.tagName === 'GA4 - Event - PDF Download Click Tag' && s.trigger.clickUrlOperator === 'endsWith') && !guideDl.some((s) => s.trigger.clickTextValue));
check('full: SCOPED / purpose form tag is KEPT (contact_form present)', fullForm.some((s) => s.eventName === 'contact_form'));
// An unrecognized (other) form with no heading is now DROPPED — the generic "Form Submission" tag AND
// the site-wide catch-all were removed, so it yields no form-submit tag at all (single- or multi-page).
const fullOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'other', action: '', provider: prov0 }], elements: [] }, { full: true });
check('full: an untitled "other" form yields NO form-submit tag (generic tag + catch-all removed)', !fullOther.some((s) => s.trigger.kind === 'form_submit'));
const siteWideOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/a', purpose: 'other', action: '', provider: prov0 }, { page: '/b', purpose: 'other', action: '', provider: prov0 }], elements: [] }, { full: true });
check('full: a site-wide untitled "other" form also yields NO tag (no catch-all fold)', !siteWideOther.some((s) => s.trigger.kind === 'form_submit'));

// ── FAQ accordion grouping ───────────────────────────────────────────────────
// >=2 question rows (CTA text ending "?") collapse into ONE tag. {{Click Text}} ends with "?" is the
// PRIMARY condition (always present, corpus-dominant); a stable shared class ANDs the {{Click
// Element}} CSS selector on top (corpus: "Click Text ENDS_WITH ? AND Click Classes CONTAINS <cls>");
// single-page FAQs ALSO get an ANDed {{Page Path}} condition. Per-question tags never emitted alongside.
const faqEls = [
  { page: '/faq', kind: 'cta' as const, text: 'Does ChowNow charge commissions?', intent: 'generic' as const, className: 'faq-question flex items-center' },
  { page: '/faq', kind: 'cta' as const, text: 'Does ChowNow integrate with my POS?', intent: 'generic' as const, className: 'faq-question flex items-center' },
  { page: '/faq', kind: 'cta' as const, text: 'What happens to my customer data?', intent: 'generic' as const, className: 'faq-question flex items-center' },
];
const faq = buildSuggestions({ siteHost: 'a.com', forms: [], elements: faqEls });
const faqTag = faq.find((s) => s.eventName === 'faq_click');
check('faq: class route = THREE ANDed conditions — {{Click Text}} ends with "?" AND the class selector AND {{Page Path}}',
  !!faqTag && faqTag.trigger.kind === 'all_clicks' && faqTag.trigger.clickTextValue === '?' && faqTag.trigger.clickTextOperator === 'endsWith' && faqTag.trigger.clickElementValue === '.faq-question, .faq-question *' && faqTag.trigger.clickElementOperator === 'cssSelector' && faqTag.trigger.pagePathValue === '/faq' && faqTag.trigger.pagePathOperator === 'contains' && /faq/i.test(faqTag.tagName));
check('faq: the grouped question rows are NOT also emitted as their own per-question CTAs', !faq.some((s) => s.trigger.clickTextOperator === 'equals' && /\?$/.test(s.trigger.clickTextValue ?? '')));
// A LONE question (only one on the whole site) is not an accordion — stays an individual CTA.
const loneQ = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/x', kind: 'cta', text: 'Need help?', intent: 'generic', className: 'faq-question' }] });
check('faq: a single question row is NOT grouped (no faq tag; stays an individual CTA)', !loneQ.some((s) => s.eventName === 'faq_click') && loneQ.some((s) => s.trigger.clickTextValue === 'Need help?'));
// A STATE class (Bootstrap-style "collapsed", toggled as the accordion opens) must never scope the
// trigger — the stable structural class ("acc-tog", the ChowNow shape) is picked instead.
const stateCls = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/', kind: 'cta', text: 'Does ChowNow charge commissions?', intent: 'generic', className: 'collapsed acc-tog' },
  { page: '/', kind: 'cta', text: 'What happens to my customer data?', intent: 'generic', className: 'collapsed acc-tog' },
] }).find((s) => s.eventName === 'faq_click');
check('faq: a toggling state class (.collapsed) is rejected — the stable class (.acc-tog) scopes the selector; root page uses equals',
  stateCls?.trigger.clickElementValue === '.acc-tog, .acc-tog *' && stateCls?.trigger.pagePathValue === '/' && stateCls?.trigger.pagePathOperator === 'equals');
// No usable shared class → the corpus-dominant TEXT route: ONE tag on {{Click Text}} ends with "?",
// still ANDed with the page condition — never per-question tags.
const noShared = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/x', kind: 'cta', text: 'Q one is long enough?', intent: 'generic', className: 'flex items-center' },
  { page: '/x', kind: 'cta', text: 'Q two is long enough?', intent: 'generic', className: 'grid gap-2' },
] });
const noSharedFaq = noShared.find((s) => s.eventName === 'faq_click');
check('faq: no shared class → ONE text-route tag ({{Click Text}} ends with "?" + {{Page Path}}), no per-question tags',
  !!noSharedFaq && noSharedFaq.trigger.clickTextValue === '?' && noSharedFaq.trigger.clickTextOperator === 'endsWith' && noSharedFaq.trigger.pagePathValue === '/x' && !noShared.some((s) => s.trigger.clickTextOperator === 'equals' && /\?$/.test(s.trigger.clickTextValue ?? '')));
// A generic component class (.btn) never scopes the selector — these group via the TEXT route instead
// (no ".btn, .btn *" page-wide selector).
const btnQ = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/x', kind: 'cta', text: 'Ready to scale?', intent: 'generic', className: 'btn btn-lg btn-primary' },
  { page: '/x', kind: 'cta', text: 'Have questions?', intent: 'generic', className: 'btn btn-lg btn-primary' },
] });
const btnFaq = btnQ.find((s) => s.eventName === 'faq_click');
check('faq: "?" buttons sharing only .btn → TEXT route (no .btn selector)', !!btnFaq && !btnFaq.trigger.clickElementValue && btnFaq.trigger.clickTextOperator === 'endsWith');
// ACCORDIONS on MULTIPLE pages (each page has >=2 distinct questions) → ONE site-wide tag, no page cond.
const multiPage = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/a', kind: 'cta', text: 'How does shipping work?', intent: 'generic', className: 'faq-q' },
  { page: '/a', kind: 'cta', text: 'What countries do you ship to?', intent: 'generic', className: 'faq-q' },
  { page: '/b', kind: 'cta', text: 'How do returns work?', intent: 'generic', className: 'faq-q' },
  { page: '/b', kind: 'cta', text: 'How long do refunds take?', intent: 'generic', className: 'faq-q' },
] });
const multiFaq = multiPage.find((s) => s.eventName === 'faq_click');
check('faq: accordions on multiple pages → ONE site-wide tag, no {{Page Path}} condition', !!multiFaq && multiFaq.page === 'site-wide' && !multiFaq.trigger.pagePathValue && multiPage.filter((s) => s.eventName === 'faq_click').length === 1);
// GUARDS against over-folding (adversarial-review catches):
// An INTENT CTA ending in "?" is never swallowed into the FAQ group — it keeps its intent tag.
const intentQ = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/faq', kind: 'cta', text: 'Q one is long enough?', intent: 'generic', className: 'faq-q' },
  { page: '/faq', kind: 'cta', text: 'Q two is long enough?', intent: 'generic', className: 'faq-q' },
  { page: '/faq', kind: 'cta', text: 'Want to book a demo?', intent: 'book_demo', className: 'faq-q' },
] });
check('faq: an intent CTA ending in "?" keeps its own tag (not swallowed into faq_click)',
  intentQ.some((s) => s.eventName === 'faq_click') && intentQ.some((s) => s.eventName !== 'faq_click' && s.trigger.clickTextValue === 'Want to book a demo?' && s.trigger.clickTextOperator === 'equals'));
// A repeated identical "?" button across pages (footer chat launcher) is NOT an accordion.
const repeated = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/a', kind: 'cta', text: 'Questions or thoughts?', intent: 'generic', className: 'chat-launcher' },
  { page: '/b', kind: 'cta', text: 'Questions or thoughts?', intent: 'generic', className: 'chat-launcher' },
] });
check('faq: a repeated identical "?" button across pages does NOT fabricate an FAQ group (stays a CTA)',
  !repeated.some((s) => s.eventName === 'faq_click') && repeated.some((s) => s.trigger.clickTextValue === 'Questions or thoughts?'));
// A stray "?" CTA on another page does NOT degrade a real accordion's class route + page scoping.
const strayMix = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/faq', kind: 'cta', text: 'Does it work offline?', intent: 'generic', className: 'accordion-button' },
  { page: '/faq', kind: 'cta', text: 'Is there a free trial?', intent: 'generic', className: 'accordion-button' },
  { page: '/home', kind: 'cta', text: 'Ready to grow your restaurant?', intent: 'generic', className: 'btn btn-primary' },
] });
const strayFaq = strayMix.find((s) => s.eventName === 'faq_click');
check('faq: a stray "?" CTA elsewhere stays OUT of the group — accordion keeps class route + page scope, stray keeps its tag',
  strayFaq?.trigger.clickElementValue === '.accordion-button, .accordion-button *' && strayFaq?.trigger.pagePathValue === '/faq' && strayMix.some((s) => s.trigger.clickTextValue === 'Ready to grow your restaurant?'));
// A PREFIXED state class (is-collapsed) is rejected like the bare one — the stable class wins.
const prefixedState = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/', kind: 'cta', text: 'Does it sync with my POS?', intent: 'generic', className: 'is-collapsed acc-tog' },
  { page: '/', kind: 'cta', text: 'Can I export my data?', intent: 'generic', className: 'is-collapsed acc-tog' },
] }).find((s) => s.eventName === 'faq_click');
check('faq: a prefixed state class (.is-collapsed) never scopes the selector', prefixedState?.trigger.clickElementValue === '.acc-tog, .acc-tog *');

// REGRESSION (image bug): no generated tag/trigger name may contain ":" (GTM rejects it).
const colonCta = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'cta', text: 'Apply Now: Today', intent: 'generic' }] });
check('names: a CTA text with ":" yields a colon-free trigger name ("Apply Now Today Trigger")', colonCta[0].trigger.name === 'Apply Now Today Click Trigger');
const allNames = [...ctaInput, ...moreCtas, ...socialOut, ...els, ...out1, ...nlForm, ...searchForm, ...loginFormS].flatMap((s) => [s.tagName, s.trigger.name]);
check('names: NO tag or trigger name contains the GTM-invalid ":" character', allNames.every((n) => !n.includes(':')));

// ── Meta (Facebook) Pixel suggestions (platforms option) ─────────────────────
// A form → Meta 'Lead'; the base google_tag → Meta 'PageView'. GA4 default unchanged; 'both' returns
// GA4 + Meta with the Meta counterpart REUSING the same trigger name (so the trigger is shared on create).
const metaInput: SuggestInput = { siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'lead-form' }], elements: [] };
// meta-only, full mode: the base pixel + the form's Lead pixel; NO GA4 tags returned.
const metaOnly = buildSuggestions(metaInput, { full: true, platforms: ['meta'] });
check('meta: platforms:[meta] returns ONLY meta_pixel suggestions (no GA4/google_tag)', metaOnly.length > 0 && metaOnly.every((s) => s.platform === 'meta_pixel'));
check('meta: the base google_tag → Meta base PageView pixel', metaOnly.some((s) => s.eventName === 'PageView' && s.tagName === 'Meta Pixel - Base Code' && s.measurementId === '{{Meta Pixel ID}}' && s.trigger.kind === 'pageview'));
const metaLead = metaOnly.find((s) => s.eventName === 'Lead');
check('meta: a contact form → Meta "Lead" pixel, pixel id = {{Meta Pixel ID}}, no event params', !!metaLead && metaLead.measurementId === '{{Meta Pixel ID}}' && metaLead.trigger.kind === 'form_submit' && !metaLead.eventParameters);
check('meta: default (no platforms) is unchanged — GA4 only, no meta_pixel', buildSuggestions(metaInput, { full: true }).every((s) => s.platform !== 'meta_pixel') && buildSuggestions(metaInput, { full: true }).some((s) => s.platform === 'ga4_event' || s.platform === 'google_tag'));
// both: GA4 + Meta, Meta counterpart reuses the SAME trigger.name as its GA4 source.
const both = buildSuggestions(metaInput, { full: true, platforms: ['ga4', 'meta'] });
const ga4Lead = both.find((s) => s.platform === 'ga4_event' && s.eventName === 'contact_form');
const bothMetaLead = both.find((s) => s.platform === 'meta_pixel' && s.eventName === 'Lead');
check('meta: platforms:[ga4,meta] returns BOTH the GA4 and the Meta form tags', !!ga4Lead && !!bothMetaLead);
check('meta: the Meta counterpart REUSES the GA4 source trigger name (shared trigger on create)', ga4Lead!.trigger.name === bothMetaLead!.trigger.name && bothMetaLead!.trigger.name === 'Contact Form Trigger');
check('meta: the GA4 base tag + its Meta base pixel share the "All Pages" trigger', both.some((s) => s.platform === 'google_tag' && s.trigger.name === 'All Pages') && both.some((s) => s.platform === 'meta_pixel' && s.eventName === 'PageView' && s.trigger.name === 'All Pages'));
// Event keyword mapping (derived from the GA4 event name): an "Add to Cart" CTA → Meta AddToCart; a
// generic outbound click → null (skipped, no Meta counterpart).
const metaEvents = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [
  { page: '/', kind: 'cta', text: 'Add to Cart', intent: 'add_to_cart' }, // event add_to_cart_click → Meta AddToCart
  { page: '/blog', kind: 'outbound', text: 'partner', href: 'https://partner.com' }, // generic click → no meta
] }, { platforms: ['meta'] });
check('meta: an "Add to Cart" CTA → Meta "AddToCart"; a generic outbound click yields NO meta counterpart', metaEvents.some((s) => s.eventName === 'AddToCart') && !metaEvents.some((s) => s.eventName === 'outbound_click') && metaEvents.every((s) => s.platform === 'meta_pixel'));

// ── Additional ad platforms (multi-select: pinterest / tiktok / linkedin / reddit / google_ads) ──
// Each platform derives from the SAME GA4 suggestions and REUSES their trigger name (shared trigger on
// create). A form → the platform's lead/registration event; the base google_tag → the platform's base
// tag; an add_to_cart CTA → the platform's AddToCart-equivalent. Default platforms:['ga4'] unchanged.
{
  const formInput: SuggestInput = { siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'lead-form' }], elements: [] };
  const ga4Base = buildSuggestions(formInput, { full: true }); // GA4 config + the contact_form tag
  const ga4Trig = new Set(ga4Base.map((s) => s.trigger.name));

  // Pinterest: base google_tag → Pinterest base ('pagevisit'); a contact form → Pinterest 'lead'.
  const pin = buildSuggestions(formInput, { full: true, platforms: ['pinterest'] });
  check('pinterest: platforms:[pinterest] returns ONLY pinterest_tag suggestions', pin.length > 0 && pin.every((s) => s.platform === 'pinterest_tag'));
  check('pinterest: base google_tag → Pinterest base tag (pagevisit, All Pages, {{Pinterest Tag ID}})',
    pin.some((s) => s.eventName === 'pagevisit' && s.tagName === 'Pinterest - Base Tag' && s.measurementId === '{{Pinterest Tag ID}}' && s.trigger.name === 'All Pages'));
  const pinLead = pin.find((s) => s.eventName === 'lead');
  check('pinterest: a contact form → Pinterest "lead", no event params, reuses the GA4 trigger name',
    !!pinLead && pinLead.measurementId === '{{Pinterest Tag ID}}' && !pinLead.eventParameters && ga4Trig.has(pinLead.trigger.name) && pinLead.trigger.name === 'Contact Form Trigger');

  // TikTok: base → 'Pageview'; contact form → 'Contact' (contact_form matches the "contact" keyword).
  const tik = buildSuggestions(formInput, { full: true, platforms: ['tiktok'] });
  check('tiktok: platforms:[tiktok] returns ONLY tiktok_pixel suggestions', tik.length > 0 && tik.every((s) => s.platform === 'tiktok_pixel'));
  check('tiktok: base google_tag → TikTok base pixel (Pageview, All Pages, {{TikTok Pixel ID}})',
    tik.some((s) => s.eventName === 'Pageview' && s.tagName === 'TikTok - Base Pixel' && s.measurementId === '{{TikTok Pixel ID}}' && s.trigger.name === 'All Pages'));
  const tikForm = tik.find((s) => s.eventName === 'Contact');
  check('tiktok: a contact form → TikTok "Contact", reuses the GA4 trigger name', !!tikForm && !tikForm.eventParameters && ga4Trig.has(tikForm.trigger.name));
  // A generate_lead-style event → TikTok "SubmitForm" (the design's form→SubmitForm mapping). A CTA
  // labelled "Generate Lead" yields the GA4 event generate_lead_click → normalizes to generatelead… → SubmitForm.
  const tikLead = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'cta', text: 'Generate Lead', intent: 'generic' }] }, { platforms: ['tiktok'] });
  check('tiktok: a generate_lead-style event → TikTok "SubmitForm"', tikLead.some((s) => s.eventName === 'SubmitForm'));

  // LinkedIn: ONLY the base Insight tag (per-event conversions are Campaign-Manager-side).
  const li = buildSuggestions(formInput, { full: true, platforms: ['linkedin'] });
  check('linkedin: platforms:[linkedin] returns EXACTLY the one base Insight tag',
    li.length === 1 && li[0].platform === 'linkedin_insight' && li[0].tagName === 'LinkedIn - Insight Tag' && li[0].measurementId === '{{LinkedIn Partner ID}}' && li[0].trigger.name === 'All Pages');
  check('linkedin: a ga4_event yields NO LinkedIn counterpart (only the base tag)', !li.some((s) => s.eventName === 'contact_form' || s.eventName === 'Lead'));

  // Reddit: base → 'PageVisit'; contact form → 'Lead'.
  const rd = buildSuggestions(formInput, { full: true, platforms: ['reddit'] });
  check('reddit: platforms:[reddit] returns ONLY reddit_pixel suggestions', rd.length > 0 && rd.every((s) => s.platform === 'reddit_pixel'));
  check('reddit: base google_tag → Reddit base pixel (PageVisit, All Pages, {{Reddit Pixel ID}})',
    rd.some((s) => s.eventName === 'PageVisit' && s.tagName === 'Reddit - Base Pixel' && s.measurementId === '{{Reddit Pixel ID}}' && s.trigger.name === 'All Pages'));
  const rdLead = rd.find((s) => s.eventName === 'Lead');
  check('reddit: a contact form → Reddit "Lead", reuses the GA4 trigger name', !!rdLead && !rdLead.eventParameters && ga4Trig.has(rdLead.trigger.name));

  // Google Ads: base → Conversion Linker; a form (conversion) → Google Ads Conversion with ID + Label.
  const ads = buildSuggestions(formInput, { full: true, platforms: ['google_ads'] });
  check('google_ads: base google_tag → a Conversion Linker (All Pages, no id fields)',
    ads.some((s) => s.platform === 'conversion_linker' && s.tagName === 'Google Ads - Conversion Linker' && s.trigger.name === 'All Pages'));
  const adsConv = ads.find((s) => s.platform === 'google_ads_conversion');
  check('google_ads: a contact form → Google Ads Conversion (Conversion ID + Label vars), reuses the GA4 trigger name',
    !!adsConv && adsConv.measurementId === '{{Google Ads Conversion ID}}' && adsConv.conversionLabel === '{{Google Ads Conversion Label}}' && ga4Trig.has(adsConv.trigger.name));

  // add_to_cart CTA → each platform's AddToCart-equivalent (Pinterest addtocart, TikTok/Reddit AddToCart).
  const cartInput: SuggestInput = { siteHost: 'a.com', forms: [], elements: [{ page: '/p', kind: 'cta', text: 'Add to Cart', intent: 'add_to_cart' }] };
  const cartPin = buildSuggestions(cartInput, { platforms: ['pinterest'] });
  const cartTik = buildSuggestions(cartInput, { platforms: ['tiktok'] });
  const cartRd = buildSuggestions(cartInput, { platforms: ['reddit'] });
  check('add_to_cart CTA → Pinterest "addtocart" / TikTok "AddToCart" / Reddit "AddToCart"',
    cartPin.some((s) => s.eventName === 'addtocart') && cartTik.some((s) => s.eventName === 'AddToCart') && cartRd.some((s) => s.eventName === 'AddToCart'));

  // A generic outbound click → NO counterpart for any conversion-focused platform.
  const outInput: SuggestInput = { siteHost: 'a.com', forms: [], elements: [{ page: '/b', kind: 'outbound', text: 'partner', href: 'https://partner.com' }] };
  check('google_ads: a generic outbound click yields NO Google Ads conversion (conversion-focused)',
    !buildSuggestions(outInput, { platforms: ['google_ads'] }).some((s) => s.platform === 'google_ads_conversion'));
  check('pinterest/tiktok/reddit: a generic outbound click yields NO pixel event counterpart',
    !buildSuggestions(outInput, { platforms: ['pinterest'] }).length && !buildSuggestions(outInput, { platforms: ['tiktok'] }).length && !buildSuggestions(outInput, { platforms: ['reddit'] }).length);

  // Multiple platforms at once: GA4 + all five → each platform's tags present, each reusing a GA4 trigger.
  const allSel = buildSuggestions(formInput, { full: true, platforms: ['ga4', 'meta', 'pinterest', 'tiktok', 'linkedin', 'reddit', 'google_ads'] });
  const allGa4Trig = new Set(allSel.filter((s) => s.platform === 'ga4_event' || s.platform === 'google_tag').map((s) => s.trigger.name));
  check('multi: GA4 + Meta + Pinterest + TikTok + LinkedIn + Reddit + Google Ads all present',
    ['ga4_event', 'meta_pixel', 'pinterest_tag', 'tiktok_pixel', 'linkedin_insight', 'reddit_pixel', 'conversion_linker'].every((pl) => allSel.some((s) => s.platform === pl)));
  check('multi: every non-GA4 tag reuses a GA4 trigger name (shared trigger on create)',
    allSel.filter((s) => s.platform !== 'ga4_event' && s.platform !== 'google_tag').every((s) => allGa4Trig.has(s.trigger.name)));

  // Default (platforms:['ga4']) is byte-identical to no-platforms: no non-GA4 tag leaks.
  check('default: platforms:[ga4] emits NO non-GA4 platform tags (unchanged behavior)',
    buildSuggestions(formInput, { full: true, platforms: ['ga4'] }).every((s) => s.platform === 'ga4_event' || s.platform === 'google_tag'));
}

// ── CTA intent → platform mapping (intent-first, NOT event-name text) ─────────
// A GA4 CTA whose EVENT NAME lacks a recognized keyword (free_audit_click, schedule_strategy_call_click)
// still gets its correct Meta/Google-Ads counterpart, because the derivers map by the classified CTA
// INTENT — not the coincidental substrings in the event name. This is the reported CSV bug.
{
  const gaCta = (text: string, intent: import('../types.js').CtaIntent): import('../types.js').DetectedElement =>
    ({ page: '/', kind: 'cta', text, intent });
  // get_started ("Free Audit") → a conversion (Meta Lead + Google Ads Conversion). Its event name is
  // free_audit_click / get_started_click — no 'lead'/'contact'/'form' keyword, so the OLD keyword path
  // gave it NO counterpart. The intent-first path now maps it via get_started → lead.
  const freeAudit = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [gaCta('Free Audit', 'get_started')] }, { full: true, platforms: ['ga4', 'meta', 'google_ads'] });
  const faMeta = freeAudit.find((s) => s.platform === 'meta_pixel' && s.eventName === 'Lead');
  const faAds = freeAudit.find((s) => s.platform === 'google_ads_conversion');
  const faGa4 = freeAudit.find((s) => s.platform === 'ga4_event' && /free audit/i.test(s.label));
  check('cta-intent: get_started CTA "Free Audit" → Meta "Lead" (via intent, not the event-name text)', !!faMeta);
  check('cta-intent: get_started CTA "Free Audit" → a Google Ads Conversion (ID + Label vars)',
    !!faAds && faAds.measurementId === '{{Google Ads Conversion ID}}' && faAds.conversionLabel === '{{Google Ads Conversion Label}}');
  check('cta-intent: the Meta counterpart reuses the GA4 CTA trigger name (shared trigger on create)',
    !!faGa4 && !!faMeta && faMeta.trigger.name === faGa4.trigger.name);

  // book_demo ("Schedule Strategy Call") → Meta Lead — NOT Contact. The event name is
  // schedule_strategy_call_click; the OLD keyword path would have matched the 'call' substring → Contact.
  // Intent-first maps book_demo → lead → Meta Lead.
  const strategyCall = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [gaCta('Schedule Strategy Call', 'book_demo')] }, { platforms: ['meta'] });
  check('cta-intent: book_demo CTA "Schedule Strategy Call" → Meta "Lead" (NOT "Contact" via the "call" substring)',
    strategyCall.some((s) => s.eventName === 'Lead') && !strategyCall.some((s) => s.eventName === 'Contact'));
  const strategyAds = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [gaCta('Schedule Strategy Call', 'book_demo')] }, { platforms: ['google_ads'] });
  check('cta-intent: book_demo CTA → a Google Ads Conversion (lead meaning)', strategyAds.some((s) => s.platform === 'google_ads_conversion'));

  // learn_more ("View Client Results") is NOT a conversion → NO meta_pixel, NO google_ads_conversion.
  const learnMore = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [gaCta('View Client Results', 'learn_more')] }, { platforms: ['ga4', 'meta', 'google_ads'] });
  check('cta-intent: learn_more CTA "View Client Results" → NO meta_pixel and NO google_ads_conversion (GA4 only)',
    learnMore.some((s) => s.platform === 'ga4_event') && !learnMore.some((s) => s.platform === 'meta_pixel') && !learnMore.some((s) => s.platform === 'google_ads_conversion'));

  // The NON-CTA keyword path is unchanged: an email_click still → Meta Contact (no ctaIntent → keyword).
  const emailMeta = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'email', text: 'hi', href: 'mailto:hi@a.com' }] }, { platforms: ['meta'] });
  check('cta-intent: a NON-CTA email_click still → Meta "Contact" (keyword path unchanged)', emailMeta.some((s) => s.eventName === 'Contact'));

  // The ecommerce dataLayer add_to_cart tag (NO ctaIntent) still maps via keyword → Meta AddToCart.
  const ecomAtc = buildSuggestions({ siteHost: 'shop.com', forms: [], elements: [], websiteType: 'ecommerce' }, { platforms: ['meta'] });
  check('cta-intent: the ecommerce dataLayer add_to_cart tag (no ctaIntent) still → Meta "AddToCart" via keyword', ecomAtc.some((s) => s.eventName === 'AddToCart'));

  // Google Ads: a search-intent CTA is NOT a conversion → no google_ads_conversion; but it IS a Meta Search.
  const searchCta = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [gaCta('Search', 'search')] }, { platforms: ['meta', 'google_ads'] });
  check('cta-intent: search CTA → Meta "Search" but NO Google Ads Conversion (search is not an Ads conversion)',
    searchCta.some((s) => s.eventName === 'Search' && s.platform === 'meta_pixel') && !searchCta.some((s) => s.platform === 'google_ads_conversion'));
}

// ── eCommerce funnel suggestions (websiteType-gated) ─────────────────────────
{
  const ECOM_EVENTS = ['view_item_list', 'select_item', 'view_item', 'add_to_cart', 'remove_from_cart', 'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'];
  // The explicit GA4 event parameters each ecommerce event carries (from the GA4 ecommerce reference).
  const ECOM_PARAMS: Record<string, string[]> = {
    view_item_list: ['items', 'item_list_id', 'item_list_name'],
    select_item: ['items', 'item_list_id', 'item_list_name'],
    view_item: ['items', 'value', 'currency'],
    add_to_cart: ['items', 'value', 'currency'],
    remove_from_cart: ['items', 'value', 'currency'],
    view_cart: ['items', 'value', 'currency'],
    begin_checkout: ['items', 'value', 'currency', 'coupon'],
    add_shipping_info: ['items', 'value', 'currency', 'coupon', 'shipping_tier'],
    add_payment_info: ['items', 'value', 'currency', 'coupon', 'payment_type'],
    purchase: ['items', 'value', 'currency', 'transaction_id', 'coupon', 'shipping', 'tax'],
  };
  // An ecommerce input emits ALL ten GA4 ecommerce funnel tags: custom_event triggers + EXPLICIT event
  // parameters valued from {{Ecommerce X}} Data Layer variables.
  const ecomInput: SuggestInput = { siteHost: 'shop.com', forms: [], elements: [], websiteType: 'ecommerce' };
  const ecomGa4 = buildSuggestions(ecomInput);
  for (const ev of ECOM_EVENTS) {
    const t = ecomGa4.find((s) => s.platform === 'ga4_event' && s.eventName === ev);
    const gotParams = (t?.eventParameters ?? []).map((p) => `${p.name}=${p.value}`);
    const wantParams = ECOM_PARAMS[ev].map((p) => {
      const words = p.split('_').map((w) => (w === 'id' ? 'ID' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
      return `${p}={{Ecommerce ${words}}}`;
    });
    check(`ecom: ecommerce input emits GA4 "${ev}" (custom_event + explicit {{Ecommerce X}} params)`,
      !!t && t.trigger.kind === 'custom_event' && t.trigger.eventName === ev && JSON.stringify(gotParams) === JSON.stringify(wantParams));
  }
  check('ecom: all ten ecommerce GA4 tags are high-confidence and site-wide', ECOM_EVENTS.every((ev) => { const t = ecomGa4.find((s) => s.platform === 'ga4_event' && s.eventName === ev); return t?.confidence === 'high' && t?.page === 'site-wide'; }));

  // A NON-ecommerce input emits NONE of them (byte-identical default behavior).
  const nonEcom: SuggestInput = { siteHost: 'blog.com', forms: [], elements: [], websiteType: 'non_ecommerce' };
  check('ecom: a non_ecommerce input emits NONE of the ecommerce events', buildSuggestions(nonEcom).every((s) => !ECOM_EVENTS.includes(s.eventName)));
  // Undefined websiteType (older callers) is also treated as non-ecommerce (no ecommerce suggestions).
  const noType: SuggestInput = { siteHost: 'blog.com', forms: [], elements: [] };
  check('ecom: undefined websiteType emits NONE of the ecommerce events', buildSuggestions(noType).every((s) => !ECOM_EVENTS.includes(s.eventName)));

  // With platforms:['ga4','meta'] the ecommerce GA4 tags get their Meta counterparts WITH ecommerce
  // Object Properties from the dlv variables. Mapping: add_to_cart→AddToCart, purchase→Purchase,
  // begin_checkout→InitiateCheckout, add_payment_info→AddPaymentInfo, view_item→ViewContent.
  const ecomBoth = buildSuggestions(ecomInput, { platforms: ['ga4', 'meta'] });
  const metaFor = (metaEvent: string) => ecomBoth.find((s) => s.platform === 'meta_pixel' && s.eventName === metaEvent);
  // Only the safe 1:1 bindings value + currency — `contents` is intentionally NOT bound to the raw
  // GA4 items array (Meta's contents needs a reshaped [{id,quantity,item_price}] shape).
  const ecomMetaProps = [
    { name: 'value', value: '{{dlv - ecommerce.value}}' },
    { name: 'currency', value: '{{dlv - ecommerce.currency}}' },
  ];
  const propsMatch = (t: ReturnType<typeof buildSuggestions>[number] | undefined): boolean =>
    !!t?.eventParameters && JSON.stringify(t.eventParameters) === JSON.stringify(ecomMetaProps);
  check('ecom: add_to_cart → Meta AddToCart with ecommerce Object Properties (value/currency)', propsMatch(metaFor('AddToCart')));
  check('ecom: purchase → Meta Purchase with ecommerce Object Properties', propsMatch(metaFor('Purchase')));
  check('ecom: begin_checkout → Meta InitiateCheckout with ecommerce Object Properties', propsMatch(metaFor('InitiateCheckout')));
  check('ecom: add_payment_info → Meta AddPaymentInfo with ecommerce Object Properties', propsMatch(metaFor('AddPaymentInfo')));
  check('ecom: view_item → Meta ViewContent with ecommerce Object Properties', propsMatch(metaFor('ViewContent')));
  // remove_from_cart / view_cart / add_shipping_info have NO Meta standard event → no counterpart.
  check('ecom: remove_from_cart / view_cart / add_shipping_info have NO Meta counterpart', !ecomBoth.some((s) => s.platform === 'meta_pixel' && /remove|viewcart|shipping/i.test(s.eventName)));
  // A NON-ecommerce Meta event (a form Lead) must NOT gain value/currency Object Properties.
  const leadInput: SuggestInput = { siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'lead-form' }], elements: [] };
  const leadMeta = buildSuggestions(leadInput, { platforms: ['meta'] }).find((s) => s.eventName === 'Lead');
  check('ecom: a form Lead Meta tag has NO ecommerce Object Properties (undefined eventParameters)', !!leadMeta && !leadMeta.eventParameters);
}

// ── near-duplicate click tags: a shorter click-text inside another CTA (won't fire / double-count) ──
{
  const mk = (text: string, op = 'equals'): SuggestedTag =>
    ({ trigger: { kind: 'link_click', clickTextValue: text, clickTextOperator: op } } as unknown as SuggestedTag);
  const s = [mk('Free Audit'), mk('Get Free Audit'), mk('Book a Call')];
  flagOverlappingClickTexts(s);
  check('overlap: shorter "Free Audit" flagged (contained in "Get Free Audit")', /contained in another CTA/.test(s[0].note ?? ''));
  check('overlap: names the containing CTA', (s[0].note ?? '').includes('Get Free Audit'));
  check('overlap: longer "Get Free Audit" NOT flagged', !s[1].note);
  check('overlap: unrelated "Book a Call" NOT flagged', !s[2].note);
  // Word-boundary only: "Audit" is NOT "inside" "Auditorium Tickets".
  const s2 = [mk('Audit'), mk('Auditorium Tickets')];
  flagOverlappingClickTexts(s2);
  check('overlap: whole-word only ("Audit" not inside "Auditorium")', !s2[0].note);
  // A 'contains' trigger isn't an equals under-fire risk → not flagged.
  const s3 = [mk('Free Audit', 'contains'), mk('Get Free Audit')];
  flagOverlappingClickTexts(s3);
  check('overlap: only "equals" triggers are flagged', !s3[0].note);
  // An existing note is preserved (appended, not overwritten).
  const withNote = mk('Free Audit');
  withNote.note = 'prior note.';
  flagOverlappingClickTexts([withNote, mk('Get Free Audit')]);
  check('overlap: appends to an existing note', withNote.note.startsWith('prior note.') && /contained in another CTA/.test(withNote.note));
}

console.log(`\nTag-suggest: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
