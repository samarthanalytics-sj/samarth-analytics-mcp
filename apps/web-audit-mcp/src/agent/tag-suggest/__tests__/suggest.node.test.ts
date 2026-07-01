/**
 * Tag-suggestion engine — pure-logic tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/suggest.node.test.ts
 */
import { detectFormProvider, detectEmbeddedForm } from '../providers.js';
import { buildSuggestions } from '../suggest.js';
import { isYouTubeEmbed } from '../video.js';
import type { PageSignals, SuggestInput, DetectedForm } from '../types.js';

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
check('form: contact → contact_form on form_submit', out1.length === 1 && out1[0].eventName === 'contact_form' && out1[0].trigger.kind === 'form_submit');
check('form: label names the provider', out1[0].label.includes('hubspot'));
check('form: directly creatable (platform + measurementId)', out1[0].platform === 'ga4_event' && out1[0].measurementId === '{{GA4 Measurement ID}}');
check('naming: tag "GA4 Event - Contact Form Tag", trigger "Contact Form Trigger"', out1[0].tagName === 'GA4 - Event - Contact Form Tag' && out1[0].trigger.name === 'Contact Form Trigger');
const provLow = { vendor: 'unknown' as const, confidence: 'low' as const, evidence: '' };
const searchForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'search', action: '', provider: provLow }], elements: [] });
check('form: search form → ONE view_search_results site-search tag; ships only resolvable params + a note to add search_term', searchForm.length === 1 && searchForm[0].eventName === 'view_search_results' && searchForm[0].tagName === 'GA4 - Event - Site Search Tag' && !(searchForm[0].eventParameters ?? []).some((p) => p.value === '{{Search Term}}') && /search_term/.test(searchForm[0].note ?? ''));
// A search bar on MANY pages (its action varies per page) is ONE header component → ONE site-wide tag.
const multiSearch = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/a', purpose: 'search', action: '/a/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
  { page: '/b', purpose: 'search', action: '/b/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
  { page: '/c', purpose: 'search', action: '/c/results', provider: provLow, fields: [{ type: 'text', name: 'search', required: false }] },
], elements: [] });
const siteSearches = multiSearch.filter((s) => s.eventName === 'view_search_results');
check('form: a search bar on many pages (varying actions) collapses to ONE site-wide search tag', siteSearches.length === 1 && siteSearches[0].page === 'site-wide' && !siteSearches[0].trigger.pagePathValue);
const loginFormS = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'login', action: '', provider: provLow }], elements: [] });
check('form: login form → login event + "GA4 Event - Login Form Tag"', loginFormS.length === 1 && loginFormS[0].eventName === 'login' && loginFormS[0].tagName === 'GA4 - Event - Login Form Tag');
check('form: checkout STILL produces no suggestion (ecommerce, deferred)', buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'checkout', action: '', provider: provLow }], elements: [] }).length === 0);
const nlForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'newsletter', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: newsletter → "GA4 Event - Newsletter Form Tag" + newsletter_form', nlForm[0].tagName === 'GA4 - Event - Newsletter Form Tag' && nlForm[0].eventName === 'newsletter_form' && nlForm[0].trigger.name === 'Newsletter Form Trigger');
const otherFormName = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/x', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: "other" → "GA4 Event - Form Submission Tag" + form_submission', otherFormName[0].tagName === 'GA4 - Event - Form Submission Tag' && otherFormName[0].eventName === 'form_submission');

// ── field/provider-aware form tracking ───────────────────────────────────────
const prov0 = { vendor: 'unknown' as const, confidence: 'low' as const, evidence: '' };
const formWithId = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'contact', action: 'https://a.com/x', provider: prov0, method: 'post', formId: 'contact-form', formClasses: 'contact-form', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] }], elements: [] });
check('form: scoped to its id → {{Form ID}} equals, no caveat', formWithId[0].trigger.formIdValue === 'contact-form' && formWithId[0].trigger.formIdOperator === 'equals' && !formWithId[0].note);

// ── form NAME from its heading/title (not just the purpose) ──────────────────
const titled = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'lead', title: 'Get a Free Consultation', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: titled form → tag "GA4 Event - Get a Free Consultation Form Tag" + matching trigger',
  titled[0].tagName === 'GA4 - Event - Get A Free Consultation Form Tag' && titled[0].trigger.name === 'Get A Free Consultation Form Trigger');
check('form: titled form keeps its purpose event (contact_form)', titled[0].eventName === 'contact_form');
// A title that already says "Form" isn't doubled up; no title → purpose label.
const titledForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'n1', title: 'Newsletter Form' }], elements: [] });
check('form: title already ending "Form" is not doubled ("Newsletter Form", not "Newsletter Form Form")', titledForm[0].tagName === 'GA4 - Event - Newsletter Form Tag');
const untitled = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'c2' }], elements: [] });
check('form: no title → falls back to the purpose label ("Contact Form")', untitled[0].tagName === 'GA4 - Event - Contact Form Tag');
check('form: evidence lists the field signature', /fields: email, message/.test(formWithId[0].evidence) && /id=#contact-form/.test(formWithId[0].evidence));

// Instance-unique class (numeric instance, e.g. gform_1) → {{Form Classes}} contains.
const formInstanceClass = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row gform_1 gform_wrapper', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: instance class gform_1 → {{Form Classes}} contains (skips "row"/"gform_wrapper")', formInstanceClass[0].trigger.formClassesValue === 'gform_1' && formInstanceClass[0].trigger.formClassesOperator === 'contains');

// A SHARED framework wrapper class (wpcf7-form, bare "form") is NOT used to scope. When the same
// form (no usable id/class) appears on MULTIPLE pages it is site-wide → stays unscoped, the catch-all
// covers it. (A single-page no-id form is page-scoped instead — see the "full:" cases below.)
const formWrapperClass = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'wpcf7-form form', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/d', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'wpcf7-form form', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
check('form: wrapper class (wpcf7-form/"form") is NOT used; site-wide form stays unscoped + "every form" note', !formWrapperClass[0].trigger.formClassesValue && !formWrapperClass[0].trigger.pagePathValue && /every form submit/i.test(formWrapperClass[0].note ?? ''));

const formNoScope = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/c', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row container', fields: [] },
  { page: '/d', purpose: 'contact', action: '', provider: prov0, method: 'post', formClasses: 'row container', fields: [] },
], elements: [] });
check('form: no id/class on multiple pages → note that it fires on EVERY form submit', !formNoScope[0].trigger.formIdValue && !formNoScope[0].trigger.formClassesValue && !formNoScope[0].trigger.pagePathValue && /every form submit/i.test(formNoScope[0].note ?? ''));

const hubForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: { vendor: 'hubspot', confidence: 'high', evidence: 'js.hsforms.net' }, method: 'js', formId: 'hsForm_123' }], elements: [] });
check('form: HubSpot (embedded) → note recommends a Custom Event trigger', /custom event/i.test(hubForm[0].note ?? '') && /hubspot/i.test(hubForm[0].note ?? ''));

const jsForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, method: 'js', fields: [{ type: 'email', name: 'email', required: true }] }], elements: [] });
check('form: JS/div form → note the native Form Submission trigger may not fire', /native <form> submit|may not fire/i.test(jsForm[0].note ?? ''));

// Pardot FORM HANDLER (native <form> POST) → native trigger DOES fire: scoped by id, no "won't fire" note.
const pardotHandler = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: 'https://go.pardot.com/l/1/2/form-handler', provider: { vendor: 'pardot', confidence: 'high', evidence: 'action pardot.com' }, method: 'post', formId: 'pardot-form' }], elements: [] });
check('form: Pardot form-handler (native POST) → scoped by id, NO iframe/Custom-Event note', pardotHandler[0].trigger.formIdValue === 'pardot-form' && !/iframe|custom event/i.test(pardotHandler[0].note ?? ''));

// Two DIFFERENT contact forms (different ids) stay as TWO scoped tags, not merged.
const twoForms = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'contact-main' },
  { page: '/', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'footer-contact' },
], elements: [] });
check('form: two contact forms with different ids → two scoped tags (not collapsed)', twoForms.filter((s) => s.eventName === 'contact_form').length === 2);

// A NON-UNIQUE id (same id on two DIFFERENT forms) can't scope by id. When the forms are also
// SITE-WIDE (each signature spans several pages) they can't be page-scoped either → collision note.
const sharedId = buildSuggestions({ siteHost: 'a.com', forms: [
  { page: '/contact', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] },
  { page: '/about', purpose: 'contact', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }, { type: 'textarea', name: 'message', required: false }] },
  { page: '/', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }] },
  { page: '/blog', purpose: 'newsletter', action: '', provider: prov0, method: 'post', formId: 'gform_1', fields: [{ type: 'email', name: 'email', required: true }] },
], elements: [] });
check('form: shared id across different SITE-WIDE forms → no {{Form ID}} scope, no page scope + a collision note', sharedId.every((s) => !s.trigger.formIdValue && !s.trigger.pagePathValue && /shares this id|unique id/i.test(s.note ?? '')));

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
check('form: contact_form carries form_id={{Form ID}} + form_name (static form label)',
  leadParams.some((p) => p.name === 'form_id' && p.value === '{{Form ID}}') &&
  leadParams.some((p) => p.name === 'form_name' && p.value === 'Contact Form'));
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

const otherForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/x', purpose: 'other', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] });
check('form: "other" uses form_submission (not the reserved EM form_submit)', otherForm[0].eventName === 'form_submission');

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
const subs = ctaInput.filter((s) => s.eventName === 'subscribe_click');
check('cta: each distinct subscribe text → its OWN tag named for that exact text (no regex collapse)',
  subs.length === 2 &&
  subs.some((s) => s.tagName === 'GA4 - Event - Subscribe Now Click Tag' && s.trigger.name === 'Subscribe Now Click Trigger') &&
  subs.some((s) => s.tagName === 'GA4 - Event - Subscribe Click Tag'));
check('cta: named-intent trigger is a plain {{Click Text}} equals <text> (not matchRegex)',
  subs.every((s) => s.trigger.clickTextOperator === 'equals') &&
  ctaInput.find((s) => s.tagName === 'GA4 - Event - Subscribe Now Click Tag')?.trigger.clickTextValue === 'Subscribe now');
const demo = ctaInput.find((s) => s.eventName === 'book_demo_click');
check('cta: tag named for the actual button text "Request a demo", trigger {{Click Text}} equals it',
  demo?.tagName === 'GA4 - Event - Request A Demo Click Tag' && demo?.trigger.name === 'Request A Demo Click Trigger' &&
  demo?.trigger.clickTextValue === 'Request a demo' && demo?.trigger.clickTextOperator === 'equals');
check('cta: Learn More tag named for the button text + own event', ctaInput.find((s) => s.eventName === 'learn_more_click')?.tagName === 'GA4 - Event - Learn More Click Tag');
check('cta: Add to Cart uses non-reserved add_to_cart_click event (not the GA4 ecommerce add_to_cart)',
  ctaInput.find((s) => s.eventName === 'add_to_cart_click')?.tagName === 'GA4 - Event - Add To Cart Click Tag' && !ctaInput.some((s) => s.eventName === 'add_to_cart'));
const genericCtas = ctaInput.filter((s) => s.eventName === 'cta_click');
check('cta: generic "Buy now" → {{Click Text}} equals "Buy now" + "Buy now Trigger" + same text collapses site-wide', genericCtas.length === 1 && genericCtas[0].page === 'site-wide' && genericCtas[0].trigger.clickTextValue === 'Buy now' && genericCtas[0].trigger.clickTextOperator === 'equals' && genericCtas[0].trigger.name === 'Buy Now Click Trigger');
check('cta: every CTA carries dynamic click_text={{Click Text}}', ctaInput.every((s) => s.eventParameters?.some((p) => p.name === 'click_text' && p.value === '{{Click Text}}')));
check('cta: ALL CTA triggers use a plain "equals" condition (no regex)', ctaInput.every((s) => s.trigger.clickTextOperator === 'equals'));

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

// ── full mode: GA4 Configuration + All-form catch-all ────────────────────────
const fullForm = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'contact', action: '', provider: prov0, formId: 'c' }], elements: [] }, { full: true });
check('full: GA4 Configuration (google_tag) is always FIRST, on All Pages', fullForm[0].platform === 'google_tag' && fullForm[0].tagName === 'GA4 Configuration' && fullForm[0].trigger.kind === 'pageview' && fullForm[0].tagId === '{{GA4 Measurement ID}}');
check('full: "All Form Submissions" catch-all when a form exists (form_submit, no scope)', fullForm.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag' && s.eventName === 'form_submission' && s.trigger.kind === 'form_submit' && !s.trigger.formIdValue));
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
check('full: SCOPED / purpose form tag is KEPT (contact_form not dropped by the catch-all)', fullForm.some((s) => s.eventName === 'contact_form'));
// A single-page generic form (no id/class) is now PAGE-SCOPED to its own tag (per-form), instead of
// being folded into the catch-all. The All-Forms catch-all is still offered alongside it.
const fullOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/contact', purpose: 'other', action: '', provider: prov0 }], elements: [] }, { full: true });
check('full: a single-page generic form gets its OWN page-scoped tag (not folded)', fullOther.some((s) => s.eventName === 'form_submission' && s.trigger.kind === 'form_submit' && s.trigger.pagePathValue === '/contact'));
check('full: the All-Forms catch-all is still present alongside the page-scoped form', fullOther.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag' && !s.trigger.pagePathValue && !s.trigger.formIdValue));
// A SITE-WIDE generic form (same form on >1 page) has no single page → stays unscoped → folded into
// the catch-all (no per-page tag), so generic forms don't double up across pages.
const siteWideOther = buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/a', purpose: 'other', action: '', provider: prov0 }, { page: '/b', purpose: 'other', action: '', provider: prov0 }], elements: [] }, { full: true });
check('full: a site-wide generic form folds into the catch-all (one form_submission, no per-page tag)', siteWideOther.filter((s) => s.eventName === 'form_submission' && s.trigger.kind === 'form_submit').length === 1 && siteWideOther.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag') && !siteWideOther.some((s) => s.trigger.pagePathValue));

// REGRESSION (image bug): no generated tag/trigger name may contain ":" (GTM rejects it).
const colonCta = buildSuggestions({ siteHost: 'a.com', forms: [], elements: [{ page: '/', kind: 'cta', text: 'Apply Now: Today', intent: 'generic' }] });
check('names: a CTA text with ":" yields a colon-free trigger name ("Apply Now Today Trigger")', colonCta[0].trigger.name === 'Apply Now Today Click Trigger');
const allNames = [...ctaInput, ...moreCtas, ...socialOut, ...els, ...out1, ...nlForm, ...searchForm, ...loginFormS].flatMap((s) => [s.tagName, s.trigger.name]);
check('names: NO tag or trigger name contains the GTM-invalid ":" character', allNames.every((n) => !n.includes(':')));

console.log(`\nTag-suggest: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
