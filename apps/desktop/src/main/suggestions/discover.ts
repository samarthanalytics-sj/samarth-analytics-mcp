// Cheap site discovery: enumerate ALL same-site pages (like a sitemap) so the
// user can see the total and choose which to deep-scan. No browser needed —
// prefers the site's sitemap.xml (instant, complete, covers SPAs), falling back
// to a fast HTML link-crawl (regex over <a href>, server-rendered nav only).
// SSRF-guarded via safeFetch. The expensive multi-engine scan runs later, only
// on the pages the user selects.

import { safeFetch } from './ssrf';
import { normalizeUrl, sameSite } from './scan-core';

export interface DiscoverResult {
  urls: string[];
  viaSitemap: boolean;
  total: number;
  note?: string;
}

const MAX_URLS = 800;
const MAX_SITEMAPS = 15;
const MAX_CRAWL = 150;
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

async function collectSitemap(sitemapUrl: string, base: string, out: Set<string>, sitemapsLeft: { n: number }, depth = 0): Promise<void> {
  if (depth > 2 || out.size >= MAX_URLS || sitemapsLeft.n <= 0) return;
  sitemapsLeft.n -= 1;
  let body = '';
  try {
    const r = await safeFetch(sitemapUrl, 12_000, 'application/xml,text/xml,*/*');
    if (r.status >= 400 || !r.body) return;
    body = r.body;
  } catch {
    return;
  }
  const { locs, isIndex } = parseSitemapLocs(body);
  if (isIndex) {
    for (const loc of locs) {
      if (out.size >= MAX_URLS || sitemapsLeft.n <= 0) break;
      await collectSitemap(loc, base, out, sitemapsLeft, depth + 1);
    }
  } else {
    for (const loc of locs) {
      const n = normalizeUrl(loc, base);
      if (n && sameSite(n, base) && out.size < MAX_URLS) out.add(n);
    }
  }
}

async function discoverViaSitemap(start: string): Promise<string[]> {
  const origin = originOf(start);
  if (!origin) return [];
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
    /* no robots — fine */
  }
  const out = new Set<string>();
  const sitemapsLeft = { n: MAX_SITEMAPS };
  for (const sm of candidates) {
    if (out.size >= MAX_URLS || sitemapsLeft.n <= 0) break;
    await collectSitemap(sm, start, out, sitemapsLeft);
  }
  return [...out];
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

/** Enumerate same-site pages: sitemap first, link-crawl fallback. */
export async function discoverSite(startUrl: string): Promise<DiscoverResult> {
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) return { urls: [], viaSitemap: false, total: 0, note: 'Not a valid http(s) URL.' };
  const sm = await discoverViaSitemap(start);
  if (sm.length > 0) {
    const urls = sm.includes(start) ? sm : [start, ...sm];
    return { urls: urls.slice(0, MAX_URLS), viaSitemap: true, total: Math.min(urls.length, MAX_URLS) };
  }
  const crawled = await discoverViaCrawl(start);
  return {
    urls: crawled,
    viaSitemap: false,
    total: crawled.length,
    note: crawled.length >= MAX_CRAWL ? `Link-crawl capped at ${MAX_CRAWL} pages (no sitemap found).` : 'No sitemap found — discovered via a quick link-crawl (server-rendered links only).',
  };
}
