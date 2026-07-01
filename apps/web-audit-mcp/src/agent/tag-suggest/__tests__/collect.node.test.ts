/**
 * Element collector — pure classifier + assembler tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/collect.node.test.ts
 */
import { classifyElement, classifyPageElements, classifyCtaIntent, isStyledButton, buildSuggestInput, type RawElement, type PageScan } from '../collect.js';
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
// Generic CTA fallback: a prominent button / CTA-styled control surfaces even without a known intent.
check('button with non-intent label → generic cta', (() => { const d = classifyElement({ tag: 'button', href: '', text: 'Talk to our experts', hasDownload: false, region: '' }, 'acme.com'); return d?.kind === 'cta' && d?.intent === 'generic'; })());
check('CTA-styled internal anchor (cta flag) → generic cta', (() => { const d = classifyElement(a('https://acme.com/contact', { text: 'Talk to our experts', cta: true }), 'acme.com'); return d?.kind === 'cta' && d?.intent === 'generic'; })());
check('plain internal anchor (no cta flag) with non-intent text stays null', classifyElement(a('https://acme.com/team', { text: 'Our team' }), 'acme.com') === null);
check('UI chrome label on a button → null (not surfaced)', classifyElement({ tag: 'button', href: '', text: 'Menu', hasDownload: false, region: '' }, 'acme.com') === null);
check('empty-label button → null', classifyElement({ tag: 'button', href: '', text: '', hasDownload: false, region: '' }, 'acme.com') === null);
// Multi-word UI chrome must NOT leak into the generic bucket.
const btn = (text: string, over: Partial<RawElement> = {}): RawElement => ({ tag: 'button', href: '', text, hasDownload: false, region: '', ...over });
for (const chrome of ['Toggle navigation', 'Open menu', 'Show more', 'Load more', 'Back to top', 'Next page', 'Previous post', 'Read more', 'See all']) {
  check(`chrome "${chrome}" → null`, classifyElement(btn(chrome), 'acme.com') === null);
}
// Cookie/consent controls are noise, not conversions.
for (const consent of ['Accept all cookies', 'Reject all', 'Manage preferences', 'Accept', 'Got it', 'Cookie settings']) {
  check(`consent "${consent}" → null`, classifyElement(btn(consent), 'acme.com') === null);
}
// Genuine CTAs that merely start with a chrome-ish word are KEPT.
for (const real of ['Talk to our experts', 'Open account', 'Show pricing', 'Read the guide', 'Accept invitation']) {
  const d = classifyElement(btn(real), 'acme.com');
  check(`real CTA "${real}" → generic cta`, d?.kind === 'cta' && d?.intent === 'generic');
}
// A button-STYLED nav link (cta flag, region nav) stays out of the generic bucket (menu item, not a CTA).
check('button-styled NAV link → null (not a conversion)', classifyElement(a('https://acme.com/products', { text: 'Products', cta: true, region: 'nav' }), 'acme.com') === null);
// But the same styled CTA in main/header DOES surface.
check('button-styled MAIN cta → generic', (() => { const d = classifyElement(a('https://acme.com/contact', { text: 'Talk to our experts', cta: true, region: 'main' }), 'acme.com'); return d?.kind === 'cta' && d?.intent === 'generic'; })());
check('email beats outbound (mailto not treated as link)', kindOf('mailto:x@partner.com') === 'email');
check('region carried through', classifyElement(a('mailto:hi@acme.com', { region: 'footer' }), 'acme.com')?.region === 'footer');

// ── isStyledButton: a class-less styled <a> is a CTA only if it is BUTTON-sized ──────────────────
// (the height floor is what keeps the filled/bordered PILLS — chips, locale switchers, pagination,
//  breadcrumbs, badges — from flooding the review list; those are short, real CTA buttons are tall).
const BTN = { h: 44, padX: 48, padY: 14, filled: true, bordered: false };
check('isStyledButton: filled chunky button (44px) → true', isStyledButton(BTN));
check('isStyledButton: outlined button, no fill (40px) → true', isStyledButton({ h: 40, padX: 32, padY: 10, filled: false, bordered: true }));
check('isStyledButton: line-height button (padY 0, horizontal pad) → true', isStyledButton({ h: 48, padX: 40, padY: 0, filled: true, bordered: false }));
check('isStyledButton: short filled tag/chip (26px) → false', !isStyledButton({ h: 26, padX: 20, padY: 8, filled: true, bordered: false }));
check('isStyledButton: bordered locale pill (30px) → false', !isStyledButton({ h: 30, padX: 24, padY: 12, filled: false, bordered: true }));
check('isStyledButton: 32px chip is below the 36px floor → false', !isStyledButton({ h: 32, padX: 20, padY: 8, filled: true, bordered: false }));
check('isStyledButton: plain text link (no fill/border) → false', !isStyledButton({ h: 40, padX: 0, padY: 0, filled: false, bordered: false }));
check('isStyledButton: filled but unpadded block → false', !isStyledButton({ h: 40, padX: 0, padY: 0, filled: true, bordered: false }));
check('isStyledButton: NaN box (unparsed style) → false, no throw', !isStyledButton({ h: NaN, padX: NaN, padY: NaN, filled: true, bordered: false }));

// classifyElement honours the measured box for a class-less styled <a> (no cta flag, no known intent).
check('styled-button <a> (button box + action text) → generic cta', (() => { const d = classifyElement(a('https://acme.com/webinar', { text: 'Get your recording', box: BTN, region: 'main' }), 'acme.com'); return d?.kind === 'cta' && d?.intent === 'generic'; })());
check('short filled chip <a> ("Marketing", 26px box) → null (not a CTA)', classifyElement(a('https://acme.com/blog/marketing', { text: 'Marketing', box: { h: 26, padX: 20, padY: 8, filled: true, bordered: false }, region: 'main' }), 'acme.com') === null);
check('bordered locale-switcher pill <a> ("Deutsch", 30px) → null', classifyElement(a('https://acme.com/de', { text: 'Deutsch', box: { h: 30, padX: 24, padY: 12, filled: false, bordered: true }, region: 'header' }), 'acme.com') === null);
check('styled-button <a> in NAV → null (menu item, not conversion)', classifyElement(a('https://acme.com/products', { text: 'Solutions', box: BTN, region: 'nav' }), 'acme.com') === null);
check('anchor with neither cta flag nor box (plain link) → null', classifyElement(a('https://acme.com/team', { text: 'Our team' }), 'acme.com') === null);

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
check('end-to-end: contact(HubSpot) → contact_form', events.has('contact_form'));
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
check('engine file_download trigger uses a readable {{Click URL}} ends with .apk (no regex)', !!dl && dl.trigger.clickUrlValue === '.apk' && dl.trigger.clickUrlOperator === 'endsWith');
// "Login / Register" is now a tracked login CTA (was excluded); bare "register"
// still stays out of the generic bucket.
check('CTA: "Login / Register" → login CTA (tracked)', (() => { const d = classifyElement({ tag: 'button', href: '', text: 'Login / Register', hasDownload: false, region: '' }, 'a.com'); return d?.kind === 'cta' && d?.intent === 'login'; })());

// ── CTA intent classification ────────────────────────────────────────────────
check('cta intent: "Add to cart" button → add_to_cart', (() => { const d = classifyElement({ tag: 'button', href: '', text: 'Add to cart', hasDownload: false, region: '' }, 'a.com'); return d?.kind === 'cta' && d?.intent === 'add_to_cart'; })());
check('cta intent: "Learn more" same-site link → learn_more', (() => { const d = classifyElement(a('https://a.com/x', { text: 'Learn more' }), 'a.com'); return d?.kind === 'cta' && d?.intent === 'learn_more'; })());
check('cta intent: Subscribe / Buy now / FAQ / Get started recognized', classifyCtaIntent('Subscribe') === 'subscribe' && classifyCtaIntent('Buy now') === 'generic' && classifyCtaIntent('FAQ') === 'faq' && classifyCtaIntent('Get started') === 'get_started');
check('cta intent: "Login"/"Sign in"/"Login / Register" → login', classifyCtaIntent('Login') === 'login' && classifyCtaIntent('Sign in') === 'login' && classifyCtaIntent('Login / Register') === 'login');
check('cta intent: "Search" → search, "Research papers" stays null (word-bounded)', classifyCtaIntent('Search') === 'search' && classifyCtaIntent('Research papers') === null);
check('cta intent: "See all case studies"/"View all"/"See more"/"Read more" are NOT tracked (view-all removed as noise)', ['See all case studies', 'View all', 'See more', 'Browse all', 'Case studies', 'Read more'].every((t) => classifyCtaIntent(t) === null));
check('cta intent: plain text "Our team" stays null', classifyCtaIntent('Our team') === null);
// "View details" is still NOT a tracked CTA (too generic); genuine learn-more stays.
check('cta intent: "View details" stays null (too generic to track)', classifyCtaIntent('View details') === null);
check('cta intent: genuine "Learn more"/"Find out more"/"Discover more" still learn_more', ['Learn more', 'Find out more', 'Discover more'].every((t) => classifyCtaIntent(t) === 'learn_more'));
// contact + download intents (a bare "Contact us" button and a "Download brochure" text link were
// previously unmatched → the text link got dropped as a plain link).
check('cta intent: "Contact us"/"Get in touch"/"Contact our experts" → contact', classifyCtaIntent('Contact us') === 'contact' && classifyCtaIntent('Get in touch') === 'contact' && classifyCtaIntent('Contact our experts') === 'contact');
check('cta intent: "Contact sales" still wins as contact_sales (order preserved)', classifyCtaIntent('Contact sales') === 'contact_sales');
check('cta intent: page copy "Contact information" stays null (targeted, not bare "contact")', classifyCtaIntent('Contact information') === null);
check('cta intent: "Download brochure"/"Datasheet"/"Download" → download', classifyCtaIntent('Download brochure') === 'download' && classifyCtaIntent('Datasheet') === 'download' && classifyCtaIntent('Download') === 'download');
check('CTA: "Contact us" internal link → cta (contact intent), no longer dropped', (() => { const d = classifyElement(a('https://acme.com/contact', { text: 'Contact us' }), 'acme.com'); return d?.kind === 'cta' && d?.intent === 'contact'; })());
check('CTA: "Download brochure" link to a page (no file ext) → cta (download intent), not dropped', (() => { const d = classifyElement(a('https://acme.com/downloads/vibroflex', { text: 'Download brochure' }), 'acme.com'); return d?.kind === 'cta' && d?.intent === 'download'; })());
check('a real .pdf "Download brochure" link still classifies as download KIND (file link wins over intent)', classifyElement(a('https://acme.com/brochure.pdf', { text: 'Download brochure' }), 'acme.com')?.kind === 'download');
// quote/demo recall: an adjective between the verb and the noun still matches.
check('cta intent: "Get a free quote"/"Request your quote" → request_quote', classifyCtaIntent('Get a free quote') === 'request_quote' && classifyCtaIntent('Request your quote') === 'request_quote');
check('cta intent: "Get a free demo"/"Book a demo"/"Request a demo" → book_demo', classifyCtaIntent('Get a free demo') === 'book_demo' && classifyCtaIntent('Book a demo') === 'book_demo' && classifyCtaIntent('Request a demo') === 'book_demo');
// "view" dropped from book_demo: "View demo reel/gallery/video" is product content, not a booking.
check('cta intent: "View demo reel"/"View demo gallery" are NOT book_demo (product content)', classifyCtaIntent('View demo reel') === null && classifyCtaIntent('View the product demo video') === null);
// book a CALL (not just a demo): "Schedule Strategy Call" / "Book a Call" / "Schedule a Free Call".
check('cta intent: schedule/book a CALL → book_demo', ['Schedule Strategy Call', 'Book a Call', 'Schedule a Free Call', 'Schedule a Meeting', 'Request a Callback', 'Book a Consultation'].every((t) => classifyCtaIntent(t) === 'book_demo'));
check('cta intent: "Get the meeting notes" is NOT a call CTA (verb-restricted)', classifyCtaIntent('Get the meeting notes') === null);
// the "free audit" family — the conversion CTA on tag-audit / consulting sites.
check('cta intent: "Get Free Audit"/"Start a free audit"/"Free audit" → get_started', ['Get Free Audit', 'Start a free audit', 'Run a free audit', 'Free audit', 'Get your free audit'].every((t) => classifyCtaIntent(t) === 'get_started'));
// NARROW proof CTA — requires client/customer/our so the excluded noise stays out.
check('cta intent: "View Client Results"/"View our work"/"Client results" → learn_more', ['View Client Results', 'View our work', 'Client results', 'Customer results'].every((t) => classifyCtaIntent(t) === 'learn_more'));
check('cta intent: generic "View results"/"View all"/"Case studies" still NOT tracked (noise)', ['View results', 'View all', 'Case studies', 'See results'].every((t) => classifyCtaIntent(t) === null));

// ── social-link classification ───────────────────────────────────────────────
check('social: facebook link → social', classifyElement(a('https://facebook.com/acme', { text: 'Facebook' }), 'acme.com')?.kind === 'social');
check('social: x.com + lnkd.in short hosts → social', classifyElement(a('https://x.com/acme'), 'acme.com')?.kind === 'social' && classifyElement(a('https://lnkd.in/abc'), 'acme.com')?.kind === 'social');
check('social: non-social outbound link is still outbound', classifyElement(a('https://partner.com/x'), 'acme.com')?.kind === 'outbound');
check('social: classify records WHICH network (facebook, linkedin via lnkd.in)', classifyElement(a('https://facebook.com/acme'), 'acme.com')?.socialNetwork === 'facebook' && classifyElement(a('https://lnkd.in/abc'), 'acme.com')?.socialNetwork === 'linkedin');
check('social: classify records the EXACT scraped domain (m.facebook.com → facebook.com, lnkd.in → lnkd.in)', classifyElement(a('https://m.facebook.com/acme'), 'acme.com')?.socialDomain === 'facebook.com' && classifyElement(a('https://lnkd.in/abc'), 'acme.com')?.socialDomain === 'lnkd.in');
// Spoof host: social brand as an interior (non-registrable) label → NOT social.
check('social: spoof "facebook.com.evil.com" → outbound (not social)', classifyElement(a('https://facebook.com.evil.com/x'), 'acme.com')?.kind === 'outbound');
// The site's OWN social-named subdomain is internal nav, not a social click.
check('social: internal "discord.acme.com" subdomain → null (internal nav)', classifyElement(a('https://discord.acme.com/x'), 'acme.com') === null);

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
  check('embed: synthesized form → contact_form suggestion', buildSuggestions(embedInput).some((s) => s.eventName === 'contact_form'));
  // A readable form that is ITSELF the provider (HubSpot action) suppresses the synth (no duplicate).
  const sameProvider: PageScan = { ...embedPage, forms: [{ purpose: 'contact', action: 'https://js.hsforms.net/x' }] };
  check('embed: same-provider readable form suppresses synthesis (no duplicate)', buildSuggestInput([sameProvider], 'acme.com').forms.length === 1);
  // But an UNRELATED readable form (acme.com action) does NOT suppress the cross-origin HubSpot embed.
  const unrelatedPlusEmbed: PageScan = { ...embedPage, forms: [{ purpose: 'contact', action: 'https://acme.com/x' }] };
  const upe = buildSuggestInput([unrelatedPlusEmbed], 'acme.com');
  check('embed: unrelated readable form does NOT suppress a real provider embed', upe.forms.length === 2 && upe.forms.some((f) => f.provider.vendor === 'hubspot'));
}

// ── YouTube embed detection → video suggestion (end-to-end) ──────────────────
{
  const vsig = (iframeSrcs: string[]): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], iframeSrcs });
  const vpage: PageScan = { page: '/watch', signals: vsig(['https://www.youtube.com/embed/dQw4w9']), forms: [], elements: [] };
  const vinput = buildSuggestInput([vpage], 'acme.com');
  check('video: buildSuggestInput records a YouTube embed', (vinput.videoEmbeds ?? []).length === 1 && vinput.videoEmbeds?.[0].provider === 'youtube' && vinput.videoEmbeds?.[0].page === '/watch');
  check('video: → a youtube_video suggestion end-to-end', buildSuggestions(vinput).some((s) => s.trigger.kind === 'youtube_video'));
  const watchOnly: PageScan = { page: '/', signals: vsig(['https://www.youtube.com/watch?v=x', 'https://maps.google.com/embed?pb=1']), forms: [], elements: [] };
  check('video: a youtube WATCH link (not /embed/) and a non-YT iframe are NOT video embeds', (buildSuggestInput([watchOnly], 'acme.com').videoEmbeds ?? []).length === 0);
}

console.log(`\nTag-collect: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
