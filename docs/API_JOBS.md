# Async Jobs & Cache — API Contract (forward-looking)

This document specifies the **create / status / result** contract for async
audit runs and runtime-capture jobs, and the cache abstraction that backs job/
discovery state. It is the design contract for the foundation shipped in
Workstream B:

- `apps/portal/shared/jobs.ts` — pure job lifecycle, payload/result schemas, the
  `JobQueue` interface, and in-memory/noop dev adapters.
- `apps/portal/shared/cache.ts` — `CacheStore` interface, in-memory TTL/SWR
  implementation, no-op cache, and an Upstash REST adapter skeleton.
- `apps/portal/shared/cache-keys.ts` — the canonical key namespace + TTL policy
  these build on.
- `apps/runtime-worker/queue-consumer.mjs` — opt-in worker consumer skeleton.

> **Nothing here changes today's behavior.** The current synchronous routes
> (`POST /api/gtm/audit`, `POST /api/gtm/consent-audit`, the worker's
> `POST /capture`) keep their exact contracts. Everything below is **additive**
> and **opt-in per deployment**: the default queue is the no-op queue and the
> default cache is the no-op cache, so absent configuration the system behaves
> exactly as it does now. See
> [`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md) §4.

## Job lifecycle

Audit runs and worker jobs share a small, validated state machine. Transitions
are enforced by `assertAuditTransition` / `assertWorkerTransition` in `jobs.ts`;
an illegal flip (e.g. reviving a terminal job) throws rather than corrupting
state.

```
audit_runs:    queued ──▶ running ──▶ succeeded
                  │          │ └─────▶ failed
                  └──────────┴───────▶ cancelled         (terminal: succeeded|failed|cancelled)

worker_jobs:   queued ──▶ leased ──▶ succeeded
                  │          │ ├─────▶ failed   (no attempts left)
                  │          │ └─────▶ queued   (retry: lease expired or transient fail)
                  └──────────┴───────▶ cancelled         (terminal: succeeded|failed|cancelled)
```

Status enums are defined once in `production-types.ts` (mirroring the SQL CHECK
constraints) and re-exported from `jobs.ts`.

## Audit run endpoints (additive)

The existing `POST /api/gtm/audit` keeps returning an `AuditSummary` 200
synchronously. When a deployment enables async orchestration it MAY instead
return `202` with a run handle; clients poll for status/result.

### `POST /api/gtm/audit` — async variant (202)

Request (unchanged from today):

```json
{ "containerId": "12345", "runtimeCaptureId": "uuid-or-null" }
```

Response when async is enabled:

```json
{ "auditRunId": "uuid", "status": "queued" }   // HTTP 202
```

When async is **not** enabled (default), the response is the existing
`AuditSummary` with HTTP 200 — no client change required.

### `GET /api/audit-runs/:id` — status + result

Org-scoped. Cached for 10s under `cacheKey("audit_run_status", orgId, id)`
(`CACHE_POLICY.audit_run_status`, TTL 10s, **no** stale-while-revalidate — a
poller must see fresh state). On a terminal transition the writer deletes the
status key so the next poll reflects completion.

```json
{
  "id": "uuid",
  "status": "running",            // queued|running|succeeded|failed|cancelled
  "kind": "container",            // container|consent|sgtm
  "healthScore": null,
  "severityCounts": {},
  "result": null,                 // populated only when status==="succeeded"
  "error": null,                  // populated only when status==="failed"
  "createdAt": "ISO-8601",
  "startedAt": null,
  "finishedAt": null
}
```

`result`, when present, is the same engine output shape the synchronous route
returns today — async does not change the audit payload.

## Runtime-capture job endpoints (additive)

### `POST /api/runtime/capture` — enqueue

Org-scoped, session-authenticated. Enqueues a `worker_jobs` row with a
`RuntimeCaptureJobPayload` and returns a handle. URLs are validated at this
boundary and again by the worker (SSRF allow-list); private/loopback hosts are
always rejected.

Request (`RuntimeCaptureJobPayload`, see `jobs.ts`):

```json
{
  "kind": "runtime_capture",
  "urls": ["https://example.com", "https://example.com/checkout"],
  "consentStates": [
    { "ad_storage": "denied", "analytics_storage": "denied" },
    { "ad_storage": "granted", "analytics_storage": "granted" }
  ],
  "actions": [{ "type": "scroll" }, { "type": "wait", "ms": 2000 }],
  "wait": 4000,
  "timeout": 30000
}
```

`consentState` (single) and `consentStates` (multi, v3 proof) are mutually
exclusive. Response:

```json
{ "jobId": "uuid", "status": "queued" }
```

### `GET /api/runtime/capture/:jobId` — status

Org-scoped. Cached 10s under `cacheKey("worker_job_status", orgId, jobId)`
(`CACHE_POLICY.worker_job_status`, no SWR).

```json
{
  "jobId": "uuid",
  "status": "leased",             // queued|leased|succeeded|failed|cancelled
  "attempts": 1,
  "maxAttempts": 3,
  "result": null                  // RuntimeCaptureJobResult when succeeded
}
```

### `POST /api/runtime/capture/:jobId/artifact` — worker → API upload

Authenticated by a **worker bearer token**, not a user session. The worker posts
the capture artifact; the API persists it to `runtime_captures`
(`artifact` inline or `artifact_uri` offloaded) and calls `complete(jobId,
result)`. The result the queue carries is a `RuntimeCaptureJobResult`:

```json
{
  "ok": true,
  "captureId": "uuid",
  "artifactUri": null,
  "schema": "samarth.runtime-capture/v2",
  "summary": { "urls": 2, "consentStates": 2, "trackerHits": 7 }
}
```

The **raw artifact is never cached** and never travels through the job-status
cache (`NEVER_CACHE` includes `raw_runtime_capture` — it may carry PII in
`dataLayer` values). Only the pointer + non-sensitive summary are surfaced.

## Cache contract

`CacheStore` (`cache.ts`) is the seam. Implementations:

| Impl | Use | Notes |
| --- | --- | --- |
| `NoopCache` | **default** | every read misses; preserves today's "always hit Google" behavior |
| `InMemoryCache` | tests / single-process dev | TTL + stale-while-revalidate, injectable clock |
| `UpstashRestCache` | production (skeleton) | dependency-free over `fetch`; construct lazily after auth |

Helpers read TTLs from `CACHE_POLICY` so call sites never hardcode them:

- `setWithPolicy(store, resource, orgId, parts, value)` — set using the
  resource's policy.
- `getOrSet(store, resource, orgId, parts, load)` — read-through: fresh hit →
  return; stale hit → serve instantly + async revalidate; miss → load + set.

Selection helpers (`selectDevCache` / `selectDevJobQueue`) default to the no-op
implementations and only return the in-memory ones when
`GTM_PORTAL_CACHE=memory` / `GTM_PORTAL_JOB_QUEUE=memory` are set. A live Upstash
client or durable queue is constructed by the caller — lazily, inside an
`api/**` handler after auth — to honor the Vercel-safe import rule.

## Guardrails preserved

- Read-only by default; the queue/cache never imply a GTM/GA4 write.
- No secrets in repo, cache, or DB; tokens/sessions/secrets are in `NEVER_CACHE`.
- `api/**` top-level imports stay `node:*`/`import type` only; cache/queue
  clients load lazily after auth.
- Existing synchronous routes and the worker's `POST /capture` are unchanged.
