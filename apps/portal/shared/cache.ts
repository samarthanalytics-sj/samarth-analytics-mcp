// Cache abstraction — built on the cache-keys.ts namespace + TTL policy.
//
// FORWARD-LOOKING foundation (Workstream B). Defines a small `CacheStore`
// interface plus an in-memory TTL/SWR implementation for tests and local dev,
// and an Upstash Redis REST adapter *skeleton* that is dependency-free (it uses
// global `fetch` only and is constructed lazily). Nothing here opens a
// connection at module load, so this file is safe to import from the Vercel
// serverless `api/**` routes and from the worker.
//
// All keys flow through cacheKey()/policyFor() from cache-keys.ts so the
// namespace and TTLs stay consistent. See docs/PRODUCTION_ARCHITECTURE.md §7.

import {
  type CacheResource,
  cacheKey,
  policyFor,
} from "./cache-keys";

export interface CacheGetResult<T> {
  value: T;
  /** True when within the SWR window (past hard TTL): serve + revalidate. */
  stale: boolean;
}

/**
 * Minimal cache contract. Keys are opaque strings — always built via
 * cacheKey() so tenant scoping and sanitization are preserved. `ttlSeconds` is
 * the hard expiry; `staleSeconds` (when > 0) extends visibility for SWR, during
 * which `get` returns `{ stale: true }`.
 */
export interface CacheStore {
  get<T>(key: string): Promise<CacheGetResult<T> | null>;
  set<T>(key: string, value: T, ttlSeconds: number, staleSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete every key beginning with `prefix` (tenant/resource flush). */
  deleteByPrefix(prefix: string): Promise<number>;
}

interface MemoryEntry {
  value: unknown;
  /** Hard expiry epoch ms; past this the entry is gone unless within stale window. */
  expiresAt: number;
  /** Stale expiry epoch ms; between expiresAt and this, served as stale. */
  staleUntil: number;
}

/**
 * In-memory `CacheStore` with TTL + stale-while-revalidate semantics. Suitable
 * for tests and single-process dev only (not shared across serverless
 * invocations). `now` is injectable so tests can advance time deterministically
 * without sleeping.
 */
export class InMemoryCache implements CacheStore {
  private readonly map = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async get<T>(key: string): Promise<CacheGetResult<T> | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    const t = this.now();
    if (t < entry.expiresAt) {
      return { value: entry.value as T, stale: false };
    }
    if (t < entry.staleUntil) {
      return { value: entry.value as T, stale: true };
    }
    // Fully expired — evict and miss.
    this.map.delete(key);
    return null;
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    staleSeconds = 0,
  ): Promise<void> {
    const t = this.now();
    const expiresAt = t + ttlSeconds * 1000;
    // staleSeconds is measured from `set` and, by policy, always >= ttl when
    // enabled; guard so a misconfigured 0/short value never shrinks the window
    // below the hard TTL.
    const staleUntil = staleSeconds > 0 ? t + Math.max(staleSeconds, ttlSeconds) * 1000 : expiresAt;
    this.map.set(key, { value, expiresAt, staleUntil });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Test helper — current entry count (including not-yet-evicted stale ones). */
  size(): number {
    return this.map.size;
  }
}

/**
 * No-op cache: every read misses, every write is dropped. The safe default when
 * no cache is configured — callers fall back to the source of truth (Google
 * APIs) on every request, preserving today's behavior.
 */
export class NoopCache implements CacheStore {
  async get<T>(): Promise<CacheGetResult<T> | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async deleteByPrefix(): Promise<number> {
    return 0;
  }
}

/**
 * Upstash Redis REST adapter — SKELETON.
 *
 * Dependency-free: uses Upstash's HTTP REST API via global `fetch`, so there is
 * no socket pool and no npm dependency to add. Construct it lazily *inside* an
 * `api/**` handler after auth (never at module load) per the Vercel-safe rule.
 *
 * `deleteByPrefix` is intentionally NOT implemented here: a production prefix
 * flush should use a server-side `SCAN`/`UNLINK` Lua script rather than a
 * blocking `KEYS` scan from a serverless function. It throws so a caller can't
 * silently assume a flush happened. Everything else maps 1:1 to REST commands.
 *
 * This skeleton is unit-tested for command shaping but is not exercised against
 * a live Upstash instance in CI (no credentials required).
 */
export class UpstashRestCache implements CacheStore {
  constructor(
    private readonly opts: {
      url: string;
      token: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    if (!opts.url || !opts.token) {
      throw new Error("UpstashRestCache requires { url, token }");
    }
  }

  private get f(): typeof fetch {
    const impl = this.opts.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error("global fetch is unavailable in this runtime");
    return impl;
  }

  /** POST a Redis command array to the Upstash REST endpoint. */
  private async command<T = unknown>(args: Array<string | number>): Promise<T> {
    const res = await this.f(this.opts.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`upstash command failed: ${res.status}`);
    }
    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) throw new Error(`upstash error: ${json.error}`);
    return json.result as T;
  }

  async get<T>(key: string): Promise<CacheGetResult<T> | null> {
    const raw = await this.command<string | null>(["GET", key]);
    if (raw == null) return null;
    // SWR for the REST adapter relies on a server-side TTL only; without a
    // sidecar timestamp we report fresh. A future revision can store
    // {v, exp, staleUntil} as the value to recover SWR semantics.
    return { value: JSON.parse(raw) as T, stale: false };
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.command(["SET", key, JSON.stringify(value), "EX", ttlSeconds]);
  }

  async delete(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  async deleteByPrefix(_prefix: string): Promise<number> {
    throw new Error(
      "UpstashRestCache.deleteByPrefix is not implemented — use a server-side SCAN/UNLINK script",
    );
  }
}

/**
 * Set a value using the configured policy for a resource. Reads ttl/stale from
 * CACHE_POLICY so call sites never hardcode TTLs.
 */
export async function setWithPolicy<T>(
  store: CacheStore,
  resource: CacheResource,
  orgId: string,
  parts: Array<string | number>,
  value: T,
): Promise<string> {
  const policy = policyFor(resource);
  const key = cacheKey(resource, orgId, ...parts);
  await store.set(key, value, policy.ttlSeconds, policy.staleSeconds);
  return key;
}

/**
 * Read-through cache: return a fresh hit, serve+revalidate a stale hit, or load
 * on miss. The TTL/stale window comes from CACHE_POLICY. `revalidate` (for SWR)
 * is fire-and-forget; its rejection is swallowed so a refresh failure never
 * breaks the request that served stale data.
 */
export async function getOrSet<T>(
  store: CacheStore,
  resource: CacheResource,
  orgId: string,
  parts: Array<string | number>,
  load: () => Promise<T>,
): Promise<T> {
  const policy = policyFor(resource);
  const key = cacheKey(resource, orgId, ...parts);
  const hit = await store.get<T>(key);
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

/**
 * Pick a dev/test cache from env, defaulting to the no-op cache so the current
 * deployment keeps hitting Google directly. A live Upstash adapter is
 * constructed by the caller (lazily, after auth) — NOT here — to honor the
 * Vercel-safe import rule.
 *
 *   GTM_PORTAL_CACHE = "memory" → InMemoryCache
 *   anything else / unset       → NoopCache
 */
export function selectDevCache(
  env: Record<string, string | undefined> = process.env,
): CacheStore {
  return env.GTM_PORTAL_CACHE === "memory" ? new InMemoryCache() : new NoopCache();
}
