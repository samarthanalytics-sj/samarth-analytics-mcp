/**
 * Element collector — pure classifier + assembler tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/collect.node.test.ts
 */
import { classifyElement, classifyPageElements, buildSuggestInput, type RawElement, type PageScan } from '../collect.js';
import { buildSuggestions } from '../suggest.js';
import type { PageSignals } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const a = (href: string, over: Partial<RawElement> = {}): RawElement => ({ tag: 'a', href, text: '', hasDownload: false, region: '', ...over });
const kindOf = (href: string, site = 'acme.com', over: Partial<RawElement> = {}) => classifyElement(a(href, over), site)?.kind ?? null;

// ── classifyElement ─────────────────────────────────────────────────────────
check('mailto → email', kindOf('mailto:hi@acme.com') === 'email');
check('tel → phone', kindOf('tel:+15551234567') === 'phone');
check('.pdf link → download', kindOf('https://acme.com/guide.pdf') === 'download');
check('.pdf with query → download', kindOf('https://acme.com/g.pdf?v=2') === 'download');
check('download attr → download', kindOf('https://acme.com/file', 'acme.com', { hasDownload: true }) === 'download');
check('outbound host → outbound', kindOf('https://partner.com/x') === 'outbound');
check('same host → null (internal nav)', kindOf('https://acme.com/about') === null);
check('subdomain → null (same site, not outbound)', kindOf('https://blog.acme.com/post') === null);
check('www normalization → internal', kindOf('https://www.acme.com/x', 'acme.com') === null);
check('CTA anchor text → cta', classifyElement(a('https://acme.com/demo', { text: 'Book a demo' }), 'acme.com')?.kind === 'cta');
check('CTA button → cta', classifyElement({ tag: 'button', href: '', text: 'Request a quote', hasDownload: false, region: '' }, 'acme.com')?.kind === 'cta');
check('plain internal anchor (no CTA text) → null', classifyElement(a('https://acme.com/team', { text: 'Our team' }), 'acme.com') === null);
check('email beats outbound (mailto not treated as link)', kindOf('mailto:x@partner.com') === 'email');
check('region carried through', classifyElement(a('mailto:hi@acme.com', { region: 'footer' }), 'acme.com')?.region === 'footer');

// ── classifyPageElements sets the page path ─────────────────────────────────
const classified = classifyPageElements([a('mailto:hi@acme.com'), a('https://acme.com/x.pdf')], 'acme.com', '/contact');
check('classifyPageElements: stamps page + keeps only trackable', classified.length === 2 && classified.every((d) => d.page === '/contact'));

// ── buildSuggestInput → engine end-to-end ───────────────────────────────────
const sigHub: PageSignals = { scriptSrcs: ['https://js.hsforms.net/forms/v2.js'], classNames: ['hs-form'], selectorsPresent: ['.hs-form'] };
const pages: PageScan[] = [
  { page: '/contact', signals: sigHub, forms: [{ purpose: 'contact', action: 'https://js.hsforms.net/x' }], elements: classifyPageElements([a('tel:+15551234567')], 'acme.com', '/contact') },
  { page: '/', signals: { scriptSrcs: [], classNames: [], selectorsPresent: [] }, forms: [], elements: classifyPageElements([a('mailto:hi@acme.com', { region: 'footer' })], 'acme.com', '/') },
];
const input = buildSuggestInput(pages, 'acme.com');
check('assemble: form gets a detected provider', input.forms.length === 1 && input.forms[0].provider.vendor === 'hubspot');
check('assemble: elements flattened across pages', input.elements.length === 2);

const suggestions = buildSuggestions(input);
const events = new Set(suggestions.map((s) => s.eventName));
check('end-to-end: contact(HubSpot) → generate_lead', events.has('generate_lead'));
check('end-to-end: tel → phone_click, mailto → email_click', events.has('phone_click') && events.has('email_click'));
check('end-to-end: every suggestion is a valid ga4_event payload', suggestions.every((s) => s.platform === 'ga4_event' && !!s.tagName && !!s.trigger.kind));

// ── review-fix regressions ───────────────────────────────────────────────────
// A CTA-text anchor that is also outbound classifies as outbound (link branch
// wins); the :not(a) button-query fix prevents a duplicate cta from the same <a>.
check('anchor CTA + outbound href → outbound (not double-counted)', classifyElement(a('https://partner.com/x', { text: 'Book a demo' }), 'acme.com')?.kind === 'outbound');
check('anchor CTA + download href → download (not cta)', classifyElement(a('https://acme.com/wp.pdf', { text: 'Get started' }), 'acme.com')?.kind === 'download');
// Unicode + scheme-bearing siteHost
check('unicode same-site host → not outbound', classifyElement(a('https://xn--mnchen-3ya.de/x'), 'münchen.de') === null);
check('siteHost passed with a scheme still matches internal links', classifyElement(a('https://acme.com/about'), 'https://acme.com') === null);
// Download regex shared with the engine trigger (apk/mp3/# now covered)
check('collector detects .apk / .mp3 / #fragment as download', kindOf('https://acme.com/app.apk') === 'download' && kindOf('https://acme.com/t.mp3') === 'download' && kindOf('https://acme.com/a.pdf#s') === 'download');
const dl = buildSuggestions({ siteHost: 'a.com', forms: [], elements: classifyPageElements([a('https://a.com/app.apk')], 'a.com', '/d') }).find((s) => s.eventName === 'file_download');
check('engine file_download trigger regex covers the same extensions (apk, #)', !!dl && /apk/.test(dl.trigger.clickUrlValue ?? '') && /#/.test(dl.trigger.clickUrlValue ?? ''));
// CTA tightening: bare "register" no longer matches header auth links
check('CTA: "Login / Register" no longer a false-positive CTA', classifyElement({ tag: 'button', href: '', text: 'Login / Register', hasDownload: false, region: '' }, 'a.com') === null);

// ── embedded cross-origin form → synthesized suggestion ──────────────────────
{
  const embedPage: PageScan = {
    page: '/contact',
    signals: { scriptSrcs: [], classNames: [], selectorsPresent: [], iframeSrcs: ['https://share.hsforms.com/x'] },
    forms: [],
    elements: [],
  };
  const embedInput = buildSuggestInput([embedPage], 'acme.com');
  check('embed: cross-origin HubSpot iframe (no readable form) → synthesized contact form',
    embedInput.forms.length === 1 && embedInput.forms[0].provider.vendor === 'hubspot' && embedInput.forms[0].purpose === 'contact');
  check('embed: synthesized form → generate_lead suggestion', buildSuggestions(embedInput).some((s) => s.eventName === 'generate_lead'));
  const realPlusEmbed: PageScan = { ...embedPage, forms: [{ purpose: 'contact', action: 'https://acme.com/x' }] };
  check('embed: a readable form suppresses synthesis (no duplicate)', buildSuggestInput([realPlusEmbed], 'acme.com').forms.length === 1);
}

console.log(`\nTag-collect: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
