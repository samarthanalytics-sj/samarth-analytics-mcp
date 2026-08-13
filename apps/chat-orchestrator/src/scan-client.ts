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
}

export interface ScanResult {
  site: string;
  suggestions: Record<string, unknown>[];
  warnings: string[];
  /** Pages the crawl actually opened, as reported by the tool. */
  scanned?: number;
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
    return {
      site: typeof body.site === 'string' ? body.site : url,
      suggestions,
      warnings: Array.isArray(body.warnings) ? (body.warnings as string[]).map(String) : [],
      ...(typeof body.scanned === 'number' ? { scanned: body.scanned } : {}),
    };
  }
}

/**
 * A crawl is slow by nature, and this ceiling is well past a normal one: a 10-page scan with a cold
 * browser start runs tens of seconds. It exists to stop a hung browser holding a request open
 * forever, not to bound a healthy scan.
 */
export const SCAN_TIMEOUT_MS = 240_000;
