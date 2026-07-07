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
import { classifyCollector, syntheticDataLayerEvent, type Collector } from '../../shared/runtime-capture';
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

const MAX_VERIFY_PAGES = 25;

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
  /** Present only when opts.gtmDebug — the on-page GTM debug signal (Phase B groundwork). */
  gtmDebug?: GtmDebugCapture;
}

/** Read GTM's on-page debug signal (serialized to page.evaluate — DOM globals only). */
function readGtmDebugInPage(): { containerIds: string[]; dataLayerEvents: string[] } {
  const w = window as unknown as { google_tag_manager?: Record<string, unknown>; dataLayer?: Array<Record<string, unknown>> };
  const containerIds = w.google_tag_manager ? Object.keys(w.google_tag_manager).filter((k) => /^GTM-/i.test(k)) : [];
  const dataLayerEvents = Array.isArray(w.dataLayer)
    ? [...new Set(w.dataLayer.map((e) => (e && typeof e === 'object' ? String((e as { event?: unknown }).event ?? '') : '')).filter(Boolean))]
    : [];
  return { containerIds, dataLayerEvents };
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
  let el: Element | undefined;
  for (const n of nodes) {
    const txt = ((n.textContent || (n as HTMLInputElement).value || '') as string).trim();
    const href = (n.getAttribute && n.getAttribute('href')) || '';
    const okText = spec.clickText ? matches(txt, spec.clickText, spec.clickTextOp || 'equals') : true;
    const okUrl = spec.clickUrl ? matches(href, spec.clickUrl, spec.clickUrlOp || 'contains') : true;
    if (spec.clickText && okText && okUrl) { el = n; break; }
    if (!spec.clickText && spec.clickUrl && okUrl) { el = n; break; }
  }
  if (!el) return { targetFound: false, performed: false, note: 'no element matched the trigger' };
  try {
    (el as HTMLElement).click();
    return { targetFound: true, performed: true };
  } catch (e) {
    return { targetFound: true, performed: false, note: String(e).slice(0, 150) };
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
          try {
            await page.evaluate(pushDataLayerInPage, payload);
          } catch {
            /* ignore push failure — reported as no-hit below */
          }
          await waitForHitsSettle(() => captured.length, page, settleQuiet, settleMax);
          perTag.push({
            tagId: tag.id,
            kind: 'custom_event',
            targetFound: true,
            performed: true,
            hits: captured.slice(before).map((h) => ({ url: h.url, body: h.body, collector: h.collector })),
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
        perTag.push({
          tagId: tag.id,
          kind: kind === 'form_submit' ? 'submit' : 'click',
          targetFound: outcome.targetFound,
          performed: outcome.performed,
          ...(outcome.note ? { note: outcome.note } : {}),
          hits,
        });
      }

      // Phase B (best-effort): after driving this page, read GTM's on-page debug signal.
      if (opts.gtmDebug) {
        try {
          const d = (await page.evaluate(readGtmDebugInPage)) as { containerIds: string[]; dataLayerEvents: string[] };
          d.containerIds.forEach((c) => debugContainerIds.add(c));
          d.dataLayerEvents.forEach((e) => debugEvents.add(e));
        } catch {
          /* best-effort — never fail verification over the debug read */
        }
      }
    }

    const gtmDebug: GtmDebugCapture | undefined = opts.gtmDebug
      ? { containerLoaded: debugContainerIds.size > 0, containerIds: [...debugContainerIds], dataLayerEvents: [...debugEvents] }
      : undefined;
    return { pagesOk: true, injected, previewAuth, perTag, ...(pagesDriven.length ? { pagesDriven } : {}), ...(gtmDebug ? { gtmDebug } : {}) };
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
