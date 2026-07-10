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

import os from 'node:os';
import { requestAllowed } from './ssrf';
import { classifyCollector, syntheticDataLayerEvent, buildNetworkLog, summarizeDataLayer, type Collector, type DescribedHit, type DataLayerEventView } from '../../shared/runtime-capture';
import { isMonitorHit, parseMonitorHit, type MonitorEvent } from './tag-monitor';
import { PlaywrightUnavailableError } from './playwright-driver';
import type { PerTagCapture } from './verify-tags';

interface PwRoute {
  request(): { url(): string; postData(): string | null; resourceType(): string };
  /** `overrides.url` rewrites the request URL (same protocol) — used to append env-preview params to the
   *  container's gtm.js request so Google serves our previewed version. */
  continue(overrides?: { url?: string }): Promise<void>;
  abort(): Promise<void>;
}
interface PwResponse { status(): number }
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  evaluate<T = unknown>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; timeout?: number }): Promise<Buffer>;
  close(): Promise<void>;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
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
// that actually have a routed tag, so this self-limits — it's a ceiling, not a fixed cost). Pages are now
// processed by a bounded worker POOL (runPagePool), so a bigger ceiling no longer means a linearly longer
// run — the wall-clock scales with ceil(pages / concurrency).
const MAX_VERIFY_PAGES = 120;

// Page-level parallelism. Each worker is a full, ISOLATED browser context + page (own request-route
// handler, own capture buffer) — the only safe way to attribute captured beacons to the right page — so
// the cap keeps memory/CPU sane rather than opening a tab per page. Concurrency is min(cap, cores-1,
// pages): it never exceeds the work available, and leaves a core for the app/UI thread.
export const PAGE_CONCURRENCY_CAP = 5;
export function defaultPageConcurrency(pages: number): number {
  let cores = 4;
  try { cores = os.cpus()?.length || 4; } catch { /* os probe failed — assume 4 */ }
  return Math.max(1, Math.min(PAGE_CONCURRENCY_CAP, cores - 1, Math.max(1, pages)));
}
/** Resolve the effective page concurrency: an explicit request (clamped) else the machine default,
 *  never above the cap and never more workers than there are pages. */
export function clampConcurrency(requested: number | undefined, pages: number): number {
  const want = requested && requested > 0 ? requested : defaultPageConcurrency(pages);
  return Math.max(1, Math.min(want, PAGE_CONCURRENCY_CAP, Math.max(1, pages)));
}

/** Run `handle` over every page group with BOUNDED concurrency. A single shared cursor hands each group
 *  to exactly ONE worker: the claim (`cursor < len ? groups[cursor++] : undefined`) is a single
 *  synchronous expression, and JS runs it to completion with no interleaving, so no group is ever taken
 *  twice and the loop drains the queue so none is left behind. Up to `concurrency` workers run at once,
 *  each owning isolated resources from `makeWorker` (torn down by `closeWorker` when the queue empties).
 *  `handle` must not throw (record per-page failures itself); a fatal makeWorker error rejects the run. */
export async function runPagePool<G, W>(
  groups: G[],
  concurrency: number,
  makeWorker: (workerId: number) => Promise<W>,
  handle: (worker: W, group: G) => Promise<void>,
  closeWorker: (worker: W) => Promise<void>,
): Promise<void> {
  if (groups.length === 0) return; // nothing to do — spawn no workers (no idle context)
  let cursor = 0;
  const claim = (): G | undefined => (cursor < groups.length ? groups[cursor++] : undefined);
  const worker = async (id: number): Promise<void> => {
    const w = await makeWorker(id);
    try {
      for (let g = claim(); g !== undefined; g = claim()) await handle(w, g);
    } finally {
      try { await closeWorker(w); } catch { /* best-effort teardown */ }
    }
  };
  const n = Math.max(1, Math.min(concurrency, groups.length));
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
}

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
function groupByPage<T extends { page?: string }>(baseUrl: string, tags: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
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
  /** Page-level parallelism: how many pages to drive at once, each in its own isolated context.
   *  Defaults to the machine's cores-1 (capped) when omitted; clamped to [1, cap] and never more than
   *  the page count. Set 1 to force the old sequential behaviour. */
  concurrency?: number;
  /** Fired as each page's drive BEGINS (best-effort) so the caller can stream a live "verifying <url>"
   *  progress feed. `done` counts pages started so far (1-based), `total` is the page count. */
  onPageProgress?: (page: string, done: number, total: number) => void;
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
  /** AUTHORITATIVE per-tag firing captured from an injected GTM Monitor tag (addEventCallback) — which
   *  tags GTM fired on each event, with status. Present only when a monitor-preview snippet was used;
   *  feeds verdictsFromMonitor for the Tag-Assistant-grade result. */
  monitorEvents?: MonitorEvent[];
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

/** The GTM environment-preview params (gtm_auth / gtm_preview / gtm_cookies_win) a preview loader
 *  carries, or null for a plain published-container loader.
 *
 *  These MUST ride the NAVIGATION URL, not just an injected loader. A page that already embeds this
 *  container loads its LIVE gtm.js during page.goto and claims window.google_tag_manager[id]; a second
 *  loader we inject afterwards for the SAME id is deduped away, so our previewed version — the only
 *  place a just-created draft/monitor tag exists — never initialises (the "0 fired" bug). Put the params
 *  on the page URL instead and the site's OWN gtm.js reads them at its bootstrap and serves the previewed
 *  environment's version, exactly like a GTM environment share-preview link overriding a live site. */
export function previewParamsFromLoader(loaderSrc: string | null): Record<string, string> | null {
  if (!loaderSrc) return null;
  try {
    const q = new URL(loaderSrc).searchParams;
    const auth = q.get('gtm_auth');
    const preview = q.get('gtm_preview');
    if (!auth || !preview) return null;
    return { gtm_auth: auth, gtm_preview: preview, gtm_cookies_win: q.get('gtm_cookies_win') || 'x' };
  } catch {
    return null;
  }
}

/** Merge GTM preview params into a page URL (preserving any existing query) so page.goto lands in
 *  environment-preview mode. Applied to EVERY page.goto, not just the first: each page runs in its own
 *  isolated worker context, so the gtm_cookies_win preview cookie does not carry across pages. Falls back
 *  to the raw url if it can't be parsed. */
export function withPreviewParams(pageUrl: string, params: Record<string, string> | null): string {
  if (!params) return pageUrl;
  try {
    const u = new URL(pageUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  } catch {
    return pageUrl;
  }
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

export interface DriveSpec {
  kind: string;
  clickText?: string;
  clickTextOp?: string;
  clickUrl?: string;
  clickUrlOp?: string;
  formId?: string;
  formIdOp?: string;
  formClasses?: string;
  formClassesOp?: string;
  /** A CSS selector the trigger scopes on ({{Click Element}} cssSelector, e.g. an FAQ accordion). */
  cssSelector?: string;
  /** Ring + scroll the target into view but DON'T click/submit it. Used by the suggestion-screenshot
   *  pass, where the tag doesn't exist yet — we only want a proof image of WHERE it would fire. */
  locateOnly?: boolean;
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
      // A red halo PLUS a huge dark spread (spotlight): dims the rest of the page so the ringed control
      // is unmistakable — a thin outline alone is easy to misread next to a dominant filled button.
      h.style.setProperty('box-shadow', '0 0 0 5px rgba(255,45,85,0.55), 0 0 0 9999px rgba(0,0,0,0.38)', 'important');
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
        // `hl.length >= vl.length` guards the empty/short-haystack case: without it, hay='' + val='?'
        // gives lastIndexOf=-1 === (0-1)=-1 → TRUE, so every TEXT-LESS <a>/<button> (logo, icon, FAB)
        // "ends with ?" and the shortest-text ranking rings an icon instead of a real FAQ question row.
        return vl.length > 0 && hl.length >= vl.length && hl.lastIndexOf(vl) === hl.length - vl.length;
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

  // A CSS-selector-scoped trigger ({{Click Element}} cssSelector, e.g. an FAQ accordion header): ring
  // the first match. Falls through to text/URL matching below if the selector finds nothing.
  if (spec.cssSelector) {
    let hit: Element | null = null;
    try { hit = document.querySelector(spec.cssSelector); } catch { hit = null; }
    if (hit) {
      highlight(hit);
      if (spec.locateOnly) return { targetFound: true, performed: false };
      try { (hit as HTMLElement).click(); return { targetFound: true, performed: true }; }
      catch (e) { return { targetFound: true, performed: false, note: String(e).slice(0, 150) }; }
    }
  }

  if (spec.kind === 'form_submit') {
    const forms = Array.prototype.slice.call(document.querySelectorAll('form')) as HTMLFormElement[];
    let f: HTMLFormElement | undefined;
    if (spec.formId) f = forms.find((x) => matches(x.id, spec.formId, spec.formIdOp || 'equals'));
    if (!f && spec.formClasses) f = forms.find((x) => matches(x.className, spec.formClasses, spec.formClassesOp || 'contains'));
    if (!f && forms.length === 1) f = forms[0];
    if (!f) return { targetFound: false, performed: false, note: 'no matching <form> on the page' };
    highlight(f);
    if (spec.locateOnly) return { targetFound: true, performed: false };
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
  if (spec.locateOnly) return { targetFound: true, performed: false };
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
      // A red halo PLUS a huge dark spread (spotlight): dims the rest of the page so the ringed control
      // is unmistakable — a thin outline alone is easy to misread next to a dominant filled button.
      h.style.setProperty('box-shadow', '0 0 0 5px rgba(255,45,85,0.55), 0 0 0 9999px rgba(0,0,0,0.38)', 'important');
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
  const fieldCount = (form: HTMLFormElement): number =>
    form.querySelectorAll('input:not([type="hidden"]),textarea,select').length;
  const tokens = (loc.tokens || []).filter(Boolean);
  if (!f && tokens.length) {
    // A generic CTA word ("get"/"free") shouldn't pin a form on its own; a distinctive one ("cro",
    // "consultation", "analytics") can. Everything else needs 2+ hits.
    const COMMON = ['get', 'free', 'your', 'our', 'the', 'us', 'we', 'buy', 'now', 'new', 'all', 'click', 'submit', 'send', 'form', 'contact', 'tag', 'ga4', 'event'];
    const distinctive = (t: string): boolean => t.length >= 3 && COMMON.indexOf(t) < 0;
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
      // Field names/placeholders + the submit label often carry the distinctive token ("CRO audit",
      // a submit reading "Request Consultation") even when the heading is generic.
      Array.prototype.slice.call(form.querySelectorAll('input,textarea,select')).forEach((c: Element) => {
        const el = c as HTMLInputElement;
        if (el.name) parts.push(el.name);
        const ph = el.getAttribute && el.getAttribute('placeholder'); if (ph) parts.push(ph);
      });
      const submit = form.querySelector('button[type="submit"],input[type="submit"],button');
      if (submit && submit.textContent) parts.push(submit.textContent);
      return parts.join(' ').toLowerCase();
    };
    let best: HTMLFormElement | undefined;
    let bestScore = 0;
    let bestDistinct = false;
    for (const form of forms) {
      const hay = hayOf(form);
      let score = 0;
      let distinct = false;
      for (const t of tokens) if (hay.indexOf(t) >= 0) { score++; if (distinctive(t)) distinct = true; }
      if (score > bestScore) { bestScore = score; best = form; bestDistinct = distinct; }
    }
    // Accept 2+ token hits, OR a single DISTINCTIVE token — enough to pin the right form without ringing
    // a random one on a generic single ("get") hit.
    if (best && (bestScore >= Math.min(2, tokens.length) || (bestScore >= 1 && bestDistinct))) f = best;
  }
  // Last resort: ring the page's PRIMARY form — the one with the most (visible) fields, so a footer
  // newsletter (1 field) doesn't win over the real conversion form. Better an honest "here's the form on
  // this page" than a blank thumbnail for a form tag whose heading just didn't share a token.
  if (!f && forms.length) {
    f = forms.slice().sort((a, b) => fieldCount(b) - fieldCount(a))[0];
  }
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
  // Reserve the slot SYNCHRONOUSLY (before the awaited screenshot) so concurrent page workers sharing
  // this counter can't both pass the cap and overshoot MAX_SCREENSHOTS; release it back on failure.
  if (state.n >= MAX_SCREENSHOTS) return undefined;
  state.n += 1;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 });
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    state.n -= 1;
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
  // When the loader is a workspace/environment PREVIEW, its gtm_auth/gtm_preview params must ride the
  // navigation URL so the site's own gtm.js serves our previewed version (see previewParamsFromLoader).
  const previewParams = previewParamsFromLoader(loaderSrc);
  // The GTM-XXXX id our loader targets — used to skip the fallback injection when that container already
  // loaded on the page (via the site's own gtm.js + our URL params), so we never add a redundant loader.
  const loaderContainerId = loaderSrc?.match(/[?&]id=(GTM-[A-Z0-9]+)/i)?.[1] ?? null;
  const perTag: PerTagCapture[] = [];

  if (!(await requestAllowed(url))) {
    return { pagesOk: false, injected: false, previewAuth, perTag, error: `Refusing to load ${url}: blocked by the SSRF guard (private/loopback/invalid host).` };
  }
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  // Shared, ORDER-INDEPENDENT aggregation across all page workers (appends are safe on JS's single
  // thread; perTag is keyed by tagId downstream, so its order never matters).
  let injected = false;
  const pagesDriven: string[] = [];
  let pagesToDrive = 0; // set right before the pool; the `total` for onPageProgress
  let pagesStarted = 0; // incremented (synchronously) as each page's drive begins → the `done`
  const debugContainerIds = new Set<string>();
  const debugEvents = new Set<string>();
  // Real dataLayer pushes captured across pages + the event names WE pushed synthetically (so those
  // are labelled and not mistaken for the site's own emissions).
  const debugDataLayer: Array<{ event: string; params: Record<string, string> }> = [];
  const syntheticEvents = new Set<string>();
  const shotState = { n: 0 }; // screenshots embedded so far (bounded by MAX_SCREENSHOTS, shared cap)
  // Each worker's own capture buffer, collected on teardown → merged into the one network log.
  const capturedByWorker: { url: string; body: string | null; collector: Collector }[][] = [];

  // A page worker owns an ISOLATED browser context: its own request-route handler, its own capture
  // buffer, and its own `armed` flag. Isolation is REQUIRED for correctness — a shared context-level
  // route handler couldn't attribute a captured beacon to the page that fired it (attribution is
  // captured.slice(before), which assumes one page at a time), and one page's "armed" would abort
  // another page's pre-container requests.
  interface VerifyWorker {
    context: PwContext;
    page: PwPage;
    captured: { url: string; body: string | null; collector: Collector }[];
    armed: { on: boolean };
    /** GTM Monitor pixel URLs captured on this worker (authoritative per-tag firing) — parsed at the end. */
    monitorHits: string[];
  }
  // Monitor pixels, collected per worker → merged + parsed into MonitorEvent[] for authoritative verdicts.
  const monitorHitsByWorker: string[][] = [];

  let browser: PwBrowser | null = null;
  try {
    const launched = await pw.chromium.launch({ headless: true });
    browser = launched;

    const makeWorker = async (): Promise<VerifyWorker> => {
      const context = await launched.newContext({ viewport: { width: 1366, height: 900 } });
      const captured: VerifyWorker['captured'] = [];
      const monitorHits: string[] = [];
      const armed = { on: false }; // after THIS worker's container loads, kill every beacon (capture+abort)
      await context.route('**/*', (route) => {
        const req = route.request();
        const reqUrl = req.url();
        // PREVIEW OVERRIDE (the reliable path): a normally-installed GTM snippet requests
        // `googletagmanager.com/gtm.js?id=GTM-XXXX` with NO preview params, and its loader does NOT read
        // gtm_auth/gtm_preview from the page URL — so a site that already publishes this container serves
        // its LIVE version and our monitor/draft tags never load. Rewrite that request to carry the env
        // preview params (exactly what the environment install snippet's src has), so Google serves OUR
        // previewed version instead. Same origin + protocol, only added query params. Only the container's
        // own loader is rewritten (not gtag/js), only when it lacks gtm_auth, so it runs at most once.
        if (
          previewParams && loaderContainerId &&
          /googletagmanager\.com\/gtm\.js\?/i.test(reqUrl) &&
          reqUrl.includes(`id=${loaderContainerId}`) &&
          !/[?&]gtm_auth=/i.test(reqUrl)
        ) {
          const qp = `&gtm_auth=${previewParams.gtm_auth}&gtm_preview=${previewParams.gtm_preview}&gtm_cookies_win=${previewParams.gtm_cookies_win}`;
          void route.continue({ url: reqUrl + qp });
          return;
        }
        // The injected GTM Monitor tag GET-pixels per-tag firing to our sentinel endpoint — capture +
        // abort it (it is route-aborted anyway) BEFORE the collector/armed checks so it isn't misread.
        if (isMonitorHit(reqUrl)) {
          monitorHits.push(reqUrl);
          void route.abort();
          return;
        }
        const collector = classifyCollector(reqUrl);
        if (collector) {
          captured.push({ url: reqUrl, body: safePostData(req), collector });
          void route.abort();
          return;
        }
        if (armed.on && isBeaconType(req.resourceType())) {
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
      return { context, page, captured, armed, monitorHits };
    };
    const closeWorker = async (w: VerifyWorker): Promise<void> => {
      capturedByWorker.push(w.captured);
      monitorHitsByWorker.push(w.monitorHits);
      await w.context.close();
    };

    // Drive every tag on ITS page: navigate, inject the (preview) container so DRAFT tags load, then
    // drive the group's triggers. One call per page; runPagePool fans these across the worker pool.
    const driveOnePage = async (w: VerifyWorker, [pageUrl, groupTags]: [string, VerifyDriverTag[]]): Promise<void> => {
      const { page, captured } = w;
      if (opts.onPageProgress) {
        pagesStarted += 1; // single-threaded increment — safe across parallel workers
        try { opts.onPageProgress(pageUrl, pagesStarted, pagesToDrive); } catch { /* progress is a nicety */ }
      }
      // Disarm BEFORE this page's own load. The page must load with its beacons flowing so client-rendered
      // CTAs/images actually render (classified analytics collectors are still captured+aborted regardless
      // of armed); we RE-arm only after injecting the container below, so a beacon fired during the page's
      // own load isn't mistaken for a tag firing. A worker drives several pages in turn, so without this
      // reset every page after its first would load already-armed (arming leaks across pages) — its load
      // subresources would be aborted, breaking element location and polluting loadHits, with results that
      // depend on which pages a worker happened to claim.
      w.armed.on = false;
      const loadStart = captured.length;
      try {
        // In preview mode, navigate WITH the env params so the site's own gtm.js serves our previewed
        // version at its bootstrap (the injected loader below is deduped when the site already embeds this
        // container). pagesDriven/notes keep the clean pageUrl; only the goto carries the params.
        await page.goto(withPreviewParams(pageUrl, previewParams), { waitUntil: 'networkidle', timeout: navTimeoutMs });
      } catch (e) {
        const note = `could not load ${pageUrl}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
        for (const t of groupTags) perTag.push({ tagId: t.id, kind: 'navigate', targetFound: false, performed: false, note, hits: [] });
        return; // this page failed to load — the pool moves on to the next queued page
      }
      pagesDriven.push(pageUrl);

      // FALLBACK loader injection — ONLY when the container isn't already on the page. If we navigated
      // with env preview params and the site embeds this container, its own gtm.js already served our
      // previewed version, so injecting a second loader for the same id would be a redundant deduped
      // no-op (and an extra gtm.start push). Inject only when the container is absent (a target that does
      // NOT embed it, e.g. a staging page) so DRAFT/monitor tags still load.
      if (loaderSrc) {
        const alreadyLoaded = loaderContainerId
          ? await page
              .evaluate(
                (id: string) => Boolean((window as unknown as { google_tag_manager?: Record<string, unknown> }).google_tag_manager?.[id]),
                loaderContainerId,
              )
              .catch(() => false)
          : false;
        if (!alreadyLoaded) {
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
      }

      await page.evaluate(installGuardsInPage);
      await page.evaluate(grantConsentInPage); // grant Consent Mode so gated tags fire
      // Drop the cookie-consent banner so a ringed FOOTER control (a footer CTA / mailto tag) isn't
      // obscured in the per-tag proof shot — same benefit as the suggestion pass. display:none persists
      // for every tag driven on this page, so once per page load is enough. Best-effort.
      try { await page.evaluate(hideCookieOverlaysInPage); } catch { /* best-effort */ }
      w.armed.on = true; // from here every cross-site beacon is a tag firing → capture+abort it
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
    };

    // Fan the per-page drive across a bounded worker pool (each page handled exactly once, none skipped).
    const pageGroups = [...groupByPage(url, tags)];
    pagesToDrive = pageGroups.length; // the `total` reported to onPageProgress
    const concurrency = clampConcurrency(opts.concurrency, pageGroups.length);
    await runPagePool(pageGroups, concurrency, makeWorker, driveOnePage, closeWorker);

    const gtmDebug: GtmDebugCapture | undefined = opts.gtmDebug
      ? { containerLoaded: debugContainerIds.size > 0, containerIds: [...debugContainerIds], dataLayerEvents: [...debugEvents] }
      : undefined;
    const dataLayer = summarizeDataLayer(debugDataLayer.map((p) => ({ ...p, synthetic: syntheticEvents.has(p.event) })));
    const networkLog = buildNetworkLog(capturedByWorker.flat());
    // Authoritative per-tag firing from the injected GTM Monitor (if any pixels were captured).
    const monitorEvents = monitorHitsByWorker.flat().map(parseMonitorHit).filter((e): e is MonitorEvent => e !== null);
    return { pagesOk: true, injected, previewAuth, perTag, ...(pagesDriven.length ? { pagesDriven } : {}), ...(networkLog.length ? { networkLog } : {}), ...(dataLayer.length ? { dataLayer } : {}), ...(gtmDebug ? { gtmDebug } : {}), ...(monitorEvents.length ? { monitorEvents } : {}) };
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

// ── Suggestion screenshots ───────────────────────────────────────────────────
// The "Tag suggestions" panel proposes tags the user could CREATE. This reuses the SAME screenshot
// logic as tag verification (ring the target + captureShot), but LOCATE-ONLY: the tag doesn't exist
// yet, so we never click/submit — we just show visual proof of WHERE each suggested tag would fire.

/** The subset of a suggested tag's trigger the locate-only screenshot pass needs. */
export interface SuggestionShotTrigger {
  kind: string;
  clickTextValue?: string;
  clickTextOperator?: string;
  clickUrlValue?: string;
  clickUrlOperator?: string;
  clickElementValue?: string;
  clickElementOperator?: string;
  /** For an all_clicks tag that fires on several exact click texts via a companion Lookup Table (e.g. a
   *  social-share widget: Twitter/LinkedIn/Facebook/Copy Link). The locate-only pass rings the FIRST
   *  listed text as visual proof of where the tag fires. */
  lookupTable?: { name: string; texts: string[] };
  formIdValue?: string;
  formIdOperator?: string;
  formClassesValue?: string;
  formClassesOperator?: string;
  eventName?: string;
  customEventData?: Record<string, string>;
}
export interface SuggestionShotTag {
  id: string;
  /** "/contact" | "site-wide" | undefined — the page whose element this tag would track. */
  page?: string;
  /** The tag's GA4 event name (e.g. get_your_free_cro_consultation_form) — for a native form_submit tag
   *  whose trigger carries no form id/class, this is the best source of tokens to locate the right form. */
  eventName?: string;
  trigger: SuggestionShotTrigger;
}
export interface SuggestionShot {
  tagId: string;
  page: string;
  /** JPEG data-URI of the ringed element/location (absent when it couldn't be located). */
  screenshot?: string;
}

/** DriveSpec for a locate-ONLY pass (ring + screenshot, never click) from a suggested tag's trigger. */
export function specForShot(t: SuggestionShotTrigger): DriveSpec {
  const cssSelector =
    t.clickElementOperator === 'cssSelector' ? t.clickElementValue
      : t.clickUrlOperator === 'cssSelector' ? t.clickUrlValue
        : undefined;
  // Suggestions store form scopes selector-style ("#contact-form", ".hs-form"); the driver matches raw
  // id / className, so strip the leading #/. (a dotted multi-class becomes space-separated).
  const formId = t.formIdValue ? t.formIdValue.replace(/^#/, '') : undefined;
  const formClasses = t.formClassesValue ? t.formClassesValue.replace(/^\./, '').replace(/\./g, ' ') : undefined;
  // An all_clicks tag scoped by a {{Click Text}} Lookup Table (e.g. a share widget) carries no single
  // clickTextValue — ring the FIRST listed text so the tag still gets a proof shot.
  const lookupText = !t.clickTextValue && t.lookupTable?.texts?.length ? t.lookupTable.texts[0] : undefined;
  return {
    kind: t.kind,
    locateOnly: true,
    ...(cssSelector ? { cssSelector } : {}),
    ...(t.clickTextValue ? { clickText: t.clickTextValue, clickTextOp: t.clickTextOperator }
      : lookupText ? { clickText: lookupText, clickTextOp: 'equals' } : {}),
    ...(t.clickUrlValue && t.clickUrlOperator !== 'cssSelector' ? { clickUrl: t.clickUrlValue, clickUrlOp: t.clickUrlOperator } : {}),
    ...(formId ? { formId, formIdOp: t.formIdOperator } : {}),
    ...(formClasses ? { formClasses, formClassesOp: t.formClassesOperator } : {}),
  };
}

/** A form locator for a NATIVE form_submit suggestion, so its proof shot rings the on-page <form>.
 *  Prefers the trigger's {{Form ID}}/{{Form Classes}} scope, else seeds tokens from the tag's GA4 event
 *  (get_your_free_cro_consultation_form → cro/consultation) so the RIGHT form is picked on multi-form
 *  pages. ALWAYS returns an object → locateFormInPage's primary-form fallback rings SOME form even when
 *  nothing token-matches, so a page-scoped form_submit tag always gets a screenshot. */
export function formLocatorForSubmit(t: SuggestionShotTag): { formId?: string; tokens?: string[] } {
  const trig = t.trigger;
  const loc: { formId?: string; tokens?: string[] } = {};
  if (trig.formIdValue) loc.formId = trig.formIdValue.replace(/^#/, '');
  // Strip boilerplate + common CTA words so tokens are DISTINCTIVE (cro, consultation), not noise (get,
  // free) that would add score to unrelated forms.
  const stop = new Set(['ga4', 'event', 'tag', 'form', 'forms', 'submit', 'submission', 'the', 'of', 'to', 'your', 'our', 'a', 'an', 'get', 'free', 'new', 'now', 'us', 'we']);
  const src = t.eventName || trig.formClassesValue || '';
  const tokens = src.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w));
  if (tokens.length) loc.tokens = tokens;
  return loc;
}

/** Re-scroll the currently-ringed element ([data-sx-hl]) back to center. Called right before the shot:
 *  the initial locate scrolls the target into view, but that scroll can trigger LAZY content that grows
 *  the page BELOW the target (a footer newsletter/email area), pushing it off-screen by capture time. */
function rescrollRingedInPage(): void {
  try {
    const el = document.querySelector('[data-sx-hl]');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
  } catch {
    /* best-effort */
  }
}

/** Hide fixed/sticky cookie-consent + similar overlays so a ringed FOOTER element (email/phone/footer
 *  CTA — the usual site-wide mailto) isn't obscured behind the banner in the proof screenshot. Only
 *  hides fixed/sticky consent-style containers; best-effort and read-only-ish (a discarded page). */
function hideCookieOverlaysInPage(): void {
  try {
    const sel = [
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[id*="gdpr" i]', '[class*="gdpr" i]', '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
      // CookieYes classes all begin with "cky-": anchor to a class-token boundary (start of the attr, or
      // after a space) so a "sticky-*" UTILITY class — Bootstrap .sticky-top, .sticky-cta, .sticky-footer,
      // whose substring "cky-" would otherwise match — is NOT hidden (that would blank a legit footer/CTA).
      '[class^="cky-" i]', '[class*=" cky-" i]',
      '#onetrust-banner-sdk', '#onetrust-consent-sdk', '[id*="usercentrics" i]', '[id*="cookiebot" i]',
      // Other mainstream CMPs — named hosts only (a generic [id*="cmp"] would hit component/campaign).
      '[id*="iubenda" i]', '[class*="osano" i]', '[id*="termly" i]', '[id*="qc-cmp" i]', '[class*="qc-cmp" i]',
    ].join(',');
    Array.prototype.slice.call(document.querySelectorAll(sel)).forEach((e: Element) => {
      const el = e as HTMLElement;
      // Only hide a fixed/sticky OVERLAY — never a normal (static) footer that holds the target link.
      const cs = window.getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') el.style.setProperty('display', 'none', 'important');
    });
  } catch {
    /* best-effort — never fail a screenshot over this */
  }
}

/**
 * Poll a pure in-page LOCATE function until it reports the element is present, then return true
 * IMMEDIATELY (capture the instant it renders). Read-only: `evalFn` only queries + rings the DOM
 * (driveInPage locateOnly / locateFormInPage), and re-ringing is safe because highlight()/ring() clear
 * the prior ring first. Bounded: at most `tries` probes every `intervalMs` (~5s) so a never-rendering
 * element (SPA route, lazy/IntersectionObserver section, deferred embed) can't hang the run.
 */
export async function waitForLocate(
  page: PwPage,
  evalFn: unknown,
  spec: unknown,
  found: (r: unknown) => boolean,
  opts: { tries?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const tries = opts.tries ?? 16; // 16 × 300ms ≈ 4.8s worst case
  const intervalMs = opts.intervalMs ?? 300;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await page.evaluate(evalFn, spec);
      if (found(r)) return true; // found → capture now
    } catch {
      /* transient (navigation/detached during hydration) — retry */
    }
    if (i < tries - 1) await page.waitForTimeout(intervalMs);
  }
  return false;
}

/**
 * Open each page a suggested tag lives on and capture a proof screenshot of the element/location it
 * would track (ringed), reusing the verify driver's locate + captureShot. LOCATE-ONLY — never clicks
 * or submits, injects no container, sends no beacon. Best-effort + bounded (MAX_VERIFY_PAGES pages,
 * MAX_SCREENSHOTS shots). Returns one entry per tag (screenshot absent when the element wasn't found).
 */
export async function runSuggestionScreenshots(
  url: string,
  tags: SuggestionShotTag[],
  opts: {
    navTimeoutMs?: number;
    settleMs?: number;
    /** Called before EACH tag's capture with how many are done, the total, and which tag/page is
     *  being shot right now — drives the live progress card in the suggestions panel. */
    onProgress?: (done: number, total: number, tagId: string, page: string) => void;
    /** Page-level parallelism (pages shot at once, each in its own tab). Defaults to cores-1 (capped). */
    concurrency?: number;
  } = {},
): Promise<{ pagesOk: boolean; error?: string; shots: SuggestionShot[] }> {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 700;
  const shots: SuggestionShot[] = [];
  if (tags.length === 0) return { pagesOk: true, shots };
  if (!(await requestAllowed(url))) {
    return { pagesOk: false, error: `Refusing to load ${url}: blocked by the SSRF guard (private/loopback/invalid host).`, shots };
  }
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    // No request-capture here (locate-only), so pages can share ONE context; each worker just owns its
    // own tab. The screenshot cap (shotState) is shared so the total stays bounded across workers.
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const shotState = { n: 0 };

    const shotOnePage = async (page: PwPage, [pageUrl, groupTags]: [string, SuggestionShotTag[]]): Promise<void> => {
      try {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs });
      } catch {
        for (const t of groupTags) shots.push({ tagId: t.id, page: pageUrl });
        return; // this page failed to load — the pool moves on to the next queued page
      }
      // A short head-start settle; the per-tag poll below covers anything that renders later.
      await page.waitForTimeout(Math.min(Math.max(settleMs, 400), 1200));
      // Drop the cookie-consent banner (and similar fixed overlays) so a ringed FOOTER element — an
      // email/phone/footer CTA, the usual site-wide mailto — isn't hidden behind it in the proof shot.
      try { await page.evaluate(hideCookieOverlaysInPage); } catch { /* best-effort */ }
      for (const t of groupTags) {
        opts.onProgress?.(shots.length, tags.length, t.id, pageUrl);
        let found = false;
        try {
          if (t.trigger.kind === 'pageview') {
            found = true; // a page-load tag's "location" is the whole page
          } else if (t.trigger.kind === 'custom_event' || t.trigger.kind === 'form_submit') {
            // Ring the <form> the tag tracks. A native form_submit tag scoped only by page path (empty
            // form id + a Tailwind class GTM can't use) has NO form scope in its DriveSpec, and
            // driveInPage's sole-form fallback fails on a 2-form page → no shot. Route it through
            // locateFormInPage instead (token-scored + primary-form fallback), so it always rings a form.
            const loc = t.trigger.kind === 'custom_event' ? formLocatorFor(t.trigger as DriverTrigger) : formLocatorForSubmit(t);
            // Poll: a HubSpot/Marketo-style form embed can mount a second or two after load.
            if (loc) found = await waitForLocate(page, locateFormInPage, loc, (r) => Boolean((r as { found?: boolean }).found));
          } else {
            // Poll: an SPA route or lazy/IntersectionObserver section can mount the CTA after load;
            // capture the instant it appears, else give up after ~5s (never hangs).
            found = await waitForLocate(page, driveInPage, specForShot(t.trigger), (r) => Boolean((r as DriveOutcome).targetFound));
          }
        } catch {
          found = false;
        }
        if (found) {
          try {
            // Re-hide right before the shot: a CMP that injects its banner LATE (OneTrust/Cookiebot/
            // Usercentrics load async) would otherwise still cover the ringed footer.
            await page.evaluate(hideCookieOverlaysInPage);
            // Scrolling to the target can trigger lazy content that grows the page BELOW it, leaving it
            // off-screen by capture time (repro'd on the homepage footer email). Let layout settle, then
            // re-scroll the ringed element into view right before the shot.
            await page.waitForTimeout(350);
            await page.evaluate(rescrollRingedInPage);
            await page.waitForTimeout(120);
          } catch { /* best-effort */ }
        }
        const screenshot = found ? await captureShot(page, shotState) : undefined;
        shots.push({ tagId: t.id, page: pageUrl, ...(screenshot ? { screenshot } : {}) });
      }
    };

    // Shoot pages in parallel across a bounded pool of tabs (each page handled exactly once, none skipped).
    const pageGroups = [...groupByPage(url, tags)];
    const concurrency = clampConcurrency(opts.concurrency, pageGroups.length);
    await runPagePool(
      pageGroups,
      concurrency,
      () => context.newPage(),
      shotOnePage,
      (page) => page.close(),
    );
    return { pagesOk: true, shots };
  } catch (e) {
    return { pagesOk: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), shots };
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
