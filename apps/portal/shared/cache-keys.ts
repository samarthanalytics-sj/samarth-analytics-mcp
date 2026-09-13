// Cache key design + TTL policy for the production caching layer.
//
// FORWARD-LOOKING foundation: pure, dependency-free helpers that define the
// canonical cache-key namespace and TTLs for the short-lived GTM/GA4 discovery
// caches and job-state lookups. This file does NOT open a Redis/Upstash
// connection and does not import any client — it only describes keys and
// policy, so it is safe to import from the Vercel serverless `api/**` routes
// (no heavy top-level import) and from the worker.
//
// Wiring this to a real cache (Upstash Redis over HTTP is the recommended
// serverless-friendly choice) is a later step; when that happens, the cache
// client reads `ttlSeconds` and `staleSeconds` from `CACHE_POLICY` and builds
// keys exclusively through `cacheKey()` so the namespace stays consistent.
//
// See docs/PRODUCTION_ARCHITECTURE.md §"Caching strategy" for invalidation
// triggers and the stale-while-revalidate contract.

/** Cache key prefix; bump to invalidate the entire namespace on a breaking change. */
export const CACHE_NS = "sa:v1";

/**
 * Logical cache resources. Each maps to a TTL policy below. Tokens, secrets,
 * and raw runtime captures are deliberately absent — see `NEVER_CACHE`.
 */
export type CacheResource =
  | "gtm_accounts" // account list for a connection
  | "gtm_containers" // container list for an account
  | "gtm_workspaces" // workspace list for a container
  | "ga4_properties" // GA4 property list for a connection
  | "ga4_data_streams" // data stream list for a property
  | "audit_run_status" // status of an in-flight audit run
  | "worker_job_status"; // status of a runtime-capture job

export interface CachePolicy {
  /** Hard time-to-live, in seconds, after which the entry is evicted. */
  ttlSeconds: number;
  /**
   * Stale window, in seconds. After `ttlSeconds` but within `staleSeconds`,
   * a served entry is returned immediately AND an async refresh is triggered
   * (stale-while-revalidate). 0 disables SWR for that resource.
   */
  staleSeconds: number;
}

/**
 * TTLs are intentionally short. The Google API is always the source of truth;
 * the cache only collapses repeated identical reads within a session and
 * smooths bursty discovery traffic. Discovery lists tolerate brief staleness
 * (SWR), while job/run status is short-lived and not revalidated stale.
 */
export const CACHE_POLICY: Record<CacheResource, CachePolicy> = {
  gtm_accounts: { ttlSeconds: 300, staleSeconds: 600 },
  gtm_containers: { ttlSeconds: 300, staleSeconds: 600 },
  gtm_workspaces: { ttlSeconds: 120, staleSeconds: 300 },
  ga4_properties: { ttlSeconds: 300, staleSeconds: 600 },
  ga4_data_streams: { ttlSeconds: 300, staleSeconds: 600 },
  audit_run_status: { ttlSeconds: 10, staleSeconds: 0 },
  worker_job_status: { ttlSeconds: 10, staleSeconds: 0 },
};

/**
 * Things that must NEVER be written to the cache (or any shared store) in
 * plaintext. Documented here as a guardrail and asserted by the test suite.
 */
export const NEVER_CACHE = [
  "oauth_access_token",
  "oauth_refresh_token",
  "session_cookie",
  "client_secret",
  "raw_runtime_capture", // may contain PII in dataLayer values; redact/encrypt + retention-police instead
] as const;

export type NeverCacheItem = (typeof NEVER_CACHE)[number];

/**
 * Build a canonical, collision-resistant cache key. All keys are tenant-scoped
 * by `orgId` first so a cache flush for one org never touches another, and so
 * keys can be range-scanned/deleted by `{CACHE_NS}:{orgId}:` prefix.
 *
 * Parts are sanitized (`:` and whitespace collapsed) so a malformed id can't
 * smuggle in a delimiter and forge another key.
 *
 *   cacheKey("gtm_containers", "org-123", "acct-9")
 *     → "sa:v1:org-123:gtm_containers:acct-9"
 */
export function cacheKey(
  resource: CacheResource,
  orgId: string,
  ...parts: Array<string | number>
): string {
  const segments = [CACHE_NS, sanitize(orgId), resource, ...parts.map(sanitize)];
  return segments.join(":");
}

/** Prefix used to invalidate every cached entry for one tenant. */
export function orgKeyPrefix(orgId: string): string {
  return `${CACHE_NS}:${sanitize(orgId)}:`;
}

/** Prefix used to invalidate every cached entry of one resource for a tenant. */
export function resourceKeyPrefix(
  resource: CacheResource,
  orgId: string,
): string {
  return `${CACHE_NS}:${sanitize(orgId)}:${resource}:`;
}

/** Return the configured policy for a resource. */
export function policyFor(resource: CacheResource): CachePolicy {
  return CACHE_POLICY[resource];
}

function sanitize(part: string | number): string {
  return String(part)
    .trim()
    .replace(/[:\s]+/g, "_")
    .replace(/_{2,}/g, "_");
}
