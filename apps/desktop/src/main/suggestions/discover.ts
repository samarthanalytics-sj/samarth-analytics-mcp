// Cheap site discovery: enumerate ALL same-site pages (like a sitemap) so the
// user can see the total and choose which to deep-scan. No browser needed —
// prefers the site's sitemap.xml (instant, complete, covers SPAs), falling back
// to a fast HTML link-crawl (regex over <a href>, server-rendered nav only).
// SSRF-guarded via safeFetch. The expensive multi-engine scan runs later, only
// on the pages the user selects.

import { safeFetch } from './ssrf';
import { normalizeUrl, sameSite, detectInstalled, prioritizeUrls } from './scan-core';

export interface DiscoverResult {
  urls: string[];
  viaSitemap: boolean;
  total: number;
  /** GTM container + measurement ids already live on the site (from its homepage). */
  installed: { containers: string[]; measurementIds: string[] };
  note?: string;
  /**
   * Why the sitemap path did or did not produce urls. Every sitemap fetch failure used to be swallowed,
   * so a 429, a timeout or a 503 was reported identically to a site that genuinely has no sitemap, and a
   * caller would state "no sitemap found" as fact. Observed live: three rapid calls to the same site,
   * the third got throttled and reported no sitemap for a site with 700+ urls in one.
   *   'found'       urls came from a sitemap.
   *   'none'        every candidate answered cleanly with nothing (a real, reportable absence).
   *   'unreachable' at least one candidate errored or returned >= 400, so absence is NOT established.
   *   'partial'     urls came from a sitemap, but the MAX_SITEMAPS budget ran out, so `total` is a floor.
   */
  sitemapStatus: 'found' | 'none' | 'unreachable' | 'partial';
}

const MAX_URLS = 800;
const MAX_SITEMAPS = 15;
// No-sitemap link-crawl budget. Kept >= the deep-scan cap (SCAN_URLS_CAP) so the discover step can list
// enough pages for the user to select up to that cap even when the site has no sitemap.
const MAX_CRAWL = 250;
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
};

/** PURE: pull <loc> URLs out of a sitemap (or sitemapindex) XML body. */
export function parseSitemapLocs(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex/i.test(xml);
  const locs: string[] = [];
  let m: RegExpExecArray | null;
  LOC_RE.lastIndex = 0;
  while ((m = LOC_RE.exec(xml)) !== null) locs.push(m[1].trim());
  return { locs, isIndex };
}

/** PURE: same-site links from an HTML body (server-rendered <a href>). */
export function extractCrawlLinks(html: string, pageUrl: string, base: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(html)) !== null) {
    const n = normalizeUrl(m[1], pageUrl);
    if (n && sameSite(n, base)) out.push(n);
  }
  return out;
}

async function collectSitemap(sitemapUrl: string, base: string, out: Set<string>, sitemapsLeft: { n: number }, depth = 0, fail?: { failed: boolean }): Promise<void> {
  if (depth > 2 || out.size >= MAX_URLS || sitemapsLeft.n <= 0) return;
  sitemapsLeft.n -= 1;
  let body = '';
  try {
    const r = await safeFetch(sitemapUrl, 12_000, 'application/xml,text/xml,*/*');
    // A 404 is a clean "not here" and says nothing is wrong. Anything else (429, 5xx, an empty body on a
    // 200) means we did not get to LOOK, which must not be reported as "this site has no sitemap".
    if (r.status >= 400 || !r.body) {
      if (fail && r.status !== 404) fail.failed = true;
      return;
    }
    body = r.body;
  } catch {
    if (fail) fail.failed = true;
    return;
  }
  const { locs, isIndex } = parseSitemapLocs(body);
  if (isIndex) {
    for (const loc of locs) {
      if (out.size >= MAX_URLS || sitemapsLeft.n <= 0) break;
      // Only follow SAME-SITE sub-sitemaps — never let a sitemapindex point our
      // fetch at an arbitrary host.
      if (sameSite(loc, base)) await collectSitemap(loc, base, out, sitemapsLeft, depth + 1);
    }
  } else {
    for (const loc of locs) {
      const n = normalizeUrl(loc, base);
      if (n && sameSite(n, base) && out.size < MAX_URLS) out.add(n);
    }
  }
}

async function discoverViaSitemap(start: string): Promise<{ urls: string[]; failed: boolean; budgetHit: boolean }> {
  const origin = originOf(start);
  if (!origin) return { urls: [], failed: false, budgetHit: false };
  let robotsFailed = false;
  const candidates = new Set<string>([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  // robots.txt commonly lists the real sitemap location(s).
  try {
    const robots = await safeFetch(`${origin}/robots.txt`, 8_000, 'text/plain,*/*');
    if (robots.status < 400 && robots.body) {
      for (const line of robots.body.split('\n')) {
        const mm = /^\s*sitemap:\s*(\S+)/i.exec(line);
        if (mm) candidates.add(mm[1].trim());
      }
    }
  } catch {
    // robots.txt is optional, so its absence proves nothing either way, but a FAILURE here is a hint
    // that the host is refusing us rather than that it has no sitemap.
    robotsFailed = true;
  }
  const out = new Set<string>();
  const sitemapsLeft = { n: MAX_SITEMAPS };
  const fail = { failed: robotsFailed };
  for (const sm of candidates) {
    if (out.size >= MAX_URLS || sitemapsLeft.n <= 0) break;
    await collectSitemap(sm, start, out, sitemapsLeft, 0, fail);
  }
  // Budget exhausted with urls in hand means `total` is a floor, not a count: a big sitemap index gets
  // cut off at MAX_SITEMAPS, and WHICH sub-sitemaps finish varies with network timing, which is why
  // repeated runs against the same site returned 730 / 728 / 702.
  return { urls: [...out], failed: fail.failed, budgetHit: sitemapsLeft.n <= 0 };
}

async function discoverViaCrawl(start: string): Promise<string[]> {
  const visited = new Set<string>();
  const discovered = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0 && visited.size < MAX_CRAWL) {
    const url = queue.shift()!;
    const key = url.replace(/\/$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    let body = '';
    try {
      const r = await safeFetch(url, 10_000);
      if (r.status >= 400 || !r.body) continue;
      body = r.body;
    } catch {
      continue;
    }
    for (const n of extractCrawlLinks(body, url, start)) {
      if (!discovered.has(n)) {
        discovered.add(n);
        if (queue.length + visited.size < MAX_URLS) queue.push(n);
      }
    }
  }
  return [...discovered].slice(0, MAX_URLS);
}

/** Read the homepage once to see which GTM/GA4 is already installed on the site. */
async function detectInstalledOnHomepage(start: string): Promise<{ containers: string[]; measurementIds: string[] }> {
  try {
    const r = await safeFetch(start, 10_000);
    if (r.status >= 400 || !r.body) return { containers: [], measurementIds: [] };
    return detectInstalled([r.body]);
  } catch {
    return { containers: [], measurementIds: [] };
  }
}

/** Enumerate same-site pages: sitemap first, link-crawl fallback. Also reports
 *  which GTM container is already live on the site. */
export async function discoverSite(startUrl: string): Promise<DiscoverResult> {
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) return { urls: [], viaSitemap: false, total: 0, installed: { containers: [], measurementIds: [] }, sitemapStatus: 'none', note: 'Not a valid http(s) URL.' };
  const installed = await detectInstalledOnHomepage(start);
  const sm = await discoverViaSitemap(start);
  if (sm.urls.length > 0) {
    const urls = sm.urls.includes(start) ? sm.urls : [start, ...sm.urls];
    // STABLE-sort form-likely pages first (homepage always leads) so App.tsx's "first 25" pre-select
    // naturally picks the contact/audit/consultation pages instead of raw sitemap order. Same URL SET,
    // only its order — nothing is added or dropped.
    return {
      urls: prioritizeUrls(urls).slice(0, MAX_URLS),
      viaSitemap: true,
      total: Math.min(urls.length, MAX_URLS),
      installed,
      sitemapStatus: sm.budgetHit || sm.failed ? 'partial' : 'found',
      ...(sm.budgetHit || sm.failed
        ? { note: `Sitemap read only in part (${sm.budgetHit ? `stopped after ${MAX_SITEMAPS} sitemap files` : 'a sitemap fetch failed'}), so the page count is a FLOOR, not the total.` }
        : {}),
    };
  }
  const crawled = await discoverViaCrawl(start);
  // The distinction that matters: 'unreachable' means we never got to look, so the caller must NOT
  // report "this site has no sitemap". 'none' means every candidate answered cleanly with nothing.
  const status = sm.failed ? 'unreachable' : 'none';
  return {
    urls: prioritizeUrls(crawled),
    viaSitemap: false,
    total: crawled.length,
    installed,
    sitemapStatus: status,
    note: status === 'unreachable'
      ? 'Could NOT read the sitemap for this site (it refused or timed out), so do not say it has none. These pages come from a quick link-crawl; retry in a moment for the full list.'
      : crawled.length >= MAX_CRAWL
        ? `Link-crawl capped at ${MAX_CRAWL} pages (no sitemap found).`
        : 'No sitemap found, discovered via a quick link-crawl (server-rendered links only).',
  };
}
