// Desktop "measurement plan from a URL": crawl a site and turn each page into
// GA4 tag suggestions — the input for the review/approve panel. The BFS + the
// suggestion assembly live here and are driven through an injected PageDriver,
// so the whole orchestration is unit-testable with a fake driver (no Electron,
// no real browser). The real driver (Electron's built-in Chromium) is in
// electron-driver.ts.
//
// This REUSES the same pure engine the web-audit MCP uses — buildSuggestInput /
// buildSuggestions / classifyPageElements / analyzeForms — imported cross-package.
// Those modules are LEAF-PURE (they reference Playwright's page type only via
// `import type`, which is erased), so nothing browser/Playwright is pulled into
// the desktop bundle. Mirrors apps/web-audit-mcp/src/agent/tag-suggest/scan.ts,
// but the I/O is Electron, and the few tiny crawl helpers (normalizeUrl /
// sameSite / urlPriority / pagePath) are re-stated here to avoid importing
// crawler.ts (which DOES pull the Playwright-typed browser module as a value).

import {
  classifyPageElements,
  buildSuggestInput,
  type PageScan,
  type PageScanRaw,
} from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import { buildSuggestions } from '../../../../web-audit-mcp/src/agent/tag-suggest/suggest.js';
import { analyzeForms, type RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import type { SuggestedTag } from '../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import type { TagScanResult } from '../../shared/ipc';

/** What one navigated page yields. Produced by a PageDriver; consumed here. */
export interface DrivenPage {
  ok: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  /** Read-only DOM scan (anchors/buttons + provider signals). Absent on error/HTTP-error. */
  raw?: PageScanRaw;
  /** Raw form descriptors (never values). Absent on error/HTTP-error. */
  rawForms?: RawForm[];
  error?: string;
}

/** Drives a browser to one page at a time. The Electron adapter implements this. */
export interface PageDriver {
  open(url: string): Promise<DrivenPage>;
  close(): Promise<void>;
}

export interface ScanOptions {
  /** Pages to open/scan (default 10, hard cap 25). */
  maxPages?: number;
  /** Link depth from the start URL (default 2, hard cap 4). */
  maxDepth?: number;
}

const clamp = (v: number | undefined, dflt: number, cap: number): number =>
  v === undefined || !Number.isFinite(v) || v <= 0 ? dflt : Math.min(Math.floor(v), cap);

// ── Crawl helpers (mirror apps/web-audit-mcp/src/agent/crawler.ts — keep in
//    sync; re-stated to keep this module free of the Playwright browser import) ──
const ASSET_RE =
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|css|js|mjs|ico|zip|gz|rar|mp3|mp4|webm|mov|woff2?|ttf|eot|xml|rss|json)([?#]|$)/i;
const FORMY_RE =
  /contact|kontakt|signup|sign-up|register|registr|subscribe|newsletter|demo|quote|enquir|inquir|checkout|cart|book|apply|support|feedback|account|login/i;

const stripWww = (host: string): string => host.toLowerCase().replace(/^www\./, '');

export function sameSite(candidate: string, base: string): boolean {
  try {
    const c = stripWww(new URL(candidate).hostname);
    const b = stripWww(new URL(base).hostname);
    return c === b || c.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

export function normalizeUrl(raw: string, baseUrl: string): string | null {
  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    if (ASSET_RE.test(u.pathname + u.search)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function urlPriority(url: string): number {
  return FORMY_RE.test(url) ? 1 : 0;
}

/** A crawled URL → its page path ("/contact", "/" for root); query/hash dropped. */
export function pagePath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

/** GTM containers (GTM-XXXX) + measurement ids (G-/AW-/GT-/UA-) that are LIVE on
 *  the scanned pages — parsed from the googletagmanager.com script srcs. Lets the
 *  user see which container is actually installed on the site. PURE + tested. */
export function detectInstalled(scriptSrcs: string[]): { containers: string[]; measurementIds: string[] } {
  const containers = new Set<string>();
  const measurementIds = new Set<string>();
  for (const src of scriptSrcs) {
    const gtm = /googletagmanager\.com\/gtm\.js\?[^"'\s]*\bid=(GTM-[A-Z0-9]+)/i.exec(src);
    if (gtm) containers.add(gtm[1].toUpperCase());
    const gtag = /googletagmanager\.com\/gtag\/js\?[^"'\s]*\bid=((?:G|AW|GT|UA)-[A-Z0-9-]+)/i.exec(src);
    if (gtag) measurementIds.add(gtag[1].toUpperCase());
  }
  return { containers: [...containers], measurementIds: [...measurementIds] };
}

function emptyResult(site: string, siteHost: string, warnings: string[]): TagScanResult {
  return {
    site,
    siteHost,
    scannedAt: new Date().toISOString(),
    summary: {
      pagesCrawled: 0,
      pagesScanned: 0,
      formsFound: 0,
      trackableElements: 0,
      suggestions: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
      enhancedMeasurementOverlap: 0,
      newTracking: 0,
    },
    suggestions: [],
    pages: [],
    inventory: { elements: [], forms: [] },
    installed: { containers: [], measurementIds: [] },
    notScanned: [],
    warnings,
  };
}

/** Scan ONE already-admitted URL → a PageScan (+ its same-site links), or a
 *  not-scanned reason. Read-only DOM read via the driver. */
async function scanTarget(
  driver: PageDriver,
  url: string,
  siteHost: string,
  base: string,
): Promise<{ page?: PageScan; links?: string[]; reason?: string }> {
  const driven = await driver.open(url);
  if (!driven.ok) return { reason: driven.error ? `scan failed: ${driven.error}`.slice(0, 200) : 'navigation failed' };
  if (driven.httpStatus !== null && driven.httpStatus >= 400) return { reason: `http ${driven.httpStatus}` };
  if (!driven.raw) return { reason: 'no page content' };
  const path = pagePath(url);
  const elements = classifyPageElements(driven.raw.elements, siteHost, path);
  const forms = (driven.rawForms ? analyzeForms(driven.rawForms, driven.finalUrl ?? url) : []).map((f) => ({
    purpose: f.purpose,
    action: f.action,
  }));
  const links: string[] = [];
  for (const el of driven.raw.elements) {
    if (el.tag !== 'a' || !el.href) continue;
    const norm = normalizeUrl(el.href, url);
    if (norm && sameSite(norm, base)) links.push(norm);
  }
  return { page: { page: path, elements, forms, signals: driven.raw.signals }, links };
}

/** Build the final report from collected page scans (pure assembly + dedup). */
function assembleResult(
  site: string,
  siteHost: string,
  pageScans: PageScan[],
  notScanned: TagScanResult['notScanned'],
  warnings: string[],
  opened: number,
): TagScanResult {
  const input = buildSuggestInput(pageScans, siteHost);
  const suggestions: SuggestedTag[] = buildSuggestions(input);
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let em = 0;
  for (const sug of suggestions) {
    byConfidence[sug.confidence] += 1;
    if (sug.enhancedMeasurementOverlap) em += 1;
  }
  return {
    site,
    siteHost,
    scannedAt: new Date().toISOString(),
    summary: {
      pagesCrawled: opened,
      pagesScanned: pageScans.length,
      formsFound: input.forms.length,
      trackableElements: input.elements.length,
      suggestions: suggestions.length,
      byConfidence,
      enhancedMeasurementOverlap: em,
      newTracking: suggestions.length - em,
    },
    suggestions,
    pages: pageScans.map((p) => ({ page: p.page, forms: p.forms.length, elements: p.elements.length })),
    // The full inventory: every detected element/form (before the engine dedups
    // them into suggestions), so the user can see ALL trackable elements.
    inventory: {
      elements: input.elements.slice(0, 1000).map((e) => ({ page: e.page, kind: e.kind, text: e.text, href: e.href, region: e.region })),
      forms: input.forms.map((f) => ({ page: f.page, purpose: f.purpose, action: f.action, provider: f.provider.vendor })),
    },
    installed: detectInstalled(pageScans.flatMap((p) => p.signals.scriptSrcs)),
    notScanned,
    warnings,
  };
}

/**
 * Crawl a site (same-site BFS, form-heavy pages first) via the injected driver
 * and return ranked, deduped GA4 tag suggestions. READ-ONLY: the driver only
 * navigates + reads the DOM — it never clicks or submits.
 */
export async function crawlAndSuggest(
  driver: PageDriver,
  startUrl: string,
  opts: ScanOptions = {},
): Promise<TagScanResult> {
  const maxPages = clamp(opts.maxPages, 10, 50);
  const maxDepth = clamp(opts.maxDepth, 2, 4);

  const warnings: string[] = [];
  const start = normalizeUrl(startUrl, startUrl);
  let siteHost = '';
  try {
    siteHost = new URL(start ?? startUrl).hostname;
  } catch {
    /* validated upstream by urlAllowed */
  }
  if (!start) {
    await driver.close();
    return emptyResult(startUrl, siteHost, ['Not a crawlable http(s) URL.']);
  }

  const notScanned: TagScanResult['notScanned'] = [];
  const pageScans: PageScan[] = [];
  const visited = new Set<string>();
  const discovered = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  let opened = 0;

  try {
    while (queue.length > 0 && opened < maxPages) {
      queue.sort((a, b) => a.depth - b.depth || urlPriority(b.url) - urlPriority(a.url));
      const { url, depth } = queue.shift()!;
      const key = url.replace(/\/$/, '');
      if (visited.has(key)) continue;
      visited.add(key);

      const verdict = urlAllowed(url, []);
      if (!verdict.ok) {
        notScanned.push({ url, reason: verdict.reason });
        continue;
      }

      opened += 1;
      const r = await scanTarget(driver, url, siteHost, start);
      if (!r.page) {
        notScanned.push({ url, reason: r.reason ?? 'not scanned' });
        continue;
      }
      pageScans.push(r.page);
      if (depth < maxDepth) {
        for (const norm of r.links ?? []) {
          const k = norm.replace(/\/$/, '');
          if (visited.has(k) || discovered.has(norm)) continue;
          discovered.add(norm);
          queue.push({ url: norm, depth: depth + 1 });
        }
      }
    }
  } finally {
    await driver.close();
  }

  if (queue.length > 0) {
    warnings.push(`${queue.length} more same-site page(s) were discovered but not scanned (page budget ${maxPages}).`);
  }
  return assembleResult(start, siteHost, pageScans, notScanned, warnings, opened);
}

/** Max pages a single "scan selected" run will deep-scan. */
export const SCAN_URLS_CAP = 60;

/**
 * Deep-scan a SPECIFIC list of URLs (no BFS) — used after the discover step,
 * where the user picked which pages to scan. READ-ONLY.
 */
export async function scanUrls(driver: PageDriver, urls: string[], siteHostHint?: string): Promise<TagScanResult> {
  const list = urls.filter(Boolean);
  const start = list[0] ? normalizeUrl(list[0], list[0]) : null;
  let siteHost = siteHostHint ?? '';
  if (!siteHost) {
    try {
      siteHost = new URL(start ?? list[0] ?? '').hostname;
    } catch {
      /* leave empty */
    }
  }
  const warnings: string[] = [];
  const targets = list.slice(0, SCAN_URLS_CAP);
  if (list.length > SCAN_URLS_CAP) {
    warnings.push(`Selected ${list.length} pages; scanning the first ${SCAN_URLS_CAP} (cap).`);
  }

  const notScanned: TagScanResult['notScanned'] = [];
  const pageScans: PageScan[] = [];
  const seen = new Set<string>();
  let opened = 0;
  try {
    for (const raw of targets) {
      const url = normalizeUrl(raw, raw) ?? raw;
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = urlAllowed(url, []);
      if (!verdict.ok) {
        notScanned.push({ url, reason: verdict.reason });
        continue;
      }
      opened += 1;
      const r = await scanTarget(driver, url, siteHost, url);
      if (!r.page) {
        notScanned.push({ url, reason: r.reason ?? 'not scanned' });
        continue;
      }
      pageScans.push(r.page);
    }
  } finally {
    await driver.close();
  }
  return assembleResult(start ?? list[0] ?? '', siteHost, pageScans, notScanned, warnings, opened);
}
