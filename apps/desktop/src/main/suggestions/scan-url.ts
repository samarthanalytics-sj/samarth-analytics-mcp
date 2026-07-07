// Scan a SINGLE live URL with the headless browser stack and return the ranked tag suggestions
// (each with a ready-to-use trigger condition). This is the reusable core behind both the
// Tag-suggestions panel's single-page scan AND the `suggest_tags_from_url` chat tool, so the
// chat assistant can answer "how should the trigger be set up for X on <url>?" and feed the
// returned trigger straight to create_gtm_tracking_tag. Read-only: it inventories the DOM; it
// never submits forms or clicks anything (consent-banner interaction only, if a driver needs it).

import { scanUrls, type PageDriver, type DrivenPage } from './scan-core';
import { createElectronDriver } from './electron-driver';
import { createMultiDriver } from './multi-driver';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import type { TagScanOptions, TagScanResult } from '../../shared/ipc';

export const clampSettle = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms <= 0 ? undefined : Math.min(Math.floor(ms), 10_000);

// ── shared page-render cache ─────────────────────────────────────────────────────────────────────
// The "Verify" action runs TWO crawls back-to-back on the SAME site — the click-tag inventory crawl and
// the form-plan crawl — and their page sets overlap (the form crawl's pages ⊆ the sitemap crawl's). Left
// alone each renders the overlap independently (≈2× the browser work). This memoises driver.open(url)
// across BOTH crawls (module-level, keyed by normalised URL) so each page renders ONCE. It stores the
// in-flight PROMISE so concurrent crawls share a single render; a short TTL re-renders on a later verify;
// failed renders are evicted so they retry. PURE-ish factory (clock injected) → unit-testable.
export function makePageCache(now: () => number = Date.now, ttlMs = 90_000, max = 150): {
  wrap(driver: PageDriver): PageDriver;
  size(): number;
} {
  const cache = new Map<string, { at: number; p: Promise<DrivenPage> }>();
  const keyOf = (url: string): string => url.replace(/#.*$/, '').replace(/\/+$/, '');
  return {
    wrap(driver: PageDriver): PageDriver {
      return {
        open: (url: string): Promise<DrivenPage> => {
          const k = keyOf(url);
          const t = now();
          const hit = cache.get(k);
          if (hit && t - hit.at < ttlMs) return hit.p;
          const p = driver.open(url);
          cache.set(k, { at: t, p });
          // Don't keep a failed render — let a later request retry it.
          p.then((d) => { if (!d || !d.ok) cache.delete(k); }, () => cache.delete(k));
          if (cache.size > max) {
            for (const [ck, cv] of cache) if (t - cv.at >= ttlMs) cache.delete(ck);
            while (cache.size > max) { const f = cache.keys().next().value; if (f === undefined) break; cache.delete(f); }
          }
          return p;
        },
        close: () => driver.close(),
        ...(driver.screenshot ? { screenshot: (): Promise<Buffer | null> => driver.screenshot!() } : {}),
        ...(driver.diagnostics ? { diagnostics: () => driver.diagnostics!() } : {}),
      };
    },
    size: () => cache.size,
  };
}
const sharedPageCache = makePageCache();

/**
 * Build the merged page driver: Electron (always-on) + Cheerio (static HTML, if installed) +
 * Playwright (network-idle JS render, if installed). Optional packages are lazy-imported so a
 * missing one never crashes. Shared by the suggestions IPC and the chat scan tool.
 *
 * `cachePages: true` wraps it in the shared page-render cache so the verify action's two crawls render
 * each page only once (transparent — same DrivenPage data, no logic change).
 */
export async function makeDriver(opts: TagScanOptions & { cachePages?: boolean } = {}): Promise<PageDriver> {
  const settleMs = clampSettle(opts.settleMs);
  const drivers: PageDriver[] = [createElectronDriver(settleMs !== undefined ? { settleMs } : {})];
  try {
    const { createCheerioDriver } = await import('./cheerio-driver');
    drivers.push(createCheerioDriver());
  } catch {
    /* cheerio not installed — fine */
  }
  try {
    const { createPlaywrightDriver } = await import('./playwright-driver');
    drivers.push(await createPlaywrightDriver({ settleMs }));
  } catch {
    /* playwright not installed — Electron (+Cheerio) still run */
  }
  const merged = drivers.length === 1 ? drivers[0] : createMultiDriver(drivers);
  return opts.cachePages ? sharedPageCache.wrap(merged) : merged;
}

/**
 * Scan one URL → ranked tag suggestions (form submits, CTA/link clicks, mailto/tel, downloads,
 * outbound links), each carrying the trigger condition it needs. Rejects non-public/invalid URLs
 * via the SSRF guard BEFORE launching a browser.
 */
export async function scanUrlForSuggestions(url: string, opts: TagScanOptions = {}): Promise<TagScanResult> {
  const target = String(url ?? '').trim();
  const verdict = urlAllowed(target, []);
  if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
  const driver = await makeDriver(opts);
  let siteHost: string | undefined;
  try {
    siteHost = new URL(target).hostname;
  } catch {
    /* per-URL admission still applies inside scanUrls */
  }
  return scanUrls(driver, [target], siteHost, undefined, { platforms: opts.platforms ?? ['ga4'] });
}
