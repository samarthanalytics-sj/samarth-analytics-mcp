/**
 * Standalone Node test for the cache abstraction (../cache.ts).
 * Run: node apps/portal/shared/__tests__/cache.node.test.mjs
 *
 * Mirrors the runtime behaviour of apps/portal/shared/cache.ts without importing
 * TS (kept dependency-free like the other .node.test.mjs files). If the .ts
 * logic changes, update this mirror. Focus: TTL expiry, stale-while-revalidate
 * window, prefix flush, and policy-driven key/TTL behaviour via cache-keys.
 *
 * Time is injected (`now`) so the suite is deterministic and never sleeps.
 */

import assert from "node:assert";

// ── cache-key policy mirror (kept in lockstep with cache-keys.ts) ────────────
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
function sanitize(part) {
  return String(part).trim().replace(/[:\s]+/g, "_").replace(/_{2,}/g, "_");
}
function cacheKey(resource, orgId, ...parts) {
  return [CACHE_NS, sanitize(orgId), resource, ...parts.map(sanitize)].join(":");
}
function policyFor(resource) {
  return CACHE_POLICY[resource];
}

// ── InMemoryCache mirror ─────────────────────────────────────────────────────
class InMemoryCache {
  constructor(opts = {}) {
    this.map = new Map();
    this.now = opts.now ?? (() => Date.now());
  }
  async get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    const t = this.now();
    if (t < e.expiresAt) return { value: e.value, stale: false };
    if (t < e.staleUntil) return { value: e.value, stale: true };
    this.map.delete(key);
    return null;
  }
  async set(key, value, ttlSeconds, staleSeconds = 0) {
    const t = this.now();
    const expiresAt = t + ttlSeconds * 1000;
    const staleUntil =
      staleSeconds > 0 ? t + Math.max(staleSeconds, ttlSeconds) * 1000 : expiresAt;
    this.map.set(key, { value, expiresAt, staleUntil });
  }
  async delete(key) {
    this.map.delete(key);
  }
  async deleteByPrefix(prefix) {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        n++;
      }
    }
    return n;
  }
  size() {
    return this.map.size;
  }
}

class NoopCache {
  async get() {
    return null;
  }
  async set() {}
  async delete() {}
  async deleteByPrefix() {
    return 0;
  }
}

async function setWithPolicy(store, resource, orgId, parts, value) {
  const policy = policyFor(resource);
  const key = cacheKey(resource, orgId, ...parts);
  await store.set(key, value, policy.ttlSeconds, policy.staleSeconds);
  return key;
}

async function getOrSet(store, resource, orgId, parts, load) {
  const policy = policyFor(resource);
  const key = cacheKey(resource, orgId, ...parts);
  const hit = await store.get(key);
  if (hit && !hit.stale) return hit.value;
  if (hit && hit.stale) {
    void Promise.resolve()
      .then(load)
      .then((fresh) => store.set(key, fresh, policy.ttlSeconds, policy.staleSeconds))
      .catch(() => {});
    return hit.value;
  }
  const fresh = await load();
  await store.set(key, fresh, policy.ttlSeconds, policy.staleSeconds);
  return fresh;
}

let clock = 0;
const now = () => clock;
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok ${name}`);
}

// ── TTL behaviour ────────────────────────────────────────────────────────────
await check("returns a fresh hit within TTL", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set("k", { a: 1 }, 10);
  clock = 9_000;
  const hit = await c.get("k");
  assert.deepStrictEqual(hit, { value: { a: 1 }, stale: false });
});

await check("hard-expires after TTL when no stale window", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set("k", 42, 10, 0);
  clock = 10_001;
  assert.strictEqual(await c.get("k"), null);
});

await check("evicts fully-expired entry on read", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set("k", 1, 10, 0);
  clock = 20_000;
  await c.get("k");
  assert.strictEqual(c.size(), 0, "expired entry should be evicted");
});

// ── stale-while-revalidate window ────────────────────────────────────────────
await check("serves stale within the SWR window", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set("k", "v", 10, 60);
  clock = 30_000; // past TTL (10s), within stale (60s)
  const hit = await c.get("k");
  assert.deepStrictEqual(hit, { value: "v", stale: true });
});

await check("misses once past the stale window", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set("k", "v", 10, 60);
  clock = 60_001;
  assert.strictEqual(await c.get("k"), null);
});

await check("stale window never shrinks below the hard TTL", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  // Misconfigured: stale < ttl. set() must floor staleUntil at expiresAt.
  await c.set("k", "v", 30, 5);
  clock = 20_000; // within ttl
  assert.deepStrictEqual(await c.get("k"), { value: "v", stale: false });
});

// ── prefix flush ─────────────────────────────────────────────────────────────
await check("deleteByPrefix flushes one tenant only", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await c.set(cacheKey("gtm_accounts", "orgA"), 1, 300);
  await c.set(cacheKey("gtm_containers", "orgA", "acct"), 2, 300);
  await c.set(cacheKey("gtm_accounts", "orgB"), 3, 300);
  const removed = await c.deleteByPrefix(`${CACHE_NS}:orgA:`);
  assert.strictEqual(removed, 2);
  assert.ok(await c.get(cacheKey("gtm_accounts", "orgB")), "orgB must survive");
  assert.strictEqual(await c.get(cacheKey("gtm_accounts", "orgA")), null);
});

// ── policy-driven helpers ────────────────────────────────────────────────────
await check("setWithPolicy applies the resource TTL + stale window", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  const key = await setWithPolicy(c, "gtm_workspaces", "org1", ["c1"], ["w1"]);
  assert.strictEqual(key, "sa:v1:org1:gtm_workspaces:c1");
  clock = 200_000; // past 120s ttl, within 300s stale
  const hit = await c.get(key);
  assert.deepStrictEqual(hit, { value: ["w1"], stale: true });
});

await check("getOrSet loads on miss then serves the cached value", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  let loads = 0;
  const load = async () => {
    loads++;
    return { n: loads };
  };
  const first = await getOrSet(c, "gtm_accounts", "org1", [], load);
  const second = await getOrSet(c, "gtm_accounts", "org1", [], load);
  assert.deepStrictEqual(first, { n: 1 });
  assert.deepStrictEqual(second, { n: 1 }, "second call must be a cache hit");
  assert.strictEqual(loads, 1, "load should run exactly once");
});

await check("getOrSet serves stale immediately and revalidates async", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  let loads = 0;
  const load = async () => {
    loads++;
    return { n: loads };
  };
  await getOrSet(c, "gtm_accounts", "org1", [], load); // n:1, loads=1
  clock = 400_000; // past 300s ttl, within 600s stale
  const served = await getOrSet(c, "gtm_accounts", "org1", [], load);
  assert.deepStrictEqual(served, { n: 1 }, "must serve the stale value instantly");
  await Promise.resolve(); // let the fire-and-forget revalidate settle
  await Promise.resolve();
  assert.strictEqual(loads, 2, "stale read should trigger one background reload");
});

await check("status resources do not serve stale (TTL only)", async () => {
  clock = 0;
  const c = new InMemoryCache({ now });
  await setWithPolicy(c, "audit_run_status", "org1", ["run1"], { status: "running" });
  clock = 11_000; // past the 10s ttl; stale=0 means hard miss
  assert.strictEqual(await c.get(cacheKey("audit_run_status", "org1", "run1")), null);
});

// ── noop cache ───────────────────────────────────────────────────────────────
await check("NoopCache always misses and drops writes", async () => {
  const c = new NoopCache();
  await c.set("k", 1, 10);
  assert.strictEqual(await c.get("k"), null);
  assert.strictEqual(await c.deleteByPrefix("x"), 0);
});

// eslint-disable-next-line no-console
console.log(`\ncache: ${passed} checks passed.`);
