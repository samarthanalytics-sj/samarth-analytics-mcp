/**
 * Enumerate a site's pages WITHOUT opening a browser, so a person can see what there is and choose
 * what to scan.
 *
 * The deep scan is expensive: a headless Chromium, a navigation, a settle, a form inventory and a
 * full-page screenshot per page. Spending that budget on a crawl's idea of the 25 most interesting
 * pages is a guess, and on a content site it is usually the wrong one. This runs first, costs a few
 * HTTP GETs, and turns "trust the crawler" into "here is the list, pick".
 *
 * Sitemap first, link-crawl only as a fallback. A sitemap is instant, complete, and it lists pages a
 * link crawl cannot reach at all: anything behind client-side routing, and anything not linked from
 * the pages the crawl happened to open.
 *
 * The one thing this must never do is report "no sitemap" when it simply could not read one. A 429,
 * a timeout or a 503 are not evidence of absence, and a caller that treats them as absence tells the
 * user their site has no sitemap when it has seven hundred URLs in one. That distinction is what
 * `sitemapStatus` carries.
 */

import { normalizeUrl, sameSite, urlPriority } from '../crawler.js';
import { isBlogLike } from './blog-paths.js';
import { safeFetch } from '../../utils/safeFetch.js';
import { urlAllowed } from '../../utils/urlGuard.js';

/** Hard ceiling on URLs returned. A big site's sitemap can hold tens of thousands. */
export const MAX_DISCOVERED = 800;
/** How many sitemap files (including nested index children) may be fetched in one discovery. */
export const MAX_SITEMAPS = 15;
/** Pages the fallback link-crawl will open. Well above the deep-scan cap so there is a real choice. */
export const MAX_CRAWL = 250;

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;

/**
 * Why the sitemap path produced what it did.
 *
 * `none` and `unreachable` look the same on screen and mean opposite things: one is a site that
 * genuinely publishes no sitemap, the other is a site that would not answer. Only the first is
 * something to state as fact.
 *
 * `partial` means URLs came back but a budget ran out, so the count is a floor rather than a total.
 */
export type SitemapStatus = 'found' | 'partial' | 'none' | 'unreachable' | 'skipped';

/** Where a discovered page came from, so the list can say why it is being offered. */
export type PageSource = 'sitemap' | 'crawl' | 'given';

export interface DiscoveredPage {
  url: string;
  /** "/contact", or "/" for the root. What the table shows. */
  path: string;
  source: PageSource;
  /**
   * Looks editorial: a blog post, a news item, a dated or category path.
   *
   * Marked rather than dropped. Which of these to scan is a judgement, and a list that had already
   * removed them could not be told apart from a site that has none. The caller can deselect them in
   * one action, having seen what it would remove.
   */
  blogLike?: boolean;
}

/** One sitemap file that was attempted, and what came of it. */
export interface SitemapRead {
  url: string;
  ok: boolean;
  /** URLs contributed by this file. For an index, the children it pointed at. */
  urls: number;
  /** Present when it could not be read. A 404 is reported as a clean absence, not an error. */
  error?: string;
}

export interface DiscoverResult {
  site: string;
  pages: DiscoveredPage[];
  /** How many pages were found before the MAX_DISCOVERED cap. */
  total: number;
  sitemapStatus: SitemapStatus;
  /** Every sitemap file attempted, in order. The audit trail for "why so few pages". */
  sitemapsRead: SitemapRead[];
  /** True when the list came from the link-crawl fallback rather than a sitemap. */
  viaCrawl: boolean;
  /** URLs the caller supplied that were refused, each with the reason. */
  rejected: { url: string; reason: string }[];
  note?: string;
}

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
};

/** The path a page is shown as. Query and hash are already gone by normalizeUrl. */
export function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return p || '/';
  } catch {
    return url;
  }
}

const toPage = (url: string, source: PageSource): DiscoveredPage => ({
  url,
  path: pathOf(url),
  source,
  ...(isBlogLike(url) ? { blogLike: true } : {}),
});

/** PURE: pull <loc> URLs out of a sitemap (or sitemapindex) XML body. */
export function parseSitemapLocs(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex/i.test(xml);
  const locs: string[] = [];
  let m: RegExpExecArray | null;
  LOC_RE.lastIndex = 0;
  while ((m = LOC_RE.exec(xml)) !== null) locs.push(m[1].trim());
  return { locs, isIndex };
}

/** PURE: same-site links from an HTML body (server-rendered <a href> only). */
export function extractLinks(html: string, pageUrl: string, base: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(html)) !== null) {
    const n = normalizeUrl(m[1], pageUrl);
    if (n && sameSite(n, base)) out.push(n);
  }
  return out;
}

/**
 * PURE: sitemap URLs named in a robots.txt body.
 *
 * Where the real sitemap usually is on a site that does not use the conventional path, so skipping
 * robots.txt is how a discovery reports "none" for a site that publishes one under another name.
 */
export function sitemapsInRobots(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * PURE: order pages so the ones worth tagging come first.
 *
 * Stable, and it adds and drops nothing: contact, pricing, demo and checkout lead, everything else
 * keeps sitemap order. It matters because the caller pre-ticks a bounded number of these, and raw
 * sitemap order on a content site is a thousand blog posts before /contact.
 *
 * The entry page is pinned to the top, ahead of even the form-likely ones. It scores zero on the
 * form heuristic and would sink below every /services page: on a real 226-page site it landed well
 * past the 25 that get pre-ticked. It is also where the footer email, phone and site-wide CTAs are,
 * which is why the crawl always scans it first, and a list that quietly dropped it would lose every
 * site-wide suggestion while looking complete.
 */
export function prioritize(urls: string[], entry?: string): string[] {
  const rest = urls
    .map((url, i) => ({ url, i, score: urlPriority(url) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.url)
    .filter((u) => u !== entry);
  return entry && urls.includes(entry) ? [entry, ...rest] : rest;
}

/**
 * A sitemap URL is NOT run through normalizeUrl.
 *
 * normalizeUrl drops anything matching the crawler's asset pattern, and that pattern includes .xml
 * because a crawl must not try to render one. Passing a sitemap through it returns null for every
 * sitemap on the internet, which would make this whole path silently find nothing.
 */
function validSitemapUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!urlAllowed(u.href, []).ok) return null;
    return u.href;
  } catch {
    return null;
  }
}

interface CollectState {
  out: Set<string>;
  reads: SitemapRead[];
  left: { n: number };
  /** Set when a fetch failed for a reason other than a clean 404, so absence is not established. */
  unreachable: boolean;
}

async function collectSitemap(sitemapUrl: string, base: string, st: CollectState, depth = 0): Promise<void> {
  if (depth > 2 || st.out.size >= MAX_DISCOVERED || st.left.n <= 0) return;
  st.left.n -= 1;

  let body = '';
  try {
    const r = await safeFetch(sitemapUrl, 12_000, 'application/xml,text/xml,*/*');
    // A 404 is a clean "not here" and says nothing is wrong. Anything else (429, 5xx, an empty body
    // on a 200) means we did not get to LOOK, which must not be reported as "no sitemap".
    if (r.status >= 400 || !r.body) {
      if (r.status !== 404) st.unreachable = true;
      st.reads.push({
        url: sitemapUrl,
        ok: false,
        urls: 0,
        error: r.status >= 400 ? `HTTP ${r.status}` : 'empty response',
      });
      return;
    }
    body = r.body;
  } catch (err) {
    st.unreachable = true;
    st.reads.push({
      url: sitemapUrl,
      ok: false,
      urls: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return;
  }

  const { locs, isIndex } = parseSitemapLocs(body);
  if (isIndex) {
    const children = locs
      .map((loc) => validSitemapUrl(loc, base))
      // Never let a sitemapindex point our fetch at another host.
      .filter((u): u is string => Boolean(u) && sameSite(u as string, base));
    st.reads.push({ url: sitemapUrl, ok: true, urls: children.length });
    for (const child of children) {
      if (st.out.size >= MAX_DISCOVERED || st.left.n <= 0) break;
      await collectSitemap(child, base, st, depth + 1);
    }
    return;
  }

  let added = 0;
  for (const loc of locs) {
    const n = normalizeUrl(loc, base);
    if (n && sameSite(n, base) && st.out.size < MAX_DISCOVERED && !st.out.has(n)) {
      st.out.add(n);
      added += 1;
    }
  }
  st.reads.push({ url: sitemapUrl, ok: true, urls: added });
}

/** The conventional locations, plus whatever robots.txt names. */
async function sitemapCandidates(start: string, st: CollectState): Promise<string[]> {
  const origin = originOf(start);
  if (!origin) return [];
  const candidates = new Set<string>([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  try {
    const robots = await safeFetch(`${origin}/robots.txt`, 8_000, 'text/plain,*/*');
    if (robots.status < 400 && robots.body) {
      for (const raw of sitemapsInRobots(robots.body)) {
        const u = validSitemapUrl(raw, start);
        if (u) candidates.add(u);
      }
    }
  } catch {
    // robots.txt is optional, so its absence proves nothing. A FAILURE is still a hint that the host
    // is refusing us rather than that it publishes nothing.
    st.unreachable = true;
  }
  return [...candidates];
}

/**
 * Fallback when no sitemap answers: a fast link-crawl over server-rendered <a href>.
 *
 * No browser, so it sees only what the HTML ships with. That is a real limit and it is why the
 * result says which path it came from: on a client-rendered site this finds the shell and little
 * else, and the honest response to that is to let the user paste URLs rather than to pretend.
 */
async function discoverViaCrawl(start: string): Promise<string[]> {
  const visited = new Set<string>();
  const found = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0 && visited.size < MAX_CRAWL) {
    const url = queue.shift() as string;
    const key = url.replace(/\/$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const r = await safeFetch(url, 10_000);
      if (r.status >= 400 || !r.body) continue;
      for (const n of extractLinks(r.body, url, start)) {
        if (!found.has(n)) {
          found.add(n);
          if (queue.length + visited.size < MAX_DISCOVERED) queue.push(n);
        }
      }
    } catch {
      continue;
    }
  }
  return [...found].slice(0, MAX_DISCOVERED);
}

export interface DiscoverOptions {
  /**
   * Read exactly these sitemaps instead of looking for them.
   *
   * For the site that keeps its sitemap somewhere robots.txt does not name, and for the site whose
   * index is too large to walk inside the file budget: naming the two sub-sitemaps that matter gets
   * a complete list where auto-discovery gets a truncated one.
   */
  sitemaps?: string[];
  /** Skip sitemaps entirely and link-crawl. */
  crawlOnly?: boolean;
}

/**
 * Enumerate the pages of a site.
 *
 * Same-site throughout: a sitemap entry, a robots.txt entry and a sub-sitemap pointing at another
 * host are all dropped. Without that this is a tool for fetching arbitrary URLs through the
 * server, which is not what it is for.
 */
export async function discoverSitePages(startUrl: string, options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const rejected: { url: string; reason: string }[] = [];
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) {
    return {
      site: startUrl,
      pages: [],
      total: 0,
      sitemapStatus: 'none',
      sitemapsRead: [],
      viaCrawl: false,
      rejected: [{ url: startUrl, reason: 'Not a valid http(s) URL.' }],
      note: 'That is not a URL this can read.',
    };
  }

  const st: CollectState = { out: new Set(), reads: [], left: { n: MAX_SITEMAPS }, unreachable: false };

  if (!options.crawlOnly) {
    let candidates: string[];
    if (options.sitemaps?.length) {
      candidates = [];
      for (const raw of options.sitemaps) {
        const u = validSitemapUrl(raw.trim(), start);
        if (!u) rejected.push({ url: raw, reason: 'Not a valid http(s) URL, or blocked by the URL guard.' });
        else if (!sameSite(u, start)) {
          rejected.push({ url: raw, reason: 'Not on the same site as the URL being scanned.' });
        } else candidates.push(u);
      }
    } else {
      candidates = await sitemapCandidates(start, st);
    }

    for (const sm of candidates) {
      if (st.out.size >= MAX_DISCOVERED || st.left.n <= 0) break;
      await collectSitemap(sm, start, st);
    }
  }

  const budgetHit = st.left.n <= 0;

  if (st.out.size > 0) {
    const urls = st.out.has(start) ? [...st.out] : [start, ...st.out];
    const ordered = prioritize(urls, start).slice(0, MAX_DISCOVERED);
    return {
      site: start,
      pages: ordered.map((url) => toPage(url, 'sitemap')),
      total: Math.min(urls.length, MAX_DISCOVERED),
      sitemapStatus: budgetHit || st.unreachable ? 'partial' : 'found',
      sitemapsRead: st.reads,
      viaCrawl: false,
      rejected,
      ...(budgetHit || st.unreachable
        ? {
            note: budgetHit
              ? `Stopped after ${MAX_SITEMAPS} sitemap files, so this is a floor rather than the whole site. Name the sitemaps you care about to read them directly.`
              : 'At least one sitemap could not be read, so this list may be incomplete.',
          }
        : {}),
    };
  }

  const crawled = await discoverViaCrawl(start);
  const status: SitemapStatus = options.crawlOnly ? 'skipped' : st.unreachable ? 'unreachable' : 'none';
  return {
    site: start,
    pages: prioritize(crawled, start).map((url) => toPage(url, 'crawl')),
    total: crawled.length,
    sitemapStatus: status,
    sitemapsRead: st.reads,
    viaCrawl: true,
    rejected,
    note:
      status === 'unreachable'
        ? 'The sitemap could not be read (the site refused or timed out), so this is NOT a site without one. These pages come from a quick link-crawl; try again in a moment, or name the sitemap directly.'
        : status === 'skipped'
          ? 'Sitemaps were skipped, so these pages come from a link-crawl of server-rendered links.'
          : crawled.length >= MAX_CRAWL
            ? `No sitemap found. Link-crawl stopped at ${MAX_CRAWL} pages.`
            : 'No sitemap found. These pages come from a link-crawl, which sees only server-rendered links, so a client-rendered site will look smaller than it is.',
  };
}
