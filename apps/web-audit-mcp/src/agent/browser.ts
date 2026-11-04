/**
 * Browser layer: lazy Playwright loading, instrumented contexts, and network
 * classification. Playwright is an optional dependency — the server starts and
 * lists tools without it; the first browser-backed call explains how to
 * install it. Patterns mirror apps/runtime-worker/capture.mjs so captures here
 * reconcile with the portal's consent engine.
 */

import { createRequestGuard } from '../utils/safeFetch.js';

// ── Minimal structural typings for the Playwright surface we use ───────────
// (Avoids a hard dependency on playwright's types when it is not installed.)

export interface PwResponse {
  status(): number;
  /** Response headers, lower-cased keys (Playwright shape). Read to classify a WAF / bot-challenge page.
   *  Playwright leaves security-related headers out of this, Set-Cookie included. */
  headers(): Record<string, string>;
  /** All response headers, Set-Cookie included (multiple values joined with "\n"). */
  allHeaders(): Promise<Record<string, string>>;
  /** The request this answered: the LAST hop of a redirect chain. */
  request?(): PwRequest;
}
export interface PwRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  /** The request that redirected to this one; null when it was not reached by a redirect. */
  redirectedFrom?(): PwRequest | null;
}
export interface PwElement {
  click(opts?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
}
export interface PwFrame {
  $(selector: string): Promise<PwElement | null>;
  url(): string;
}
export interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate<T = unknown>(fn: any, arg?: unknown): Promise<T>;
  addInitScript(script: { content: string }): Promise<void>;
  on(event: string, cb: (arg: never) => void): void;
  frames(): PwFrame[];
  $(selector: string): Promise<PwElement | null>;
  title(): Promise<string>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  /** Returns the encoded image. Only the options this codebase passes are declared. */
  screenshot(opts?: { fullPage?: boolean; type?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
  close(): Promise<void>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(): Promise<{ name: string }[]>;
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  close(): Promise<void>;
}
export interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
export interface Playwright {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> };
}

export class PlaywrightMissingError extends Error {
  constructor() {
    super(
      [
        'Playwright is not installed — browser-backed audit tools cannot run.',
        '',
        'Install it and a browser, then retry:',
        '    npm i playwright   # in apps/web-audit-mcp (or the repo root)',
        '    npx playwright install chromium',
        '',
        'Note: this server needs a real browser host (local machine, Render, Fly,',
        'Railway, VPS) — it cannot run on Vercel serverless.',
      ].join('\n'),
    );
    this.name = 'PlaywrightMissingError';
  }
}

export async function loadPlaywright(): Promise<Playwright | null> {
  try {
    // Non-literal specifier: playwright is an optional dependency, so the
    // import must not be statically resolved at compile time.
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

// ── Tracker classification (kept in sync with runtime-worker) ──────────────

export const TRACKER_PATTERNS: { id: string; group: string; label: string; re: RegExp }[] = [
  { id: 'ga4_collect', group: 'ga4', label: 'GA4 /g/collect', re: /\/g\/collect(?:\?|$)/i },
  { id: 'ua_collect', group: 'ga4', label: 'Universal Analytics /collect', re: /google-analytics\.com\/(?:r\/)?collect/i },
  { id: 'gtm_loader', group: 'gtm', label: 'GTM container load', re: /googletagmanager\.com\/gtm\.js|\/gtag\/js/i },
  { id: 'meta_pixel', group: 'meta', label: 'Meta Pixel /tr', re: /facebook\.com\/tr\b|connect\.facebook\.net\/.*\/fbevents\.js/i },
  { id: 'google_ads', group: 'google_ads', label: 'Google Ads conversion', re: /googleadservices\.com\/pagead\/conversion|googleads\.g\.doubleclick\.net\/pagead/i },
  { id: 'floodlight', group: 'floodlight', label: 'Floodlight', re: /fls\.doubleclick\.net|ad\.doubleclick\.net\/activity/i },
  { id: 'tiktok', group: 'tiktok', label: 'TikTok Pixel', re: /analytics\.tiktok\.com\/api|analytics\.tiktok\.com\/i18n\/pixel/i },
  { id: 'linkedin', group: 'linkedin', label: 'LinkedIn Insight', re: /px\.ads\.linkedin\.com|snap\.licdn\.com/i },
];

/** Vendor groups that mean "a measurement/marketing tag actually fired" (loader excluded). */
export const MEASUREMENT_GROUPS = new Set([
  'ga4', 'meta', 'google_ads', 'floodlight', 'tiktok', 'linkedin',
]);

export function classifyUrl(url: string): { ids: string[]; groups: string[] } {
  const ids: string[] = [];
  const groups = new Set<string>();
  for (const p of TRACKER_PATTERNS) {
    if (p.re.test(url)) {
      ids.push(p.id);
      groups.add(p.group);
    }
  }
  return { ids, groups: [...groups] };
}

/** Parse a URL's query string into a flat decoded map (GA4 gcs/gcd/en/...). */
export function parseQuery(url: string): Record<string, string> {
  const q = url.indexOf('?');
  if (q < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    if (!k) continue;
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// ── Instrumented page ───────────────────────────────────────────────────────

export interface CapturedHit {
  url: string;
  method: string;
  ids: string[];
  groups: string[];
  query?: Record<string, string>;
  /** ms since navigation start. */
  tMs: number;
  resourceType: string;
}

export interface PageInstruments {
  page: PwPage;
  trackerHits: CapturedHit[];
  consoleErrors: string[];
  pageErrors: string[];
  requestCount: () => number;
  /** Call immediately before goto so hit timestamps are nav-relative (it also starts a new landing check). */
  markNavigationStart: () => void;
  /**
   * Call after goto, and again after reading the page: the refusal note when this navigation reached
   * an address the SSRF guard refuses through a redirect hop (see watchLanding), else null. On a
   * refusal the hits and errors recorded since markNavigationStart are dropped and the page is left
   * on about:blank; the caller must discard anything it read from the page.
   */
  blockedLanding: (resp?: PwResponse | null) => Promise<string | null>;
}

const MAX_HITS = 1000;
const MAX_ERRORS = 100;

/**
 * Init script injected before any page script runs. It hooks dataLayer.push so
 * consent default/update events get millisecond timing relative to page start,
 * which lets the audit prove "tag fired before consent". gtag pushes arrive as
 * `arguments` objects, so array-likes are normalised to real arrays before
 * snapshotting.
 */
export const DATALAYER_HOOK = `(() => {
  const w = window;
  if (w.__wa_hook_installed) return;
  w.__wa_hook_installed = true;
  const t0 = Date.now();
  w.__wa_t0 = t0;
  w.__wa_dl_log = [];
  const norm = (e) => {
    try {
      const v = (e && typeof e === 'object' && !Array.isArray(e) && typeof e.length === 'number')
        ? Array.prototype.slice.call(e)
        : e;
      return JSON.parse(JSON.stringify(v));
    } catch { return null; }
  };
  const record = (it) => {
    if (w.__wa_dl_log.length < 2000) {
      w.__wa_dl_log.push({ t: Date.now() - t0, entry: norm(it) });
    }
  };
  const hook = (arr) => {
    if (!arr || arr.__wa_hooked) return arr;
    try {
      for (const it of arr) record(it);
      const origPush = arr.push.bind(arr);
      arr.push = function () {
        for (let i = 0; i < arguments.length; i++) record(arguments[i]);
        return origPush.apply(null, arguments);
      };
      Object.defineProperty(arr, '__wa_hooked', { value: true });
    } catch {}
    return arr;
  };
  let current = hook(w.dataLayer);
  try {
    Object.defineProperty(w, 'dataLayer', {
      configurable: true,
      get() { return current; },
      set(v) { current = hook(v); },
    });
  } catch {}
})();`;

// ── Redirect landing check ──────────────────────────────────────────────────

/**
 * Playwright calls a route handler only for the FIRST URL of a redirect chain; it continues every
 * redirect hop itself. So a context.route guard cannot stop a public URL that 302s to a private,
 * loopback or metadata address: the browser loads it. Stopping that request (a blind GET) needs
 * egress control outside the browser, such as an SSRF-filtering proxy or Chromium's
 * --host-resolver-rules. What this guarantees is that nothing is READ from such a page.
 */
export interface LandingWatch {
  /** A new top-level navigation starts: hops seen before it no longer count. */
  reset(): void;
  /**
   * The refusal note when this navigation reached an address the request guard refuses, through any
   * redirect hop the page saw (main frame, iframe or subresource), the response's own redirect chain,
   * or where the page and its frames now are; null when it did not. A refusal moves the page to
   * about:blank and holds until reset().
   */
  blockedLanding(resp?: PwResponse | null): Promise<string | null>;
}

const MAX_REDIRECT_CHAIN = 25;

function landingRefusal(url: string): string {
  let where: string;
  try {
    where = new URL(url).host;
  } catch {
    where = url.slice(0, 80);
  }
  return `blocked: redirected to ${where}, which the SSRF guard refuses (private, loopback or metadata address); nothing was read from the page`;
}

/** Re-check every redirect hop of `page` with `requestGuard`; register before the first goto. */
export function watchLanding(page: PwPage, requestGuard: (rawUrl: string) => Promise<boolean>): LandingWatch {
  let generation = 0;
  let blocked: string | null = null;
  let left = false;
  const pending = new Set<Promise<void>>();
  const allowed = (url: string): Promise<boolean> => requestGuard(url).catch(() => false);
  const refuse = (url: string, gen: number): void => {
    if (gen === generation && blocked === null) blocked = url;
  };

  page.on('request', (req: PwRequest) => {
    if (!req.redirectedFrom?.()) return;
    const url = req.url();
    const gen = generation;
    const check = allowed(url).then((ok) => {
      if (!ok) refuse(url, gen);
    });
    pending.add(check);
    void check.finally(() => pending.delete(check));
  });

  return {
    reset() {
      generation += 1;
      blocked = null;
      left = false;
    },
    async blockedLanding(resp) {
      if (blocked === null) {
        const urls = new Set<string>();
        let req = resp?.request?.() ?? null;
        for (let i = 0; req && i < MAX_REDIRECT_CHAIN; i++) {
          urls.add(req.url());
          req = req.redirectedFrom?.() ?? null;
        }
        try {
          urls.add(page.url());
          for (const frame of page.frames()) urls.add(frame.url());
        } catch {
          /* page closed: nothing more to read from it */
        }
        await Promise.all([...pending]);
        const gen = generation;
        for (const url of urls) {
          if (blocked !== null) break;
          // about:blank, data:, chrome-error:// (a frame the route guard aborted) reach no address.
          if (!/^https?:/i.test(url)) continue;
          if (!(await allowed(url))) refuse(url, gen);
        }
      }
      if (blocked === null) return null;
      if (!left) {
        left = true;
        await page.goto('about:blank').catch(() => null);
      }
      return landingRefusal(blocked);
    },
  };
}

/**
 * Open a new instrumented page: SSRF route guard on every routed request
 * (private ranges always blocked) plus a landing check for the redirect hops
 * Playwright never routes (blockedLanding), tracker classification with
 * nav-relative timing, console/page error capture, dataLayer hook.
 *
 * `requestGuard` defaults to a DNS-resolving guard scoped to this call; tests
 * inject one built on a fake resolver.
 */
export async function openInstrumentedPage(
  context: PwContext,
  requestGuard: (rawUrl: string) => Promise<boolean> = createRequestGuard(),
): Promise<PageInstruments> {
  // Defence in depth: subresources may go anywhere public, but never to
  // private/loopback/metadata hosts (allowlist applies only to top-level
  // navigation, at the tool boundary). Named hosts are DNS-resolved, because a
  // hostname-string check passes a name that resolves inside
  // (metadata.google.internal, 127.0.0.1.nip.io, a docker service name).
  // Redirect hops never reach this handler; watchLanding re-checks them.
  await context.route('**/*', (route) =>
    requestGuard(route.request().url()).then(
      (ok) => (ok ? route.continue() : route.abort()),
      () => route.abort(),
    ),
  );

  const page = await context.newPage();
  await page.addInitScript({ content: DATALAYER_HOOK });
  const landing = watchLanding(page, requestGuard);

  const trackerHits: CapturedHit[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let navStart = Date.now();
  let requests = 0;
  // Where each record stood at markNavigationStart, so a refused landing drops only its own.
  let marks = { hits: 0, consoleErrors: 0, pageErrors: 0 };

  page.on('request', (req: PwRequest) => {
    requests += 1;
    const url = req.url();
    const { ids, groups } = classifyUrl(url);
    if (ids.length === 0 || trackerHits.length >= MAX_HITS) return;
    const hit: CapturedHit = {
      url: url.slice(0, 500),
      method: req.method(),
      ids,
      groups,
      tMs: Date.now() - navStart,
      resourceType: req.resourceType(),
    };
    if (groups.includes('ga4')) {
      const q = parseQuery(url);
      const keep: Record<string, string> = {};
      for (const k of ['gcs', 'gcd', 'tid', 'en', 'dl', 'cid', 'v']) {
        if (q[k] !== undefined) keep[k] = q[k].slice(0, 200);
      }
      hit.query = keep;
    }
    trackerHits.push(hit);
  });

  page.on('console', (msg: { type(): string; text(): string }) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    if (type === 'error' && consoleErrors.length < MAX_ERRORS) {
      consoleErrors.push(msg.text().slice(0, 500));
    }
  });

  page.on('pageerror', (err: Error) => {
    if (pageErrors.length < MAX_ERRORS) {
      pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500));
    }
  });

  return {
    page,
    trackerHits,
    consoleErrors,
    pageErrors,
    requestCount: () => requests,
    markNavigationStart: () => {
      navStart = Date.now();
      landing.reset();
      marks = { hits: trackerHits.length, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length };
    },
    blockedLanding: async (resp) => {
      const note = await landing.blockedLanding(resp);
      if (note) {
        trackerHits.length = Math.min(trackerHits.length, marks.hits);
        consoleErrors.length = Math.min(consoleErrors.length, marks.consoleErrors);
        pageErrors.length = Math.min(pageErrors.length, marks.pageErrors);
      }
      return note;
    },
  };
}
