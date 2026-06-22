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
    notScanned: [],
    warnings,
  };
}

/**
 * Crawl a site (same-site BFS, form-heavy pages first) via the injected driver
 * and return ranked, deduped GA4 tag suggestions. READ-ONLY: the driver only
 * navigates + reads the DOM — it never clicks or submits. Each suggestion is in
 * the create_gtm_tracking_tag payload shape.
 */
export async function crawlAndSuggest(
  driver: PageDriver,
  startUrl: string,
  opts: ScanOptions = {},
): Promise<TagScanResult> {
  const maxPages = clamp(opts.maxPages, 10, 25);
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
      // BFS by depth; form-looking URLs first within a depth level.
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
      const driven = await driver.open(url);
      if (!driven.ok) {
        notScanned.push({ url, reason: driven.error ? `scan failed: ${driven.error}`.slice(0, 200) : 'navigation failed' });
        continue;
      }
      if (driven.httpStatus !== null && driven.httpStatus >= 400) {
        notScanned.push({ url, reason: `http ${driven.httpStatus}` });
        continue;
      }
      if (!driven.raw) {
        notScanned.push({ url, reason: 'no page content' });
        continue;
      }

      const path = pagePath(url);
      const elements = classifyPageElements(driven.raw.elements, siteHost, path);
      const forms = (driven.rawForms ? analyzeForms(driven.rawForms, driven.finalUrl ?? url) : []).map((f) => ({
        purpose: f.purpose,
        action: f.action,
      }));
      pageScans.push({ page: path, elements, forms, signals: driven.raw.signals });

      // Enqueue same-site links from the anchors the collector already gathered.
      if (depth < maxDepth) {
        for (const el of driven.raw.elements) {
          if (el.tag !== 'a' || !el.href) continue;
          const norm = normalizeUrl(el.href, url);
          if (!norm || !sameSite(norm, start)) continue;
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

  const input = buildSuggestInput(pageScans, siteHost);
  const suggestions: SuggestedTag[] = buildSuggestions(input);
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let em = 0;
  for (const sug of suggestions) {
    byConfidence[sug.confidence] += 1;
    if (sug.enhancedMeasurementOverlap) em += 1;
  }
  if (queue.length > 0) {
    warnings.push(`${queue.length} more same-site page(s) were discovered but not scanned (page budget ${maxPages}).`);
  }

  return {
    site: start,
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
    notScanned,
    warnings,
  };
}
