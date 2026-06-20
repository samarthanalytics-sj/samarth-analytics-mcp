/**
 * Tag-suggestion engine — pure-logic tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/suggest.node.test.ts
 */
import { detectFormProvider } from '../providers.js';
import { buildSuggestions } from '../suggest.js';
import type { PageSignals, SuggestInput, DetectedForm } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sig = (o: Partial<PageSignals>): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], ...o });

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

// ── form → suggestion ───────────────────────────────────────────────────────
const contactForm: DetectedForm = { page: '/contact', purpose: 'contact', action: 'https://js.hsforms.net/x', provider: { vendor: 'hubspot', confidence: 'high', evidence: 'script js.hsforms.net' } };
const out1 = buildSuggestions({ siteHost: 'acme.com', forms: [contactForm], elements: [] });
check('form: contact → generate_lead on form_submit', out1.length === 1 && out1[0].eventName === 'generate_lead' && out1[0].trigger.kind === 'form_submit');
check('form: label names the provider', out1[0].label.includes('hubspot'));
check('form: directly creatable (platform + measurementId)', out1[0].platform === 'ga4_event' && out1[0].measurementId === '{{GA4 Measurement ID}}');
check('naming: tag "GA4 Event - Generate Lead", trigger "Form Submit - Contact"', out1[0].tagName === 'GA4 Event - Generate Lead' && out1[0].trigger.name === 'Form Submit - Contact');
check('form: search/login produce NO suggestion', buildSuggestions({ siteHost: 'a.com', forms: [{ page: '/', purpose: 'search', action: '', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }], elements: [] }).length === 0);

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
check('naming: email tag "GA4 Event - Email Click", trigger "Link Click - Email"', byEvent('email_click')?.tagName === 'GA4 Event - Email Click' && byEvent('email_click')?.trigger.name === 'Link Click - Email');

// ── event parameters: GA4-standard, valued by GTM built-in variables ─────────
const emailParams = byEvent('email_click')?.eventParameters ?? [];
check('email: carries link_url={{Click URL}} + link_text={{Click Text}}',
  emailParams.some((p) => p.name === 'link_url' && p.value === '{{Click URL}}') &&
  emailParams.some((p) => p.name === 'link_text' && p.value === '{{Click Text}}'));
check('download/outbound also carry link_url/link_text params',
  (byEvent('file_download')?.eventParameters?.length ?? 0) >= 2 && (byEvent('outbound_click')?.eventParameters?.length ?? 0) >= 2);
const leadParams = out1[0].eventParameters ?? [];
check('form: generate_lead carries form_id={{Form ID}} + form_destination={{Form URL}}',
  leadParams.some((p) => p.name === 'form_id' && p.value === '{{Form ID}}') &&
  leadParams.some((p) => p.name === 'form_destination' && p.value === '{{Form URL}}'));
check('form: also carries form_text={{Form Text}}', leadParams.some((p) => p.name === 'form_text' && p.value === '{{Form Text}}'));
check('page context: every event carries page_path={{Page Path}} + page_referrer={{Referrer}}',
  [byEvent('email_click'), out1[0]].every((s) =>
    (s?.eventParameters ?? []).some((p) => p.name === 'page_path' && p.value === '{{Page Path}}') &&
    (s?.eventParameters ?? []).some((p) => p.name === 'page_referrer' && p.value === '{{Referrer}}')));
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

const ctas = buildSuggestions({
  siteHost: 'a.com', forms: [],
  elements: [
    { page: '/', kind: 'cta', text: 'Buy now' },
    { page: '/', kind: 'cta', text: 'Request a demo' },
    { page: '/pricing', kind: 'cta', text: 'Buy now' }, // same text on 2 pages → collapses
  ],
});
const ctaSugs = ctas.filter((s) => s.eventName === 'cta_click');
check('dedup: distinct CTAs stay distinct (2), same-text CTA collapses', ctaSugs.length === 2);
check('cta: fires for its own text via a {{Click Text}} filter', new Set(ctaSugs.map((s) => s.trigger.clickTextValue)).size === 2 && ctaSugs.every((s) => s.trigger.clickTextOperator === 'contains'));
check('cta: cta_text param is DYNAMIC {{Click Text}} (not the scraped text)', ctaSugs.every((s) => s.eventParameters?.some((p) => p.name === 'cta_text' && p.value === '{{Click Text}}')));
check('dedup: same-text CTA across pages → site-wide', ctaSugs.find((s) => s.trigger.clickTextValue === 'Buy now')?.page === 'site-wide');

console.log(`\nTag-suggest: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
