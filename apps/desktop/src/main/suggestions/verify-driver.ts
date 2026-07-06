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
import { classifyCollector, type Collector } from '../../shared/runtime-capture';
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
}
export interface VerifyDriverResult {
  pagesOk: boolean;
  injected: boolean;
  /** The injected snippet carried workspace-preview auth (so DRAFT tags load). */
  previewAuth: boolean;
  error?: string;
  perTag: PerTagCapture[];
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
      armed = true; // from here every cross-site beacon is a tag firing → capture+abort it
      const loadHits = captured.slice(loadStart);

      for (const tag of groupTags) {
        const kind = tag.trigger.kind;
        // Fire-on-load triggers (pageview / base Google tag): attribute this page's load hits.
        if (kind === 'pageview' || kind === 'custom_event') {
          perTag.push({
            tagId: tag.id,
            kind: 'navigate',
            targetFound: kind === 'pageview',
            performed: kind === 'pageview',
            ...(kind === 'custom_event' ? { note: 'custom-event (dataLayer) trigger — not exercised by interaction' } : {}),
            hits: loadHits.map((h) => ({ url: h.url, body: h.body, collector: h.collector })),
          });
          continue;
        }
        const before = captured.length;
        let outcome: DriveOutcome;
        try {
          outcome = await page.evaluate<DriveOutcome>(driveInPage, specFor(tag.trigger));
        } catch (e) {
          outcome = { targetFound: false, performed: false, note: (e instanceof Error ? e.message : String(e)).slice(0, 150) };
        }
        if (outcome.performed) await page.waitForTimeout(settleMs);
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
    }

    return { pagesOk: true, injected, previewAuth, perTag };
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
