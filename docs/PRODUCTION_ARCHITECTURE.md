# Production Architecture — Scalable Foundation

A forward-looking blueprint for scaling the Samarth Analytics platform from the
current single-tenant-feel, signed-cookie portal into a multi-tenant,
horizontally-scalable production system — **without changing today's
user-facing behavior**.

> This document is a *design + minimal foundation*. The current deployment stays
> exactly as-is (Vercel serverless + signed-cookie sessions, no database). The
> code shipped alongside this doc is **inert scaffolding**: a portable SQL
> schema (`infra/database/0001_init.sql`), typed domain models
> (`apps/portal/shared/production-types.ts`), a cache-key/TTL policy
> (`apps/portal/shared/cache-keys.ts`), and a read-only capability probe
> (`apps/portal/api/system/capabilities.ts`). Nothing here wires a live external
> service. For the system *as it is today*, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Guardrails this design preserves

These are non-negotiable and every component below is designed around them:

- **Read-only by default.** Writes/publishes/deletes stay gated behind
  `GTM_MCP_ENABLE_WRITES/PUBLISH/DELETES` (all default `false`). The DB stores
  audit *reads*, capture artifacts, and workflow state — never an implied write.
  The approval queue is workflow metadata; publishing still goes through the MCP
  guardrail.
- **No secrets in the repo or the database.** OAuth token *bytes* never land in
  Postgres or in any `.env` committed here. Postgres holds only token
  *metadata* + an opaque `token_ref` into an external secret manager.
- **Vercel-safe serverless pattern.** `api/**` files import only `node:*` +
  `import type` at module load; heavy modules load lazily *after* auth. The new
  capability route obeys this; any future DB/cache client must be `await
  import()`-ed inside the handler after session validation.
- **Consent Mode v2 suite stays 170/170.** No engine changes here.
- **All current tool names, routes, and response shapes unchanged.** New
  surfaces are additive (`/api/system/capabilities`); existing routes keep their
  contracts.

---

## 1. System architecture

```
                          ┌──────────────────────────────────────────┐
        Browser           │            Vercel Edge / CDN              │
   (React + Vite SPA) ───▶│  static assets, SPA shell, edge cache     │
                          └───────────────┬──────────────────────────┘
                                          │  /api/*  (same origin)
                                          ▼
                          ┌──────────────────────────────────────────┐
                          │   Serverless API (Vercel functions)       │
                          │   apps/portal/api/**                      │
                          │   • OAuth start/callback/status/logout    │
                          │   • GTM/GA4 discovery proxy               │
                          │   • audit / consent / sgtm execute        │
                          │   • system/capabilities, health           │
                          └───┬───────────┬───────────┬───────────────┘
                              │           │           │
              ┌───────────────┘           │           └────────────────┐
              ▼                           ▼                            ▼
   ┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────┐
   │  Secret manager /  │   │   Postgres (Supabase/     │   │  Redis / Upstash    │
   │  KMS token vault   │   │   Neon/RDS) — durable      │   │  short-lived cache  │
   │  (token BYTES)     │   │   tenancy + audit history  │   │  + job-state lookups│
   └────────────────────┘   └────────────┬─────────────┘   └────────────────────┘
        token_ref ▲                       │  enqueue worker_jobs
                  │                        ▼
   ┌──────────────┴───────┐   ┌──────────────────────────────────────┐
   │  Google APIs         │   │  Runtime capture worker (separate)    │
   │  GTM v2 / GA4 Admin  │   │  apps/runtime-worker — headless       │
   │  / GA4 Data (reads)  │   │  Chromium on Render/Fly/Railway/VPS    │
   └──────────────────────┘   │  leases jobs (SKIP LOCKED), uploads    │
                              │  capture artifacts back                │
                              └──────────────────────────────────────┘
```

### Component boundaries

| Tier | Today | Production target |
| --- | --- | --- |
| **Frontend** | React+Vite SPA on Vercel CDN | Unchanged. Add edge caching of static assets; client reads `/api/system/capabilities` to gate UI. |
| **API gateway** | Vercel serverless `api/**` | Unchanged shape. Becomes the only tier that holds a backend service identity (resolves `token_ref`, talks to DB/cache). |
| **Session/token** | Signed cookie holding tokens | Cookie holds only a session id; token bytes move to a secret-manager vault keyed by `oauth_connections.token_ref`. Backwards-compatible cutover (see §3). |
| **Durable state** | none | Postgres: orgs, users, audit history, captures, jobs, approvals. |
| **Cache** | none | Redis/Upstash: discovery lists (SWR) + job/run status. |
| **Async work** | runtime worker called ad-hoc | Postgres-backed job queue (`worker_jobs`, SKIP LOCKED) → swap to SQS/QStash later with no schema change. |

---

## 2. Component structure

```
apps/portal/
  client/                     # React SPA (unchanged)
  api/                        # Vercel serverless routes (Vercel-safe)
    system/capabilities.ts    # NEW: read-only subsystem probe
    health.ts                 # existing
    oauth/*, gtm/*, ga4/*     # existing — contracts unchanged
  server/                     # local Express mirror (unchanged)
  shared/
    portal-types.ts           # product shapes (source of truth) — unchanged
    consent-audit.ts          # consent engine — unchanged (170/170)
    production-types.ts       # DB domain models + ProductionStore iface
    cache-keys.ts             # cache key namespace + TTL policy
    cache.ts                  # NEW: CacheStore iface + in-memory/noop + Upstash skeleton
    jobs.ts                   # NEW: job lifecycle + payload/result + JobQueue + adapters
    __tests__/
      consent-audit.node.test.ts   # unchanged
      cache-keys.node.test.mjs     # cache-key invariants
      cache.node.test.mjs          # NEW: TTL/SWR + policy behavior
      jobs.node.test.mjs           # NEW: lifecycle/lease/retry invariants
apps/runtime-worker/          # headless capture worker
  server.mjs                  # HTTP /capture (default mode, unchanged)
  queue-consumer.mjs          # NEW: opt-in queue-consumer skeleton
infra/
  database/
    0001_init.sql             # portable Postgres schema
docs/
  ARCHITECTURE.md             # system as-is
  PRODUCTION_ARCHITECTURE.md  # this file
  API_JOBS.md                 # NEW: async create/status/result + cache contract
```

The `ProductionStore` interface in `production-types.ts` is the seam: route and
worker code can be written against it now; a concrete `pg`/Drizzle/Supabase
implementation drops in later without touching call sites. Two more seams join
it: `CacheStore` (`cache.ts`) and `JobQueue` (`jobs.ts`) — both pure interfaces
with in-memory/noop dev adapters today, so call sites are backend-agnostic
before any Redis/Upstash or durable queue is provisioned. The async API contract
they back is specified in [`API_JOBS.md`](./API_JOBS.md).

---

## 3. OAuth / session / token storage strategy

**Today:** stateless signed cookie (`PORTAL_SESSION_SECRET`, HMAC-SHA256) holds
the access/refresh tokens directly; refresh happens lazily and rotates the
cookie. Simple, no infra, but tokens travel in the cookie and the cookie size
grows with scope.

**Production target — server-side token vault:**

1. Cookie holds only an opaque, signed **session id** (HttpOnly, SameSite=Lax,
   Secure). No token bytes in the browser.
2. `oauth_connections` row stores **metadata only**: `scopes`,
   `access_expires_at`, `has_refresh`, and `token_ref`.
3. `token_ref` points into a **secret manager / KMS-encrypted vault** (GCP
   Secret Manager, AWS Secrets Manager, or a KMS-encrypted column). Only the
   backend service identity can resolve it.
4. Refresh: the API checks `access_expires_at`, resolves `token_ref`, refreshes
   against Google, and writes the new token back to the vault — never to
   Postgres, never to the cookie.

**Migration path (no behavior change):** the cookie format is versioned (`v1`
today). Introduce `v2` = session-id cookie. On read, accept both: `v1` keeps
working until expiry; new logins mint `v2`. The signed-cookie code stays as the
fallback when no DB/vault is configured — `/api/system/capabilities` reports
`sessionMode: "signed_cookie"` until `DATABASE_URL` is present, then
`"database"`.

---

## 4. Data flow

### 4.1 Discovery (account → container → workspace; GA4 property → stream)

```
client → GET /api/gtm/accounts
  → validate session (resolve token via vault)
  → cache GET  cacheKey("gtm_accounts", orgId)        [cache-keys.ts]
      hit  → return (SWR: if stale, return + async refresh)
      miss → googleapis tagmanager_v2 list (paginated)
           → upsert gtm_accounts snapshot (warm DB cache)
           → cache SET ttl=300s
  → return { accounts, count }
```

Snapshots in Postgres are a *warm* cache (survive cold starts, queryable);
Redis is the *hot* cache (sub-ms, TTL'd). Google remains source of truth.

### 4.2 Audit run (async-capable orchestration)

```
client → POST /api/gtm/audit { containerId, runtimeCaptureId? }
  → validate session
  → create audit_runs row (status=queued)            [synchronous today]
  → run engine inline (config + optional runtime)      ← current behavior
  → persist findings → audit_findings, set status=succeeded, severity_counts
  → return AuditSummary (unchanged shape)

# At scale, the same row supports a deferred model:
client → POST /api/gtm/audit         → 202 { auditRunId, status: "queued" }
client → GET  /api/audit-runs/:id     → poll status (cache: audit_run_status, 10s)
worker/function → executes, writes findings, flips status
```

The response shape returned to the client is **unchanged**; the async variant is
additive (a new status endpoint), opt-in per deployment. Full request/response
contract and the status state machine: [`API_JOBS.md`](./API_JOBS.md).

### 4.3 Runtime capture (queue + worker)

```
client → POST /api/runtime/capture { urls[], consentScenarios[] }
  → validate session
  → enqueue worker_jobs (status=queued, payload=urls+scenarios)
  → return { jobId }

worker (apps/runtime-worker, separate host):
  → leaseNextJob (SELECT ... FOR UPDATE SKIP LOCKED, set lease_expires_at)
  → drive headless Chromium, build capture artifact
  → POST artifact back → runtime_captures (artifact or artifact_uri)
  → completeJob(jobId, captureId); link audit_runs.runtime_capture_id

client → GET /api/runtime/capture/:jobId  → status (cache: worker_job_status,10s)
```

Lease + `attempts`/`max_attempts` give at-least-once delivery with retry. The
partial index `worker_jobs_queue_idx` keeps dequeue O(1)-ish on the hot path.

---

## 5. API design

All under same-origin `/api`. **Existing routes keep their exact contracts.**
New/extended routes are marked. Auth = signed session cookie unless noted.

### Auth / session / profile
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/oauth/start` | existing — begin Google OAuth |
| GET | `/api/oauth/callback` | existing — token exchange, set session |
| GET | `/api/oauth/status` | existing — `OAuthState` |
| POST | `/api/oauth/logout` | existing — clear session |
| GET | `/api/system/capabilities` | **NEW** — subsystem presence, `sessionMode` |
| GET | `/api/health` | existing |

### Projects / workspaces
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/projects` | **future** — list saved audit targets (org-scoped) |
| POST | `/api/projects` | **future** — create project |
| GET | `/api/projects/:id` | **future** |

### GTM / GA4 discovery
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/gtm/accounts` | existing |
| GET | `/api/gtm/accounts/:accountId/containers` | existing |
| GET | `/api/gtm/accounts/:accountId/containers/:containerId/workspaces` | existing |
| GET | `/api/ga4/admin` | existing — properties + streams |

### Audit run create / status / result
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/gtm/audit` | existing — returns `AuditSummary`. **Future:** may return `202 {auditRunId}` when async enabled |
| POST | `/api/gtm/consent-audit` | existing — `ConsentAuditResponse` |
| GET | `/api/audit-runs/:id` | **future** — run status + result (cached 10s) |

### Runtime capture request / upload / result
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/runtime/capture` | **future** — enqueue a `worker_job`, return `{jobId}` |
| GET | `/api/runtime/capture/:jobId` | **future** — job status (cached 10s) |
| POST | `/api/runtime/capture/:jobId/artifact` | **future** — worker→API upload (worker bearer auth, not session) |

### sGTM overview
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/gtm/sgtm` | existing — `SgtmOverview` (action `overview`) |

### Approval queue
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/approvals` | **future** — list (`status` filter) |
| POST | `/api/approvals` | **future** — submit a change plan for review |
| POST | `/api/approvals/:id/decision` | **future** — approve/reject (does NOT publish; publish stays MCP-guardrailed) |

---

## 6. Database schema summary

Full DDL: [`infra/database/0001_init.sql`](../infra/database/0001_init.sql).
Typed models: [`apps/portal/shared/production-types.ts`](../apps/portal/shared/production-types.ts).

| Table | Purpose | Key columns |
| --- | --- | --- |
| `organizations` | Tenants (white-label). | `slug`, `plan`, `settings` |
| `users` | Identities (Google `sub`). | `google_sub`, `email` |
| `memberships` | user↔org with role; RLS unit. | `org_id`, `user_id`, `role` |
| `oauth_connections` | **Token metadata only** — no token bytes. | `token_ref`, `scopes`, `access_expires_at`, `has_refresh` |
| `gtm_accounts` / `gtm_containers` / `gtm_workspaces` | Discovery snapshots (warm cache). | `(org_id, …)` unique, `fetched_at` |
| `ga4_properties` / `ga4_data_streams` | GA4 metadata cache. | `property_id`, `measurement_id` |
| `projects` | Saved audit targets. | container + GA4 property refs |
| `audit_runs` | One audit execution. | `kind`, `status`, `capability_flags`, `health_score`, `severity_counts`, `result` |
| `audit_findings` | Normalized findings. | `severity`, `category`, `sources`, `detail` |
| `worker_jobs` | Durable job queue (SKIP LOCKED). | `status`, `lease_expires_at`, `attempts` |
| `runtime_captures` | Capture artifacts (PII-sensitive). | `artifact` / `artifact_uri`, `expires_at` |
| `approval_requests` | Change-plan review workflow. | `status`, `plan`, `risk_level` |

**Tenancy & isolation:** every tenant-scoped table carries `org_id` and has an
illustrative Row-Level-Security policy keyed on `current_setting('app.current_org_id')`.
Policies are created but not `FORCE`d — enable forcing only after the app
reliably sets the GUC per transaction, so migrations don't lock themselves out.

**Enum strategy:** CHECK-constrained text (not native ENUM) so values extend via
cheap migrations and stay in lockstep with `portal-types.ts`.

**Large blobs:** `audit_runs.result` and `runtime_captures.artifact` are JSONB
for fidelity now; the scaling roadmap moves them to object storage with only a
`*_uri` pointer kept in Postgres.

---

## 7. Caching strategy

Policy + keys: [`apps/portal/shared/cache-keys.ts`](../apps/portal/shared/cache-keys.ts)
(pure, no Redis connection). Abstraction + adapters:
[`apps/portal/shared/cache.ts`](../apps/portal/shared/cache.ts) — the
`CacheStore` interface, an in-memory TTL/SWR implementation for tests, a no-op
default, and a dependency-free `UpstashRestCache` skeleton. `getOrSet` /
`setWithPolicy` read TTLs straight from `CACHE_POLICY` so call sites never
hardcode them. Recommended backend: **Upstash Redis REST** (works from Vercel
functions over HTTPS; no socket pool to manage).

### Keys
All keys are tenant-scoped first: `sa:v1:{orgId}:{resource}:{…parts}`. This makes
per-tenant flush a prefix delete and prevents cross-tenant collisions. Parts are
sanitized (`:`/whitespace collapsed) so a malformed id can't forge another key.

### TTLs (from `CACHE_POLICY`)
| Resource | TTL | Stale (SWR) |
| --- | --- | --- |
| `gtm_accounts` | 300s | 600s |
| `gtm_containers` | 300s | 600s |
| `gtm_workspaces` | 120s | 300s |
| `ga4_properties` | 300s | 600s |
| `ga4_data_streams` | 300s | 600s |
| `audit_run_status` | 10s | — |
| `worker_job_status` | 10s | — |

### Stale-while-revalidate
Discovery lists serve a stale entry instantly (within the stale window) while
kicking off an async refresh. Status lookups are short-TTL and **not** served
stale — a polling client must see fresh state.

### Invalidation triggers
- **Discovery lists:** on TTL expiry; on explicit reconnect/re-consent; on a
  detected 401/permission change (drop the org prefix).
- **Audit/job status:** natural TTL expiry; on terminal state transition the
  writer deletes the status key so the next poll reflects completion.
- **Tenant-wide:** delete by `orgKeyPrefix(orgId)` on logout/disconnect.

### What NOT to cache (`NEVER_CACHE`, asserted by tests)
- OAuth access/refresh tokens, session cookies, client secrets — **never** in a
  shared cache.
- **Raw runtime captures** — may contain PII in `dataLayer` values. Cache/store
  only redacted or encrypted forms, under a retention policy (`expires_at`), and
  never expose to the browser without redaction.

---

## 8. Observability / monitoring / logging

> Full playbook — event catalog, metric names, dashboards, and alert
> thresholds — lives in [`OBSERVABILITY.md`](./OBSERVABILITY.md). The structured
> event taxonomy + redaction (`apps/portal/shared/observability.ts`) and the
> metric naming contract (`apps/portal/shared/metrics.ts`) are shipped as inert
> foundation (no vendor SDK, no live connection); call sites adopt them
> incrementally.

- **Structured logs:** JSON lines from serverless + worker (request id, org id —
  *never* token bytes or raw capture payloads). Ship to a log sink (Vercel log
  drains / Datadog / Logtail).
- **Metrics:** request rate/latency/error per route; Google API call count +
  quota headroom; cache hit ratio per resource; queue depth + job age +
  retry/fail counts (`worker_jobs`).
- **Tracing:** propagate a trace id from the client through API → vault → Google
  so a slow audit is attributable to a specific upstream call.
- **Alerts:** OAuth refresh failure spike (mass re-consent signal), queue age
  over SLO, Google quota near limit, audit failure rate.
- **Health/readiness:** `/api/health` (liveness) + `/api/system/capabilities`
  (which subsystems are wired) for deploy verification.

---

## 9. Scaling roadmap

Each phase is independently shippable and preserves current behavior.

**Phase 0 — Foundation.** Schema, domain types, cache-key policy, capability
probe, env docs. No live services. *Done.*

**Phase 0.5 — Storage/security primitives (Workstream A).** DB client
abstraction + config (`shared/db/`), `TokenVault` interface + inert dev stub
(`shared/token-vault.ts`), pure RBAC matrix/authorization (`shared/rbac.ts`), and
retention policy/cutoff helpers (`shared/retention.ts`), all unit-tested without
credentials. The Postgres adapter is a loud-failing skeleton (no driver
dependency). See [`STORAGE_SECURITY.md`](./STORAGE_SECURITY.md). No live
services. *Done.*

**Phase 0.5 — Inert async + cache abstractions (Workstream B).** Pure
`CacheStore` (`cache.ts`) + `JobQueue` (`jobs.ts`) interfaces with in-memory/noop
dev adapters and an Upstash REST skeleton; runtime-capture payload/result
schemas; an opt-in worker queue-consumer skeleton (`queue-consumer.mjs`); the
async create/status/result API contract ([`API_JOBS.md`](./API_JOBS.md)). Still
no live services — defaults are no-op, current synchronous routes and the
worker's HTTP `/capture` are unchanged. *Done.*

**Phase 1 — Durable identity + discovery cache.** Provision Postgres; flesh out
the `PostgresStore` skeleton (orgs/users/memberships, discovery snapshots). Wire
Upstash for discovery SWR behind a feature check on `DATABASE_URL`/`UPSTASH_*`.
Cookie stays `v1`; no UX change.

**Phase 2 — Token vault.** Introduce `v2` session-id cookie + secret-manager
vault; dual-read cookies for backwards compatibility. Tokens leave the browser.

**Phase 3 — Audit history.** Persist `audit_runs` + `audit_findings` on every
run (still synchronous). Adds history/trends UI; response shapes unchanged.

**Phase 4 — Async orchestration + worker queue.** `worker_jobs` (Postgres SKIP
LOCKED) drives the runtime worker; add `202 + status-poll` audit variant.
Graduate the queue to SQS/QStash if volume warrants — no schema change.

**Phase 5 — Object storage for blobs.** Move `audit_runs.result` and
`runtime_captures.artifact` to S3/GCS, keep `*_uri` pointers; enforce
`expires_at` retention via a sweep job.

**Phase 6 — Horizontal hardening.** Replace the in-process MCP HTTP session map
(ARCHITECTURE.md R5) with a shared store; per-tenant rate limits via cache;
read replicas if audit-history reads grow.

### Non-goals / invariants for every phase
- Read-only defaults and `confirm` + capability-flag publish gates.
- All existing tool names, routes, and response shapes.
- `node:*`-only top-level imports in `api/**` (DB/cache clients load lazily,
  after auth).
- Consent v2 suite at 170/170.
- No secrets in repo or Postgres; token bytes only in the vault.
- Portal mobile/tablet/desktop compatibility.
