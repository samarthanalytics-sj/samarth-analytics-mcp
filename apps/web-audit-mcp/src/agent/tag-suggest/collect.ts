// Phase 2: turn a real page into the Phase-1 engine's input. Mirrors forms.ts:
// an in-page DOM extractor (collectPageInBrowser, runs in Playwright, returns RAW
// data) + a PURE classifier (classifyElement / buildSuggestInput, unit-tested,
// no browser). The same raw shape can be produced by a Cheerio static parse, so
// a no-browser path for custom-HTML pages drops in later without touching the
// classifier.

import type { PwPage } from '../browser.js';
import type { PageSignals, DetectedElement, DetectedForm, SuggestInput, FormPurpose } from './types.js';
import { detectFormProvider } from './providers.js';
import { DOWNLOAD_EXT } from './suggest.js';

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

/** Serialized by Playwright and executed IN the page (DOM globals). */
export function collectPageInBrowser(): PageScanRaw {
  const MAX = 400;
  const regionOf = (el: Element): RawElement['region'] => {
    const t = el.closest('header,footer,nav,main')?.tagName.toLowerCase();
    return t === 'header' || t === 'footer' || t === 'nav' || t === 'main' ? t : '';
  };
  const txt = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const elements: RawElement[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, MAX)) {
    const el = a as HTMLAnchorElement;
    elements.push({ tag: 'a', href: el.href || '', text: txt(el), hasDownload: el.hasAttribute('download'), region: regionOf(el) });
  }
  // :not(a) — an <a href role="button"> is already captured (with its href) by the
  // anchor query above; without this it would be emitted a second time as a hrefless
  // "button" and double-classified.
  for (const b of Array.from(document.querySelectorAll('button, [role="button"]:not(a)')).slice(0, MAX)) {
    elements.push({ tag: 'button', href: '', text: txt(b), hasDownload: false, region: regionOf(b) });
  }
  const scriptSrcs = Array.from(document.querySelectorAll('script[src]'))
    .map((s) => (s as HTMLScriptElement).src)
    .slice(0, 200);
  const classNames = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('[class]')).slice(0, 1000)) {
    for (const c of (el as HTMLElement).classList) classNames.add(c);
    if (classNames.size > 600) break;
  }
  const selectorsPresent: string[] = [];
  for (const sel of ['.hs-form', '[data-tf-widget]', '#mce-EMAIL', '#mc-embedded-subscribe', '.gform_wrapper', '.wpcf7', '.wpforms-form', '.wpforms-container']) {
    try {
      if (document.querySelector(sel)) selectorsPresent.push(sel);
    } catch {
      /* invalid selector */
    }
  }
  const mkto = document.querySelector('[id^="mktoForm_"]') as HTMLElement | null;
  if (mkto?.id) selectorsPresent.push('#' + mkto.id);
  return { elements, signals: { scriptSrcs, classNames: Array.from(classNames), selectorsPresent } };
}

/* ── PURE classification (unit-tested, no browser) ── */

// Built from the engine's shared extension list so detection ⇔ the suggested
// tag's trigger filter can never diverge.
const DOWNLOAD_RE = new RegExp(`\\.(${DOWNLOAD_EXT})(\\?|#|$)`, 'i');
// A focused CTA vocabulary — high-precision, not "every button". Bare "register"
// is excluded (matches header "Login / Register" auth links, not conversions).
const CTA_RE = /\b(book(\s+a)?\s+demo|request\s+(a\s+)?(demo|quote)|get\s+(a\s+)?(quote|started)|sign\s*up|free\s+trial|start\s+(free|now|trial)|subscribe|contact\s+sales|buy\s+now|add\s+to\s+cart|create\s+account)\b/i;
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
    if (host && host !== site && !host.endsWith('.' + site)) return make('outbound');
  }
  // CTA: a button, or a non-tracked anchor whose text reads like a call to action.
  if ((raw.tag === 'button' || raw.tag === 'a') && raw.text && CTA_RE.test(raw.text)) return make('cta');
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
  forms: Array<{ purpose: FormPurpose; action: string }>;
  signals: PageSignals;
}

/** Combine per-page scans into the Phase-1 engine's SuggestInput, attaching a
 *  detected provider to every form. Pure — the buildSuggestions() engine then
 *  maps + dedups + ranks. */
export function buildSuggestInput(pages: PageScan[], siteHost: string): SuggestInput {
  const forms: DetectedForm[] = [];
  const elements: DetectedElement[] = [];
  for (const p of pages) {
    elements.push(...p.elements);
    for (const f of p.forms) {
      forms.push({ page: p.page, purpose: f.purpose, action: f.action, provider: detectFormProvider(p.signals, f.action) });
    }
  }
  return { siteHost, forms, elements };
}

/** Playwright wrapper: run the in-page collector on an already-navigated page. */
export async function collectPageRaw(page: PwPage): Promise<PageScanRaw> {
  return page.evaluate<PageScanRaw>(collectPageInBrowser);
}
