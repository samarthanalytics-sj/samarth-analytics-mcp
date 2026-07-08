// Scan a SINGLE live URL with the headless browser stack and return the ranked tag suggestions
// (each with a ready-to-use trigger condition). This is the reusable core behind both the
// Tag-suggestions panel's single-page scan AND the `suggest_tags_from_url` chat tool, so the
// chat assistant can answer "how should the trigger be set up for X on <url>?" and feed the
// returned trigger straight to create_gtm_tracking_tag. Read-only: it inventories the DOM; it
// never submits forms or clicks anything (consent-banner interaction only, if a driver needs it).

import os from 'node:os';
import { scanUrls, type PageDriver } from './scan-core';
import { createElectronDriver } from './electron-driver';
import { createMultiDriver } from './multi-driver';
import { makePageCache } from './page-cache';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import type { TagScanOptions, TagScanResult } from '../../shared/ipc';

export const clampSettle = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms <= 0 ? undefined : Math.min(Math.floor(ms), 10_000);

// How many page drivers to run IN PARALLEL. Each driver is a FULL browser stack (an Electron window +
// a Playwright browser), so this is deliberately below the raw thread count — a modern desktop (16GB+,
// many cores) comfortably runs ~5. Bounded by the work available at the call site (never more drivers
// than pages). An explicit request wins (capped at 8). Falls back to 1 if the CPU probe fails.
export function scanConcurrency(requested?: number): number {
  if (requested && requested > 0) return Math.min(Math.floor(requested), 8);
  let cores = 4;
  try { cores = os.cpus()?.length || 4; } catch { /* probe failed — assume a modest machine */ }
  return Math.max(1, Math.min(5, Math.floor(cores / 3)));
}

// One process-wide render cache shared by the verify action's two crawls (see page-cache.ts). Enabled
// per-driver via makeDriver({ cachePages: true }).
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
 * Build a POOL of `n` independent page drivers for PARALLEL scanning — each its own Electron window +
 * Playwright browser + Cheerio, so N drivers scan N pages at once. They share the process-wide render
 * cache, which is concurrency-safe (it dedupes in-flight renders by URL), so re-opening the same URL
 * across drivers still renders once. Returns 1 driver as `n === 1`, so callers can always spread across
 * `pool[0]` (primary) + `pool.slice(1)` (extras) for crawlAndSuggest / scanUrls.
 */
export async function makeDrivers(n: number, opts: TagScanOptions & { cachePages?: boolean } = {}): Promise<PageDriver[]> {
  const count = Math.max(1, Math.floor(n));
  // Each driver eagerly opens a real browser window, so if one fails to build we must close the ones
  // that already succeeded before rejecting — otherwise a partial pool leaks live windows. (Preserves
  // the reject-on-any-failure contract callers rely on.)
  const settled = await Promise.allSettled(Array.from({ length: count }, () => makeDriver(opts)));
  const built = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    await Promise.all(built.map((d) => d.close().catch(() => undefined)));
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
  return built;
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
