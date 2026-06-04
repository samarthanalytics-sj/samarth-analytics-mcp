/**
 * Standalone Node test for the cache-key design helpers.
 * Run: node apps/portal/shared/__tests__/cache-keys.node.test.mjs
 *
 * Mirrors the runtime behaviour of apps/portal/shared/cache-keys.ts without
 * importing TS (kept dependency-free like the other .node.test.mjs files in
 * this repo). If the .ts logic changes, update this mirror.
 */

import assert from "node:assert";

const CACHE_NS = "sa:v1";

const CACHE_POLICY = {
  gtm_accounts: { ttlSeconds: 300, staleSeconds: 600 },
  gtm_containers: { ttlSeconds: 300, staleSeconds: 600 },
  gtm_workspaces: { ttlSeconds: 120, staleSeconds: 300 },
  ga4_properties: { ttlSeconds: 300, staleSeconds: 600 },
  ga4_data_streams: { ttlSeconds: 300, staleSeconds: 600 },
  audit_run_status: { ttlSeconds: 10, staleSeconds: 0 },
  worker_job_status: { ttlSeconds: 10, staleSeconds: 0 },
};

const NEVER_CACHE = [
  "oauth_access_token",
  "oauth_refresh_token",
  "session_cookie",
  "client_secret",
  "raw_runtime_capture",
];

function sanitize(part) {
  return String(part)
    .trim()
    .replace(/[:\s]+/g, "_")
    .replace(/_{2,}/g, "_");
}

function cacheKey(resource, orgId, ...parts) {
  const segments = [CACHE_NS, sanitize(orgId), resource, ...parts.map(sanitize)];
  return segments.join(":");
}

function orgKeyPrefix(orgId) {
  return `${CACHE_NS}:${sanitize(orgId)}:`;
}

function resourceKeyPrefix(resource, orgId) {
  return `${CACHE_NS}:${sanitize(orgId)}:${resource}:`;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok ${name}`);
}

// ── key shape ────────────────────────────────────────────────────────────
check("builds a namespaced, org-scoped key", () => {
  assert.strictEqual(
    cacheKey("gtm_containers", "org-123", "acct-9"),
    "sa:v1:org-123:gtm_containers:acct-9",
  );
});

check("supports numeric parts", () => {
  assert.strictEqual(
    cacheKey("ga4_data_streams", "org1", 123, 456),
    "sa:v1:org1:ga4_data_streams:123:456",
  );
});

check("org prefix is a strict prefix of every key for that org", () => {
  const prefix = orgKeyPrefix("orgX");
  const key = cacheKey("gtm_accounts", "orgX");
  assert.ok(key.startsWith(prefix), `${key} should start with ${prefix}`);
});

check("resource prefix is a strict prefix of resource keys", () => {
  const prefix = resourceKeyPrefix("gtm_workspaces", "orgX");
  const key = cacheKey("gtm_workspaces", "orgX", "c1", "w1");
  assert.ok(key.startsWith(prefix), `${key} should start with ${prefix}`);
});

// ── tenant isolation ───────────────────────────────────────────────────────
check("different orgs never collide", () => {
  const a = cacheKey("gtm_containers", "orgA", "acct");
  const b = cacheKey("gtm_containers", "orgB", "acct");
  assert.notStrictEqual(a, b);
  assert.ok(!a.startsWith(orgKeyPrefix("orgB")));
});

// ── injection resistance ─────────────────────────────────────────────────────
check("delimiter injection in a part cannot forge another key", () => {
  // A malicious id trying to smuggle a ':' delimiter gets sanitized.
  const forged = cacheKey("gtm_containers", "org1", "acct:evil:gtm_accounts");
  assert.ok(!forged.includes("acct:evil"), "colon must be stripped from parts");
  assert.strictEqual(
    forged,
    "sa:v1:org1:gtm_containers:acct_evil_gtm_accounts",
  );
});

check("whitespace in ids is collapsed", () => {
  assert.strictEqual(
    cacheKey("gtm_accounts", "  org 1  "),
    "sa:v1:org_1:gtm_accounts",
  );
});

// ── policy invariants ────────────────────────────────────────────────────────
check("every resource has a policy with sane TTLs", () => {
  for (const [resource, policy] of Object.entries(CACHE_POLICY)) {
    assert.ok(policy.ttlSeconds > 0, `${resource} ttl must be > 0`);
    assert.ok(policy.staleSeconds >= 0, `${resource} stale must be >= 0`);
    // SWR window, when enabled, must extend beyond the hard TTL.
    if (policy.staleSeconds > 0) {
      assert.ok(
        policy.staleSeconds >= policy.ttlSeconds,
        `${resource} stale window should be >= ttl`,
      );
    }
  }
});

check("status caches are short-lived and not revalidated stale", () => {
  assert.ok(CACHE_POLICY.audit_run_status.ttlSeconds <= 30);
  assert.strictEqual(CACHE_POLICY.audit_run_status.staleSeconds, 0);
  assert.ok(CACHE_POLICY.worker_job_status.ttlSeconds <= 30);
  assert.strictEqual(CACHE_POLICY.worker_job_status.staleSeconds, 0);
});

// ── secrets must never be cacheable resources ────────────────────────────────
check("NEVER_CACHE items are not valid cache resources", () => {
  const resources = new Set(Object.keys(CACHE_POLICY));
  for (const item of NEVER_CACHE) {
    assert.ok(
      !resources.has(item),
      `${item} must not be a cacheable resource`,
    );
  }
});

// eslint-disable-next-line no-console
console.log(`\ncache-keys: ${passed} checks passed.`);
