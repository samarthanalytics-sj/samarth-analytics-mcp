# Production Cutover Runbook

How to take the Samarth Analytics platform from its current **foundation-only**
state (Vercel serverless + signed-cookie sessions, no live durable services) to a
durable, multi-tenant production deployment — **one subsystem at a time, each
independently reversible, with no user-facing behavior change until you choose to
flip a flag.**

> **Current state (2026-06): foundation only.** Every durable subsystem below is
> *scaffolded but not wired.* No live Postgres, token vault, Redis/Upstash, job
> queue, deployed runtime worker, or metrics exporter is connected. The code seams
> exist and are unit-tested without credentials:
>
> - Durable store: [`apps/portal/shared/db/`](../apps/portal/shared/db) +
>   [`infra/database/0001_init.sql`](../infra/database/0001_init.sql)
> - Token vault: [`apps/portal/shared/token-vault.ts`](../apps/portal/shared/token-vault.ts)
> - Cache: [`apps/portal/shared/cache.ts`](../apps/portal/shared/cache.ts) +
>   [`cache-keys.ts`](../apps/portal/shared/cache-keys.ts)
> - Jobs: [`apps/portal/shared/jobs.ts`](../apps/portal/shared/jobs.ts)
> - Worker queue mode: [`apps/runtime-worker/queue-consumer.mjs`](../apps/runtime-worker/queue-consumer.mjs)
> - Observability: [`apps/portal/shared/observability.ts`](../apps/portal/shared/observability.ts) +
>   [`metrics.ts`](../apps/portal/shared/metrics.ts)
> - Readiness probe: [`apps/portal/api/system/capabilities.ts`](../apps/portal/api/system/capabilities.ts)
>
> This runbook is **provider-neutral**. It does not pick Supabase over Neon, or
> Datadog over Grafana — it gives the generic steps plus concrete examples so the
> work is executable the moment a provider is chosen. See
> [`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md) for the design and
> [`STORAGE_SECURITY.md`](./STORAGE_SECURITY.md) / [`OBSERVABILITY.md`](./OBSERVABILITY.md)
> for the storage-security and observability contracts this runbook executes.

---

## How to use this runbook

- Each phase is **independently shippable and reversible.** Do them in order; do
  not start a phase until the prior one meets its success criteria.
- "Provider-neutral steps" apply to any backend. "Example —" callouts show a
  specific provider so the step is concrete.
- Secrets are set in the **platform's** environment (Vercel Project → Settings →
  Environment Variables, the worker host's secret store), **never** committed to
  the repo. The `.env.example` files list the variable *names* only.
- After every phase, hit `GET /api/system/capabilities` and confirm the affected
  subsystem reports the expected `readiness`. That endpoint reads env *presence*
  only — it never returns a secret — and is the canonical post-deploy gate.

### Guardrails that hold across every phase

These are non-negotiable (see [CLAUDE.md](../CLAUDE.md)). A phase that would
violate one is wrong, no matter how convenient:

- **Read-only by default.** `GTM_MCP_ENABLE_WRITES/PUBLISH/DELETES` stay `false`.
  The portal's strongest action remains `approval:decide`, which never publishes.
- **No token bytes in Postgres or the repo.** Postgres holds only
  `oauth_connections.token_ref`; bytes live in the vault.
- **`api/**` import safety.** Files under `apps/portal/api/` import only `node:*`
  and `import type` at module load; DB/cache/vault clients load via
  `await import()` *inside the handler, after auth*.
- **Consent v2 suite stays 170/170** (`npm run test:consent`).
- **Portal stays responsive** on mobile/tablet/desktop.

---

## Rollout order at a glance

| Phase | Subsystem | Goal | Reversible by |
| :-: | --- | --- | --- |
| 1 | **Postgres / Supabase** | Deploy schema; read-only capability probe | Unset `DATABASE_URL` |
| 2 | **Token vault** | Move token bytes out of cookie; dual-read/dual-write | Keep `v1` cookie fallback; unset vault vars |
| 3 | **Redis / Upstash cache** | Read-through + SWR for discovery lists | Unset cache vars (falls back to no-op) |
| 4 | **Async job queue** | Shadow-mode audits/captures (no client impact) | Keep synchronous path as default |
| 5 | **Runtime worker** | Deploy headless-Chromium worker behind queue | Scale worker to 0; unset worker URL |
| 6 | **Observability** | Wire metrics exporter + activate alerts | Stop exporter; logs already structured |

Each phase below has the same structure: **What it does → Provider-neutral steps →
Provider examples → Env vars (secret vs non-secret) → Migration/validation →
Smoke test & success criteria → Rollback → Security checks → Cost/scaling.**

---

## Phase 1 — Postgres / Supabase schema deploy + read-only probe

**What it does.** Provisions the durable database and applies the portable schema.
No application code starts *reading from* or *writing to* it yet — this phase only
proves the schema applies cleanly and the capability probe flips to `ready`.

### Provider-neutral steps

1. Provision a managed Postgres (15+) with TLS required.
2. Apply [`infra/database/0001_init.sql`](../infra/database/0001_init.sql) (idempotent;
   creates tables, CHECK-constrained enums, RLS policies — created but **not**
   `FORCE`d yet, by design).
3. Create a least-privilege application role (it needs DML on the app tables and
   the ability to `SET app.current_org_id`; it does **not** need superuser).
4. Put the connection string in the platform env as a **secret** (`DATABASE_URL`
   or `PORTAL_DATABASE_URL` — they must not disagree;
   [`db/config.ts`](../apps/portal/shared/db/config.ts) enforces TLS + parses the
   pool/timeout hints).
5. Redeploy. The `PostgresStore` skeleton remains a *loud-failing* stub
   ([`postgres-store.ts`](../apps/portal/shared/db/postgres-store.ts)) — call sites
   still take the stateless path because nothing reads from it yet. This phase is a
   **schema + connectivity** milestone, not a code cutover.

> **Example — Supabase.** Create a project; run the SQL in the SQL Editor (or
> `supabase db push` with the file as a migration). Use the **session pooler**
> connection string (port 6543, `?pgbouncer=true`) for serverless;
> `?sslmode=require`. The service-role key is **not** used for app queries — only
> the pooled app role.
>
> **Example — Neon.** Create a project + branch; apply the SQL via `psql`. Use the
> pooled endpoint (`-pooler` host) so Vercel functions don't exhaust connections.
>
> **Example — RDS/Cloud SQL.** Put the DB in a private subnet; reach it from
> Vercel via the provider's connection proxy or a PgBouncer in front. Rotate the
> app password via the platform secret store.

### Env vars

| Var | Secret? | Notes |
| --- | :-: | --- |
| `DATABASE_URL` *or* `PORTAL_DATABASE_URL` | **secret** | Full connection string incl. credentials. Recognized by `db/config.ts`. |
| `DATABASE_SSL` | non-secret | `true` (default). Never set `false` in prod. |
| `DATABASE_POOL_MAX` | non-secret | Pool size hint for the lazy driver (start `5`). |
| `DATABASE_STATEMENT_TIMEOUT_MS` | non-secret | Per-query timeout (start `10000`). |

### Migration / validation commands

```bash
# Apply schema (psql against the provisioned DB):
psql "$DATABASE_URL" -f infra/database/0001_init.sql

# Verify tables + RLS landed (expect all app tables, rls enabled where applicable):
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace;"

# Read-only connectivity probe (no app rows written):
psql "$DATABASE_URL" -c "SELECT now();"
```

### Smoke test & success criteria

- `GET /api/system/capabilities` → `capabilities.database: true`,
  `readiness.persistence: "ready"`, `sessionMode: "database"`.
- `npm run smoke -- --base-url <url> --mcp dist/index.js` passes (shape + no-secret
  guard on the capabilities payload).
- `\dt` lists every table in §6 of `PRODUCTION_ARCHITECTURE.md`; RLS is enabled
  (not forced) on tenant-scoped tables.
- **No** application write has occurred (this phase is schema + connectivity only).

### Rollback

- Unset `DATABASE_URL`/`PORTAL_DATABASE_URL` and redeploy → probe reports
  `unconfigured`, app stays on the stateless signed-cookie path. The schema can
  stay applied (an empty, unused DB is harmless) or the project can be deleted.

### Security checks

- App role is least-privilege (no superuser, no DDL in steady state).
- Connection string is a platform secret, never in the repo or logs
  (`db/config.ts` never logs it).
- No `oauth_connections` rows yet → trivially no token bytes in the DB.

### Cost / scaling

- Start on the smallest managed tier; this phase has near-zero query volume.
- Always use the **pooled** endpoint for serverless to avoid connection
  exhaustion on cold starts.

---

## Phase 2 — Token vault integration + dual-read/dual-write

**What it does.** Moves OAuth token *bytes* out of the signed cookie into an
external secret manager, keyed by `oauth_connections.token_ref`. Introduces a `v2`
session-id cookie while keeping the `v1` token-bearing cookie working until expiry.

### Provider-neutral steps

1. Choose a secret manager and grant **only the backend service identity** read
   access (the resolver credentials come from platform IAM, *never* from token
   values in env).
2. Implement the `TokenVault` interface
   ([`token-vault.ts`](../apps/portal/shared/token-vault.ts)) against it:
   `store(token) → metadata`, `get(tokenRef) → bytes|null`, `delete(tokenRef)`
   (idempotent). Hold the invariants: refs are opaque (`newTokenRef()`), bytes are
   never logged/cached/sent to the browser.
3. Set the provider env var(s) so `detectVaultProvider(env)` reports the intended
   provider and `/api/system/capabilities` flips `tokenVault` to `ready`.
4. **Dual-write:** on new logins/refresh, write bytes to the vault and store only
   `token_ref` + metadata in `oauth_connections`; mint a `v2` session-id cookie.
5. **Dual-read:** accept both cookie versions. `v1` (token-bearing) keeps working
   until natural expiry; `v2` resolves bytes via the vault. No forced logout.
6. After the `v1` max-age window elapses, drop `v1` acceptance.

> **Example — Supabase Vault.** pgsodium-backed, co-located with the Phase-1
> Postgres. Detected via `SUPABASE_VAULT_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
>
> **Example — GCP Secret Manager / KMS.** IAM-scope the Vercel backend identity to
> `secretmanager.versions.access`. Vars: `GCP_KMS_KEY` / `GOOGLE_CLOUD_PROJECT`.
>
> **Example — AWS Secrets Manager / KMS.** `AWS_SECRETS_MANAGER_REGION` /
> `AWS_KMS_KEY_ID`; grant the function role `secretsmanager:GetSecretValue`.
>
> **Example — HashiCorp Vault.** `VAULT_ADDR`; authenticate via the platform's
> workload identity, not a static token in env.

### Env vars (pick ONE provider)

| Var | Secret? | Provider |
| --- | :-: | --- |
| `SUPABASE_VAULT_URL` | non-secret (URL) | Supabase Vault |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Supabase Vault |
| `GCP_KMS_KEY` / `GOOGLE_CLOUD_PROJECT` | non-secret (refs; IAM grants access) | GCP |
| `AWS_KMS_KEY_ID` / `AWS_SECRETS_MANAGER_REGION` | non-secret (refs; IAM grants access) | AWS |
| `VAULT_ADDR` | non-secret (URL) | HashiCorp |
| `TOKEN_VAULT_ALLOW_MEMORY` | **dev/test only** | NEVER set in prod (keeps the in-memory vault inert) |

> The resolver's *credentials* (service-role key, IAM token) are the only secrets;
> key references/URLs are not secret on their own because access is IAM-gated.

### Migration / validation commands

```bash
# Confirm provider detection + readiness (no secret returned):
curl -s "$BASE_URL/api/system/capabilities" | jq '.capabilities.tokenVault, .readiness.tokenVault'

# After dual-write begins, assert NO token bytes in Postgres (must be empty):
psql "$DATABASE_URL" -c "SELECT token_ref, scopes, has_refresh, access_expires_at FROM oauth_connections LIMIT 5;"
# token_ref is an opaque pointer; there is no token column to leak.
```

### Smoke test & success criteria

- A fresh login mints a `v2` cookie; the cookie contains **no** token bytes (only
  a signed session id).
- An existing `v1` session keeps working through the cutover (no forced re-consent).
- Token refresh writes new bytes to the vault, never to Postgres or the cookie.
- `oauth_connections` has `token_ref` populated and **no** token-byte column.

### Rollback

- Unset the vault provider var(s) and stop minting `v2` → the signed-cookie `v1`
  path resumes (it never stopped accepting `v1`). No data loss; the vault entries
  can be deleted on a schedule.

### Security checks

- **No token bytes in DB** (verified by the `oauth_connections` query above — there
  is no column for them).
- **Vault only** holds bytes; the resolver is reachable solely by the backend
  service identity.
- Vault errors emit `vault.error` (see [`OBSERVABILITY.md`](./OBSERVABILITY.md) §2)
  without the byte payload; alert on `sa_vault_errors_total > 0`.
- `TOKEN_VAULT_ALLOW_MEMORY` is **absent** in production (probe/CI should fail if
  set).

### Cost / scaling

- Secret-manager read cost is per-API-call; cache resolved tokens **in process for
  the request only**, never in the shared Redis cache (`NEVER_CACHE` forbids it).

---

## Phase 3 — Redis / Upstash cache (read-through + SWR)

**What it does.** Adds a hot cache for GTM/GA4 discovery lists and job-status
lookups, with stale-while-revalidate for discovery. Source of truth stays Google;
Postgres snapshots remain the warm cache.

### Provider-neutral steps

1. Provision a Redis. Prefer an **HTTP/REST** Redis from Vercel functions (no
   socket pool to manage across cold starts).
2. Wire the `CacheStore` ([`cache.ts`](../apps/portal/shared/cache.ts)) to it; the
   `UpstashRestCache` skeleton is already dependency-free. `getOrSet` /
   `setWithPolicy` read TTLs from `CACHE_POLICY` — never hardcode TTLs at call
   sites.
3. Enable **read-through** on discovery routes: cache hit → return (SWR: serve
   stale within the stale window + async refresh); miss → Google list → warm the DB
   snapshot → `SET` with policy TTL.
4. Keep status lookups (`audit_run_status`, `worker_job_status`) at 10s TTL and
   **never** serve them stale.

> **Example — Upstash Redis (REST).** Set `UPSTASH_REDIS_REST_URL` +
> `UPSTASH_REDIS_REST_TOKEN`. Works over HTTPS from Vercel; per-request billing
> suits bursty serverless.
>
> **Example — Vercel KV.** Set `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash
> under the hood; the capability probe already recognizes `KV_REST_API_URL`).
>
> **Example — self-hosted/Elasticache Redis.** Use `REDIS_URL` from a non-serverless
> host (the worker) where a socket pool is fine; avoid raw sockets from Vercel.

### Env vars

| Var | Secret? | Notes |
| --- | :-: | --- |
| `UPSTASH_REDIS_REST_URL` *or* `KV_REST_API_URL` *or* `REDIS_URL` | non-secret (URL) / **secret if URL embeds creds** | Backend selection. `REDIS_URL` often embeds a password → treat as secret. |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | **secret** | REST auth token. |
| `GTM_PORTAL_CACHE` | non-secret | Dev/test adapter selector (`memory`/`noop`). Does **not** enable a live service. |

### Migration / validation commands

```bash
# Readiness:
curl -s "$BASE_URL/api/system/capabilities" | jq '.capabilities.cache, .readiness.cache'

# Cache-key invariants + TTL/SWR behavior (no live Redis needed):
npm run test:cache    # cache-keys + cache TTL/SWR/policy suites
```

### Smoke test & success criteria

- `capabilities.cache: true`, `readiness.cache: "ready"`.
- A repeated discovery call shows a cache hit (latency drop + `cache.hit` event);
  the first call is a miss that warms the snapshot.
- Status endpoints reflect terminal state within one TTL (≤10s); never serve a
  stale terminal status.
- Cache hit-ratio metric (`sa_cache_operations_total`) begins emitting.

### Rollback

- Unset cache vars (or set `GTM_PORTAL_CACHE` away from a live backend) → the
  `CacheStore` falls back to no-op; every read hits Google (higher latency/quota,
  but correct). No data migration needed.

### Security checks

- **`NEVER_CACHE` holds:** no OAuth tokens, session cookies, client secrets, or
  **raw runtime captures** (PII risk) in the shared cache — asserted by the cache
  tests.
- Keys are tenant-scoped (`sa:v1:{orgId}:…`) so a malformed id can't forge another
  tenant's key; per-tenant flush is a prefix delete on logout/disconnect.

### Cost / scaling

- REST Redis bills per request — SWR keeps request volume low. Watch
  `sa_cache_operations_total{result="error"}`; a cache outage must degrade to
  source-of-truth reads, not error the user.

---

## Phase 4 — Async job queue (shadow mode)

**What it does.** Introduces the durable job queue for audits and runtime captures
in **shadow mode**: jobs are enqueued and processed, but the client still gets
today's synchronous response. No client-visible change until you opt a deployment
into the `202 + status-poll` variant.

### Provider-neutral steps

1. Start with the **Postgres-backed queue** (`worker_jobs`, `SELECT … FOR UPDATE
   SKIP LOCKED`) — it needs no new infra beyond Phase 1 and gives at-least-once
   delivery with `attempts`/`max_attempts` and a lease (`lease_expires_at`).
2. Wire the `JobQueue` ([`jobs.ts`](../apps/portal/shared/jobs.ts)) to it. Keep the
   default no-op so absent config preserves today's behavior.
3. **Shadow mode:** on an audit/capture request, enqueue a job *and* run the
   synchronous path; compare outputs out-of-band. The client response is unchanged.
4. Only after shadow output matches, expose the additive async variant
   (`POST → 202 {auditRunId}`, `GET /api/audit-runs/:id`) per
   [`API_JOBS.md`](./API_JOBS.md) — opt-in per deployment.
5. Graduate to a managed queue (SQS/QStash) later **with no schema change** if
   volume warrants.

> **Example — Postgres SKIP LOCKED (default).** No new provider. The partial index
> `worker_jobs_queue_idx` keeps dequeue cheap.
>
> **Example — Upstash QStash.** HTTP-push queue that fits serverless; point it at a
> worker/function endpoint. `JOB_QUEUE_PROVIDER=qstash`.
>
> **Example — AWS SQS.** Durable + visibility-timeout semantics map to the lease
> model. `JOB_QUEUE_PROVIDER=sqs`.

### Env vars

| Var | Secret? | Notes |
| --- | :-: | --- |
| `JOB_QUEUE_PROVIDER` | non-secret | `postgres` (default) / `qstash` / `sqs`. |
| `GTM_PORTAL_JOB_QUEUE` | non-secret | Dev/test adapter selector (`memory`/`noop`). No live service. |
| `QSTASH_TOKEN` *(if QStash)* | **secret** | QStash auth token. |
| `AWS_SQS_QUEUE_URL` *(if SQS)* | non-secret | Queue URL; access via function IAM role. |

### Migration / validation commands

```bash
# Job lifecycle/lease/retry invariants (in-memory; no live queue needed):
npm run test:jobs

# Inspect the durable queue (Postgres backend), no rows in shadow until enqueued:
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM worker_jobs GROUP BY status;"
```

### Smoke test & success criteria

- Shadow: every audit/capture enqueues a `worker_jobs` row that reaches a terminal
  state; the **client response is byte-identical** to the pre-shadow synchronous
  response.
- `npm run test:jobs` passes (lifecycle, lease, retry, at-least-once).
- Queue metrics emit: `sa_worker_queue_depth`, `sa_worker_job_age_seconds`.

### Rollback

- Set `GTM_PORTAL_JOB_QUEUE` to no-op / unset `JOB_QUEUE_PROVIDER` → enqueue
  becomes a no-op, synchronous path is the only path. In-flight Postgres jobs are
  swept by retention (terminal jobs, 30d).

### Security checks

- Jobs carry org-scoped payloads; the worker resolves only its leased job's org.
- No token bytes in job payloads (jobs reference `token_ref`/session, never bytes).
- Worker→API artifact upload uses a **worker bearer token**, not a user session.

### Cost / scaling

- Postgres queue is free beyond the DB you already run; move to SQS/QStash only
  when queue depth/latency (`sa_worker_queue_depth`, p95 job age) breaches SLO.

---

## Phase 5 — Runtime worker deployment (behind the queue)

**What it does.** Deploys the headless-Chromium capture worker
([`apps/runtime-worker`](../apps/runtime-worker)) on a **real browser host** (never
Vercel) and switches it from ad-hoc HTTP to leasing jobs from the Phase-4 queue.

### Provider-neutral steps

1. Deploy the worker to a host that can run headless Chromium with enough
   memory/CPU (≥1 vCPU, ≥1–2 GB). **Not Vercel** — it needs a persistent browser
   process.
2. Keep the default **HTTP `/capture` mode** ([`server.mjs`](../apps/runtime-worker/server.mjs))
   for direct calls during validation; set `RUNTIME_WORKER_TOKEN`,
   `RUNTIME_WORKER_ALLOWLIST`, and the URL/wait/timeout limits.
3. Flip to **queue mode** by setting `RUNTIME_WORKER_MODE=queue` and implementing a
   `QueueClient` against the Phase-4 durable queue
   ([`queue-consumer.mjs`](../apps/runtime-worker/queue-consumer.mjs) is the
   skeleton; it refuses to run as queue mode until a client is wired).
4. Point the portal at the worker via `PORTAL_RUNTIME_WORKER_URL` +
   `RUNTIME_WORKER_TOKEN` so `/api/system/capabilities` flips `runtimeCapture` to
   `ready`.

> **Example — Render.** Background Worker or Web Service with a Chromium buildpack;
> set the worker env in the Render dashboard; scale instances for throughput.
>
> **Example — Fly.io.** A `fly.toml` machine sized for Chromium; scale to 0 when
> idle, autostart on queue depth.
>
> **Example — Railway.** Deploy from the repo subdir; set the worker token + queue
> creds as Railway variables.

### Env vars (set on the WORKER host, not Vercel)

| Var | Secret? | Notes |
| --- | :-: | --- |
| `RUNTIME_WORKER_TOKEN` | **secret** | Bearer token the portal/worker share for the artifact-upload path. |
| `RUNTIME_WORKER_MODE` | non-secret | `queue` to lease jobs; default HTTP otherwise. |
| `RUNTIME_WORKER_ALLOWLIST` | non-secret | Comma-separated host allowlist for capture targets. |
| `RUNTIME_WORKER_MAX_URLS` / `_MAX_WAIT` / `_TIMEOUT` | non-secret | Safety limits (defaults 10/8000/30000). |
| `PORTAL_RUNTIME_WORKER_URL` *(on Vercel)* | non-secret (URL) | Portal → worker endpoint. |

### Migration / validation commands

```bash
# Static checks on the worker (no browser needed):
npm --prefix apps/runtime-worker run check   # node --check server/capture/cli

# Queue-mode dry run against the in-memory queue (no durable client required):
RUNTIME_WORKER_MODE=queue node apps/runtime-worker/queue-consumer.mjs --demo
```

### Smoke test & success criteria

- HTTP mode: `POST /capture` against an allowlisted URL returns a redacted
  artifact within the timeout.
- Queue mode: a seeded `worker_jobs` row is leased, processed, and flipped to
  `succeeded`; the artifact lands in `runtime_captures` with an `expires_at`.
- `capabilities.runtimeWorker: true`, `readiness.runtimeCapture: "ready"`; the
  production caveat about "no runtime worker" disappears.

### Rollback

- Scale the worker to **0** and unset `PORTAL_RUNTIME_WORKER_URL` → runtime-capture
  audits become unavailable (probe reports `unconfigured`), but config-only audits
  are unaffected. Queue jobs stay queued until a worker returns or retention sweeps
  them.

### Security checks

- **Allowlist enforced** (`RUNTIME_WORKER_ALLOWLIST`) so the worker can't be used as
  an SSRF proxy.
- Artifacts are **PII-sensitive**: store only redacted/encrypted forms, stamp
  `expires_at` (30-day retention, [`retention.ts`](../apps/portal/shared/retention.ts)),
  never log raw `dataLayer` values, never serve unredacted to the browser.
- Worker authenticates uploads with `RUNTIME_WORKER_TOKEN`, not a user session.

### Cost / scaling

- Chromium hosts are the most expensive tier — scale to 0 when idle, autostart on
  queue depth. Cap concurrency with `RUNTIME_WORKER_MAX_URLS` to bound memory.

---

## Phase 6 — Observability exporter + alert activation

**What it does.** Wires a metrics exporter to the already-defined metric contract
and activates the alert thresholds. Structured logs already emit (provider-neutral
JSON lines); this phase makes metrics flow and alerts page.

### Provider-neutral steps

1. Ship structured logs to a sink via the platform's log drain (no SDK needed —
   logs are plain JSON lines from [`observability.ts`](../apps/portal/shared/observability.ts)).
   Set `LOG_LEVEL` (default `info`).
2. Wire a metrics exporter to the names in [`metrics.ts`](../apps/portal/shared/metrics.ts)
   / [`OBSERVABILITY.md`](./OBSERVABILITY.md) §3. Names are Prometheus-native
   (`sa_*`, `_total`/`_seconds`) and map cleanly to Datadog/StatsD.
3. Optionally add error tracking (Sentry) via `SENTRY_DSN`; redaction
   (`redact()` + `safeErrorName()`) already strips secrets/PII before emit.
4. Build the dashboards (OBSERVABILITY §4) and activate alerts (§5). Start with the
   high-severity ones: 5xx spike, `FUNCTION_INVOCATION_FAILED`, OAuth refresh-failure
   spike, vault errors.

> **Example — Sentry.** Set `SENTRY_DSN`; capture `*.failed` events. The DSN is a
> write-only ingest key but treat it as a secret by convention.
>
> **Example — Grafana / Prometheus.** Expose a future `/metrics` endpoint and
> scrape it; the metric names are already Prom-native. Encode alert conditions as
> Prometheus alerting rules.
>
> **Example — Datadog.** Use the same names as custom metrics; map `status_class` /
> `outcome` to tags; build monitors from the OBSERVABILITY §5 table. Authenticate
> with `DD_API_KEY`.

### Env vars

| Var | Secret? | Notes |
| --- | :-: | --- |
| `LOG_LEVEL` | non-secret | `debug`/`info`/`warn`/`error` (default `info`). |
| `OBSERVABILITY_PROVIDER` | non-secret | `none`/`sentry`/`datadog`/`grafana`/`otel` selector. |
| `SENTRY_DSN` | **secret** (by convention) | Error tracking ingest. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | non-secret (URL) | OTLP collector endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | **secret** | Auth headers for the collector. |
| `DD_API_KEY` *(if Datadog)* | **secret** | Datadog ingest key. |
| `METRICS_ENABLED` | non-secret | Gate the exporter on/off. |

### Migration / validation commands

```bash
# Redaction + event/metric-name contracts (no live exporter needed):
npm run test:observability   # observability + metrics name/label invariants

# Confirm log level is honored and no secret leaks into a sample line:
LOG_LEVEL=debug node -e "require('./apps/portal/shared/observability.ts')" 2>/dev/null || true
```

### Smoke test & success criteria

- A test request produces structured log lines in the sink with `traceId`/`orgId`
  but **no** token bytes, emails, or raw captures.
- Metrics appear in the backend under the `sa_*` names; the derived rates
  (error rate, audit failure rate, cache hit ratio) render.
- High-severity alerts fire on a synthetic trigger (e.g., force a 5xx) and resolve.

### Rollback

- Set `METRICS_ENABLED=false` / unset `OBSERVABILITY_PROVIDER` → exporter stops;
  structured logs keep flowing (they never depended on a vendor). No data loss.

### Security checks

- **No secret or PII in logs/metrics:** `redact()` runs on every field payload;
  metric labels are low-cardinality only (`FORBIDDEN_LABEL_KEYS` forbids ids/urls/
  tokens — asserted by tests).
- DSN/API keys are platform secrets, never in the repo.

### Cost / scaling

- Custom-metric and log-ingest cost scales with cardinality/volume — the
  low-cardinality label rule keeps it bounded. Sample `debug` logs in prod via
  `LOG_LEVEL=info`.

---

## Cross-phase security checklist

Run this after **every** phase, and as a final gate before declaring production:

- [ ] **No token bytes in Postgres.** `oauth_connections` has only `token_ref` +
      metadata; there is no token-byte column.
- [ ] **Vault only.** OAuth bytes resolve solely through the secret manager via the
      backend service identity; `TOKEN_VAULT_ALLOW_MEMORY` is unset in prod.
- [ ] **No secrets in repo or cache.** No `.env`, `*.gtm-mcp-tokens.json`,
      service-account key, or `.vercel/` artifact committed; `NEVER_CACHE` holds.
- [ ] **PII / runtime-capture retention.** Captures are redacted/encrypted, stamped
      with `expires_at` (30d), never logged raw, never served unredacted.
- [ ] **RBAC enforced.** `viewer` is read-only; no portal-grantable `*:publish`;
      cross-tenant access is denied before role check (maps to 404).
- [ ] **Read-only defaults intact.** `GTM_MCP_ENABLE_WRITES/PUBLISH/DELETES` all
      `false`; publish stays MCP-guardrailed even after `approval:decide`.
- [ ] **`api/**` import safety.** No heavy top-level imports added under
      `apps/portal/api/`; clients load lazily after auth.
- [ ] **Consent v2 suite 170/170** (`npm run test:consent`).

---

## Final validation (whole-system)

```bash
# Root MCP server:
npm run typecheck && npm run build && npm test

# Consent engine (must be 170/170):
npm run test:consent

# Portal:
npm run portal:check && npm run portal:build

# Runtime worker:
npm --prefix apps/runtime-worker run check

# Live deployment gate:
npm run smoke -- --base-url <prod-url> --mcp dist/index.js
curl -s "<prod-url>/api/system/capabilities" | jq '.readiness, .caveats'
```

**Success = all green, `readiness` is `ready` for every provisioned subsystem, and
`caveats` is empty** for the subsystems you intended to wire.

---

## Per-phase rollback summary

| Phase | One-line rollback |
| :-: | --- |
| 1 | Unset `DATABASE_URL`; app returns to stateless signed-cookie path. |
| 2 | Stop minting `v2`, keep `v1` acceptance; unset vault vars. |
| 3 | Unset cache vars; `CacheStore` no-ops, reads hit Google. |
| 4 | No-op the `JobQueue`; synchronous path is the only path. |
| 5 | Scale worker to 0; unset `PORTAL_RUNTIME_WORKER_URL`. |
| 6 | `METRICS_ENABLED=false`; structured logs keep flowing. |

Every rollback is config-only (unset an env var + redeploy) — no code revert and no
data migration is required to return to the current foundation-only behavior.
