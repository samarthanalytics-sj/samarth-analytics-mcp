/**
 * Operator configuration via environment variables. Every limit has a hard cap
 * so a misconfigured (or prompt-injected) client cannot turn the audit agent
 * into a crawler botnet.
 */

export interface WebAuditConfig {
  /** Host suffixes the server may load. Empty = any public host. */
  allowlist: string[];
  /** Default / hard-cap page budget for crawls and full audits. */
  maxPages: number;
  maxPagesCap: number;
  /** Ceiling on an explicitly chosen page list, which is not bounded by the crawl budget. */
  maxSelectedCap: number;
  /** Maximum crawl depth from the start URL. */
  maxDepth: number;
  maxDepthCap: number;
  /** Per-page navigation timeout (ms). */
  navTimeoutMs: number;
  /** Post-load settle time to let tags fire (ms). */
  settleMs: number;
  /** When false, banner click-through is refused (detection still works). */
  interactionEnabled: boolean;
  headless: boolean;
  /**
   * Expose the `verify` MCP tool (tag verification engine). OFF by default:
   * unlike the rest of the server, verify drives operator-supplied interactions
   * (incl. real form submits) on the target page. WEB_AUDIT_ENABLE_VERIFY=true.
   */
  verifyEnabled: boolean;
  /** verify: stop capturing after this many ms with no new GA4 collect. */
  settleQuietMs: number;
  /** verify: hard cap on capture time (ms). */
  settleMaxMs: number;
}

function intEnv(name: string, dflt: number, cap: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return dflt;
  return Math.min(Math.floor(raw), cap);
}

export function loadConfig(): WebAuditConfig {
  const allowlist = (process.env.WEB_AUDIT_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    allowlist,
    maxPages: intEnv('WEB_AUDIT_MAX_PAGES', 10, 200),
    // 200, up from 25. A page costs about six seconds, and the scan now runs a pool of contexts, so
    // the ceiling is patience rather than a timeout. The default stays 10: a big scan should be a
    // choice someone makes, not one they get by accident.
    maxPagesCap: 200,
    // A CHOSEN list is not a crawl budget. Someone who ticked 226 pages meant 226, so the only
    // ceiling that applies is the one that keeps a scan inside its timeout: at about three seconds
    // a page, 300 is fifteen minutes against a twenty-minute limit.
    maxSelectedCap: 300,
    maxDepth: intEnv('WEB_AUDIT_MAX_DEPTH', 2, 4),
    maxDepthCap: 4,
    navTimeoutMs: intEnv('WEB_AUDIT_NAV_TIMEOUT', 30_000, 60_000),
    settleMs: intEnv('WEB_AUDIT_SETTLE_MS', 3_000, 10_000),
    interactionEnabled: process.env.WEB_AUDIT_DISABLE_INTERACTION !== 'true',
    headless: process.env.WEB_AUDIT_HEADED !== 'true',
    verifyEnabled: process.env.WEB_AUDIT_ENABLE_VERIFY === 'true',
    settleQuietMs: intEnv('WEB_AUDIT_VERIFY_SETTLE_QUIET', 2_000, 10_000),
    settleMaxMs: intEnv('WEB_AUDIT_VERIFY_SETTLE_MAX', 10_000, 30_000),
  };
}

/** Clamp a tool-supplied number into [1, cap], falling back to dflt. */
export function clampOpt(value: number | undefined, dflt: number, cap: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return dflt;
  return Math.min(Math.floor(value), cap);
}
