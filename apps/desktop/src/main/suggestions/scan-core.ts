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
import {
  buildSuggestions,
  toMetaSuggestion,
  toPinterestSuggestion,
  toTikTokSuggestion,
  toLinkedInSuggestion,
  toRedditSuggestion,
  toGoogleAdsSuggestion,
} from '../../../../web-audit-mcp/src/agent/tag-suggest/suggest.js';
import { analyzeForms, type RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import type { SuggestedTag, SuggestPlatform } from '../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import type { TagScanResult, ScanDebug } from '../../shared/ipc';
import { suggestionDedupKey } from '../../shared/tag-template';

/** Non-GA4 platform → its GA4→platform deriver (mirrors buildSuggestions' PLATFORM_DERIVERS), so the
 *  AI-derived `extra` suggestions get the same per-platform counterparts as the engine ones. */
const EXTRA_DERIVERS: Record<Exclude<SuggestPlatform, 'ga4'>, (ga4: SuggestedTag) => SuggestedTag | null> = {
  meta: toMetaSuggestion,
  pinterest: toPinterestSuggestion,
  tiktok: toTikTokSuggestion,
  linkedin: toLinkedInSuggestion,
  reddit: toRedditSuggestion,
  google_ads: toGoogleAdsSuggestion,
};

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
  /** Capture a PNG of the page loaded by the most recent open() (for the AI scan).
   *  Optional — only the browser drivers implement it (Cheerio can't). */
  screenshot?(): Promise<Buffer | null>;
  /** Browser diagnostics accumulated across this driver's opens (form-probe counts,
   *  console/page errors) for the debug toggle. Optional — only browser drivers
   *  have them. Safe to call after close() (reads retained buffers). */
  diagnostics?(): ScanDebug | undefined;
  close(): Promise<void>;
}

export interface ScanOptions {
  /** Pages to open/scan (default 10, hard cap 300 — see the clamp in crawlAndSuggest). */
  maxPages?: number;
  /** Link depth from the start URL (default 2, hard cap 4). */
  maxDepth?: number;
  /** Which ad platforms to generate tags for (default ['ga4']). 'meta' adds Meta
   *  (Facebook) Pixel tags derived from the GA4 ones (sharing each trigger). */
  platforms?: SuggestPlatform[];
  /** Extra URLs to crawl at TOP priority (before form-likely/BFS discovery) — used by verify to
   *  guarantee content-hub pages (case-studies/blog/guides) are scanned so their click-CTAs enter the
   *  inventory and their tags aren't falsely "untested". */
  seedUrls?: string[];
  /** ADDITIONAL page drivers, beyond the primary one, to scan pages IN PARALLEL. The crawl runs one
   *  worker per driver over a shared page queue (each URL scanned by exactly one worker), so N drivers
   *  ≈ N× throughput on a multi-page site. Omitted / empty → the single primary driver → the original
   *  strictly-sequential behaviour (unchanged). All drivers (primary + these) are closed when done. */
  drivers?: PageDriver[];
  /** Cooperative cancel. Checked at each worker's loop boundary — when it returns true the workers stop
   *  claiming new pages and the crawl resolves with whatever it scanned so far (a Stop button). */
  shouldStop?: () => boolean;
}

/** Streamed after every page is scanned — the RUNNING (full) suggestion list so the
 *  review panel can fill in one-by-one as the crawl proceeds, plus crawl progress. */
export interface ScanProgress {
  /** Pages successfully scanned so far. */
  scanned: number;
  /** Pages opened (incl. failures) so far. */
  opened: number;
  /** Pages still queued (an estimate of what's left). */
  queued: number;
  /** The page that was just scanned (drives the live "scanning <url>" progress feed). */
  page?: string;
  /** The complete suggestion list built from everything scanned SO FAR. */
  suggestions: SuggestedTag[];
}
export type OnScanProgress = (p: ScanProgress) => void;

/** The complete (full-mode) suggestion list from the pages scanned so far. */
function runningSuggestions(pageScans: PageScan[], siteHost: string, platforms: SuggestPlatform[] = ['ga4']): SuggestedTag[] {
  return buildSuggestions(buildSuggestInput(pageScans, siteHost), { full: true, platforms });
}

const clamp = (v: number | undefined, dflt: number, cap: number): number =>
  v === undefined || !Number.isFinite(v) || v <= 0 ? dflt : Math.min(Math.floor(v), cap);
// A short yield used by the parallel crawl workers to wait for in-flight peers to enqueue newly
// discovered links before concluding the queue is truly drained.
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Merge the debug diagnostics of every driver in a scan pool — pages are split across the pool, so the
 *  "Show debug" panel must union all of them, not just the primary's. A single-driver pool returns that
 *  driver's diagnostics verbatim (so concurrency 1 is unchanged). Diagnostics buffers are retained past
 *  close(), so this is safe to read after the pool is torn down. */
function mergePoolDiagnostics(pool: PageDriver[]): ScanDebug | undefined {
  if (pool.length <= 1) return pool[0]?.diagnostics?.();
  const parts = pool.map((d) => d.diagnostics?.()).filter((x): x is ScanDebug => Boolean(x));
  if (!parts.length) return undefined;
  return {
    driver: [...new Set(parts.map((p) => p.driver))].join('+'),
    settleMode: parts[0].settleMode,
    pages: parts.flatMap((p) => p.pages),
    consoleErrors: parts.flatMap((p) => p.consoleErrors),
    pageErrors: parts.flatMap((p) => p.pageErrors),
  };
}

// ── Crawl helpers (mirror apps/web-audit-mcp/src/agent/crawler.ts — keep in
//    sync; re-stated to keep this module free of the Playwright browser import) ──
const ASSET_RE =
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|css|js|mjs|ico|zip|gz|rar|mp3|mp4|webm|mov|woff2?|ttf|eot|xml|rss|json)([?#]|$)/i;
const FORMY_RE =
  /contact|kontakt|signup|sign-up|register|registr|subscribe|newsletter|demo|quote|enquir|inquir|checkout|cart|book|apply|career|job|support|feedback|account|login|audit|consult|estimate|proposal|get-?started|onboard|free-trial|trial|pricing|solution|service|partner|get-in-touch|reach-us|schedule|appointment|callback/i;
// CONTENT hub/index pages — not form-likely, but where CTAs like "Read Full Case Study", "View Case
// Studies", "Subscribe to Insights", "Download Free Checklist" live. Verify crawls these too so those
// click tags aren't falsely "untested". (Individual articles are excluded via a shallow-path check.)
const CONTENT_RE =
  /case-?stud|\bblog\b|\bguide|resource|insight|\bnews\b|article|\bstory|stories|portfolio|\bwork\b|about|\bteam\b|library|download|checklist|webinar|ebook|e-book|report|whitepaper|white-paper|\bpress\b|media|\blearn\b|help-?cent|knowledge|docs?\b/i;

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

/** A CONTENT hub/index page (case-studies / blog / guides / about / team …) — where non-form CTAs
 *  live. Excludes deep individual articles (path > 2 segments) so we crawl the hub, not 150 posts. */
export function contentLikely(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    const segments = path.split('/').filter(Boolean);
    return segments.length <= 2 && CONTENT_RE.test(path);
  } catch {
    return false;
  }
}

/** Crawl priority for the VERIFY BFS: home (3) → form-likely (2) → content hub (1) → other (0). Content
 *  hubs sort above plain pages so their CTAs enter the inventory before the page budget runs out. */
export function crawlRank(url: string): number {
  if (isHomeUrl(url)) return 3;
  if (urlPriority(url) === 1) return 2;
  if (contentLikely(url)) return 1;
  return 0;
}

/** Is this the origin root ("/")? Discovery started there, users expect it first, and the homepage
 *  often has forms — so it must always sort ahead of everything, even a /contact page. */
function isHomeUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p === '' || p === '/';
  } catch {
    return false;
  }
}

/** Order a URL list form-likely-first (STABLE): the origin root ("/") always leads, then form-likely
 *  URLs (urlPriority 1), then the rest — preserving the original relative order WITHIN each tier via an
 *  index tiebreak. Used by scanUrls (so a form page beyond the scan cap still survives) and by the
 *  discover sort (so the review panel's "first N" pre-select naturally picks form pages). PURE. */
export function prioritizeUrls(list: string[]): string[] {
  // rank: 2 = home root, 1 = form-likely, 0 = plain. Higher sorts first.
  const rank = (u: string): number => (isHomeUrl(u) ? 2 : urlPriority(u));
  return [...list].map((u, i) => ({ u, i })).sort((a, b) => rank(b.u) - rank(a.u) || a.i - b.i).map((x) => x.u);
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
 *  the site. Accepts either script-src strings (from a scan) OR raw page HTML
 *  (from discovery) — catches gtm.js?id=, gtag/js?id=, AND the inline GTM
 *  snippet ('GTM-XXXX'). PURE + tested. */
export function detectInstalled(texts: string[]): { containers: string[]; measurementIds: string[] } {
  const containers = new Set<string>();
  const measurementIds = new Set<string>();
  const gtmRe = /googletagmanager\.com\/gtm\.js\?[^"'\s]*\bid=(GTM-[A-Z0-9]+)/gi;
  const gtagRe = /googletagmanager\.com\/gtag\/js\?[^"'\s]*\bid=((?:G|AW|GT|UA)-[A-Z0-9-]+)/gi;
  const gtmInline = /['"](GTM-[A-Z0-9]{4,})['"]/gi; // (window,document,'script','dataLayer','GTM-XXXX')
  for (const t of texts) {
    for (const m of t.matchAll(gtmRe)) containers.add(m[1].toUpperCase());
    for (const m of t.matchAll(gtagRe)) measurementIds.add(m[1].toUpperCase());
    for (const m of t.matchAll(gtmInline)) containers.add(m[1].toUpperCase());
  }
  return { containers: [...containers], measurementIds: [...measurementIds] };
}

export function emptyResult(site: string, siteHost: string, warnings: string[]): TagScanResult {
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
): Promise<{ page?: PageScan; links?: string[]; navLinks?: string[]; reason?: string; rawForms?: RawForm[] }> {
  const driven = await driver.open(url);
  if (!driven.ok) return { reason: driven.error ? `scan failed: ${driven.error}`.slice(0, 200) : 'navigation failed' };
  if (driven.httpStatus !== null && driven.httpStatus >= 400) return { reason: `http ${driven.httpStatus}` };
  if (!driven.raw) return { reason: 'no page content' };
  const path = pagePath(url);
  const elements = classifyPageElements(driven.raw.elements, siteHost, path);
  const forms = (driven.rawForms ? analyzeForms(driven.rawForms, driven.finalUrl ?? url) : []).map((f) => ({
    purpose: f.purpose,
    action: f.action,
    method: f.method,
    formId: f.formId,
    formClasses: f.formClasses,
    title: f.title,
    fields: f.fields.map((x) => ({ type: x.type, name: x.name, required: x.required })),
    hidden: f.hidden,
  }));
  const links: string[] = [];
  const navLinks: string[] = [];
  for (const el of driven.raw.elements) {
    if (el.tag !== 'a' || !el.href) continue;
    const norm = normalizeUrl(el.href, url);
    if (!norm || !sameSite(norm, base)) continue;
    links.push(norm);
    // Anchors in the site's HEADER / NAV / FOOTER are its primary navigation (contact, about, privacy,
    // careers, services…). Surface those separately so the crawler can scan them FIRST — a page reachable
    // only from the footer (a privacy policy carrying a mailto/tel, or a contact tab tucked in the footer)
    // must not be stranded past the page budget.
    if (el.region === 'header' || el.region === 'nav' || el.region === 'footer') navLinks.push(norm);
  }
  // Surface the RAW forms alongside the page so the verify scan can build the form-fill plan from this same
  // crawl (site crawled ONCE for both click CTAs and forms). Kept off PageScan (a shared type); other
  // callers just ignore it.
  return { page: { page: path, elements, forms, signals: driven.raw.signals }, links, ...(navLinks.length ? { navLinks } : {}), ...(driven.rawForms ? { rawForms: driven.rawForms } : {}) };
}

/** Dedup key for a suggestion — its event + trigger filter (mirrors buildSuggestions). */
const suggestionKey = (s: SuggestedTag): string =>
  `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${s.trigger.clickTextValue ?? ''}|${s.trigger.clickElementValue ?? ''}|${s.trigger.formIdValue ?? ''}|${s.trigger.formClassesValue ?? ''}|${s.trigger.pagePathValue ?? ''}|${s.trigger.pageUrlValue ?? ''}|${(s.trigger.dataLayerConditions ?? []).map((c) => `${c.key}=${c.value}`).join(',')}`;

/** Remove suggestions that would create the SAME GTM tag, keeping the FIRST occurrence. Identity is
 *  platform + eventName + NORMALIZED tag name (see suggestionDedupKey): GTM tag names MUST be unique,
 *  so two suggestions sharing a name can never both be created — the second is always noise, even if
 *  its trigger differs slightly (the classic case: an engine tag and the AI vision pass's copy of the
 *  same button, whose triggers vary just enough to slip past the trigger-key filter; or the same CTA
 *  whose label differs only by punctuation/whitespace, e.g. "Free Audit" vs "Free  Audit", which yield
 *  the same event but a punctuation-differing name). Normalizing the name to alphanumeric words
 *  collapses those to one. MUST use the SAME key as the renderer net (dedupeViewsByGtmName). PURE. */
export function dedupSuggestions(list: SuggestedTag[]): SuggestedTag[] {
  const byIdentity = new Map<string, SuggestedTag>();
  for (const s of list) {
    const k = suggestionDedupKey(s);
    if (!byIdentity.has(k)) byIdentity.set(k, s);
  }
  return [...byIdentity.values()];
}

/** Does a CTA trigger fire on the given click text? Mirrors GTM's matchRegex (compiled with the JS
 *  'i' flag — gtm.js evaluates web matchRegex via JS RegExp, with case-insensitivity carried by the
 *  condition-level ignore_case parameter, not an inline (?i) flag) / contains / equals, so we can
 *  tell whether an engine tag ALREADY covers an AI-suggested button. PURE. */
export function ctaTriggerFiresOn(trigger: SuggestedTag['trigger'], text: string): boolean {
  // A lookup-table trigger fires on its exact text rows (compared case-insensitively here, since the
  // AI's scraped casing may differ from the engine's).
  if (trigger.lookupTable?.texts?.length) {
    return trigger.lookupTable.texts.some((t) => t.trim().toLowerCase() === text.trim().toLowerCase());
  }
  const v = trigger.clickTextValue ?? '';
  if (!v || !text) return false;
  if (trigger.clickTextOperator === 'matchRegex') {
    try {
      return new RegExp(v.replace(/^\(\?i\)/, ''), 'i').test(text);
    } catch {
      return false;
    }
  }
  if (trigger.clickTextOperator === 'contains') return text.toLowerCase().includes(v.toLowerCase());
  if (trigger.clickTextOperator === 'equals') return text.trim().toLowerCase() === v.trim().toLowerCase();
  if (trigger.clickTextOperator === 'endsWith') return text.trim().toLowerCase().endsWith(v.trim().toLowerCase());
  return false;
}

// Events where ONE engine tag covers EVERY instance (a single mailto:/tel:/social/outbound/download
// trigger), so an AI tag re-proposing the same event is always a duplicate of it.
const AI_GLOBAL_EVENTS = new Set(['email_click', 'phone_click', 'social_click', 'outbound_click', 'file_download']);

// Cookie-consent-banner / CMP controls ("Accept All", "Decline All", "Manage Preferences", "Cookie
// Settings") — the vision pass picks these out of the banner in the screenshot, but they're CMP UI,
// not conversions, so a GA4 click tag on them is noise. Tested against a haystack with underscores
// normalized to spaces, so it matches both "Accept All Cookies" and the snake_case event name.
const COOKIE_BANNER_RE =
  /\b(accept|reject|decline|allow|deny|manage|customi[sz]e)\s+(all|cookies?|consent|preferences?|settings?|choices?)\b|\bcookie\s+(settings?|preferences?|consent|policy|choices?)\b|\bconsent\s+(settings?|preferences?|manager?)\b/i;

/** Whether an AI-suggested tag should be DROPPED when merged onto the engine scan: it's a
 *  cookie-consent-banner control (CMP UI, not a conversion), it's UNSAFE (an all-clicks CTA with no
 *  scope → fires on every click), or it DUPLICATES the engine — a global
 *  click event the engine already tracks once, or a CTA whose literal button text an engine CTA
 *  trigger already fires on (so the AI's "Get Free Audit Click" drops because the engine's "Get Free
 *  Audit" tag already matches it, even though the event names differ). PURE. */
export function dropAiSuggestion(a: SuggestedTag, engine: SuggestedTag[]): boolean {
  if (COOKIE_BANNER_RE.test(`${a.tagName} ${a.eventName} ${a.trigger.clickTextValue ?? ''}`.replace(/_/g, ' '))) return true;
  if (a.trigger.kind === 'all_clicks' && !a.trigger.clickTextValue && !a.trigger.clickUrlValue) return true;
  if (AI_GLOBAL_EVENTS.has(a.eventName) && engine.some((e) => e.eventName === a.eventName)) return true;
  // The engine's single FAQ tag (one trigger covering the question text/row/arrow) already covers any
  // per-question AI tag — its class-route trigger has no click-text condition, so ctaTriggerFiresOn
  // can't see the coverage; match on the question shape instead.
  if (/\?\s*$/.test(a.trigger.clickTextValue ?? '') && engine.some((e) => e.eventName === 'faq_click')) return true;
  // A click-text CTA the engine already fires on is a duplicate — regardless of whether either tag is a
  // "Click - All Elements" (all_clicks) or "Click - Just Links" (link_click) trigger. A CTA's trigger
  // type now follows the element (a real <a href> → link_click, a button/control → all_clicks), so the
  // engine copy of the same button may be either type; match on the click-text coverage, not the kind.
  const isClickCta = (t: SuggestedTag['trigger']): boolean => t.kind === 'all_clicks' || t.kind === 'link_click';
  if (isClickCta(a.trigger) && a.trigger.clickTextOperator !== 'matchRegex' && a.trigger.clickTextValue) {
    return engine.some((e) => isClickCta(e.trigger) && ctaTriggerFiresOn(e.trigger, a.trigger.clickTextValue ?? ''));
  }
  return false;
}

/** Build a PageScan from an ALREADY-opened page (mirrors scanTarget's assembly,
 *  minus the link extraction) — so the AI scan can open once, screenshot, and scan. */
export function pageScanFromDriven(driven: DrivenPage, url: string, siteHost: string): PageScan | null {
  if (!driven.ok || !driven.raw) return null;
  const path = pagePath(url);
  const elements = classifyPageElements(driven.raw.elements, siteHost, path);
  const forms = (driven.rawForms ? analyzeForms(driven.rawForms, driven.finalUrl ?? url) : []).map((f) => ({
    purpose: f.purpose,
    action: f.action,
    method: f.method,
    formId: f.formId,
    formClasses: f.formClasses,
    title: f.title,
    fields: f.fields.map((x) => ({ type: x.type, name: x.name, required: x.required })),
    hidden: f.hidden,
  }));
  return { page: path, elements, forms, signals: driven.raw.signals };
}

/** Build the final report from collected page scans (pure assembly + dedup). `extra`
 *  suggestions (e.g. AI-derived) are appended after the scan-derived ones, deduped
 *  against them by trigger key — used by the AI single-page scan. */
export function assembleResult(
  site: string,
  siteHost: string,
  pageScans: PageScan[],
  notScanned: TagScanResult['notScanned'],
  warnings: string[],
  opened: number,
  extra: SuggestedTag[] = [],
  platforms: SuggestPlatform[] = ['ga4'],
  debug?: ScanDebug,
): TagScanResult {
  const input = buildSuggestInput(pageScans, siteHost);
  // full: include the GA4 Configuration base tag + the All-form / All-PDF catch-alls
  // so the review list is the COMPLETE set of creatable tags, not only scan-derived.
  // platforms selects GA4 and/or the derived Meta (Facebook) Pixel counterparts.
  const scanned: SuggestedTag[] = buildSuggestions(input, { full: true, platforms });
  const seen = new Set(scanned.map(suggestionKey));
  // The AI-derived `extra` are GA4 tags — subject them to the SAME platform selection as the engine
  // suggestions: keep the GA4 ones only when 'ga4' is chosen, and derive each selected non-GA4
  // platform's counterparts (sharing each trigger, like the engine path). Without this, an AI scan
  // with a non-GA4-only selection would leak GA4 tags, and a mixed selection would give AI-discovered
  // elements no platform counterparts.
  const extraForPlatforms: SuggestedTag[] = [...(platforms.includes('ga4') ? extra : [])];
  for (const platform of platforms) {
    if (platform === 'ga4') continue;
    extraForPlatforms.push(...extra.map(EXTRA_DERIVERS[platform]).filter((s): s is SuggestedTag => s !== null));
  }
  // Merge the (platform-filtered) `extra`: drop exact-key dupes, semantic dupes of an engine tag (same
  // global event, or a CTA the engine already fires on), and unsafe unscoped all-clicks suggestions.
  const merged = [...scanned, ...extraForPlatforms.filter((s) => !seen.has(suggestionKey(s)) && !dropAiSuggestion(s, scanned))];
  // Final safety net: NEVER emit two suggestions that would create the SAME GTM tag. Keep the first.
  const suggestions = dedupSuggestions(merged);
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let em = 0;
  for (const sug of suggestions) {
    byConfidence[sug.confidence] += 1;
    if (sug.enhancedMeasurementOverlap) em += 1;
  }
  // Diagnostic: what the scan actually DETECTED (so a "missing form/CTA" report can be localized —
  // 0 forms here means the extractor never saw it, not that a later step dropped it).
  console.error(
    `[tag-scan] ${siteHost}: ${pageScans.length} page(s) | forms=${input.forms.length} [${input.forms.map((f) => f.purpose).join(',')}] | ` +
      `elements=${input.elements.length} [${[...new Set(input.elements.map((e) => e.kind))].join(',')}] | suggestions=${suggestions.length}`,
  );
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
      // Auto-detected site type (from buildSuggestInput) — drives the UI badge + the ecommerce suggestions.
      // Only when at least one page actually loaded: a failed/empty scan has no signals to judge, so it
      // stays undefined (no misleading "Non-eCommerce site" badge on a scan that never reached the site).
      ...(pageScans.length > 0 && input.websiteType ? { websiteType: input.websiteType } : {}),
      ...(pageScans.length > 0 && input.ecommerceEvidence?.length ? { ecommerceEvidence: input.ecommerceEvidence } : {}),
    },
    // The engine SuggestedTag[] flows straight into the view here (same field
    // names). This is where each suggestion's structured `install` plan rides
    // along untouched → SuggestedTagView.install → the review panel's "How to
    // install" panel. (Nothing to map — the assignment carries it as-is.)
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
    ...(debug ? { debug } : {}),
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
  onProgress?: OnScanProgress,
  // Called once per scanned page with its RAW forms — lets the verify scan build the form-fill plan from
  // the SAME crawl that inventories click CTAs (one crawl, not two). Best-effort; ignored by other callers.
  onPageForms?: (page: string, rawForms: RawForm[]) => void,
): Promise<TagScanResult> {
  // Cap lifted 150 → 300: a larger site (200+ pages) left many CTAs "untested here" under the old budget,
  // and the user wants EVERY page scanned. The default (when no budget is passed) stays 10 — only callers
  // that explicitly request more (Verify) reach higher. Pages are prioritized (header/nav/footer navigation
  // first, then home → form-likely → content), so even a truncated budget covers the important pages.
  const maxPages = clamp(opts.maxPages, 10, 300);
  const maxDepth = clamp(opts.maxDepth, 2, 4);
  const platforms = opts.platforms ?? ['ga4'];

  const warnings: string[] = [];
  const start = normalizeUrl(startUrl, startUrl);
  let siteHost = '';
  try {
    siteHost = new URL(start ?? startUrl).hostname;
  } catch {
    /* validated upstream by urlAllowed */
  }
  if (!start) {
    // Close the WHOLE pool, not just the primary: the caller pre-allocates the extra drivers, so an
    // early return here (e.g. an asset start URL like /sitemap.xml or /file.pdf that passes the SSRF
    // guard but is not crawlable) must not leak them.
    await Promise.all([driver, ...(opts.drivers ?? [])].map((d) => d.close().catch(() => undefined)));
    return emptyResult(startUrl, siteHost, ['Not a crawlable http(s) URL.']);
  }

  const notScanned: TagScanResult['notScanned'] = [];
  const pageScans: PageScan[] = [];
  const visited = new Set<string>();
  const discovered = new Set<string>([start]);
  // The start page is scanned FIRST (top priority) — it carries the site's header/footer nav, and we must
  // discover those links before a large sitemap-seed set consumes the budget. Otherwise, with seeds present,
  // the home page (depth-0, non-seed) would sort BELOW the seeds and be scanned last, too late to enqueue its
  // footer links.
  const queue: { url: string; depth: number; seed?: boolean; nav?: boolean }[] = [{ url: start, depth: 0, nav: true }];
  // Seed content-hub pages at TOP priority so they're scanned before the page budget is spent on the
  // (many) form-likely pages — otherwise content CTAs ("Read Full Case Study", …) never get inventoried.
  for (const s of opts.seedUrls ?? []) {
    const n = normalizeUrl(s, start);
    if (n && sameSite(n, start) && !discovered.has(n)) { discovered.add(n); queue.push({ url: n, depth: 0, seed: true }); }
  }
  let opened = 0;
  let active = 0; // pages being scanned by SOME worker right now; a worker only exits when the queue is
  //                 drained AND active === 0 (another in-flight worker may still enqueue discovered links).
  const pool = [driver, ...(opts.drivers ?? [])];

  // Claim the next scannable URL SYNCHRONOUSLY (no await inside → atomic on JS's single thread, so no URL
  // is ever handed to two workers): pop the highest-priority queued URL that passes the visited + SSRF
  // checks, reserving a budget slot and an `active` slot. null when nothing is claimable right now.
  const claimNext = (): { url: string; depth: number } | null => {
    while (queue.length > 0 && opened < maxPages) {
      // Priority: the site's REAL navigation (header/nav/footer links) first — even above sitemap seeds and
      // regardless of depth — so Contact / Privacy / Careers (often NOT in the sitemap, and only depth-1 from
      // the home page) are never crowded out by a large sitemap. Then sitemap seeds, then shallowest, then
      // crawl rank (home → form-likely → content hub → other).
      const pri = (x: { seed?: boolean; nav?: boolean }): number => (x.nav ? 2 : x.seed ? 1 : 0);
      queue.sort((a, b) => pri(b) - pri(a) || a.depth - b.depth || crawlRank(b.url) - crawlRank(a.url));
      const item = queue.shift()!;
      const key = item.url.replace(/\/$/, '');
      if (visited.has(key)) continue;
      const verdict = urlAllowed(item.url, []);
      if (!verdict.ok) {
        notScanned.push({ url: item.url, reason: verdict.reason });
        continue;
      }
      visited.add(key);
      opened += 1;
      active += 1;
      return { url: item.url, depth: item.depth };
    }
    return null;
  };
  // Add a scanned page's links to the frontier (synchronous critical section). `priority` orders them:
  // 'nav' (header/nav/footer navigation) is scanned before everything, 'seed' before ordinary links, 'none'
  // is a plain in-page/content link.
  const enqueueLinks = (links: string[] | undefined, depth: number, priority: 'nav' | 'seed' | 'none' = 'none'): void => {
    if (depth >= maxDepth) return;
    for (const norm of links ?? []) {
      const k = norm.replace(/\/$/, '');
      if (visited.has(k) || discovered.has(norm)) continue;
      discovered.add(norm);
      queue.push({ url: norm, depth: depth + 1, ...(priority === 'nav' ? { nav: true } : priority === 'seed' ? { seed: true } : {}) });
    }
  };

  // One worker per driver, all draining the SAME queue. At concurrency 1 (a single driver, no extras)
  // this reduces to the original strictly-sequential BFS.
  const worker = async (d: PageDriver): Promise<void> => {
    for (;;) {
      if (opts.shouldStop?.()) return; // Stop pressed → drain workers; the crawl resolves with what it has
      const item = claimNext();
      if (!item) {
        if (active === 0) return; // queue drained and nobody can still enqueue → done
        await delay(15); // work in flight elsewhere may still enqueue links — wait, don't exit early
        continue;
      }
      try {
        const r = await scanTarget(d, item.url, siteHost, start);
        if (!r.page) {
          notScanned.push({ url: item.url, reason: r.reason ?? 'not scanned' });
        } else {
          pageScans.push(r.page);
          enqueueLinks(r.navLinks, item.depth, 'nav'); // header/nav/footer navigation → scanned first (above sitemap seeds)
          enqueueLinks(r.links, item.depth);
          if (onPageForms && r.rawForms?.length) {
            try { onPageForms(item.url, r.rawForms); } catch { /* a forms sink error must never abort the crawl */ }
          }
          // Stream the running list so the review panel fills in as the crawl proceeds.
          if (onProgress) {
            try {
              onProgress({ scanned: pageScans.length, opened, queued: queue.length, page: item.url, suggestions: runningSuggestions(pageScans, siteHost, platforms) });
            } catch {
              /* a progress sink error must never abort the crawl */
            }
          }
        }
      } finally {
        active -= 1; // released AFTER enqueue, so a worker that observes active===0 sees a settled queue
      }
    }
  };

  try {
    await Promise.all(pool.map((d) => worker(d)));
  } finally {
    await Promise.all(pool.map((d) => d.close().catch(() => undefined)));
  }

  if (queue.length > 0) {
    warnings.push(`${queue.length} more same-site page(s) were discovered but not scanned (page budget ${maxPages}).`);
  }
  return assembleResult(start, siteHost, pageScans, notScanned, warnings, opened, [], platforms, mergePoolDiagnostics(pool));
}

/** Max pages a single "scan selected" run (Main website) or CSV import will deep-scan. Matches the
 *  crawl budget used by tag verification so suggestions cover the same breadth of the site. */
export const SCAN_URLS_CAP = 250;

/**
 * Deep-scan a SPECIFIC list of URLs (no BFS) — used after the discover step,
 * where the user picked which pages to scan. READ-ONLY.
 */
export async function scanUrls(
  driver: PageDriver,
  urls: string[],
  siteHostHint?: string,
  onProgress?: OnScanProgress,
  opts: { platforms?: SuggestPlatform[]; drivers?: PageDriver[] } = {},
): Promise<TagScanResult> {
  const platforms = opts.platforms ?? ['ga4'];
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
  // STABLE-sort form-likely URLs (and the homepage) to the front BEFORE the cap, so a form page sitting
  // beyond position SCAN_URLS_CAP in the raw selection order isn't silently dropped by the slice.
  const ordered = prioritizeUrls(list);
  const targets = ordered.slice(0, SCAN_URLS_CAP);
  if (list.length > SCAN_URLS_CAP) {
    warnings.push(`Selected ${list.length} pages; scanning the first ${SCAN_URLS_CAP} (cap).`);
  }

  const notScanned: TagScanResult['notScanned'] = [];
  const pageScans: PageScan[] = [];
  const seen = new Set<string>();
  const pool = [driver, ...(opts.drivers ?? [])];
  let idx = 0;
  let opened = 0;

  // Claim the next target SYNCHRONOUSLY (no await inside → atomic on JS's single thread, so no URL is
  // scanned twice). A fixed list has no frontier to grow, so a worker simply exits when the list is
  // exhausted. At concurrency 1 this reduces to the original strictly-sequential loop.
  const claimNext = (): string | null => {
    while (idx < targets.length) {
      const raw = targets[idx++];
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
      return url;
    }
    return null;
  };
  const worker = async (d: PageDriver): Promise<void> => {
    for (;;) {
      const url = claimNext();
      if (!url) return;
      const r = await scanTarget(d, url, siteHost, url);
      if (!r.page) {
        notScanned.push({ url, reason: r.reason ?? 'not scanned' });
        continue;
      }
      pageScans.push(r.page);
      if (onProgress) {
        try {
          onProgress({ scanned: pageScans.length, opened, queued: targets.length - opened, suggestions: runningSuggestions(pageScans, siteHost, platforms) });
        } catch {
          /* a progress sink error must never abort the scan */
        }
      }
    }
  };

  try {
    await Promise.all(pool.map((d) => worker(d)));
  } finally {
    await Promise.all(pool.map((d) => d.close().catch(() => undefined)));
  }
  return assembleResult(start ?? list[0] ?? '', siteHost, pageScans, notScanned, warnings, opened, [], platforms, mergePoolDiagnostics(pool));
}
