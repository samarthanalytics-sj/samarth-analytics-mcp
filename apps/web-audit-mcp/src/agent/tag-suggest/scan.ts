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
import { crawlSite } from '../crawler.js';
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
import type { SuggestedTag, FormPurpose } from './types.js';

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
  /** What was detected per scanned page (path → counts). */
  pages: { page: string; forms: number; elements: number }[];
  /** Discovered but not scanned: over budget, crawler-skipped, or nav failure. */
  notScanned: NotScanned[];
  notes: string[];
  /** Present only when the caller passed debug:true — see SuggestDebug. */
  debug?: SuggestDebug;
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
}

/** Combine per-page scans → SuggestInput → ranked suggestions → the report. Pure. */
export function assembleTagReport(args: AssembleArgs): TagSuggestionReport {
  const input = buildSuggestInput(args.pageScans, args.siteHost);
  const suggestions = buildSuggestions(input);

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
    pages: args.pageScans.map((p) => ({ page: p.page, forms: p.forms.length, elements: p.elements.length })),
    notScanned: args.notScanned,
    notes: args.notes,
    ...(args.debug ? { debug: args.debug } : {}),
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
}

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
  const browser = await pw.chromium.launch({ headless: config.headless });
  try {
    const crawl = await crawlSite(browser, startUrl, {
      maxPages,
      maxDepth,
      navTimeoutMs: config.navTimeoutMs,
      allowlist: config.allowlist,
    });
    try {
      siteHost = new URL(crawl.startUrl).hostname;
    } catch {
      /* keep the start-URL host */
    }

    // Always scan the entry page (footer mailto/tel/CTAs live there), then the
    // most form-heavy pages first so a small scan budget still hits the rich ones.
    const okPages = crawl.pages.filter((p) => !p.note && p.httpStatus !== null && p.httpStatus < 400);
    const ranked = [...okPages].sort((a, b) => b.formsCount - a.formsCount || a.depth - b.depth);
    const ordered = okPages[0] ? [okPages[0], ...ranked] : ranked;
    const seenUrls = new Set<string>();
    const targets: typeof okPages = [];
    for (const p of ordered) {
      if (seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      targets.push(p);
      if (targets.length >= scanPages) break;
    }

    const pageScans: PageScan[] = [];
    let debugData: SuggestDebug | undefined;
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    try {
      const inst = await openInstrumentedPage(context);
      const page = inst.page;
      for (const target of targets) {
        try {
          inst.markNavigationStart();
          await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
          await page.waitForTimeout(settleMs);
          const raw = await collectPageRaw(page);
          const forms = await scanForms(page, page.url());
          pageScans.push(
            toPageScan(target.url, raw, forms.map((f) => ({ purpose: f.purpose, action: f.action, method: f.method, formId: f.formId, formClasses: f.formClasses, title: f.title, fields: f.fields.map((x) => ({ type: x.type, name: x.name, required: x.required })), hidden: f.hidden })), siteHost),
          );
        } catch (err) {
          collectFailures.push({
            url: target.url,
            reason: `scan failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          });
        }
      }
      if (options.debug) {
        debugData = {
          headless: config.headless,
          navTimeoutMs: config.navTimeoutMs,
          settleMs,
          consoleErrors: inst.consoleErrors,
          pageErrors: inst.pageErrors,
        };
      }
    } finally {
      await context.close();
    }

    const scannedTargetUrls = new Set(targets.map((t) => t.url));
    const notScanned = accountNotScanned(crawl.pages, crawl.skipped, scannedTargetUrls, collectFailures);

    return assembleTagReport({
      site: crawl.startUrl || startUrl,
      siteHost,
      scannedAt: new Date().toISOString(),
      pagesCrawled: crawl.pages.length,
      pageScans,
      notScanned,
      notes: [CREATE_NOTE],
      ...(debugData ? { debug: debugData } : {}),
    });
  } finally {
    await browser.close();
  }
}
