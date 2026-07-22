/**
 * Element collector — pure classifier + assembler tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/collect.node.test.ts
 */
import { classifyElement, classifyPageElements, classifyCtaIntent, isStyledButton, buildSuggestInput, detectEcommerceSignals, collectPageInBrowser, type RawElement, type PageScan } from '../collect.js';
import { buildSuggestions } from '../suggest.js';
import { PROVIDER_SELECTORS, PROVIDER_ID_PREFIXES } from '../providers.js';
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
// className is threaded through to the DetectedElement (drives FAQ accordion grouping in the engine).
check('classifyElement carries the element className through', classifyElement({ tag: 'button', href: '', text: 'Does it work?', hasDownload: false, region: '', className: 'faq-question flex' }, 'acme.com')?.className === 'faq-question flex');

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

// ── share widgets: a SHARE link (share the current page) vs a FOLLOW link (visit the profile) ──
check('share: twitter intent → share/twitter', (() => { const d = classifyElement(a('https://twitter.com/intent/tweet?url=https://acme.com/blog/p&text=Hi', { text: 'Twitter' }), 'acme.com'); return d?.kind === 'share' && d?.shareMethod === 'twitter'; })());
check('share: facebook sharer → share/facebook', (() => { const d = classifyElement(a('https://www.facebook.com/sharer/sharer.php?u=https://acme.com/blog/p', { text: 'Facebook' }), 'acme.com'); return d?.kind === 'share' && d?.shareMethod === 'facebook'; })());
check('share: linkedin share-offsite → share/linkedin', (() => { const d = classifyElement(a('https://www.linkedin.com/sharing/share-offsite/?url=https://acme.com/blog/p', { text: 'LinkedIn' }), 'acme.com'); return d?.kind === 'share' && d?.shareMethod === 'linkedin'; })());
check('share: x.com intent/post → share/twitter (x mapped to twitter)', classifyElement(a('https://x.com/intent/post?url=https://acme.com/p', { text: 'Post' }), 'acme.com')?.kind === 'share');
check('share: whatsapp send → share/whatsapp', (() => { const d = classifyElement(a('https://api.whatsapp.com/send?text=https://acme.com/p', { text: 'WhatsApp' }), 'acme.com'); return d?.kind === 'share' && d?.shareMethod === 'whatsapp'; })());
// A plain FOLLOW link to the profile (no share endpoint / payload) stays a social click, NOT a share.
check('share: plain facebook.com/AcmePage → social (a FOLLOW link, not a share)', classifyElement(a('https://facebook.com/AcmePage', { text: 'Facebook' }), 'acme.com')?.kind === 'social');
// "Copy link" clipboard button (no social URL) → the copy_link method.
check('share: "Copy link" button → share/copy_link', (() => { const d = classifyElement({ tag: 'button', href: '', text: 'Copy Link', hasDownload: false, region: 'main' }, 'acme.com'); return d?.kind === 'share' && d?.shareMethod === 'copy_link'; })());
check('share: "Copy" alone (no "link") → NOT share (avoids copy-code buttons)', classifyElement({ tag: 'button', href: '', text: 'Copy', hasDownload: false, region: 'main' }, 'acme.com')?.kind !== 'share');

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

// ── eCommerce auto-detection ─────────────────────────────────────────────────
{
  const ecomSig = (o: Partial<PageSignals>): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], ...o });
  const shopPage = (over: Partial<PageScan> = {}): PageScan => ({ page: '/', elements: [], forms: [], signals: ecomSig({}), ...over });

  // STRONG signals — any ONE ⇒ ecommerce.
  const cartBtn: PageScan = { page: '/', elements: [{ page: '/', kind: 'cta', text: 'Add to cart', intent: 'add_to_cart' }], forms: [], signals: ecomSig({}) };
  const cartRes = buildSuggestInput([cartBtn], 'shop.com');
  check('ecom: an add_to_cart CTA element ⇒ ecommerce', cartRes.websiteType === 'ecommerce' && (cartRes.ecommerceEvidence ?? []).some((e) => /add to cart/i.test(e)));

  const checkoutForm: PageScan = { page: '/checkout', elements: [], forms: [{ purpose: 'checkout', action: '/pay' }], signals: ecomSig({}) };
  check('ecom: a checkout-purpose form ⇒ ecommerce', buildSuggestInput([checkoutForm], 'shop.com').websiteType === 'ecommerce');

  const shopify: PageScan = shopPage({ signals: ecomSig({ scriptSrcs: ['https://cdn.shopify.com/s/files/x.js'] }) });
  check('ecom: a Shopify platform script ⇒ ecommerce', buildSuggestInput([shopify], 'shop.com').websiteType === 'ecommerce');

  const woo: PageScan = shopPage({ signals: ecomSig({ scriptSrcs: ['https://x.com/wp-content/plugins/woocommerce/assets/js/frontend.js'] }) });
  check('ecom: a WooCommerce script ⇒ ecommerce', buildSuggestInput([woo], 'shop.com').websiteType === 'ecommerce');

  // MEDIUM signals — a SINGLE medium category is NOT enough (conservative; a blog with a stray /shop link).
  const oneMediumPath: PageScan = { page: '/shop', elements: [], forms: [], signals: ecomSig({}) };
  check('ecom: a lone /shop path is NOT enough (single medium signal) → non_ecommerce', buildSuggestInput([oneMediumPath], 'blog.com').websiteType === 'non_ecommerce');

  // TWO DISTINCT medium categories ⇒ ecommerce (e.g. a /products path + a price-like text).
  const twoMedium: PageScan = { page: '/products', elements: [{ page: '/products', kind: 'cta', text: 'Only $29.99', intent: 'generic' }], forms: [], signals: ecomSig({}) };
  check('ecom: two distinct medium categories (path + price) ⇒ ecommerce', buildSuggestInput([twoMedium], 'shop.com').websiteType === 'ecommerce');

  // A payment script alone (one medium) is NOT enough — a donation/booking page uses Stripe too.
  const stripeOnly: PageScan = shopPage({ signals: ecomSig({ scriptSrcs: ['https://js.stripe.com/v3/'] }) });
  check('ecom: a lone Stripe payment script (single medium) → non_ecommerce', buildSuggestInput([stripeOnly], 'donate.org').websiteType === 'non_ecommerce');

  // PRICE + PAYMENT with NO cart-related signal (path/text) → NOT ecommerce. This is the analytics /
  // consultancy false positive: it lists service prices ($X) and books via Stripe, but sells no products.
  const priceAndPay: PageScan = {
    page: '/pricing',
    elements: [{ page: '/pricing', kind: 'cta', text: 'Starting at $499/mo', intent: 'generic' }],
    forms: [],
    signals: ecomSig({ scriptSrcs: ['https://js.stripe.com/v3/'] }),
  };
  const paRes = buildSuggestInput([priceAndPay], 'samarthanalytics.com');
  check('ecom: price + payment WITHOUT a cart path/text → non_ecommerce (consultancy false positive)', paRes.websiteType === 'non_ecommerce' && !(paRes.ecommerceEvidence ?? []).length);
  // But a real store: a purchase-action TEXT ("Buy now") + a price IS ecommerce (a cart-related signal is present).
  const buyNowPrice: PageScan = { page: '/', elements: [{ page: '/', kind: 'cta', text: 'Buy now', intent: 'generic' }, { page: '/', kind: 'cta', text: 'Only $19', intent: 'generic' }], forms: [], signals: ecomSig({}) };
  check('ecom: purchase-action text ("Buy now") + price ⇒ ecommerce', buildSuggestInput([buyNowPrice], 'shop.com').websiteType === 'ecommerce');

  // A single "Checkout" button (text "Checkout" + href "/checkout") must NOT self-satisfy two medium
  // categories — "checkout" is a destination word covered by the path category, not a purchase ACTION,
  // so ONE such element is a single signal → non_ecommerce (guards the path-via-href double-count).
  const loneCheckoutBtn: PageScan = { page: '/', elements: [{ page: '/', kind: 'cta', text: 'Checkout', href: '/checkout', intent: 'generic' }], forms: [], signals: ecomSig({}) };
  check('ecom: a lone "Checkout" button (text + href) is ONE signal → non_ecommerce', buildSuggestInput([loneCheckoutBtn], 'saas.com').websiteType === 'non_ecommerce');

  // Plain blog — no signals at all → non_ecommerce with no evidence.
  const blog: PageScan = { page: '/blog/my-post', elements: [{ page: '/blog/my-post', kind: 'outbound', text: 'source', href: 'https://ref.com' }], forms: [], signals: ecomSig({}) };
  const blogRes = buildSuggestInput([blog], 'blog.com');
  check('ecom: a plain blog → non_ecommerce, no evidence', blogRes.websiteType === 'non_ecommerce' && !(blogRes.ecommerceEvidence ?? []).length);

  // Direct detectEcommerceSignals unit checks (evidence populated only when ecommerce).
  check('ecom: detectEcommerceSignals returns evidence for a strong signal', (() => {
    const r = detectEcommerceSignals([], [{ page: '/', kind: 'cta', text: 'Add to cart', intent: 'add_to_cart' }], [{ page: '/' }], []);
    return r.isEcommerce && r.evidence.length > 0;
  })());
  check('ecom: detectEcommerceSignals is conservative — one medium ⇒ not ecommerce, empty evidence', (() => {
    const r = detectEcommerceSignals([], [], [{ page: '/shop' }], []);
    return !r.isEcommerce && r.evidence.length === 0;
  })());
}

// -- the in-page selector probe must mirror providers.ts -----------------------
// collectPageInBrowser is stringified and evaluated inside the scanned page, so it cannot reference
// the shared lists and keeps its own copy. A copy that drifts is invisible: the vendor simply stops
// being detected, and the page silently gets a native trigger that cannot fire.
{
  // Quote style is not stable through the TS transpile (esbuild rewrites '...' to "..."), so compare
  // with every quote character stripped from both sides.
  const src = collectPageInBrowser.toString().replace(/["']/g, '');
  const bare = (s: string): string => s.replace(/["']/g, '');
  const missingSel = PROVIDER_SELECTORS.filter((s) => !src.includes(bare(s)));
  check('probe: every shared PROVIDER_SELECTOR is present in the inlined in-page copy', missingSel.length === 0, missingSel.join(', '));
  const missingPrefix = PROVIDER_ID_PREFIXES.filter((p) => !src.includes(bare(p)));
  check('probe: every shared PROVIDER_ID_PREFIX is present in the inlined in-page copy', missingPrefix.length === 0, missingPrefix.join(', '));
  check('probe: the HubSpot hsfc renderer container is probed (the ChowNow markup)', PROVIDER_SELECTORS.includes('[data-hsfc-id]'));
  check('probe: the inlined copy is self-contained (it declares its own list, not an outer reference)',
    /const PROVIDER_SELECTORS\s*=\s*\[/.test(src) && src.includes('[data-hsfc-id]'));
}

// -- providerFormId survives the whole pipeline --------------------------------
// It was captured by forms.ts and then dropped at every hand-off, which made the single-sample
// rescue in form-id-stability unreachable in production. These assert the wiring, not the rescue.
{
  const HS_GUID = '79c35ad9-5d43-407b-8c0e-0b62b2cc8de0';
  const hsPage: PageScan = {
    page: '/demo',
    elements: [],
    signals: { scriptSrcs: [], classNames: ['hs-form-html'], selectorsPresent: ['[data-hsfc-id]'], iframeSrcs: [] },
    forms: [{
      purpose: 'contact',
      action: 'https://forms-na2.hsforms.com/submissions/v3/public/submit',
      method: 'post',
      formId: `cf2be672-0e24-4813-8728-42d97847318c-${HS_GUID}`,
      providerFormId: HS_GUID,
      title: 'Get a Demo',
      fields: [{ type: 'email', name: 'email', required: true }],
    }],
  };
  const hsInput = buildSuggestInput([hsPage], 'get.chownow.com');
  check('thread: buildSuggestInput carries providerFormId onto the DetectedForm', hsInput.forms[0]?.providerFormId === HS_GUID);
  check('thread: the hsfc markup is detected as hubspot (not treated as a native form)', hsInput.forms[0]?.provider.vendor === 'hubspot');
  check('thread: a readable HubSpot form suppresses the synthesized embed (one form, not two)', hsInput.forms.length === 1);

  // THE ChowNow failure, end to end: one HubSpot form on seven pages. It used to emit a native Form
  // Submission trigger scoped by a seven-path page regex, which can never fire because the submit
  // happens inside a cross-origin iframe GTM's form listener never sees.
  const pages = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'].map((p, i): PageScan => ({
    ...hsPage,
    page: p,
    forms: [{ ...hsPage.forms[0], formId: `0000000${i}-0e24-4813-8728-42d97847318c-${HS_GUID}` }],
  }));
  const chow = buildSuggestions(buildSuggestInput(pages, 'get.chownow.com')).filter((s) => /Get A Demo/i.test(s.tagName));
  check('chownow: seven pages of one HubSpot form → exactly ONE tag', chow.length === 1, `got ${chow.length}`);
  const ct = chow[0]?.trigger;
  check('chownow: the trigger is a CUSTOM EVENT, never the Form Submission that cannot fire',
    ct?.kind === 'custom_event' && ct?.eventName === 'hubspot-form-success', JSON.stringify(ct));
  check('chownow: it is NOT scoped by a multi-page {{Page Path}} regex any more', !ct?.pagePathValue);
  check('chownow: it scopes on the dataLayer key HubSpot\'s own listener pushes, hs_form_id = the form GUID',
    ct?.dataLayerConditions?.length === 1 && ct.dataLayerConditions[0].key === 'hs_form_id'
      && ct.dataLayerConditions[0].value === HS_GUID && ct.dataLayerConditions[0].operator === 'equals',
    JSON.stringify(ct?.dataLayerConditions));
  check('chownow: no per-render DOM id leaks into the trigger', !JSON.stringify(ct).includes('0e24-4813'));
  const listener = chow[0]?.install?.requires.find((r) => r.kind === 'listener-tag');
  check('chownow: the paired listener really pushes that key (the trigger and the install plan agree)',
    !!listener && listener.kind === 'listener-tag' && listener.tag.html.includes('hs_form_id')
      && listener.dlvScope?.key === 'hs_form_id' && listener.dlvScope?.value === HS_GUID);

  // The SAME site without data-form-id, where the only identity left is inside the DOM id. HubSpot
  // writes hsForm_<instanceGuid>-<formGuid> there, and the instance half is minted on every render:
  // scoping on it produces the identical silent failure one layer down, a trigger GTM accepts and
  // that never matches again. Checked on ONE page too, where there is no second sample to disagree.
  {
    const inst = (i: number) => `${'0000000' + i}-0e24-4813-8728-42d97847318c`;
    const domIdOnly = (i: number): PageScan => ({
      ...hsPage,
      page: `/p${i}`,
      forms: [{ ...hsPage.forms[0], providerFormId: undefined, formId: `hsForm_${inst(i)}-${HS_GUID}` }],
    });
    for (const pages of [[domIdOnly(1)], [domIdOnly(1), domIdOnly(2), domIdOnly(3)]]) {
      const where = `${pages.length} page(s)`;
      const got = buildSuggestions(buildSuggestInput(pages, 'get.chownow.com')).filter((s) => /Get A Demo/i.test(s.tagName));
      const t = got[0]?.trigger;
      check(`chownow (no data-form-id, ${where}): still ONE custom-event tag`,
        got.length === 1 && t?.kind === 'custom_event' && t?.eventName === 'hubspot-form-success', JSON.stringify(t));
      check(`chownow (no data-form-id, ${where}): scoped on the FORM guid`,
        t?.dataLayerConditions?.[0]?.key === 'hs_form_id' && t.dataLayerConditions[0].value === HS_GUID,
        JSON.stringify(t?.dataLayerConditions));
      check(`chownow (no data-form-id, ${where}): the per-render instance guid is nowhere in the tag`,
        !JSON.stringify(got[0] ?? {}).includes(inst(1)), JSON.stringify(t));
    }
  }
}

console.log(`\nTag-collect: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
