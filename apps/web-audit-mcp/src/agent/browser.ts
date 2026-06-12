/**
 * Browser layer: lazy Playwright loading, instrumented contexts, and network
 * classification. Playwright is an optional dependency — the server starts and
 * lists tools without it; the first browser-backed call explains how to
 * install it. Patterns mirror apps/runtime-worker/capture.mjs so captures here
 * reconcile with the portal's consent engine.
 */

import { urlAllowed } from '../utils/urlGuard.js';

// ── Minimal structural typings for the Playwright surface we use ───────────
// (Avoids a hard dependency on playwright's types when it is not installed.)

export interface PwResponse {
  status(): number;
}
export interface PwRequest {
  url(): string;
  method(): string;
  resourceType(): string;
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
  /** Call immediately before goto so hit timestamps are nav-relative. */
  markNavigationStart: () => void;
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

/**
 * Open a new instrumented page: SSRF route guard on every request (private
 * ranges always blocked, even via redirects), tracker classification with
 * nav-relative timing, console/page error capture, dataLayer hook.
 */
export async function openInstrumentedPage(context: PwContext): Promise<PageInstruments> {
  // Defence in depth: subresources and redirects may go anywhere public, but
  // never to private/loopback/metadata hosts (allowlist applies only to
  // top-level navigation, at the tool boundary).
  await context.route('**/*', (route) => {
    const verdict = urlAllowed(route.request().url(), []);
    return verdict.ok ? route.continue() : route.abort();
  });

  const page = await context.newPage();
  await page.addInitScript({ content: DATALAYER_HOOK });

  const trackerHits: CapturedHit[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let navStart = Date.now();
  let requests = 0;

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
    },
  };
}
