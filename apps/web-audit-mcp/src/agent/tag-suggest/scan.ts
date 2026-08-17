// Phase 3: the orchestrator that turns a live URL into a "measurement plan" —
// the GA4 event tags worth creating in GTM. It wires the existing same-site
// crawler + the Phase-2 element collector + the forms scanner into the Phase-1
// pure engine:
//
//   crawlSite → (per page) collectPageRaw + scanForms → buildSuggestInput →
//   buildSuggestions → TagSuggestionReport
//
// READ-ONLY. The only page interaction is page.goto + read-only DOM evaluate
// (collectPageRaw / scanForms). It never clicks or submits anything — the
// web-audit server's sole permitted interaction (consent banners) is not used
// here. Each emitted suggestion is already the exact shape the GTM MCP's
// create_gtm_tracking_tag tool accepts, so it drops straight into that
// draft-only, approval-gated create flow (Phase 3's desktop one-click create).
//
// The report-building (pagePath / toPageScan / assembleTagReport) is pure and
// unit-tested without a browser; scanSiteForTagSuggestions is the thin browser
// glue, mirroring compliance.ts (crawl, then re-open a ranked page subset).

import { loadPlaywright, PlaywrightMissingError, openInstrumentedPage } from '../browser.js';
import { crawlSite, normalizeUrl, sameSite, type CrawledPage } from '../crawler.js';
import { scanForms } from '../forms.js';
import { loadConfig, clampOpt } from '../../utils/config.js';
import { urlAllowed } from '../../utils/urlGuard.js';
import {
  collectPageRaw,
  classifyPageElements,
  buildSuggestInput,
  type PageScan,
  type PageScanRaw,
} from './collect.js';
import { buildSuggestions } from './suggest.js';
import { BLOG_RE } from './blog-paths.js';
import { detectExistingTracking, type ExistingTracking } from './existing-tracking.js';
import type { SuggestedTag, FormPurpose, SuggestPlatform } from './types.js';

/** A page that was discovered but not turned into suggestions, with the reason. */
export interface NotScanned {
  url: string;
  reason: string;
}

export interface TagSuggestionReport {
  /** The (normalized) start URL. */
  site: string;
  siteHost: string;
  scannedAt: string;
  summary: {
    pagesCrawled: number;
    pagesScanned: number;
    formsFound: number;
    trackableElements: number;
    suggestions: number;
    byConfidence: { high: number; medium: number; low: number };
    /** Count GA4 Enhanced Measurement already auto-tracks (flagged, not new work). */
    enhancedMeasurementOverlap: number;
    /** Suggestions that fill a real gap (no EM overlap). */
    newTracking: number;
  };
  /** Ranked, deduped GA4 event tags — each directly creatable via create_gtm_tracking_tag. */
  suggestions: SuggestedTag[];
  /** What tracking the site ALREADY ships (GTM/GA4/Ads/Meta/TikTok/LinkedIn + its own dataLayer events
   *  + JS framework), harvested during the scan. Optional so existing callers are unaffected. */
  existingTracking?: ExistingTracking;
  /** What was detected per scanned page (path → counts). */
  pages: { page: string; forms: number; elements: number }[];
  /** Discovered but not scanned: over budget, crawler-skipped, or nav failure. */
  notScanned: NotScanned[];
  notes: string[];
  /** Present only when the caller passed debug:true — see SuggestDebug. */
  debug?: SuggestDebug;
  /** Present only when the caller passed captureImages:true. One entry per page actually captured. */
  pageImages?: PageImage[];
  /** Links the skip filter dropped before they could spend the page budget. */
  excluded?: number;
}

/**
 * Diagnostics for troubleshooting a scan (opt-in via debug:true). Surfaces the
 * browser console/page errors captured across the scanned pages (which the
 * normal report drops) plus the effective run mode. Purely additive — the scan
 * stays read-only and never interacts with the page.
 */
export interface SuggestDebug {
  /** Chromium launch mode (set WEB_AUDIT_HEADED=true to watch a run). */
  headless: boolean;
  navTimeoutMs: number;
  settleMs: number;
  /** Console errors observed across all scanned pages. */
  consoleErrors: string[];
  /** Uncaught page errors observed across all scanned pages. */
  pageErrors: string[];
}

/* ── PURE report building (unit-tested, no browser) ── */

/** A crawled URL → its page path ("/contact", "/" for root). Query/hash dropped
 *  so query-variants of the same page collapse to one suggestion. */
export function pagePath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

/** One raw page scan → the engine's PageScan (path stamped, elements classified). */
export function toPageScan(
  url: string,
  raw: PageScanRaw,
  forms: PageScan['forms'],
  siteHost: string,
): PageScan {
  const page = pagePath(url);
  return {
    page,
    elements: classifyPageElements(raw.elements, siteHost, page),
    forms,
    signals: raw.signals,
  };
}

export interface AssembleArgs {
  site: string;
  siteHost: string;
  scannedAt: string;
  pagesCrawled: number;
  pageScans: PageScan[];
  notScanned: NotScanned[];
  notes: string[];
  debug?: SuggestDebug;
  /** Links the skip filter dropped. */
  excluded?: number;
  /** Ad platforms to build tags for. Omitted means GA4 only, which is what every caller got
   *  before the option was reachable from a tool call. */
  platforms?: SuggestPlatform[];
  /** Screenshots of the scanned pages, when the caller asked for them. */
  pageImages?: PageImage[];
}

/** A rectangle in full-page-screenshot coordinates. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Find the thing on the page each suggestion is about, so it can be shown ringed.
 *
 * Matched AFTER the fact rather than threaded through the engine. A suggestion is built at eight
 * places in a two-thousand-line file, several of them from a GROUP of elements rather than one, and
 * editing all of them to carry a rectangle would risk the scan itself for a picture.
 *
 * The rule that keeps it honest: a rect is attached only when exactly ONE candidate matches. A ring
 * drawn around the wrong button is worse than no ring, because someone will believe it. Ambiguity,
 * a site-wide suggestion (it belongs to no single page), or a source with no measurement all mean
 * no highlight, and the picture is still shown unmarked.
 */
export function attachRects(suggestions: SuggestedTag[], pageScans: PageScan[]): SuggestedTag[] {
  const byPage = new Map(pageScans.map((p) => [p.page, p]));

  return suggestions.map((s) => {
    const t = s.trigger as Record<string, unknown>;
    // A site-wide suggestion belongs to no one page, so no page is THE page. It is still worth
    // showing: an email link in a footer is the same link everywhere, and seeing it once answers
    // "which link is this". The first page carrying exactly one match becomes the example, and the
    // suggestion records WHICH page that was, so nothing implies it is the only one.
    const candidates = s.page === 'site-wide' ? pageScans : ([byPage.get(s.page)].filter(Boolean) as PageScan[]);
    if (candidates.length === 0) return s;

    for (const scan of candidates) {
      const found = rectIn(scan, t);
      if (found) {
        return {
          ...s,
          rect: found,
          ...(s.page === 'site-wide' ? { proofPage: scan.page } : {}),
        } as SuggestedTag;
      }
    }
    return s;
  });
}

/** The one element or form on this page that a trigger points at, or nothing when it is not one. */
function rectIn(scan: PageScan, t: Record<string, unknown>): Rect | undefined {
  {
    const only = <T>(list: T[]): T | undefined => (list.length === 1 ? list[0] : undefined);

    let rect: Rect | undefined;

    if (t.kind === 'form_submit' || (t.kind === 'custom_event' && scan.forms.length > 0)) {
      const id = String(t.formIdValue ?? '').trim();
      const withRect = scan.forms.filter((f) => f.rect);
      const matched = id ? withRect.filter((f) => f.formId === id) : withRect;
      rect = only(matched)?.rect;
    }

    if (!rect) {
      const url = String(t.clickUrlValue ?? '').trim().toLowerCase();
      const text = String(t.clickTextValue ?? '').trim().toLowerCase();
      const elementId = String(t.clickIdValue ?? '').trim();
      const withRect = scan.elements.filter((e) => e.rect);

      // An id is the strongest signal there is: the author chose it, and it is unique by definition.
      if (elementId) rect = only(withRect.filter((e) => e.elementId === elementId))?.rect;
      // Then the exact label, which is how a CTA trigger is scoped.
      if (!rect && text) rect = only(withRect.filter((e) => (e.text ?? '').trim().toLowerCase() === text))?.rect;
      // Then the href. mailto:/tel: values are prefixes, so this is a startsWith rather than equals,
      // and a page with two different mailto links correctly matches neither.
      if (!rect && url) {
        rect = only(withRect.filter((e) => (e.href ?? '').toLowerCase().startsWith(url)))?.rect;
      }
    }

    return rect;
  }
}

/** Combine per-page scans → SuggestInput → ranked suggestions → the report. Pure. */
export function assembleTagReport(args: AssembleArgs): TagSuggestionReport {
  const input = buildSuggestInput(args.pageScans, args.siteHost);
  const suggestions = attachRects(
    buildSuggestions(input, args.platforms ? { platforms: args.platforms } : {}),
    args.pageScans,
  );

  const byConfidence = { high: 0, medium: 0, low: 0 };
  let em = 0;
  for (const s of suggestions) {
    byConfidence[s.confidence] += 1;
    if (s.enhancedMeasurementOverlap) em += 1;
  }

  return {
    site: args.site,
    siteHost: args.siteHost,
    scannedAt: args.scannedAt,
    summary: {
      pagesCrawled: args.pagesCrawled,
      pagesScanned: args.pageScans.length,
      formsFound: input.forms.length,
      trackableElements: input.elements.length,
      suggestions: suggestions.length,
      byConfidence,
      enhancedMeasurementOverlap: em,
      newTracking: suggestions.length - em,
    },
    suggestions,
    existingTracking: detectExistingTracking(args.pageScans),
    pages: args.pageScans.map((p) => ({ page: p.page, forms: p.forms.length, elements: p.elements.length })),
    notScanned: args.notScanned,
    notes: args.notes,
    ...(args.debug ? { debug: args.debug } : {}),
    ...(args.pageImages?.length ? { pageImages: args.pageImages } : {}),
    ...(args.excluded ? { excluded: args.excluded } : {}),
  };
}

/** Account for every discovered page that did NOT become a suggestion, with an
 *  accurate reason. Pure: keeps the labelling testable without a browser. The
 *  precedence (collect-failure → crawl note → HTTP error → over-budget → SSRF
 *  skip) guarantees each page is listed exactly once. */
export function accountNotScanned(
  crawlPages: Array<{ url: string; note?: string; httpStatus: number | null }>,
  crawlSkipped: NotScanned[],
  scannedTargetUrls: Set<string>,
  collectFailures: NotScanned[],
): NotScanned[] {
  const out: NotScanned[] = [...collectFailures];
  for (const p of crawlPages) {
    if (p.note) out.push({ url: p.url, reason: p.note });
    else if (p.httpStatus !== null && p.httpStatus >= 400) out.push({ url: p.url, reason: `http ${p.httpStatus}` });
    else if (!scannedTargetUrls.has(p.url)) out.push({ url: p.url, reason: 'over scan budget' });
    // else: it was scanned (or failed in the collect loop and is already in collectFailures).
  }
  out.push(...crawlSkipped);
  return out;
}

const CREATE_NOTE =
  'Each suggestion is a ready-to-create GA4 event tag in the tag-payload shape the GTM MCP ' +
  'create_gtm_tracking_tag tool accepts (you supply accountId/containerId/workspaceId at create ' +
  'time; creation is draft-only and approval-gated). measurementId defaults to the ' +
  '{{GA4 Measurement ID}} variable — ensure that constant variable exists in the target container ' +
  '(or replace it with the property\'s G-XXXX id) before creating, or the tag will be inert. ' +
  'Suggestions with enhancedMeasurementOverlap:true are ALREADY auto-tracked by GA4 Enhanced ' +
  'Measurement — create them only if you want the event explicitly modelled in GTM.';

/* ── Browser orchestration ── */

export interface TagSuggestOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Crawled pages to deep-scan for tags (default = pages crawled, cap 25). */
  scanPages?: number;
  /** Include a SuggestDebug block (browser console/page errors + run mode) for troubleshooting. */
  debug?: boolean;
  /**
   * Which ad platforms to build tags for (default ['ga4']).
   *
   * buildSuggestions has taken this since it was written; the option simply had no way in from a
   * tool call, so every caller through MCP got GA4 only. The extra platforms derive from the GA4
   * suggestions and share one trigger per detection, so asking for three platforms costs no extra
   * crawling.
   */
  platforms?: SuggestPlatform[];
  /**
   * Capture a screenshot of each scanned page, returned as base64 JPEG in `pageImages`.
   *
   * OFF by default, and that default is load-bearing rather than cautious: this tool is callable
   * from chat, where the result is text a model reads. A ten-page scan is several megabytes of
   * base64, which would blow a context window to no purpose. Only a caller that can display an
   * image should ask for one.
   */
  captureImages?: boolean;
  /**
   * Do not follow blog, news and article pages.
   *
   * A content site can hold hundreds of posts that are structurally identical, and they eat the page
   * budget before the crawl reaches the pages worth tagging: contact, pricing, demo, checkout. The
   * posts also produce near-duplicate suggestions (the same share and social links on every one).
   */
  skipBlog?: boolean;
  /** Extra path fragments to skip, matched case-insensitively against the URL. */
  skipPatterns?: string[];
  /**
   * Scan exactly these pages, and do not crawl.
   *
   * The crawl picks pages by its own ranking, which is a guess: on a content site the budget goes to
   * whatever it reached first, and the pages worth tagging can be the ones it never opened. Given a
   * list, the caller has already chosen (normally from discoverSitePages), so crawling again to
   * re-derive a worse answer would be pure cost.
   *
   * Every entry must be same-site with the start URL and pass the URL guard. Anything else is
   * dropped and reported, because a scanner that fetches whatever URL it is handed is a different
   * and much less safe tool than this one.
   */
  pages?: string[];
}

export interface PageListResult {
  /** Pages to open, in the order the caller gave them, capped at the scan budget. */
  targets: Array<{ url: string }>;
  /** Pages that were named and will not be scanned, each with the reason to show. */
  rejected: NotScanned[];
}

/**
 * Turn a caller-supplied page list into scan targets.
 *
 * PURE, and separate from the scan for exactly that reason: this is the check that stops the
 * scanner from being a general-purpose URL fetcher, and it should be provable without a browser.
 *
 * Three refusals, all reported rather than silently dropped:
 *   - not a URL this can open (a mailto:, a fragment, an asset)
 *   - not on the same site as the URL being scanned
 *   - blocked by the URL guard (a private address, a metadata endpoint)
 *
 * The order given is kept. The caller ticked these in a list they were looking at, and the pages
 * beyond the budget are the ones at the bottom of that list, which is the only cut that matches
 * what they saw.
 */
export function resolvePageList(
  startUrl: string,
  pages: string[],
  cap: number,
  allowlist: string[] = [],
): PageListResult {
  const targets: Array<{ url: string }> = [];
  const rejected: NotScanned[] = [];
  const seen = new Set<string>();

  for (const raw of pages) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    const normalized = normalizeUrl(trimmed, startUrl);
    if (!normalized) {
      rejected.push({ url: trimmed, reason: 'not a page URL this can open' });
      continue;
    }
    if (!sameSite(normalized, startUrl)) {
      rejected.push({ url: trimmed, reason: 'not on the same site as the URL being scanned' });
      continue;
    }
    const verdict = urlAllowed(normalized, allowlist);
    if (!verdict.ok) {
      rejected.push({ url: trimmed, reason: verdict.reason });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (targets.length >= cap) {
      // Named, not silently trimmed. "I ticked 40 and got 25" is only answerable if the 15 say so.
      rejected.push({ url: normalized, reason: `over the ${cap}-page scan budget` });
      continue;
    }
    targets.push({ url: normalized });
  }
  return { targets, rejected };
}

/** Build the crawl's exclude predicate. Returns undefined when nothing is being excluded, so the
 *  crawler keeps its original behaviour rather than calling a filter that always says no. */
export function buildExclude(opts: { skipBlog?: boolean; skipPatterns?: string[] }): ((url: string) => boolean) | undefined {
  const patterns = (opts.skipPatterns ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!opts.skipBlog && patterns.length === 0) return undefined;
  return (url: string): boolean => {
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* not parseable: match against the whole string rather than admitting it blindly */
    }
    if (opts.skipBlog && BLOG_RE.test(pathname)) return true;
    const lower = pathname.toLowerCase();
    return patterns.some((p) => lower.includes(p));
  };
}

/** A scanned page's screenshot. `image` is base64 JPEG with no data: prefix. */
export interface PageImage {
  page: string;
  image: string;
  bytes: number;
}

/** Per-image ceiling. A long marketing page can screenshot to several megabytes, and past this the
 *  proof is not worth what it costs to move through stdio and hold in memory. */
/**
 * How many pages are scanned at once.
 *
 * Four, not more: each worker is a browser context with a live page, and the cost is memory on the
 * machine running the scanner rather than anything the site notices.
 *
 * Measured on a real site, eight pages with screenshots: 45s sequential, 23s across four workers,
 * same 20 suggestions and the same 8 images. Not the 4x the worker count suggests, because the
 * crawl that precedes this is still sequential and a cold browser start is paid once either way.
 * About 3s per page in practice, so a 200-page scan is roughly ten minutes rather than nineteen.
 */
export const SCAN_CONCURRENCY = 4;

const MAX_IMAGE_BYTES = 1_500_000;
/** Whole-scan ceiling, so a 25-page scan cannot pin tens of megabytes in the orchestrator. */
// Sized for the 200-page ceiling at the ~200KB a full-page JPEG actually measures. Still a cap:
// past it the scan continues WITHOUT pictures rather than growing without bound, and the rows say
// so by having no proof to open.
const MAX_TOTAL_IMAGE_BYTES = 45_000_000;

/**
 * Crawl a site and suggest the GA4 event tags worth creating. Throws
 * PlaywrightMissingError if no browser is installed; rejects the start URL via
 * the SSRF guard before launching. Read-only throughout.
 */
export async function scanSiteForTagSuggestions(
  startUrl: string,
  options: TagSuggestOptions = {},
): Promise<TagSuggestionReport> {
  const config = loadConfig();
  const verdict = urlAllowed(startUrl, config.allowlist);
  if (!verdict.ok) throw new Error(`start URL rejected: ${verdict.reason}`);

  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightMissingError();

  const maxPages = clampOpt(options.maxPages, config.maxPages, config.maxPagesCap);
  const maxDepth = clampOpt(options.maxDepth, config.maxDepth, config.maxDepthCap);
  const scanPages = clampOpt(options.scanPages, maxPages, config.maxPagesCap);
  // Element presence only needs the DOM rendered; the operator's settle time is
  // tuned for tags firing (longer), so cap it here to keep per-page cost bounded.
  const settleMs = Math.min(config.settleMs, 3_000);

  let siteHost = '';
  try {
    siteHost = new URL(startUrl).hostname;
  } catch {
    /* admit()/urlAllowed already validated the URL upstream */
  }

  const collectFailures: NotScanned[] = [];
  // Chosen pages skip the crawl entirely. Resolved BEFORE the browser launches so a list that is
  // entirely off-site fails in milliseconds instead of after a Chromium start.
  const chosen = options.pages?.length
    ? resolvePageList(startUrl, options.pages, scanPages, config.allowlist)
    : null;
  if (chosen && chosen.targets.length === 0) {
    throw new Error(
      `none of the ${options.pages?.length ?? 0} page(s) given could be scanned: ` +
        `${chosen.rejected.map((r) => `${r.url} (${r.reason})`).join('; ')}`,
    );
  }

  const browser = await pw.chromium.launch({ headless: config.headless });
  try {
    const exclude = buildExclude(options);
    const crawl = chosen
      ? { startUrl, pages: [] as CrawledPage[], skipped: [] as NotScanned[], discovered: [] as string[] }
      : await crawlSite(browser, startUrl, {
          maxPages,
          maxDepth,
          navTimeoutMs: config.navTimeoutMs,
          allowlist: config.allowlist,
          ...(exclude ? { exclude } : {}),
        });
    try {
      siteHost = new URL(crawl.startUrl).hostname;
    } catch {
      /* keep the start-URL host */
    }

    // Always scan the entry page (footer mailto/tel/CTAs live there), then the
    // most form-heavy pages first so a small scan budget still hits the rich ones.
    //
    // Neither applies to a chosen list: the caller already decided which pages and in what order,
    // and re-ranking their choice would quietly scan a different set than the one they ticked.
    const okPages = crawl.pages.filter((p) => !p.note && p.httpStatus !== null && p.httpStatus < 400);
    const ranked = [...okPages].sort((a, b) => b.formsCount - a.formsCount || a.depth - b.depth);
    const ordered = okPages[0] ? [okPages[0], ...ranked] : ranked;
    const seenUrls = new Set<string>();
    const crawled: typeof okPages = [];
    for (const p of ordered) {
      if (seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      crawled.push(p);
      if (crawled.length >= scanPages) break;
    }
    const targets: Array<{ url: string }> = chosen ? chosen.targets : crawled;

    /**
     * Scan the pages in PARALLEL, across a small pool of independent browser contexts.
     *
     * Measured on the built scanner: about six seconds per page sequentially, nearly all of it
     * waiting - a navigation, a settle, and a full-page screenshot. That is 19 minutes for 200
     * pages, past the orchestrator's scan timeout and past nginx's read timeout, so the higher page
     * budgets would have produced a feature that always times out.
     *
     * A context per worker, not a page per worker. Contexts are isolated, so one page's dialogs,
     * storage or a hung script cannot stall another's, and a crash takes one worker down instead of
     * the run.
     *
     * The queue is claimed with a synchronous index increment. No await between reading `next` and
     * incrementing it, so two workers can never take the same page: that exactly-once property is
     * the whole correctness argument here, and an await in the middle would quietly break it.
     */
    const pageScans: PageScan[] = [];
    const pageImages: PageImage[] = [];
    let totalImageBytes = 0;
    let debugData: SuggestDebug | undefined;
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    let next = 0;
    const claim = (): { url: string } | undefined => (next < targets.length ? targets[next++] : undefined);
    const workerCount = Math.max(1, Math.min(SCAN_CONCURRENCY, targets.length));

    const worker = async (): Promise<void> => {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      try {
        const inst = await openInstrumentedPage(context);
        const page = inst.page;
        for (let target = claim(); target; target = claim()) {
          try {
            inst.markNavigationStart();
            await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
            await page.waitForTimeout(settleMs);
            const raw = await collectPageRaw(page);
            const forms = await scanForms(page, page.url());
            if (options.captureImages && totalImageBytes < MAX_TOTAL_IMAGE_BYTES) {
              // After the collect, never before: the screenshot must show the page the suggestions
              // were read from, including anything the settle time brought in.
              //
              // A capture failure is swallowed on purpose. A screenshot is supporting evidence, and
              // losing the scan of a page because its picture did not take would be the wrong trade.
              try {
                const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 });
                if (shot.byteLength <= MAX_IMAGE_BYTES) {
                  totalImageBytes += shot.byteLength;
                  pageImages.push({
                    page: pagePath(target.url),
                    image: shot.toString('base64'),
                    bytes: shot.byteLength,
                  });
                }
              } catch {
                /* no proof for this page; the suggestions from it still stand */
              }
            }
            pageScans.push(
              toPageScan(target.url, raw, forms.map((f) => ({ purpose: f.purpose, action: f.action, method: f.method, formId: f.formId, providerFormId: f.providerFormId, formClasses: f.formClasses, title: f.title, fields: f.fields.map((x) => ({ type: x.type, name: x.name, required: x.required })), hidden: f.hidden, rect: f.rect })), siteHost),
            );
          } catch (err) {
            collectFailures.push({
              url: target.url,
              reason: `scan failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
            });
          }
        }
        // Merged rather than taken from one worker, or the debug block would report the console
        // errors of whichever context happened to finish last.
        consoleErrors.push(...inst.consoleErrors);
        pageErrors.push(...inst.pageErrors);
      } finally {
        await context.close();
      }
    };

    // A worker that dies must not take the run with it: the pages it did not reach are still in the
    // queue for the others, and its failure is recorded like any other.
    const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    for (const r of results) {
      if (r.status === 'rejected') {
        collectFailures.push({
          url: startUrl,
          reason: `scan worker failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`.slice(0, 200),
        });
      }
    }

    if (options.debug) {
      debugData = {
        headless: config.headless,
        navTimeoutMs: config.navTimeoutMs,
        settleMs,
        consoleErrors,
        pageErrors,
      };
    }

    const scannedTargetUrls = new Set(targets.map((t) => t.url));
    const notScanned = accountNotScanned(
      crawl.pages,
      // A page the caller named and this refused belongs in the same list as one the crawl skipped:
      // it is a page that was expected in the result and is not there.
      [...crawl.skipped, ...(chosen?.rejected ?? [])],
      scannedTargetUrls,
      collectFailures,
    );

    return assembleTagReport({
      site: crawl.startUrl || startUrl,
      siteHost,
      scannedAt: new Date().toISOString(),
      // With a chosen list there is no crawl, so this is the number of pages asked for rather than
      // zero. Reporting zero would make a working scan look like it opened nothing.
      pagesCrawled: chosen ? targets.length : crawl.pages.length,
      pageScans,
      notScanned,
      notes: [CREATE_NOTE],
      ...(debugData ? { debug: debugData } : {}),
      ...(options.platforms?.length ? { platforms: options.platforms } : {}),
      ...(pageImages.length ? { pageImages } : {}),
      ...(crawl.excluded ? { excluded: crawl.excluded } : {}),
    });
  } finally {
    await browser.close();
  }
}
