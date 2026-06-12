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
    maxPages: intEnv('WEB_AUDIT_MAX_PAGES', 10, 25),
    maxPagesCap: 25,
    maxDepth: intEnv('WEB_AUDIT_MAX_DEPTH', 2, 4),
    maxDepthCap: 4,
    navTimeoutMs: intEnv('WEB_AUDIT_NAV_TIMEOUT', 30_000, 60_000),
    settleMs: intEnv('WEB_AUDIT_SETTLE_MS', 3_000, 10_000),
    interactionEnabled: process.env.WEB_AUDIT_DISABLE_INTERACTION !== 'true',
    headless: process.env.WEB_AUDIT_HEADED !== 'true',
  };
}

/** Clamp a tool-supplied number into [1, cap], falling back to dflt. */
export function clampOpt(value: number | undefined, dflt: number, cap: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return dflt;
  return Math.min(Math.floor(value), cap);
}
