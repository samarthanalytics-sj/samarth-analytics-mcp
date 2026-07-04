// SYNTHETIC RUNTIME DRIVER — the "runtime synthetic test" engine.
//
// It loads a page in headless Chromium, fires SYNTHETIC dataLayer funnel events, and CAPTURES the
// resulting analytics /collect hits so we can prove each tag fires at runtime with the right params —
// WITHOUT ever delivering a real hit to any collector. A real 'purchase' hit would pollute the
// user's GA4/Meta with fake conversions, so the whole design is ABORT-FIRST interception:
//
//   • ONE context.route('**/*') is installed BEFORE any navigation or injection.
//   • In the handler: if the request is an ANALYTICS COLLECTOR (classifyCollector, the exact matcher
//     the report uses), we CAPTURE url + postData() and route.abort() — we NEVER route.continue()
//     a collector. So no collector hit is ever delivered.
//   • Otherwise we apply the shared SSRF guard (requestAllowed): continue if allowed, else abort.
//
// Playwright is OPTIONAL (not a desktop dependency) — loaded lazily; if it isn't installed the tool
// reports that cleanly instead of throwing.

import { requestAllowed } from './ssrf';
import { classifyCollector, syntheticDataLayerEvent, type Collector } from '../../shared/runtime-capture';
import { GA4_ECOMMERCE_FUNNEL_EVENTS } from '../google/gtm-builders';
import { PlaywrightUnavailableError } from './playwright-driver';

// Minimal structural typings for the Playwright surface we use, so this file type-checks WITHOUT
// playwright (or its types) installed. Extends the playwright-driver's PwRoute with request().url()
// AND request().postData() so the handler can capture a batched GA4 POST body.
interface PwRoute {
  request(): { url(): string; postData(): string | null; resourceType(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

/** Resource types that carry a tracking BEACON, not a page asset. Scripts/styles/fonts/documents are
 *  allowed (so a tag can still load its library and fire); everything else (xhr/fetch/image/ping/
 *  beacon/…) is a beacon transport we kill during the synthetic window. */
function isBeaconType(rt: string): boolean {
  return rt !== 'script' && rt !== 'stylesheet' && rt !== 'font' && rt !== 'document';
}
const safePostData = (req: { postData(): string | null }): string | null => {
  try {
    return req.postData();
  } catch {
    return null;
  }
};
interface PwResponse {
  status(): number;
}
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  evaluate<T = unknown>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
}
interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> };
}

/** Lazy, non-bundled load of the optional playwright package (mirrors playwright-driver). */
async function loadPlaywright(): Promise<Playwright | null> {
  try {
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

/** A collector request that was captured and ABORTED (never delivered). */
export interface CapturedCollectorHit {
  url: string;
  body: string | null;
  collector: Collector;
}

export interface SyntheticTestOptions {
  /** Events to fire (default: the 7-event ecommerce funnel). */
  events?: string[];
  /** Optional first-party tagging server URL — its host is also treated as a collector to abort. */
  serverUrl?: string;
  navTimeoutMs?: number;
  /** Wait after each dataLayer push so the tag fires and its (aborted) hit is captured. */
  settleMs?: number;
}

export interface SyntheticTestResult {
  capturedHits: CapturedCollectorHit[];
  pagesOk: boolean;
  error?: string;
}

/** Extract a bare hostname from an optional serverUrl, for the collector matcher. */
function serverHostOf(serverUrl?: string): string | null {
  if (!serverUrl) return null;
  try {
    return new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Load `url` in headless Chromium, push SYNTHETIC dataLayer funnel events, and capture every
 * analytics /collect hit they trigger — WITHOUT delivering any of them. Best-effort: returns an
 * error string rather than throwing on a nav/launch failure. The browser is always closed.
 *
 * SAFETY INVARIANT: a request classified as a collector is only ever route.abort()'d — never
 * route.continue()'d — so nothing reaches GA4/Meta/TikTok/the tagging server.
 */
export async function runSyntheticTest(url: string, opts: SyntheticTestOptions = {}): Promise<SyntheticTestResult> {
  const events = opts.events && opts.events.length > 0 ? opts.events : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 700;
  const serverHost = serverHostOf(opts.serverUrl);
  const capturedHits: CapturedCollectorHit[] = [];

  // Validate the target URL up front with the SAME SSRF guard used per-request. This blocks
  // private/loopback/invalid targets BEFORE we ever launch a browser (and keeps the pure-logic
  // smoke test from spawning Chromium for a bogus 'x' url).
  if (!(await requestAllowed(url))) {
    return { capturedHits, pagesOk: false, error: `Refusing to load ${url}: blocked by the SSRF guard (private/loopback/invalid host).` };
  }

  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });

    // The page's own host — first-party requests are allowed; cross-site beacons are killed during
    // syntheticPhase is armed only while we push events (below).
    let syntheticPhase = false;

    // ── ABORT-FIRST interception — installed BEFORE any navigation or injection. ──────────────
    // Collector? → capture + ALWAYS abort (never continue). Otherwise apply the SSRF guard.
    await context.route('**/*', (route) => {
      const req = route.request();
      const reqUrl = req.url();
      const collector = classifyCollector(reqUrl, serverHost);
      if (collector) {
        // CAPTURE then ABORT — a collector request is NEVER continued, so no hit is delivered.
        capturedHits.push({ url: reqUrl, body: safePostData(req), collector });
        void route.abort();
        return;
      }
      // DEFENSE IN DEPTH: while we are firing synthetic events, abort EVERY data beacon we did not
      // explicitly classify — including SAME-SITE ones. This is the critical guard: a first-party
      // collector proxy (Stape / Cloudflare Zaraz / a first-party sGTM on a custom path like
      // /fbevents or /api/track) is same-site and unknown-path, so "same-site ⇒ trusted" would leak a
      // real synthetic conversion. During the synthetic window every beacon is a tag firing, so we
      // kill them all. Scripts/styles/fonts/documents still load, so a tag can load its library and
      // fire; only the beacon transports (xhr/fetch/image/ping/…) are aborted. (Before the synthetic
      // window, only KNOWN collectors above are aborted — the page's own load-time hits, which fire on
      // any normal visit and carry no synthetic funnel event, are left alone.)
      if (syntheticPhase && isBeaconType(req.resourceType())) {
        capturedHits.push({ url: reqUrl, body: safePostData(req), collector: 'ad' });
        void route.abort();
        return;
      }
      // Non-beacon (or pre-synthetic-window): normal SSRF guard (continue if allowed, else abort).
      void requestAllowed(reqUrl).then(
        (ok) => (ok ? route.continue() : route.abort()),
        () => route.abort(),
      );
    });

    const page = await context.newPage();

    // networkidle lets the container + tags finish loading before we push events.
    await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs });

    // The page + container have loaded; from here every cross-site beacon is a tag firing. Arm the
    // synthetic-phase net so nothing we don't explicitly classify can escape either.
    syntheticPhase = true;

    // Fire each synthetic event, waiting between pushes so the tag fires and its (aborted) collect
    // hit is captured. Deterministic, contract-driven payloads come from syntheticDataLayerEvent.
    for (const event of events) {
      const payload = syntheticDataLayerEvent(event);
      await page.evaluate((p: unknown) => {
        const w = window as unknown as { dataLayer?: unknown[] };
        w.dataLayer = w.dataLayer || [];
        w.dataLayer.push(p as Record<string, unknown>);
      }, payload);
      await page.waitForTimeout(settleMs);
    }

    return { capturedHits, pagesOk: true };
  } catch (e) {
    return { capturedHits, pagesOk: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
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
