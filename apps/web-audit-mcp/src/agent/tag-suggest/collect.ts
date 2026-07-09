// Phase 2: turn a real page into the Phase-1 engine's input. Mirrors forms.ts:
// an in-page DOM extractor (collectPageInBrowser, runs in Playwright, returns RAW
// data) + a PURE classifier (classifyElement / buildSuggestInput, unit-tested,
// no browser). The same raw shape can be produced by a Cheerio static parse, so
// a no-browser path for custom-HTML pages drops in later without touching the
// classifier.

import type { PwPage } from '../browser.js';
import type { PageSignals, DetectedElement, DetectedForm, SuggestInput, FormPurpose, FormFieldSummary, VideoEmbed } from './types.js';
import { detectFormProvider, detectEmbeddedForm } from './providers.js';
import { classifyCtaIntent } from './cta-intents.js';
import { socialNetworkOf, socialDomainOf } from './social.js';
import { hasYouTubeEmbed } from './video.js';
import { DOWNLOAD_EXT } from './suggest.js';

// Re-exported so callers/tests have one import site for the classifier.
export { classifyCtaIntent };

/** Raw, serializable element data emitted by the in-page collector. */
export interface RawElement {
  tag: 'a' | 'button';
  /** Absolute href (the browser resolves it); '' for buttons. */
  href: string;
  text: string;
  hasDownload: boolean;
  region: '' | 'header' | 'footer' | 'nav' | 'main';
  /** Looks like a clickable CTA control — a <button>/[role=button], an [onclick], or a
   *  btn/button/cta-classed element. Lets a prominent button surface as a (low-confidence)
   *  CTA even when its label isn't a known intent; a plain nav <a> stays unflagged. */
  cta?: boolean;
  /** An anchor's rendered box (getComputedStyle + getBoundingClientRect, browser collector only —
   *  absent in the layout-less cheerio path). Fed to isStyledButton() to tell a real CTA button apart
   *  from a small chip/pill/badge that shares the same fill/border styling. */
  box?: { h: number; padX: number; padY: number; filled: boolean; bordered: boolean };
  /** The element's own class attribute — used to find a shared accordion/FAQ class so grouped FAQ
   *  questions can be tracked by ONE tag scoped to that class via {{Click Element}} matches CSS. */
  className?: string;
}
export interface PageScanRaw {
  elements: RawElement[];
  signals: PageSignals;
}

/** Serialized by Playwright/Electron and executed IN the page (DOM globals).
 *  Self-contained (no outer refs) so .toString()-injection works. Scans the top
 *  document AND same-origin iframes (embedded forms/widgets often live in one). */
export function collectPageInBrowser(): PageScanRaw {
  const MAX = 400;
  const elements: RawElement[] = [];
  const scriptSrcs: string[] = [];
  const iframeSrcs: string[] = [];
  const classNames = new Set<string>();
  const selectorsPresent = new Set<string>();
  const PROVIDER_SELECTORS = ['.hs-form', '[data-tf-widget]', '[data-paperform-id]', '#mce-EMAIL', '#mc-embedded-subscribe', '.gform_wrapper', '.wpcf7', '.wpforms-form', '.wpforms-container'];

  const regionOf = (el: Element): RawElement['region'] => {
    const t = el.closest('header,footer,nav,main')?.tagName.toLowerCase();
    return t === 'header' || t === 'footer' || t === 'nav' || t === 'main' ? t : '';
  };
  const txt = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  // A control that LOOKS clickable: a button role, an onclick handler, or a btn/button/cta class
  // token. Used to surface a styled CTA ("Talk to our experts") that isn't a known intent phrase.
  const looksCta = (el: Element): boolean => {
    if (el.getAttribute('role') === 'button' || el.hasAttribute('onclick')) return true;
    const cls = (el.getAttribute('class') || '').toLowerCase();
    return /(^|[\s_-])(btn|button|cta)([\s_-]|$)/.test(cls);
  };
  // Measure an anchor's rendered box so the pure isStyledButton() can tell a real CTA button (a
  // filled/bordered, padded, chunky box like a yellow "Get your recording" link) from a small
  // chip/pill/badge/switcher that merely shares that styling. getComputedStyle/getBoundingClientRect
  // exist only in a real browser (Electron/Playwright); the cheerio path has no layout, so box is absent.
  const measureBox = (el: Element): RawElement['box'] => {
    try {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (!view) return undefined;
      const s = view.getComputedStyle(el);
      const bg = s.backgroundColor;
      const r = el.getBoundingClientRect();
      return {
        h: r.height,
        padX: parseFloat(s.paddingLeft) + parseFloat(s.paddingRight),
        padY: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom),
        filled: !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)',
        bordered: parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none',
      };
    } catch {
      return undefined;
    }
  };

  const scanDoc = (doc: Document): void => {
    const seen = new Set<Element>();
    for (const a of Array.from(doc.querySelectorAll('a[href]')).slice(0, MAX)) {
      if (elements.length >= MAX * 2) break;
      const el = a as HTMLAnchorElement;
      seen.add(el);
      const cta = looksCta(el);
      // Only measure the box when the cheap class/role check didn't already flag it (measuring forces layout).
      elements.push({ tag: 'a', href: el.href || '', text: txt(el), hasDownload: el.hasAttribute('download'), region: regionOf(el), cta, box: cta ? undefined : measureBox(el), className: el.getAttribute('class') || undefined });
    }
    // :not(a) — an <a href role="button"> is already captured (with its href) by
    // the anchor query above; without this it would be emitted again as a hrefless
    // "button" and double-classified.
    for (const b of Array.from(doc.querySelectorAll('button, [role="button"]:not(a)')).slice(0, MAX)) {
      if (elements.length >= MAX * 2) break;
      seen.add(b);
      elements.push({ tag: 'button', href: '', text: txt(b), hasDownload: false, region: regionOf(b), cta: true, className: b.getAttribute('class') || undefined });
    }
    // Non-semantic clickable controls: a bare <a> (no href, JS-routed), an [onclick], or a
    // btn/button/cta-classed div/span — emitted as a hrefless "button" so a styled CTA that isn't a
    // <button> or known intent still surfaces (low confidence). Skips anything already captured above.
    for (const c of Array.from(doc.querySelectorAll('a:not([href]), [onclick], [class*="btn"], [class*="button"], [class*="cta"]')).slice(0, MAX)) {
      if (elements.length >= MAX * 2) break;
      if (seen.has(c) || !looksCta(c)) continue;
      const label = txt(c);
      if (!label) continue;
      seen.add(c);
      elements.push({ tag: 'button', href: '', text: label, hasDownload: false, region: regionOf(c), cta: true, className: c.getAttribute('class') || undefined });
    }
    for (const s of Array.from(doc.querySelectorAll('script[src]')).slice(0, 200)) scriptSrcs.push((s as HTMLScriptElement).src);
    for (const fr of Array.from(doc.querySelectorAll('iframe[src]')).slice(0, 50)) {
      const src = (fr as HTMLIFrameElement).src;
      if (src) iframeSrcs.push(src);
    }
    // Lazy iframes (real URL parked in data-src until scroll) + click-to-load
    // YouTube facades (lite-youtube-embed; the .youtube-player[data-id] pattern):
    // surface their embed URL so a player that hasn't upgraded yet is still seen.
    for (const fr of Array.from(doc.querySelectorAll('iframe[data-src], iframe[data-lazy-src]')).slice(0, 50)) {
      const src = fr.getAttribute('data-src') || fr.getAttribute('data-lazy-src') || '';
      if (src) iframeSrcs.push(src);
    }
    for (const fe of Array.from(doc.querySelectorAll('lite-youtube[videoid], .youtube-player[data-id], [data-youtube-id], [data-yt-id]')).slice(0, 30)) {
      const id = fe.getAttribute('videoid') || fe.getAttribute('data-id') || fe.getAttribute('data-youtube-id') || fe.getAttribute('data-yt-id') || '';
      if (/^[\w-]{6,15}$/.test(id)) iframeSrcs.push('https://www.youtube.com/embed/' + id);
    }
    for (const el of Array.from(doc.querySelectorAll('[class]')).slice(0, 1000)) {
      for (const c of (el as HTMLElement).classList) classNames.add(c);
      if (classNames.size > 600) break;
    }
    for (const sel of PROVIDER_SELECTORS) {
      try {
        if (doc.querySelector(sel)) selectorsPresent.add(sel);
      } catch {
        /* invalid selector */
      }
    }
    const mkto = doc.querySelector('[id^="mktoForm_"]') as HTMLElement | null;
    if (mkto?.id) selectorsPresent.add('#' + mkto.id);
  };

  scanDoc(document);
  // Same-origin iframes (HubSpot/Typeform/Marketo often render the form in one).
  // Cross-origin frames throw on contentDocument access → skipped by design.
  for (const fr of Array.from(document.querySelectorAll('iframe')).slice(0, 12)) {
    try {
      const d = (fr as HTMLIFrameElement).contentDocument;
      if (d && d.body) scanDoc(d);
    } catch {
      /* cross-origin iframe — inaccessible */
    }
  }

  // dataLayer snapshot: the distinct string `event` values the SITE ITSELF already pushes (mostly
  // load-time pageview/consent/config events). Used later to mark a suggestion "already pushed to the
  // dataLayer — nothing to install". Guarded end-to-end (a getter throwing, a frozen array, etc.) so a
  // read failure degrades to [] rather than aborting the whole collect.
  const dataLayerEvents: string[] = [];
  try {
    const dl = (window as unknown as { dataLayer?: unknown }).dataLayer;
    if (Array.isArray(dl)) {
      const seenEv = new Set<string>();
      for (const entry of dl) {
        if (seenEv.size >= 40) break;
        try {
          const ev = entry && typeof (entry as { event?: unknown }).event === 'string' ? (entry as { event: string }).event : '';
          if (ev && !seenEv.has(ev)) seenEv.add(ev);
        } catch {
          /* a hostile getter on this entry — skip it */
        }
      }
      dataLayerEvents.push(...seenEv);
    }
  } catch {
    /* window.dataLayer access threw — leave dataLayerEvents empty */
  }

  // Framework marker: the FIRST cheap DOM/window signal that identifies the JS framework. Order matters —
  // Next.js is a React app, so it must be checked before the generic React signal.
  let framework: string | undefined;
  try {
    const w = window as unknown as Record<string, unknown>;
    const has = (sel: string): boolean => {
      try {
        return !!document.querySelector(sel);
      } catch {
        return false;
      }
    };
    if (w.__NEXT_DATA__ || has('#__next')) framework = 'next';
    else if (has('#___gatsby')) framework = 'gatsby';
    else if (w.ng || has('[ng-version]')) framework = 'angular';
    else if (w.Vue || has('[data-v-app]') || (has('#app') && !!(document.querySelector('#app') as unknown as { __vue__?: unknown } | null)?.__vue__)) framework = 'vue';
    else if (w.React || has('[data-reactroot],#root')) framework = 'react';
  } catch {
    /* framework probe threw — leave undefined */
  }

  return {
    elements,
    signals: {
      scriptSrcs: scriptSrcs.slice(0, 300),
      classNames: Array.from(classNames),
      selectorsPresent: Array.from(selectorsPresent),
      iframeSrcs: iframeSrcs.slice(0, 80),
      dataLayerEvents,
      ...(framework ? { framework } : {}),
    },
  };
}

/* ── PURE classification (unit-tested, no browser) ── */

// Built from the engine's shared extension list so detection ⇔ the suggested
// tag's trigger filter can never diverge.
const DOWNLOAD_RE = new RegExp(`\\.(${DOWNLOAD_EXT})(\\?|#|$)`, 'i');
// A social-network URL that SHARES the current page (vs a FOLLOW link to the brand's profile). The
// canonical share endpoints: twitter/x intent, facebook sharer/dialog, linkedin share-offsite/shareArticle,
// pinterest pin/create, reddit submit, tumblr share, whatsapp/telegram share, plus the fallback of any
// social URL carrying a url=/u=/text= share payload. A share button gets the GA4 `share` event; a plain
// profile link stays a `social` (follow) click.
const SHARE_URL_RE = /(\/intent\/(tweet|post|share)|\/sharer\/|\/sharer\.php|\/dialog\/(share|feed)|\/sharing\/share-offsite|\/shareArticle|\/cws\/share|\/pin\/create|\/submit\b|\/widgets\/share|api\.whatsapp\.com\/send|wa\.me\/\?|t\.me\/share|telegram\.me\/share)/i;
export function isShareUrl(href: string): boolean {
  if (SHARE_URL_RE.test(href)) return true;
  // Fallback: a social host with a share payload query (the page URL / text being shared).
  return /[?&](url|u|text|body|link)=/i.test(href);
}
/** A "Copy link" clipboard control (no social URL) — the copy_link method of a share widget. Requires
 *  the word "link" so a bare "Copy" (copy code/coupon) is NOT mistaken for a page share. */
export function isCopyLinkControl(text: string): boolean {
  return /\bcopy\s*(the\s+)?link\b/i.test(text) || /\bcopy\s*url\b/i.test(text);
}
// Social-link detection (which network a host belongs to) lives in social.ts —
// shared with the GTM trigger builder so the two can't diverge.
const normHost = (h: string): string => h.replace(/^www\./i, '').toLowerCase();
// siteHost may arrive Unicode or with a scheme/path — route it through the URL
// parser so it's compared as the same punycode host-only form new URL().hostname
// yields for links.
function normSiteHost(s: string): string {
  try {
    return normHost(new URL(/^[a-z]+:\/\//i.test(s) ? s : 'http://' + s).hostname);
  } catch {
    return normHost(s);
  }
}

/** True when an anchor's measured box reads as a real BUTTON: a fill or a visible border, genuine
 *  padding, and a chunky height (>= 36px). The height floor is the key filter — conversion buttons are
 *  tall, while the filled/bordered PILLS that flood a page (category/tag chips, locale switchers,
 *  pagination, breadcrumb and social-share pills, badges) are short (typically < 32px). NaN box values
 *  (unparsed styles) fail every comparison, so a bad measurement degrades to false, not a throw. */
export function isStyledButton(box: NonNullable<RawElement['box']>): boolean {
  return (box.filled || box.bordered) && (box.padX >= 12 || box.padY >= 6) && box.h >= 36;
}

/** Classify one raw element → a DetectedElement, or null if not trackable. */
export function classifyElement(raw: RawElement, siteHost: string): DetectedElement | null {
  const href = raw.href || '';
  const region = raw.region || undefined;
  const make = (kind: DetectedElement['kind']): DetectedElement => ({ page: '', kind, text: raw.text, href: href || undefined, region, className: raw.className });
  if (/^mailto:/i.test(href)) return make('email');
  if (/^tel:/i.test(href)) return make('phone');
  if (raw.tag === 'a' && /^https?:/i.test(href)) {
    if (raw.hasDownload || DOWNLOAD_RE.test(href)) return make('download');
    let host = '';
    try {
      host = normHost(new URL(href).hostname);
    } catch {
      host = '';
    }
    const site = normSiteHost(siteHost);
    const internal = !host || host === site || host.endsWith('.' + site);
    // Internal links (incl. the site's own social-named subdomain) are nav, not
    // social/outbound. Among external links, social wins (a social link IS
    // outbound, but we want it named) — and we record WHICH network it is.
    if (!internal) {
      const net = socialNetworkOf(host);
      if (net) {
        // A SHARE link (twitter/intent, facebook/sharer, linkedin/share-offsite, …) → the GA4 `share`
        // event with this network as the method; a plain FOLLOW link to the profile → a `social` click.
        if (isShareUrl(href)) return { ...make('share'), shareMethod: net };
        return { ...make('social'), socialNetwork: net, socialDomain: socialDomainOf(host) ?? undefined };
      }
      return make('outbound');
    }
  }
  // A "Copy link" clipboard control (a <button>/JS <a> with no social URL) is part of a share widget →
  // the copy_link method. Checked before the CTA branch so it isn't mis-read as a generic CTA.
  if ((raw.tag === 'button' || raw.tag === 'a') && isCopyLinkControl(raw.text || '')) {
    return { ...make('share'), shareMethod: 'copy_link' };
  }
  // CTA: a known-intent button/link, OR (low confidence) any prominent button / CTA-styled control
  // whose label reads like an action — so a styled CTA ("Talk to our experts") surfaces instead of
  // being dropped. A plain nav <a> (not a <button>, not CTA-styled) stays untracked, so nav menus
  // don't flood the list.
  if (raw.tag === 'button' || raw.tag === 'a') {
    const intent = raw.text ? classifyCtaIntent(raw.text) : null;
    if (intent) return { ...make('cta'), intent };
    // Generic (low-confidence) CTA: a real <button>, a class/role/onclick-flagged control, or an <a>
    // whose measured box is button-sized (a filled/bordered, chunky box — NOT a small chip/pill). A
    // button-styled link inside the NAV is almost always a menu item, so the fallback skips region 'nav'.
    const styled = raw.tag === 'a' && raw.box ? isStyledButton(raw.box) : false;
    if ((raw.tag === 'button' || raw.cta || styled) && raw.region !== 'nav' && isPromptableCtaText(raw.text)) return { ...make('cta'), intent: 'generic' };
  }
  return null;
}

// Pure UI chrome (menu / dialog / pagination / expanders) — excluded from the generic CTA bucket.
// Anchored to the WHOLE label so a real CTA that merely starts with one of these words is KEPT
// ("Open account", "Show pricing", "Read the guide", "Close the deal"), while the common multi-word
// chrome IS dropped ("Toggle navigation", "Show more", "Load more", "Back to top", "Next page").
const CTA_CHROME_RE = /^(menu|open\s+menu|toggle(\s+\w+)?|expand|collapse|skip\b.*|(previous|prev|next)(\s+(page|post|slide|step|item|»|›|>))?|back(\s+to\s+\w+)?|(show|load|view|see|read)\s+(more|less|all)|scroll(\s+to\s+\w+)?|go\s+to\s+\w+|first|last|[«»‹›<>×✕|–—\s-]+)$/i;
// Cookie / consent-banner controls — a GA4 click tag on these is noise, not a conversion.
const CONSENT_RE = /\b(cookies?|consent|gdpr|ccpa)\b|\b(accept|reject|decline|allow|deny|manage|customi[sz]e)\s+(all|preferences?|tracking|choices?)\b|^(accept|reject|decline|allow|deny|got\s+it|i\s+(agree|accept|understand)|ok(ay)?)$/i;
// A button label worth surfacing as a generic (low-confidence) CTA: real visible text, not UI chrome
// or a consent control, and not a whole sentence. Keeps the generic bucket to button-like LABELS.
function isPromptableCtaText(text: string): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  // Button-like labels cap at 48 chars, but a QUESTION ("…?" — an FAQ accordion row) may run longer,
  // so allow those up to 120 chars (the engine groups repeated question rows into one FAQ tag).
  if (t.length < 2 || (t.length > 48 && !(t.length <= 120 && /\?$/.test(t)))) return false;
  if (CTA_CHROME_RE.test(t) || CONSENT_RE.test(t)) return false;
  return /[a-z0-9]/i.test(t); // has an actual word/character, not just an icon/punctuation
}

export function classifyPageElements(raws: RawElement[], siteHost: string, page: string): DetectedElement[] {
  const out: DetectedElement[] = [];
  for (const r of raws) {
    const d = classifyElement(r, siteHost);
    if (d) out.push({ ...d, page });
  }
  return out;
}

/* ── Assemble the engine input (pure) ── */

export interface PageScan {
  /** Page PATH, e.g. "/contact". */
  page: string;
  elements: DetectedElement[];
  /** From forms.ts FormAnalysis (subset). */
  forms: Array<{
    purpose: FormPurpose;
    action: string;
    method?: string;
    formId?: string;
    formClasses?: string;
    title?: string;
    fields?: FormFieldSummary[];
    hidden?: boolean;
  }>;
  signals: PageSignals;
}

/* ── eCommerce auto-detection (pure) ─────────────────────────────────────────
 * Inspect the already-collected forms/elements/pages + page signals and decide
 * whether the site is an online store. Conservative by design: a blog with a
 * stray "/shop" link must NOT be flagged, so a single MEDIUM signal is never
 * enough — either one STRONG signal or two DISTINCT MEDIUM categories. */

// STRONG: a script from a known ecommerce PLATFORM / hosted checkout ⇒ ecommerce on its own.
const ECOMMERCE_PLATFORM_SCRIPTS: Array<{ re: RegExp; label: string }> = [
  { re: /cdn\.shopify\.com|shopify/i, label: 'Shopify script' },
  { re: /woocommerce|wp-content\/plugins\/woocommerce/i, label: 'WooCommerce script' },
  { re: /magento|mage\//i, label: 'Magento script' },
  { re: /bigcommerce/i, label: 'BigCommerce script' },
  { re: /snipcart/i, label: 'Snipcart script' },
  { re: /squarespace.*commerce|sqs-commerce/i, label: 'Squarespace Commerce script' },
  { re: /cdn\.checkout\.com|checkout\.stripe\.com/i, label: 'hosted checkout script' },
];
// MEDIUM: a payment-provider script (present on many stores, but also on non-store donation/booking
// pages — so it only counts toward the 2-category threshold, never alone).
const PAYMENT_PROVIDER_SCRIPTS: Array<{ re: RegExp; label: string }> = [
  { re: /js\.stripe\.com|stripe\.com/i, label: 'Stripe payment script' },
  { re: /paypal(objects)?\.com|paypal/i, label: 'PayPal payment script' },
  { re: /braintree/i, label: 'Braintree payment script' },
];
// MEDIUM: an ecommerce-ish path segment on a page path OR an element href.
const ECOMMERCE_PATH_RE = /\/(cart|checkout|basket|shop|products?|collections)(\/|\?|$)/i;
// MEDIUM: element/link TEXT that reads like a purchase ACTION. Deliberately excludes bare destination
// words ("checkout"/"cart"/"basket") — those are already the `path` category, and letting one
// "Checkout" button (text "Checkout" + href "/checkout") satisfy BOTH categories would clear the
// 2-distinct-signal bar from a single element and misclassify a non-store as ecommerce.
const ECOMMERCE_TEXT_RE = /\b(add to cart|add to bag|add to basket|buy now)\b/i;
// MEDIUM: a price-like token (currency symbol immediately before digits, e.g. "$29", "£9.99").
const PRICE_RE = /[$£€₹]\s?\d/;

/** Decide whether the scanned site is eCommerce, with human-readable evidence. PURE.
 *  isEcommerce = (any STRONG signal) OR (>= 2 DISTINCT MEDIUM categories). */
export function detectEcommerceSignals(
  forms: Array<{ purpose: FormPurpose }>,
  elements: DetectedElement[],
  pages: Array<{ page: string }>,
  scriptSrcs: string[],
): { isEcommerce: boolean; evidence: string[] } {
  const evidence: string[] = [];
  let strong = false;
  // STRONG: an add-to-cart element intent.
  if (elements.some((e) => e.kind === 'cta' && e.intent === 'add_to_cart')) {
    strong = true;
    evidence.push("'Add to cart' button");
  }
  // STRONG: a checkout-purpose form.
  if (forms.some((f) => f.purpose === 'checkout')) {
    strong = true;
    evidence.push('checkout form');
  }
  // STRONG: an ecommerce PLATFORM script.
  for (const { re, label } of ECOMMERCE_PLATFORM_SCRIPTS) {
    if (scriptSrcs.some((s) => re.test(s))) {
      strong = true;
      evidence.push(label);
      break;
    }
  }

  // MEDIUM categories (each counts ONCE): ecommerce path, purchase-action text, price, payment script.
  const medium = new Set<string>();
  const pathHit =
    pages.find((p) => ECOMMERCE_PATH_RE.test(p.page)) ??
    (elements.find((e) => e.href && ECOMMERCE_PATH_RE.test(e.href)) ? { page: '' } : undefined);
  if (pathHit) {
    medium.add('path');
    const sample = pages.find((p) => ECOMMERCE_PATH_RE.test(p.page))?.page
      ?? elements.find((e) => e.href && ECOMMERCE_PATH_RE.test(e.href))?.href;
    const seg = sample ? (ECOMMERCE_PATH_RE.exec(sample)?.[1] ?? '') : '';
    evidence.push(seg ? `ecommerce path /${seg}` : 'ecommerce path');
  }
  if (elements.some((e) => ECOMMERCE_TEXT_RE.test(e.text || ''))) {
    medium.add('text');
    const m = elements.map((e) => ECOMMERCE_TEXT_RE.exec(e.text || '')?.[0]).find(Boolean);
    evidence.push(m ? `"${m}" text` : 'purchase-action text');
  }
  if (elements.some((e) => PRICE_RE.test(e.text || ''))) {
    medium.add('price');
    evidence.push('price-like text');
  }
  for (const { re, label } of PAYMENT_PROVIDER_SCRIPTS) {
    if (scriptSrcs.some((s) => re.test(s))) {
      medium.add('payment');
      evidence.push(label);
      break;
    }
  }

  // ecommerce = a STRONG signal alone, OR 2+ medium categories WHERE at least one is genuinely
  // CART-related (a store path like /cart|/shop|/products, or a purchase-action text like "add to
  // cart"/"buy now"). Price + a payment script are BOTH common on NON-stores — an analytics/consulting
  // site that lists service prices and books via Stripe, a donation page, a SaaS pricing page — so those
  // two alone must NOT classify a site as ecommerce (the false positive on samarthanalytics.com).
  const cartish = medium.has('path') || medium.has('text');
  const isEcommerce = strong || (cartish && medium.size >= 2);
  return { isEcommerce, evidence: isEcommerce ? evidence : [] };
}

/** Combine per-page scans into the Phase-1 engine's SuggestInput, attaching a
 *  detected provider to every form. Pure — the buildSuggestions() engine then
 *  maps + dedups + ranks. */
export function buildSuggestInput(pages: PageScan[], siteHost: string): SuggestInput {
  const forms: DetectedForm[] = [];
  const elements: DetectedElement[] = [];
  const videoEmbeds: VideoEmbed[] = [];
  for (const p of pages) {
    elements.push(...p.elements);
    // An embedded YouTube player → one site-wide YouTube Video tag suggestion.
    if (hasYouTubeEmbed(p.signals.iframeSrcs)) videoEmbeds.push({ page: p.page, provider: 'youtube' });
    for (const f of p.forms) {
      forms.push({
        page: p.page,
        purpose: f.purpose,
        action: f.action,
        provider: detectFormProvider(p.signals, f.action),
        method: f.method,
        formId: f.formId,
        formClasses: f.formClasses,
        title: f.title,
        fields: f.fields,
        hidden: f.hidden,
      });
    }
    // A provider form is EMBEDDED (often a cross-origin iframe whose fields we can't
    // read) → synthesize a lead form so it still gets a suggestion (these embeds are
    // typically lead/contact). Runs even when the page has other readable forms, so a
    // HubSpot/Calendly embed beside a search box isn't suppressed. Skip only if a READABLE
    // form on this page is ITSELF that provider — judged by THAT form's own classes/action
    // (not page-level signals, which would mis-attribute the embed to an unrelated form).
    const embed = detectEmbeddedForm(p.signals);
    if (embed) {
      // Judge each readable form by ITS OWN action + classes + id (the form's action host is fed as a
      // script/iframe src so detectFormProvider's host regexes match, e.g. a js.hsforms.net action →
      // hubspot). So a same-provider readable form suppresses the synth (no double), while an unrelated
      // form (a search box) on a page that merely embeds a provider does NOT.
      const isSameProviderForm = (f: { formClasses?: string; formId?: string; action: string }): boolean =>
        detectFormProvider(
          {
            scriptSrcs: f.action ? [f.action] : [],
            classNames: (f.formClasses ?? '').split(/\s+/).filter(Boolean),
            selectorsPresent: f.formId ? ['#' + f.formId] : [],
            iframeSrcs: f.action ? [f.action] : [],
          },
          f.action,
        ).vendor === embed.vendor;
      if (!p.forms.some(isSameProviderForm)) {
        forms.push({ page: p.page, purpose: 'contact', action: '', provider: embed });
      }
    }
  }
  // Auto-detect eCommerce from everything collected (forms/elements/pages + page scripts). An
  // ecommerce site unlocks the ecommerce funnel event suggestions; a non-ecommerce site emits none.
  const scriptSrcs = pages.flatMap((p) => p.signals.scriptSrcs);
  const { isEcommerce, evidence } = detectEcommerceSignals(forms, elements, pages, scriptSrcs);
  // Deduped union of the dataLayer `event` values the SITE already pushes — threaded to buildSuggestions
  // so a custom_event tag whose event is already pushed becomes "already tracked, nothing to install".
  const dlEventSet = new Set<string>();
  for (const p of pages) for (const ev of p.signals.dataLayerEvents ?? []) if (ev) dlEventSet.add(ev);
  const dataLayerEvents = [...dlEventSet];
  return {
    siteHost,
    forms,
    elements,
    ...(videoEmbeds.length ? { videoEmbeds } : {}),
    websiteType: isEcommerce ? 'ecommerce' : 'non_ecommerce',
    ...(evidence.length ? { ecommerceEvidence: evidence } : {}),
    ...(dataLayerEvents.length ? { dataLayerEvents } : {}),
  };
}

/** Playwright wrapper: run the in-page collector on an already-navigated page. */
export async function collectPageRaw(page: PwPage): Promise<PageScanRaw> {
  return page.evaluate<PageScanRaw>(collectPageInBrowser);
}
