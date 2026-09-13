// Consent Mode SIGNAL probe — the check the Admin/Data APIs cannot do. Loads the property's site
// headlessly (first paint only, no interaction, SSRF-guarded) and inspects the GA4 collect hits the
// page itself fires: Consent Mode v2 stamps every hit with a `gcs=` parameter, so its presence on a
// live hit is direct evidence the signal exists — and its absence on a firing hit is direct evidence
// Consent Mode is NOT implemented. When no hit fires at all we return that honestly (a consent banner
// gating hits pre-interaction is normal), so the caller can SKIP rather than guess.
// Read-only: navigates one page, never clicks, never injects.

import { requestAllowed } from './ssrf';

interface PwRequest {
  url(): string;
}
interface PwPage {
  on(event: 'request', handler: (req: PwRequest) => void): void;
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> };
}

async function loadPlaywright(): Promise<Playwright | null> {
  try {
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

export interface ConsentProbeResult {
  url: string;
  /** A GA4 collect hit was observed on first load (pre-interaction). */
  observedHit: boolean;
  /** At least one observed hit carried Consent Mode's gcs= parameter. */
  gcsPresent: boolean;
  /** The raw gcs value (e.g. "G111" all granted, "G100" denied) for the check detail. */
  gcs: string | null;
}

// GA4/gtag hit endpoints (web): /g/collect (GA4), /j/collect (legacy), /collect, region1 subpaths.
const COLLECT_RE = /(google-analytics\.com|analytics\.google\.com|googletagmanager\.com)\/(?:[a-z0-9]+\/)?(?:g|j)?\/?collect/i;

/** Pure classifier for a request URL: is it a GA4 collect hit, and what gcs does it carry.
 *  Exported for tests. */
export function parseGa4CollectHit(u: string): { isCollect: boolean; gcs: string | null } {
  if (!COLLECT_RE.test(u)) return { isCollect: false, gcs: null };
  try {
    return { isCollect: true, gcs: new URL(u).searchParams.get('gcs') };
  } catch {
    return { isCollect: true, gcs: null };
  }
}

/** Load `url` headlessly and watch its GA4 hits for ~observeMs. Returns null when the probe could
 *  not run at all (SSRF-blocked, Playwright unavailable, navigation failed) — the caller must treat
 *  null as "unknown", never as "no consent". */
export async function probeConsentSignal(
  url: string,
  opts: { navTimeoutMs?: number; observeMs?: number } = {},
): Promise<ConsentProbeResult | null> {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const observeMs = opts.observeMs ?? 6_000;
  if (!(await requestAllowed(url))) return null;
  const pw = await loadPlaywright();
  if (!pw) return null;

  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const hits: Array<{ gcs: string | null }> = [];
    page.on('request', (req) => {
      const parsed = parseGa4CollectHit(req.url());
      if (parsed.isCollect) hits.push({ gcs: parsed.gcs });
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } catch {
      return null;
    }
    await page.waitForTimeout(observeMs);
    const withGcs = hits.find((h) => h.gcs);
    return { url, observedHit: hits.length > 0, gcsPresent: Boolean(withGcs), gcs: withGcs?.gcs ?? null };
  } catch {
    return null;
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
