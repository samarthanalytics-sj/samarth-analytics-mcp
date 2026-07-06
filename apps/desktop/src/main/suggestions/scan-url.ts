// Scan a SINGLE live URL with the headless browser stack and return the ranked tag suggestions
// (each with a ready-to-use trigger condition). This is the reusable core behind both the
// Tag-suggestions panel's single-page scan AND the `suggest_tags_from_url` chat tool, so the
// chat assistant can answer "how should the trigger be set up for X on <url>?" and feed the
// returned trigger straight to create_gtm_tracking_tag. Read-only: it inventories the DOM; it
// never submits forms or clicks anything (consent-banner interaction only, if a driver needs it).

import { scanUrls, type PageDriver } from './scan-core';
import { createElectronDriver } from './electron-driver';
import { createMultiDriver } from './multi-driver';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import type { TagScanOptions, TagScanResult } from '../../shared/ipc';

export const clampSettle = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms <= 0 ? undefined : Math.min(Math.floor(ms), 10_000);

/**
 * Build the merged page driver: Electron (always-on) + Cheerio (static HTML, if installed) +
 * Playwright (network-idle JS render, if installed). Optional packages are lazy-imported so a
 * missing one never crashes. Shared by the suggestions IPC and the chat scan tool.
 */
export async function makeDriver(opts: TagScanOptions = {}): Promise<PageDriver> {
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
  return drivers.length === 1 ? drivers[0] : createMultiDriver(drivers);
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
