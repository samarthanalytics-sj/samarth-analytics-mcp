/**
 * Same-site BFS crawler. Discovers pages from the start URL, staying on the
 * same site (host or its subdomains), bounded by maxPages/maxDepth and the
 * SSRF guard. Pages likely to contain forms (contact, signup, checkout…) are
 * prioritised so small page budgets still find the interesting surfaces.
 */

import type { PwBrowser } from './browser.js';
import { openInstrumentedPage } from './browser.js';
import { urlAllowed } from '../utils/urlGuard.js';

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  navTimeoutMs: number;
  allowlist: string[];
  /**
   * Return true for a URL the crawl should not follow.
   *
   * Applied where links are DISCOVERED, not where pages are chosen afterwards, because the page
   * budget is spent by the crawl itself: filtering later would let 200 blog posts eat a 25-page
   * budget and leave the pages someone actually wants to tag unvisited.
   *
   * Never applied to the start URL. A filter that excluded the page the user typed would return an
   * empty scan and look like a broken site.
   */
  exclude?: (url: string) => boolean;
}

export interface CrawledPage {
  url: string;
  finalUrl: string | null;
  title: string;
  httpStatus: number | null;
  depth: number;
  formsCount: number;
  linksFound: number;
  cmpHint: boolean;
  note?: string;
}

export interface CrawlResult {
  startUrl: string;
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
  /** All unique same-site URLs discovered (also beyond the page budget). */
  discovered: string[];
  /** How many discovered links the exclude filter dropped. Counted rather than listed: a blog can
   *  hold hundreds of posts and the number is the useful part, not the URLs. */
  excluded?: number;
}

const ASSET_RE = /\.(pdf|jpe?g|png|gif|svg|webp|avif|css|js|mjs|ico|zip|gz|rar|mp3|mp4|webm|mov|woff2?|ttf|eot|xml|rss|json)([?#]|$)/i;
const FORMY_RE = /contact|kontakt|signup|sign-up|register|registr|subscribe|newsletter|demo|quote|enquir|inquir|checkout|cart|book|apply|career|job|support|feedback|account|login|audit|consult|estimate|proposal|get-?started|onboard|free-trial|trial|pricing|solution|service|partner|get-in-touch|reach-us|schedule|appointment|callback/i;

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

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

/** Higher score = crawled earlier within the same depth. */
export function urlPriority(url: string): number {
  return FORMY_RE.test(url) ? 1 : 0;
}

interface PageScan {
  title: string;
  links: string[];
  formsCount: number;
  cmpHint: boolean;
}

function scanPageInBrowser(): PageScan {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = new URL(href, location.href).href;
      if (!seen.has(abs) && links.length < 150) {
        seen.add(abs);
        links.push(abs);
      }
    } catch {
      // unparseable href
    }
  }
  const cmpHint = Boolean(
    document.querySelector(
      '#onetrust-banner-sdk, #CybotCookiebotDialog, #usercentrics-root, #didomi-host, #qc-cmp2-container, ' +
        '#truste-consent-track, .cmplz-cookiebanner, .cky-consent-container, #iubenda-cs-banner, .osano-cm-window, ' +
        '#cmpbox, #BorlabsCookieBox, [class*="cookie-banner"], [id*="cookie-banner"], [class*="cookieconsent"], [id*="cookieconsent"]',
    ),
  );
  return {
    title: (document.title || '').slice(0, 200),
    links,
    formsCount: document.querySelectorAll('form').length,
    cmpHint,
  };
}

export async function crawlSite(
  browser: PwBrowser,
  startUrl: string,
  opts: CrawlOptions,
): Promise<CrawlResult> {
  const pages: CrawledPage[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const queue: { url: string; depth: number }[] = [];

  const start = normalizeUrl(startUrl, startUrl);
  let excludedCount = 0;
  if (!start) return { startUrl, pages, skipped: [{ url: startUrl, reason: 'not a crawlable URL' }], discovered: [] };
  queue.push({ url: start, depth: 0 });
  discovered.add(start);

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  try {
    const inst = await openInstrumentedPage(context);
    const page = inst.page;

    while (queue.length > 0 && pages.length < opts.maxPages) {
      // BFS by depth, form-looking URLs first within a depth level.
      queue.sort((a, b) => a.depth - b.depth || urlPriority(b.url) - urlPriority(a.url));
      const { url, depth } = queue.shift()!;
      const dedupeKey = url.replace(/\/$/, '');
      if (visited.has(dedupeKey)) continue;
      visited.add(dedupeKey);

      const verdict = urlAllowed(url, opts.allowlist);
      if (!verdict.ok) {
        skipped.push({ url, reason: verdict.reason });
        continue;
      }

      let scan: PageScan = { title: '', links: [], formsCount: 0, cmpHint: false };
      let status: number | null = null;
      let note: string | undefined;
      try {
        inst.markNavigationStart();
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs });
        status = resp ? resp.status() : null;
        await page.waitForTimeout(500);
        scan = await page.evaluate<PageScan>(scanPageInBrowser);
      } catch (err) {
        note = `navigation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      }

      pages.push({
        url,
        finalUrl: note ? null : page.url(),
        title: scan.title,
        httpStatus: status,
        depth,
        formsCount: scan.formsCount,
        linksFound: scan.links.length,
        cmpHint: scan.cmpHint,
        ...(note ? { note } : {}),
      });

      if (depth < opts.maxDepth) {
        for (const raw of scan.links) {
          const normalized = normalizeUrl(raw, url);
          if (!normalized || !sameSite(normalized, start)) continue;
          const key = normalized.replace(/\/$/, '');
          if (visited.has(key) || discovered.has(normalized)) continue;
          discovered.add(normalized);
          if (opts.exclude?.(normalized)) {
            excludedCount += 1;
            continue;
          }
          queue.push({ url: normalized, depth: depth + 1 });
        }
      }
    }
  } finally {
    await context.close();
  }

  return { startUrl: start, pages, skipped, discovered: [...discovered], ...(excludedCount ? { excluded: excludedCount } : {}) };
}
