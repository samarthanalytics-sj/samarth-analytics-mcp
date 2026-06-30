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

  const scanDoc = (doc: Document): void => {
    for (const a of Array.from(doc.querySelectorAll('a[href]')).slice(0, MAX)) {
      if (elements.length >= MAX * 2) break;
      const el = a as HTMLAnchorElement;
      elements.push({ tag: 'a', href: el.href || '', text: txt(el), hasDownload: el.hasAttribute('download'), region: regionOf(el) });
    }
    // :not(a) — an <a href role="button"> is already captured (with its href) by
    // the anchor query above; without this it would be emitted again as a hrefless
    // "button" and double-classified.
    for (const b of Array.from(doc.querySelectorAll('button, [role="button"]:not(a)')).slice(0, MAX)) {
      if (elements.length >= MAX * 2) break;
      elements.push({ tag: 'button', href: '', text: txt(b), hasDownload: false, region: regionOf(b) });
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
  return { elements, signals: { scriptSrcs: scriptSrcs.slice(0, 300), classNames: Array.from(classNames), selectorsPresent: Array.from(selectorsPresent), iframeSrcs: iframeSrcs.slice(0, 80) } };
}

/* ── PURE classification (unit-tested, no browser) ── */

// Built from the engine's shared extension list so detection ⇔ the suggested
// tag's trigger filter can never diverge.
const DOWNLOAD_RE = new RegExp(`\\.(${DOWNLOAD_EXT})(\\?|#|$)`, 'i');
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

/** Classify one raw element → a DetectedElement, or null if not trackable. */
export function classifyElement(raw: RawElement, siteHost: string): DetectedElement | null {
  const href = raw.href || '';
  const region = raw.region || undefined;
  const make = (kind: DetectedElement['kind']): DetectedElement => ({ page: '', kind, text: raw.text, href: href || undefined, region });
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
      if (net) return { ...make('social'), socialNetwork: net, socialDomain: socialDomainOf(host) ?? undefined };
      return make('outbound');
    }
  }
  // CTA: a button, or a non-tracked anchor whose text reads like a call to action.
  if (raw.tag === 'button' || raw.tag === 'a') {
    const intent = raw.text ? classifyCtaIntent(raw.text) : null;
    if (intent) return { ...make('cta'), intent };
  }
  return null;
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
  }>;
  signals: PageSignals;
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
      const isSameProviderForm = (f: { formClasses?: string; action: string }): boolean =>
        detectFormProvider({ scriptSrcs: [], classNames: (f.formClasses ?? '').split(/\s+/).filter(Boolean), selectorsPresent: [], iframeSrcs: [] }, f.action).vendor === embed.vendor;
      if (!p.forms.some(isSameProviderForm)) {
        forms.push({ page: p.page, purpose: 'contact', action: '', provider: embed });
      }
    }
  }
  return { siteHost, forms, elements, ...(videoEmbeds.length ? { videoEmbeds } : {}) };
}

/** Playwright wrapper: run the in-page collector on an already-navigated page. */
export async function collectPageRaw(page: PwPage): Promise<PageScanRaw> {
  return page.evaluate<PageScanRaw>(collectPageInBrowser);
}
