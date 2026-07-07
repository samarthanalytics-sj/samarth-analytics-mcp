// Shared page-render cache for the verify action.
//
// A verify runs TWO crawls back-to-back on the SAME site — the sitemap-wide click-tag inventory crawl
// and the form-plan crawl — and their page sets overlap (the form crawl's pages ⊆ the sitemap crawl's).
// Left alone each renders the overlap independently (≈2× the browser work). makePageCache memoises
// driver.open(url) across BOTH crawls (module-level in scan-url.ts, keyed by normalised URL) so each
// page renders ONCE. It stores the in-flight PROMISE so concurrent crawls share a single render; a short
// TTL re-renders on a later verify; failed renders are evicted so they retry.
//
// This module imports only TYPES from scan-core (erased at runtime) — deliberately NO electron/browser
// import — so it (and its unit test) load without an installed Electron binary.

import type { PageDriver, DrivenPage } from './scan-core';

/** Build a page-render cache. `now` is injected for tests; TTL + max keep it bounded. PURE-ish. */
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
