// VERIFY-FIRING DRIVER — loads a page, INJECTS the user's (preview) container so
// draft tags load, then DRIVES each tag's own trigger (click a matching control /
// submit the matching form) and captures the analytics /collect hits it fires.
//
// Same abort-first safety as synthetic-driver.ts: a request classified as an
// analytics collector is CAPTURED then route.abort()'d — never delivered — so
// verification never sends a real hit to GA4/Meta/the tagging server. Navigation
// and real form POSTs are neutralised in-page (capturing preventDefault) so
// clicking a link / submitting a form fires GTM's trigger without leaving the
// page or posting real data.
//
// Playwright is OPTIONAL (loaded lazily); if absent the caller gets a clear error.

import { requestAllowed } from './ssrf';
import { classifyCollector, syntheticDataLayerEvent, buildNetworkLog, summarizeDataLayer, type Collector, type DescribedHit, type DataLayerEventView } from '../../shared/runtime-capture';
import { PlaywrightUnavailableError } from './playwright-driver';
import type { PerTagCapture } from './verify-tags';

interface PwRoute {
  request(): { url(): string; postData(): string | null; resourceType(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PwResponse { status(): number }
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  evaluate<T = unknown>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; timeout?: number }): Promise<Buffer>;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
}
interface PwBrowser { newContext(opts?: Record<string, unknown>): Promise<PwContext>; close(): Promise<void> }
interface Playwright { chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> } }

async function loadPlaywright(): Promise<Playwright | null> {
  try {
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}
const safePostData = (req: { postData(): string | null }): string | null => {
  try {
    return req.postData();
  } catch {
    return null;
  }
};
function isBeaconType(rt: string): boolean {
  return rt !== 'script' && rt !== 'stylesheet' && rt !== 'font' && rt !== 'document';
}

/** The trigger fields the driver needs to locate + drive an element. */
export interface DriverTrigger {
  kind: string;
  clickTextValue?: string;
  clickTextOperator?: string;
  clickUrlValue?: string;
  clickUrlOperator?: string;
  formIdValue?: string;
  formIdOperator?: string;
  formClassesValue?: string;
  formClassesOperator?: string;
  /** For custom_event triggers: the dataLayer event name to push. */
  eventName?: string;
  /** For custom_event triggers whose tag keys off form-specific data (a shared `form_submission`
   *  event split by `{{form_name}}`/`{{form_id}}`): extra dataLayer key→value pairs to push
   *  alongside the event, so the tag's condition matches. */
  customEventData?: Record<string, string>;
}
export interface VerifyDriverTag {
  id: string;
  /** The page the tag's trigger lives on ("/contact", "site-wide", "/"). Drives per-page navigation. */
  page?: string;
  trigger: DriverTrigger;
}

// Distinct pages the driver will navigate to drive tags on. Raised for sitemap-driven verification so a
// container whose click tags spread across many landing pages is covered (the driver only visits pages
// that actually have a routed tag, so this self-limits — it's a ceiling, not a fixed cost).
const MAX_VERIFY_PAGES = 40;

/** Resolve a tag's page ("/contact" | "site-wide" | undefined) to a full URL against the base. */
function resolvePageUrl(baseUrl: string, page: string | undefined): string {
  if (!page || page === 'site-wide' || page === '/') return baseUrl;
  try {
    return new URL(page, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

/** Group tags by the page their trigger lives on, so each is driven on the RIGHT page. */
function groupByPage(baseUrl: string, tags: VerifyDriverTag[]): Map<string, VerifyDriverTag[]> {
  const map = new Map<string, VerifyDriverTag[]>();
  for (const t of tags) {
    const pageUrl = resolvePageUrl(baseUrl, t.page);
    const arr = map.get(pageUrl);
    if (arr) arr.push(t);
    else if (map.size < MAX_VERIFY_PAGES) map.set(pageUrl, [t]);
  }
  return map;
}
export interface VerifyDriverOptions {
  /** GTM Preview snippet / URL / GTM-XXXX id the user pasted, so DRAFT tags load. */
  containerSnippet?: string;
  navTimeoutMs?: number;
  /** Wait after each interaction so the tag fires and its (aborted) hit is captured. */
  settleMs?: number;
  /** Phase B (best-effort): also read GTM's own debug signal from the page (which container ids
   *  actually loaded + the dataLayer event stream) so a "0 fired" result can distinguish
   *  "container didn't load" from "loaded but the tag/condition didn't match". Off by default. */
  gtmDebug?: boolean;
}
/** GTM's on-page debug signal (Phase B). Best-effort + observable — NOT the full Tag-Assistant
 *  per-tag protocol (that is undocumented and needs live-GTM validation). */
export interface GtmDebugCapture {
  /** A GTM-XXXX container was actually present on the page (google_tag_manager global). */
  containerLoaded: boolean;
  containerIds: string[];
  /** Distinct dataLayer `event` names the container processed (gtm.js/gtm.dom/gtm.load + your events). */
  dataLayerEvents: string[];
}
export interface VerifyDriverResult {
  pagesOk: boolean;
  injected: boolean;
  /** The injected snippet carried workspace-preview auth (so DRAFT tags load). */
  previewAuth: boolean;
  error?: string;
  perTag: PerTagCapture[];
  /** The distinct page URLs the driver successfully navigated + drove (multi-page drive). */
  pagesDriven?: string[];
  /** DevTools-Network-style log of the analytics calls captured (Meta pixel, GA4, sGTM relay, pixels)
   *  — the browser-side (layer-1) evidence. Server-side CAPI (graph.facebook.com) never reaches here. */
  networkLog?: DescribedHit[];
  /** Present only when opts.gtmDebug — the on-page GTM debug signal (Phase B groundwork). */
  gtmDebug?: GtmDebugCapture;
  /** The site's REAL dataLayer pushes captured during the drive, each with its parameters — the
   *  Tag-Assistant-style dataLayer view. Shows exactly what the site emits (page_view, form_start,
   *  cta_click, …) so a trigger can be built/aligned to the real event + params. Events the verifier
   *  pushed synthetically to test custom_event tags are flagged `synthetic`. */
  dataLayer?: DataLayerEventView[];
}

/** Read GTM's on-page debug signal + the real dataLayer pushes (serialized to page.evaluate — DOM
 *  globals only). Each push is SANITISED to a JSON-safe { event, params } (DOM nodes/functions dropped,
 *  nested objects summarised) so it survives the evaluate boundary; summarizeDataLayer formats it. */
function readGtmDebugInPage(): { containerIds: string[]; dataLayerEvents: string[]; dataLayer: Array<{ event: string; params: Record<string, string> }> } {
  const w = window as unknown as { google_tag_manager?: Record<string, unknown>; dataLayer?: Array<Record<string, unknown>> };
  const containerIds = w.google_tag_manager ? Object.keys(w.google_tag_manager).filter((k) => /^GTM-/i.test(k)) : [];
  const rawDl = Array.isArray(w.dataLayer) ? w.dataLayer : [];
  const dataLayerEvents = [...new Set(rawDl.map((e) => (e && typeof e === 'object' ? String((e as { event?: unknown }).event ?? '') : '')).filter(Boolean))];
  const dataLayer: Array<{ event: string; params: Record<string, string> }> = [];
  for (const item of rawDl.slice(-250)) {
    if (!item || typeof item !== 'object') continue;
    const ev = String((item as { event?: unknown }).event ?? '');
    if (!ev) continue;
    const params: Record<string, string> = {};
    let n = 0;
    for (const k of Object.keys(item)) {
      if (k === 'event' || n >= 15) continue;
      const v = (item as Record<string, unknown>)[k];
      if (v == null) continue;
      const t = typeof v;
      if (t === 'function') continue;
      if (t === 'object') {
        if (typeof Node !== 'undefined' && v instanceof Node) continue; // a DOM element (gtm.element) — skip
        try { params[k] = Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).slice(0, 5).join(',')}}`; } catch { continue; }
      } else {
        params[k] = String(v).slice(0, 80);
      }
      n += 1;
    }
    dataLayer.push({ event: ev, params });
  }
  return { containerIds, dataLayerEvents, dataLayer };
}

/**
 * Derive a gtm.js loader src from a pasted snippet / URL / GTM-XXXX id, or null.
 *
 * Crucially, it PRESERVES the preview/environment params (gtm_auth / gtm_preview /
 * gtm_cookies_win) so a GTM "Preview" or Environment snippet loads the WORKSPACE
 * (with your just-created draft tags) — not the published container. A bare id, or
 * a snippet without those params, loads the published container.
 */
export function buildLoaderSrc(snippet: string | undefined): string | null {
  if (!snippet) return null;
  const s = snippet.trim();
  // A full gtm.js URL with a literal GTM id (already carries any params) — use as-is.
  const urlMatch = s.match(/https?:\/\/[^"'\s]*\/gtm\.js\?[^"'\s]*id=GTM-[^"'\s&]+[^"'\s]*/i);
  if (urlMatch) return urlMatch[0];
  // Otherwise a snippet where the id is concatenated (`id='+i+...`); pull the id +
  // the preview params out of the text and rebuild the URL.
  const idMatch = s.match(/GTM-[A-Z0-9]+/i);
  if (!idMatch) return null;
  let src = `https://www.googletagmanager.com/gtm.js?id=${idMatch[0].toUpperCase()}`;
  const auth = s.match(/gtm_auth=([^&'"\s]+)/i);
  const preview = s.match(/gtm_preview=([^&'"\s]+)/i);
  const cookiesWin = s.match(/gtm_cookies_win=([^&'"\s]+)/i);
  if (auth && preview) {
    src += `&gtm_auth=${auth[1]}&gtm_preview=${preview[1]}&gtm_cookies_win=${cookiesWin ? cookiesWin[1] : 'x'}`;
  }
  return src;
}

/** True when the loader carries workspace-preview auth (vs. the published container). */
export function isPreviewLoader(src: string | null): boolean {
  return Boolean(src && /gtm_auth=/.test(src) && /gtm_preview=/.test(src));
}

// ── In-page helpers (serialized to page.evaluate — DOM globals only) ──────────

/** Neutralise navigations + real submits so driving fires GTM's trigger without side effects. */
function installGuardsInPage(): void {
  const w = window as unknown as { __vf_guard?: boolean };
  if (w.__vf_guard) return;
  w.__vf_guard = true;
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as Element | null;
      const a = t && t.closest ? t.closest('a[href]') : null;
      if (a) e.preventDefault(); // stop navigation; GTM's bubble-phase listener still fires
    },
    true,
  );
  document.addEventListener('submit', (e) => e.preventDefault(), true); // stop the real POST
}

/**
 * Grant Consent Mode v2 in-page so consent-gated tags (GA4/Ads/Meta) actually fire during
 * verification. Synthetic override — the question we answer is "does the tag fire when consent is
 * granted", not "what does the site's CMP do". Mirrors gtag('consent','update',{...granted}).
 */
function grantConsentInPage(): void {
  const w = window as unknown as { dataLayer?: unknown[] };
  const dl = (w.dataLayer = w.dataLayer || []);
  const gtag = function (this: unknown): void {
    // eslint-disable-next-line prefer-rest-params
    dl.push(arguments);
  };
  (gtag as unknown as (...a: unknown[]) => void)('consent', 'update', {
    ad_storage: 'granted',
    analytics_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
  });
}

/**
 * Build the dataLayer object to push for one custom_event drive: the synthetic event + this tag's
 * resolved form-specific data, with every PRIOR-pushed key this tag is NOT setting blanked to '' so
 * a stale value (a GTM Data Layer Variable reads the last value for its key) can't falsely satisfy
 * this tag's condition and wrongly credit it. PURE — the driver owns the browser + the key set.
 */
export function buildCustomEventPayload(
  evName: string,
  customEventData: Record<string, string> | undefined,
  priorKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const data = customEventData ?? {};
  const reset: Record<string, unknown> = {};
  for (const k of priorKeys) if (!(k in data)) reset[k] = '';
  return { ...(syntheticDataLayerEvent(evName) as Record<string, unknown>), ...reset, ...data };
}

/** Push a (synthetic) dataLayer event so a custom_event trigger fires. */
function pushDataLayerInPage(payload: Record<string, unknown>): void {
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push(payload);
}

/** Wait until the captured-hit count stops growing for quietMs, or maxMs elapses — robust for
 *  delayed/timer/debounced triggers (better than a single fixed sleep). */
async function waitForHitsSettle(getCount: () => number, page: PwPage, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  let last = getCount();
  let lastChange = Date.now();
  for (;;) {
    if (Date.now() - start >= maxMs) return;
    await page.waitForTimeout(120);
    const cur = getCount();
    if (cur !== last) {
      last = cur;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}

interface DriveSpec {
  kind: string;
  clickText?: string;
  clickTextOp?: string;
  clickUrl?: string;
  clickUrlOp?: string;
  formId?: string;
  formIdOp?: string;
  formClasses?: string;
  formClassesOp?: string;
}
interface DriveOutcome {
  targetFound: boolean;
  performed: boolean;
  note?: string;
}

/** Locate the element/form the trigger targets and perform the interaction. */
function driveInPage(spec: DriveSpec): DriveOutcome {
  // Ring the element we're about to drive + scroll it into view, so the screenshot the driver takes
  // right after is visual PROOF of exactly which control was clicked / which form was submitted.
  const highlight = (node: Element): void => {
    try {
      // Clear any PRIOR ring first, so each screenshot marks only the control THIS tag drove.
      document.querySelectorAll('[data-sx-hl]').forEach((p) => {
        const e = p as HTMLElement;
        e.style.removeProperty('outline'); e.style.removeProperty('outline-offset'); e.style.removeProperty('box-shadow');
        e.removeAttribute('data-sx-hl');
      });
      const h = node as HTMLElement;
      h.setAttribute('data-sx-hl', '1');
      h.style.setProperty('outline', '3px solid #ff2d55', 'important');
      h.style.setProperty('outline-offset', '2px', 'important');
      h.style.setProperty('box-shadow', '0 0 0 4px rgba(255,45,85,0.35)', 'important');
      h.scrollIntoView({ block: 'center', inline: 'center' });
    } catch { /* best-effort — never let highlighting break the drive */ }
  };
  const matches = (hay: string, val: string | undefined, op: string | undefined): boolean => {
    if (!val) return false;
    const h = (hay || '').trim();
    const hl = h.toLowerCase();
    const vl = val.toLowerCase();
    switch (op) {
      case 'contains':
        return hl.indexOf(vl) >= 0;
      case 'startsWith':
        return hl.indexOf(vl) === 0;
      case 'endsWith':
        return vl.length > 0 && hl.lastIndexOf(vl) === hl.length - vl.length;
      case 'matchRegex':
        try {
          return new RegExp(val, 'i').test(h);
        } catch {
          return false;
        }
      default:
        return hl === vl; // equals
    }
  };

  if (spec.kind === 'form_submit') {
    const forms = Array.prototype.slice.call(document.querySelectorAll('form')) as HTMLFormElement[];
    let f: HTMLFormElement | undefined;
    if (spec.formId) f = forms.find((x) => matches(x.id, spec.formId, spec.formIdOp || 'equals'));
    if (!f && spec.formClasses) f = forms.find((x) => matches(x.className, spec.formClasses, spec.formClassesOp || 'contains'));
    if (!f && forms.length === 1) f = forms[0];
    if (!f) return { targetFound: false, performed: false, note: 'no matching <form> on the page' };
    highlight(f);
    try {
      const form = f as HTMLFormElement & { requestSubmit?: () => void };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { targetFound: true, performed: true };
    } catch (e) {
      return { targetFound: true, performed: false, note: String(e).slice(0, 150) };
    }
  }

  const nodes = Array.prototype.slice.call(
    document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'),
  ) as Element[];
  // A "FAQs" nav link in the header and the in-content FAQ control share the same Click Text, but the
  // header link scrolls the proof screenshot to the top of the page (looks like the wrong place). When
  // several controls match, prefer an in-CONTENT one over page chrome (header/nav/footer).
  const inChrome = (n: Element): boolean => {
    let p: Element | null = n;
    while (p) {
      const tag = (p.tagName || '').toLowerCase();
      const role = ((p.getAttribute && p.getAttribute('role')) || '').toLowerCase();
      if (tag === 'header' || tag === 'nav' || tag === 'footer' || role === 'banner' || role === 'navigation' || role === 'contentinfo') return true;
      p = p.parentElement;
    }
    return false;
  };
  const ownTextLen = (n: Element): number => ((n.textContent || (n as HTMLInputElement).value || '') as string).trim().length;
  const candidates: Element[] = [];
  for (const n of nodes) {
    const txt = ((n.textContent || (n as HTMLInputElement).value || '') as string).trim();
    const href = (n.getAttribute && n.getAttribute('href')) || '';
    const okText = spec.clickText ? matches(txt, spec.clickText, spec.clickTextOp || 'equals') : true;
    const okUrl = spec.clickUrl ? matches(href, spec.clickUrl, spec.clickUrlOp || 'contains') : true;
    if (spec.clickText && okText && okUrl) candidates.push(n);
    else if (!spec.clickText && spec.clickUrl && okUrl) candidates.push(n);
  }
  // Prefer content over chrome; then the innermost control (drop any that merely wraps another match);
  // then the tightest label (a button reading exactly "FAQs" beats a card that just contains it).
  const content = candidates.filter((n) => !inChrome(n));
  const pool = content.length ? content : candidates;
  const leaves = pool.filter((a) => !pool.some((b) => b !== a && a.contains(b)));
  const ranked = (leaves.length ? leaves : pool).slice().sort((a, b) => ownTextLen(a) - ownTextLen(b));
  const el: Element | undefined = ranked[0];
  if (!el) return { targetFound: false, performed: false, note: 'no element matched the trigger' };
  // A "#section" link whose target isn't on the page means the feature it points to (e.g. an FAQ
  // accordion) isn't implemented HERE — clicking it proves nothing and the proof shot would show an
  // unrelated part of the page. Report not-found so it reads as honestly "untested", not fake-proven.
  if ((el.tagName || '').toLowerCase() === 'a') {
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    if (href.charAt(0) === '#' && href.length > 1) {
      const id = href.slice(1);
      let targetExists = false;
      try {
        targetExists = Boolean(document.getElementById(id) || document.querySelector('a[name="' + id.replace(/"/g, '\\"') + '"]'));
      } catch {
        targetExists = Boolean(document.getElementById(id));
      }
      if (!targetExists) {
        return { targetFound: false, performed: false, note: 'the trigger matched a "' + href + '" link, but that in-page section is not on this page (the feature it points to is not implemented here)' };
      }
    }
  }
  highlight(el);
  try {
    (el as HTMLElement).click();
    return { targetFound: true, performed: true };
  } catch (e) {
    return { targetFound: true, performed: false, note: String(e).slice(0, 150) };
  }
}

/** For a custom-event FORM tag (fired by a synthetic dataLayer push, not a real submit), ring the
 *  on-page <form> the tag tracks so the proof screenshot shows the RIGHT form — not the top of the
 *  page. Best-effort; returns whether a form was located. Matched by form id, then by name-token
 *  overlap with the form's title/heading, then the sole form on the page. */
function locateFormInPage(loc: { formId?: string; tokens?: string[] }): { found: boolean } {
  const ring = (node: Element): void => {
    try {
      document.querySelectorAll('[data-sx-hl]').forEach((p) => {
        const e = p as HTMLElement;
        e.style.removeProperty('outline'); e.style.removeProperty('outline-offset'); e.style.removeProperty('box-shadow');
        e.removeAttribute('data-sx-hl');
      });
      const h = node as HTMLElement;
      h.setAttribute('data-sx-hl', '1');
      h.style.setProperty('outline', '3px solid #ff2d55', 'important');
      h.style.setProperty('outline-offset', '2px', 'important');
      h.style.setProperty('box-shadow', '0 0 0 4px rgba(255,45,85,0.35)', 'important');
      h.scrollIntoView({ block: 'center', inline: 'center' });
    } catch { /* best-effort — never let ringing break the run */ }
  };
  const forms = Array.prototype.slice.call(document.querySelectorAll('form')) as HTMLFormElement[];
  if (!forms.length) return { found: false };
  let f: HTMLFormElement | undefined;
  if (loc.formId) {
    const want = loc.formId.toLowerCase();
    f = forms.find((x) => (x.id || '').toLowerCase() === want);
  }
  const tokens = (loc.tokens || []).filter(Boolean);
  if (!f && tokens.length) {
    const hayOf = (form: HTMLFormElement): string => {
      const parts: string[] = [];
      if (form.id) parts.push(form.id);
      const al = form.getAttribute && form.getAttribute('aria-label');
      if (al) parts.push(al);
      const named = form.querySelector('legend,h1,h2,h3,h4,[class*="title"],[class*="heading"]');
      if (named && named.textContent) parts.push(named.textContent);
      // A short heading immediately ABOVE the form often names it ("Get In Touch").
      const prev = form.previousElementSibling;
      if (prev && prev.textContent && prev.textContent.trim().length < 120) parts.push(prev.textContent);
      return parts.join(' ').toLowerCase();
    };
    let best: HTMLFormElement | undefined;
    let bestScore = 0;
    for (const form of forms) {
      const hay = hayOf(form);
      let score = 0;
      for (const t of tokens) if (hay.indexOf(t) >= 0) score++;
      if (score > bestScore) { bestScore = score; best = form; }
    }
    // Require a real overlap (2 tokens, or all of them when there are fewer) so we never ring a random form.
    if (best && bestScore >= Math.min(2, tokens.length)) f = best;
  }
  if (!f && forms.length === 1) f = forms[0];
  if (!f) return { found: false };
  ring(f);
  return { found: true };
}

/** Cap on how many per-tag screenshots we embed, so a huge container can't balloon the IPC payload
 *  (each JPEG is ~60-120KB; 80 ≈ a few MB). */
const MAX_SCREENSHOTS = 80;
/** A compact JPEG screenshot of the current page as a data URI — visual proof of the interaction the
 *  driver just performed (for click/form tags the driven element is ringed). Best-effort + bounded. */
async function captureShot(page: PwPage, state: { n: number }): Promise<string | undefined> {
  if (state.n >= MAX_SCREENSHOTS) return undefined;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 });
    state.n += 1;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return undefined; // never fail verification over a screenshot
  }
}

function specFor(trigger: DriverTrigger): DriveSpec {
  return {
    kind: trigger.kind,
    ...(trigger.clickTextValue ? { clickText: trigger.clickTextValue, clickTextOp: trigger.clickTextOperator } : {}),
    ...(trigger.clickUrlValue ? { clickUrl: trigger.clickUrlValue, clickUrlOp: trigger.clickUrlOperator } : {}),
    ...(trigger.formIdValue ? { formId: trigger.formIdValue, formIdOp: trigger.formIdOperator } : {}),
    ...(trigger.formClassesValue ? { formClasses: trigger.formClassesValue, formClassesOp: trigger.formClassesOperator } : {}),
  };
}

/** Build a form locator for a custom-event tag whose event/data is form-shaped, so the driver can ring
 *  the matching <form> for the proof screenshot. Returns null for non-form custom events (nothing to
 *  ring → no misleading top-of-page shot). Tokens come from form_name, else the event name. */
export function formLocatorFor(trigger: DriverTrigger): { formId?: string; tokens?: string[] } | null {
  const data = trigger.customEventData ?? {};
  const formId = data.form_id || data.formId || '';
  const rawName = data.form_name || data.formName || '';
  const ev = trigger.eventName ?? '';
  if (!/form/i.test(ev) && !formId && !rawName) return null; // not a form tag
  const stop = new Set(['ga4', 'event', 'tag', 'form', 'forms', 'submit', 'submission', 'the', 'of', 'to', 'your', 'a', 'an']);
  const tok = (s: string): string[] =>
    (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w));
  const tokens = rawName ? tok(rawName) : tok(ev);
  const loc: { formId?: string; tokens?: string[] } = {};
  if (formId) loc.formId = String(formId);
  if (tokens.length) loc.tokens = tokens;
  return loc.formId || loc.tokens ? loc : null;
}

/**
 * Inject the container, drive each tag's trigger, and capture the hits it fires.
 * SAFETY: collectors are captured then aborted (never delivered); navigations and
 * real submits are prevented in-page.
 */
export async function runVerifyDriver(
  url: string,
  tags: VerifyDriverTag[],
  opts: VerifyDriverOptions = {},
): Promise<VerifyDriverResult> {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 900;
  const loaderSrc = buildLoaderSrc(opts.containerSnippet);
  const previewAuth = isPreviewLoader(loaderSrc);
  const perTag: PerTagCapture[] = [];

  if (!(await requestAllowed(url))) {
    return { pagesOk: false, injected: false, previewAuth, perTag, error: `Refusing to load ${url}: blocked by the SSRF guard (private/loopback/invalid host).` };
  }
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  const captured: { url: string; body: string | null; collector: Collector }[] = [];
  let armed = false; // after the container has loaded, kill every beacon (capture+abort)

  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });

    await context.route('**/*', (route) => {
      const req = route.request();
      const reqUrl = req.url();
      const collector = classifyCollector(reqUrl);
      if (collector) {
        captured.push({ url: reqUrl, body: safePostData(req), collector });
        void route.abort();
        return;
      }
      if (armed && isBeaconType(req.resourceType())) {
        captured.push({ url: reqUrl, body: safePostData(req), collector: 'ad' });
        void route.abort();
        return;
      }
      void requestAllowed(reqUrl).then(
        (ok) => (ok ? route.continue() : route.abort()),
        () => route.abort(),
      );
    });

    const page = await context.newPage();
    let injected = false;
    const pagesDriven: string[] = [];
    const debugContainerIds = new Set<string>();
    const debugEvents = new Set<string>();
    // Real dataLayer pushes captured across pages + the event names WE pushed synthetically (so those
    // are labelled and not mistaken for the site's own emissions).
    const debugDataLayer: Array<{ event: string; params: Record<string, string> }> = [];
    const syntheticEvents = new Set<string>();
    const shotState = { n: 0 }; // screenshots embedded so far (bounded by MAX_SCREENSHOTS)

    // Drive each tag on ITS page: group by page, navigate to each, inject the
    // (preview) container so DRAFT tags load, then drive the group's triggers.
    for (const [pageUrl, groupTags] of groupByPage(url, tags)) {
      const loadStart = captured.length;
      try {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs });
      } catch (e) {
        const note = `could not load ${pageUrl}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
        for (const t of groupTags) perTag.push({ tagId: t.id, kind: 'navigate', targetFound: false, performed: false, note, hits: [] });
        continue;
      }
      pagesDriven.push(pageUrl);

      if (loaderSrc) {
        await page.evaluate((src: string) => {
          const w = window as unknown as { dataLayer?: unknown[] };
          w.dataLayer = w.dataLayer || [];
          w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
          const s = document.createElement('script');
          s.async = true;
          s.src = src;
          (document.head || document.documentElement).appendChild(s);
        }, loaderSrc);
        injected = true;
        await page.waitForTimeout(Math.max(settleMs, 1200)); // container + tags load
      }

      await page.evaluate(installGuardsInPage);
      await page.evaluate(grantConsentInPage); // grant Consent Mode so gated tags fire
      armed = true; // from here every cross-site beacon is a tag firing → capture+abort it
      const loadHits = captured.slice(loadStart);
      const settleQuiet = 400;
      const settleMax = Math.min(Math.max(settleMs, 900) * 3, 5000);
      // One screenshot of the freshly-loaded page — shared by every page-load / custom-event tag on it
      // (they don't visibly change the page). Click/form tags capture their OWN shot (ringed element).
      const pageShot = await captureShot(page, shotState);

      // Every dataLayer KEY any custom_event tag has pushed on THIS page. A GTM Data Layer Variable
      // reads the LAST value pushed for its key, so without resetting, tag A's form_name would leak
      // into tag B's evaluation and could FALSELY credit a later tag whose condition we didn't
      // actually supply. Before each push we blank the prior keys this tag isn't setting. (Reset per
      // page — page.goto starts a fresh document + dataLayer.)
      const pushedDlKeys = new Set<string>();

      for (const tag of groupTags) {
        const kind = tag.trigger.kind;

        // Fire-on-load trigger (pageview / base Google tag): attribute this page's load hits.
        if (kind === 'pageview') {
          perTag.push({
            tagId: tag.id,
            kind: 'navigate',
            targetFound: true,
            performed: true,
            hits: loadHits.map((h) => ({ url: h.url, body: h.body, collector: h.collector })),
            ...(pageShot ? { screenshot: pageShot } : {}),
          });
          continue;
        }

        // Custom-event (dataLayer) trigger: no DOM element — push the event synthetically.
        if (kind === 'custom_event') {
          const evName = tag.trigger.eventName ?? '';
          if (!evName) {
            perTag.push({ tagId: tag.id, kind: 'custom_event', targetFound: false, performed: false, note: 'the trigger has no dataLayer event name', hits: [] });
            continue;
          }
          const before = captured.length;
          // Include any form-specific dataLayer data the tag's trigger keys off (form_name/form_id/…),
          // resolved by container-verify, so a tag on a SHARED event (e.g. one form_submission split
          // per form) matches its condition instead of being missed by a bare event push.
          const data = tag.trigger.customEventData ?? {};
          const payload = buildCustomEventPayload(evName, data, pushedDlKeys);
          Object.keys(data).forEach((k) => pushedDlKeys.add(k));
          syntheticEvents.add(evName); // we pushed this — flag it in the dataLayer inspector
          try {
            await page.evaluate(pushDataLayerInPage, payload);
          } catch {
            /* ignore push failure — reported as no-hit below */
          }
          await waitForHitsSettle(() => captured.length, page, settleQuiet, settleMax);
          // Proof screenshot: for a FORM tag, ring the actual <form> this tag tracks (right place)
          // rather than the generic top-of-page shot. If we can't locate a form (or it's a non-form
          // custom event), attach NO screenshot — a top-of-page image reads as "checked the wrong
          // place". This path config-verifies via a synthetic push; the REAL submit + firing proof is
          // the separate, gated Forms section.
          let ceShot: string | undefined;
          const formLoc = formLocatorFor(tag.trigger);
          if (formLoc) {
            try {
              const loc = await page.evaluate<{ found: boolean }>(locateFormInPage, formLoc);
              if (loc.found) ceShot = await captureShot(page, shotState);
            } catch {
              /* best-effort — no shot on failure */
            }
          }
          perTag.push({
            tagId: tag.id,
            kind: 'custom_event',
            targetFound: true,
            performed: true,
            hits: captured.slice(before).map((h) => ({ url: h.url, body: h.body, collector: h.collector })),
            ...(ceShot ? { screenshot: ceShot } : {}),
          });
          continue;
        }

        // Click / form-submit trigger: locate + drive the element.
        const before = captured.length;
        let outcome: DriveOutcome;
        try {
          outcome = await page.evaluate<DriveOutcome>(driveInPage, specFor(tag.trigger));
        } catch (e) {
          outcome = { targetFound: false, performed: false, note: (e instanceof Error ? e.message : String(e)).slice(0, 150) };
        }
        if (outcome.performed) await waitForHitsSettle(() => captured.length, page, settleQuiet, settleMax);
        const hits = captured.slice(before).map((h) => ({ url: h.url, body: h.body, collector: h.collector }));
        // A screenshot with the driven control ringed — proof we clicked/submitted the RIGHT thing.
        // Only when we actually located the element (it's ringed + scrolled into view); a not-found
        // tag gets NO shot, because the top-of-page fallback reads as "checked the wrong place". The
        // status + note already tell the operator the control wasn't found.
        const shot = outcome.targetFound ? await captureShot(page, shotState) : undefined;
        perTag.push({
          tagId: tag.id,
          kind: kind === 'form_submit' ? 'submit' : 'click',
          targetFound: outcome.targetFound,
          performed: outcome.performed,
          ...(outcome.note ? { note: outcome.note } : {}),
          hits,
          ...(shot ? { screenshot: shot } : {}),
        });
      }

      // After driving this page, read GTM's on-page debug signal + the site's real dataLayer pushes
      // (always — the dataLayer inspector is core, not gated behind gtmDebug). Best-effort.
      try {
        const d = (await page.evaluate(readGtmDebugInPage)) as { containerIds: string[]; dataLayerEvents: string[]; dataLayer: Array<{ event: string; params: Record<string, string> }> };
        d.containerIds.forEach((c) => debugContainerIds.add(c));
        d.dataLayerEvents.forEach((e) => debugEvents.add(e));
        for (const p of d.dataLayer) debugDataLayer.push(p);
      } catch {
        /* best-effort — never fail verification over the debug read */
      }
    }

    const gtmDebug: GtmDebugCapture | undefined = opts.gtmDebug
      ? { containerLoaded: debugContainerIds.size > 0, containerIds: [...debugContainerIds], dataLayerEvents: [...debugEvents] }
      : undefined;
    const dataLayer = summarizeDataLayer(debugDataLayer.map((p) => ({ ...p, synthetic: syntheticEvents.has(p.event) })));
    const networkLog = buildNetworkLog(captured);
    return { pagesOk: true, injected, previewAuth, perTag, ...(pagesDriven.length ? { pagesDriven } : {}), ...(networkLog.length ? { networkLog } : {}), ...(dataLayer.length ? { dataLayer } : {}), ...(gtmDebug ? { gtmDebug } : {}) };
  } catch (e) {
    return { pagesOk: false, injected: Boolean(loaderSrc), previewAuth, perTag, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* best-effort */
      }
    }
  }
}
