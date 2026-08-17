/**
 * The site scanner behind the Tag suggestions page.
 *
 * The suggestions themselves are not computed here. They come from the web-audit MCP's
 * `gtm_tag_suggestions` tool, which is the same engine the desktop app drives, so the website and
 * the desktop cannot drift into suggesting different things from the same page.
 *
 * ONE SHARED CHILD, not one per user. Every other MCP child in this process is spawned per user and
 * carries that user's Google access token, because it reads their account. This one reads nothing of
 * theirs: it fetches public pages over the open internet, and it is given no credentials at all.
 * Spawning it per user would multiply headless browsers for no isolation benefit.
 *
 * The child is started on first use, not at boot. It needs a Playwright browser, which most
 * deployments will not have, and a scanner that cannot start must not stop the orchestrator from
 * serving chat.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpConnection } from './mcp-client.js';
import { deadline } from './deadline.js';
import type { OrchestratorConfig } from './config.js';

/** Where the built web-audit MCP sits, relative to the repo root. */
const WEB_AUDIT_ENTRY = 'apps/web-audit-mcp/dist/web-audit-mcp/src/index.js';

/**
 * Find the built scanner by walking up from this file until the path exists.
 *
 * Not a fixed number of `..` segments, because this module runs from two different depths: under tsx
 * it is apps/chat-orchestrator/src, and after a build it is apps/chat-orchestrator/dist/
 * chat-orchestrator/src. A count that is right in one is silently wrong in the other, and the
 * failure would arrive as a spawn error with no hint of which path was wrong.
 *
 * Returns null when it is not built. The caller turns that into the sentence that says how to build
 * it, which is more use than a path that does not exist.
 */
export function findWebAuditEntry(from?: string): string | null {
  let dir = from ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, WEB_AUDIT_ENTRY);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The ad platforms the engine can build tags for. GA4 is the default and the base for the rest. */
export const SCAN_PLATFORMS = ['ga4', 'meta', 'google_ads', 'tiktok', 'linkedin', 'reddit', 'pinterest'] as const;
export type ScanPlatform = (typeof SCAN_PLATFORMS)[number];

/** Keep only names the engine knows, so a typo from the browser cannot silently widen a scan. */
export function validPlatforms(input: unknown): ScanPlatform[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<string>(SCAN_PLATFORMS);
  return [...new Set(input.map(String).filter((p) => known.has(p)))] as ScanPlatform[];
}

export interface ScanOptions {
  /** Pages to open (the tool clamps this itself). */
  maxPages?: number;
  /** Link depth from the start URL. */
  maxDepth?: number;
  /** Ad platforms to build tags for. Empty or omitted means the engine's default, GA4 only. */
  platforms?: ScanPlatform[];
  /** Ask for a screenshot of each scanned page. Off in the tool by default, see the note there. */
  captureImages?: boolean;
  /** Do not follow blog, news and article paths. */
  skipBlog?: boolean;
  /**
   * Scan exactly these pages and do not crawl.
   *
   * Set when the user picked from a discovery. The crawl's own ranking is a guess about which pages
   * are worth the budget; once someone has looked at the list and chosen, re-deriving a worse answer
   * would be pure cost.
   */
  pages?: string[];
}

/** One page a discovery found. */
export interface DiscoveredPage {
  url: string;
  path: string;
  source: 'sitemap' | 'crawl' | 'given';
}

/**
 * What a discovery found, and how confident it is about what it did not find.
 *
 * `sitemapStatus` is carried through verbatim rather than reduced to a boolean, because "this site
 * has no sitemap" and "this site would not answer" are opposite facts that a boolean makes
 * identical, and only the first is safe to tell a user.
 */
export interface DiscoverResult {
  site: string;
  pages: DiscoveredPage[];
  total: number;
  sitemapStatus: 'found' | 'partial' | 'none' | 'unreachable' | 'skipped';
  sitemapsRead: { url: string; ok: boolean; urls: number; error?: string }[];
  viaCrawl: boolean;
  rejected: { url: string; reason: string }[];
  note?: string;
}

/** The hard ceiling the scanner applies to the page budget, mirrored here so the browser can show
 *  the real number instead of accepting one that will be silently clamped. */
export const MAX_SCAN_PAGES = 200;

/**
 * Ceiling on an explicitly chosen list of pages.
 *
 * Separate from the crawl budget, and larger, because they answer different questions. The crawl
 * budget is "how far should the crawler go"; a chosen list is "these, please", and clamping it to
 * the crawl number scanned a fraction of what someone ticked. The only real bound is the scan
 * timeout: about three seconds a page puts 300 at fifteen minutes against a twenty-minute limit.
 */
export const MAX_SELECTED_PAGES = 300;

/** A page the crawl opened and read. */
export interface ScannedPage {
  page: string;
  forms: number;
  elements: number;
}

/** A scanned page's screenshot, base64 JPEG. */
export interface PageImage {
  page: string;
  image: string;
  bytes: number;
}

export interface ScanResult {
  site: string;
  suggestions: Record<string, unknown>[];
  warnings: string[];
  /** Pages the crawl actually opened, as reported by the tool. */
  scanned?: number;
  /** Screenshots of the scanned pages, when they were asked for. */
  pageImages?: PageImage[];
  /** The pages actually read, so the answer to "what did you look at" is not a guess. */
  pages?: ScannedPage[];
  /** Discovered but not read, each with the reason. */
  notScanned?: { url: string; reason: string }[];
  /** Links dropped by the skip filter before they could spend the budget. */
  excluded?: number;
}

/** A scan failed in a way the user can act on. Carries no stack, only the sentence to show. */
export class ScanError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

export class SiteScanner {
  private connection: McpConnection | null = null;
  private connecting: Promise<McpConnection> | null = null;

  constructor(private readonly cfg: OrchestratorConfig) {}

  /**
   * Connect once, and let concurrent callers share the attempt.
   *
   * A failed connection is NOT cached: the usual cause is a missing build or a missing browser, both
   * of which a user fixes and retries, and caching the failure would make the retry lie.
   */
  private async connect(): Promise<McpConnection> {
    if (this.connection) return this.connection;
    if (this.connecting) return this.connecting;

    const command = process.env.WEB_AUDIT_MCP_COMMAND?.trim() || process.execPath;
    const entry = process.env.WEB_AUDIT_MCP_ENTRY?.trim() || findWebAuditEntry();
    if (!entry) {
      throw new ScanError(
        'The site scanner is not built. Run "npm --prefix apps/web-audit-mcp run build" on the ' +
          'machine running the orchestrator, then try the scan again.',
        'scanner_not_built',
      );
    }

    this.connecting = (async () => {
      const conn = new McpConnection({
        ...this.cfg,
        mcp: {
          transport: 'stdio',
          command,
          args: [entry],
          // Deliberately empty. This child gets no Google credentials of any kind: it only ever
          // fetches public pages, and the guardrail flags that gate GTM writes are meaningless here.
          env: {},
        },
      });
      try {
        await conn.connect();
      } catch (err) {
        throw new ScanError(
          `The site scanner could not start. Build it with "npm --prefix apps/web-audit-mcp run build" ` +
            `and make sure Playwright is installed. (${err instanceof Error ? err.message : String(err)})`,
          'scanner_unavailable',
        );
      }
      this.connection = conn;
      return conn;
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  /**
   * List a site's pages, without opening a browser.
   *
   * Its own timeout, an order of magnitude below the scan's: this is a handful of HTTP GETs against
   * public URLs, and a discovery still running after a minute is a hung fetch rather than a big
   * site. Sharing the scan's four-minute ceiling would leave someone watching a spinner for four
   * minutes before being told to try again.
   */
  async discover(url: string, opts: { sitemaps?: string[]; crawlOnly?: boolean } = {}): Promise<DiscoverResult> {
    const conn = await this.connect();
    const { ok, text } = await deadline(
      conn.callTool('site_pages_discover', {
        url,
        ...(opts.sitemaps?.length ? { sitemaps: opts.sitemaps } : {}),
        ...(opts.crawlOnly ? { crawlOnly: true } : {}),
      }),
      DISCOVER_TIMEOUT_MS,
      'Listing the pages took too long and was stopped. The site may be slow to answer.',
    );
    if (!ok) throw new ScanError(text, 'discover_failed');

    let body: DiscoverResult;
    try {
      body = JSON.parse(text) as DiscoverResult;
    } catch {
      throw new ScanError('The scanner returned a result that was not JSON.', 'bad_result');
    }
    return {
      site: typeof body.site === 'string' ? body.site : url,
      pages: Array.isArray(body.pages) ? body.pages : [],
      total: typeof body.total === 'number' ? body.total : 0,
      sitemapStatus: body.sitemapStatus ?? 'none',
      sitemapsRead: Array.isArray(body.sitemapsRead) ? body.sitemapsRead : [],
      viaCrawl: body.viaCrawl === true,
      rejected: Array.isArray(body.rejected) ? body.rejected : [],
      ...(body.note ? { note: body.note } : {}),
    };
  }

  /**
   * Scan a site and return the suggested tags.
   *
   * The URL is not validated here. The web-audit MCP applies its own SSRF guard on every tool call,
   * and duplicating that check in a second place is how the two drift apart: one of them gets a fix
   * and the other keeps admitting what it should not.
   */
  async scan(url: string, opts: ScanOptions = {}): Promise<ScanResult> {
    const conn = await this.connect();
    const { ok, text } = await deadline(
      conn.callTool('gtm_tag_suggestions', {
        url,
        ...(opts.maxPages ? { maxPages: opts.maxPages } : {}),
        ...(opts.maxDepth ? { maxDepth: opts.maxDepth } : {}),
        ...(opts.platforms?.length ? { platforms: opts.platforms } : {}),
        ...(opts.captureImages ? { captureImages: true } : {}),
        ...(opts.skipBlog ? { skipBlog: true } : {}),
        ...(opts.pages?.length ? { pages: opts.pages } : {}),
      }),
      SCAN_TIMEOUT_MS,
      'The scan took too long and was stopped. Try fewer pages.',
    );
    if (!ok) throw new ScanError(text, 'scan_failed');

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ScanError('The scanner returned a result that was not JSON.', 'bad_result');
    }

    const suggestions = Array.isArray(body.suggestions)
      ? (body.suggestions as Record<string, unknown>[])
      : [];
    // The report nests its counts under `summary`; reading body.scanned found nothing, so the page
    // count never appeared in the UI.
    const summary = (body.summary ?? {}) as Record<string, unknown>;
    return {
      site: typeof body.site === 'string' ? body.site : url,
      suggestions,
      warnings: Array.isArray(body.warnings) ? (body.warnings as string[]).map(String) : [],
      ...(typeof summary.pagesScanned === 'number' ? { scanned: summary.pagesScanned } : {}),
      ...(Array.isArray(body.pageImages) ? { pageImages: body.pageImages as PageImage[] } : {}),
      ...(Array.isArray(body.pages) ? { pages: body.pages as ScannedPage[] } : {}),
      ...(Array.isArray(body.notScanned)
        ? { notScanned: (body.notScanned as { url: string; reason: string }[]).slice(0, 100) }
        : {}),
      ...(typeof body.excluded === 'number' ? { excluded: body.excluded } : {}),
    };
  }
}

/**
 * A crawl is slow by nature, and this ceiling is well past a normal one.
 *
 * Twenty minutes, up from four. Measured on the built scanner: about six seconds per page
 * sequentially and about three across the worker pool, and the page budget now goes to 200. That
 * puts a full 200-page scan near ten minutes, and a slow site or a cold browser can be well past
 * that. A scan killed at four minutes threw away all of the work rather than some of it. This
 * exists to stop a hung browser holding a request open forever, not to bound a healthy scan.
 */
export const SCAN_TIMEOUT_MS = 1_200_000;

/** A discovery is HTTP GETs against public URLs, so a minute is already generous. */
export const DISCOVER_TIMEOUT_MS = 60_000;
