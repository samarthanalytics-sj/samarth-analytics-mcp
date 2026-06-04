# Observability & Alerting

The operational playbook for the Samarth Analytics platform: the structured-log
event catalog, the metric naming contract, recommended dashboards, and alert
thresholds.

> **Foundation, not wiring.** This change ships the *contract* — event names,
> metric names, a redaction guarantee, and a readiness probe — plus the docs
> below. It does **not** add a paid vendor SDK, open a log/metrics connection,
> or change any runtime behavior. Call sites adopt `logEvent(...)` incrementally;
> a metric exporter is wired in a later phase. The dashboards/alerts here are
> the target to build once metrics flow.

Backing code:

- Event taxonomy + structured logger + redaction:
  [`apps/portal/shared/observability.ts`](../apps/portal/shared/observability.ts)
- Metric naming convention + catalog:
  [`apps/portal/shared/metrics.ts`](../apps/portal/shared/metrics.ts)
- Readiness/caveats probe:
  [`apps/portal/api/system/capabilities.ts`](../apps/portal/api/system/capabilities.ts)
- Smoke test for critical surfaces: [`scripts/smoke-test.mjs`](../scripts/smoke-test.mjs)
  (`npm run smoke -- --base-url <url> --mcp dist/index.js`)

See also [`PRODUCTION_ARCHITECTURE.md` §8](./PRODUCTION_ARCHITECTURE.md#8-observability--monitoring--logging)
for how this fits the scaling roadmap.

---

## 1. Principles

- **Never log a secret or PII.** Token bytes, client secrets, session cookies,
  and email addresses must never reach a log line. `logEvent()` runs every
  `fields` payload through `redact()` (key-name match + token-shaped value
  match) before emit, and `safeErrorName()` reduces a thrown error to its class
  name only — never its message or stack. Raw runtime captures (which may carry
  PII in `dataLayer` values) are never logged.
- **Structured, one JSON object per line.** Every record carries `ts`, `level`,
  `subsystem`, `event`, `message`, and optional `traceId`/`orgId`/`userId`
  (opaque ids, never emails). This is queryable in any log sink.
- **Stable names are a contract.** `ObservabilityEvent` strings and metric names
  back saved queries and alerts. Add freely; renaming breaks dashboards.
- **Low cardinality on metric labels.** Never label a metric with an org id,
  user id, url, container/property id, or trace id (enforced by
  `FORBIDDEN_LABEL_KEYS` + the test suite). Those belong in logs/traces.
- **No vendor lock-in.** Logs are plain JSON lines (ship via Vercel log drains
  to any sink). Metric names follow the Prometheus convention, which maps
  cleanly to Datadog and StatsD.

---

## 2. Structured-log event catalog

Each event is emitted via `logEvent({ level, subsystem, event, message, ... })`.
`level` is one of `debug | info | warn | error`; the floor is `LOG_LEVEL` (env,
default `info`).

| Subsystem | Event | Level (typical) | Emit when |
| --- | --- | --- | --- |
| `audit` | `audit.run.started` | info | An audit run begins. |
| `audit` | `audit.run.succeeded` | info | A run completes; include `durationMs`. |
| `audit` | `audit.run.failed` | error | A run aborts; include `errorName`. |
| `audit` | `audit.tool.failure` | warn | A single read inside a run fails (recorded in `toolFailures`, run continues). |
| `oauth` | `oauth.start` | info | OAuth consent redirect issued. |
| `oauth` | `oauth.callback.succeeded` | info | Token exchange + session set. |
| `oauth` | `oauth.callback.failed` | error | State/CSRF, token exchange, or session write failed. |
| `oauth` | `oauth.token.refreshed` | info | Access token refreshed successfully. |
| `oauth` | `oauth.token.refresh_failed` | error | Refresh failed (re-consent signal). |
| `gtm` | `gtm.api.call` | debug | A GTM API call (include `durationMs`, `statusCode`). |
| `gtm` | `gtm.api.error` | warn/error | A GTM API call returned an error. |
| `ga4` | `ga4.api.call` | debug | A GA4 Admin/Data call. |
| `ga4` | `ga4.api.error` | warn/error | A GA4 call returned an error (scope/permission hints stay user-facing). |
| `runtime` | `runtime.capture.started` | info | A headless capture begins. |
| `runtime` | `runtime.capture.succeeded` | info | Capture artifact produced. |
| `runtime` | `runtime.capture.failed` | error | Navigation/timeout/Playwright-missing failure. |
| `worker` | `worker.job.enqueued` | info | A job is queued. |
| `worker` | `worker.job.leased` | debug | A worker leased a job; include queue `durationMs` (age). |
| `worker` | `worker.job.succeeded` | info | Job completed. |
| `worker` | `worker.job.failed` | error | Job failed terminally. |
| `worker` | `worker.job.retry` | warn | Job re-queued for another attempt. |
| `vault` | `vault.read` / `vault.write` | debug | Token-vault metadata access (never the bytes). |
| `vault` | `vault.error` | error | Vault read/write failed. |
| `cache` | `cache.hit` / `cache.miss` | debug | Discovery/job-status cache lookups. |
| `cache` | `cache.error` | warn | Cache backend error (degrade to source-of-truth read). |
| `system` | `system.startup` / `system.shutdown` | info | Server/worker lifecycle. |

**Example record (after redaction):**

```json
{"ts":"2026-06-04T12:00:00.000Z","level":"error","subsystem":"oauth",
 "event":"oauth.token.refresh_failed","message":"refresh failed",
 "traceId":"req-abc","orgId":"org-123","errorName":"FetchError",
 "fields":{"refresh_token":"[REDACTED]","phase":"refresh"}}
```

---

## 3. Metric catalog & naming convention

Convention (Prometheus base units; maps to Datadog/StatsD):

- lowercase `snake_case`, namespaced `sa_`, no dots
- counters end in `_total`; duration histograms end in `_seconds` (not ms)
- labels are **low-cardinality only** — never an id/url/token

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `sa_http_requests_total` | counter | `route, method, status_class` | Portal API requests. `status_class` ∈ {2xx,3xx,4xx,5xx}. |
| `sa_http_request_duration_seconds` | histogram | `route, method` | API latency. |
| `sa_function_invocation_failed_total` | counter | `route` | Invocations that failed before responding (FUNCTION_INVOCATION_FAILED proxy). |
| `sa_oauth_failures_total` | counter | `phase, reason` | OAuth failures. `phase` ∈ {start,callback,refresh}. |
| `sa_oauth_token_refresh_total` | counter | `outcome` | Token refreshes. `outcome` ∈ {ok,failed}. |
| `sa_audit_runs_total` | counter | `kind, outcome` | Audit runs. `outcome` ∈ {ok,failed}. |
| `sa_audit_run_duration_seconds` | histogram | `kind` | Audit run wall-clock. |
| `sa_audit_tool_failures_total` | counter | `resource` | Per-read failures recorded during runs (`toolFailures`). |
| `sa_google_api_calls_total` | counter | `api, outcome` | GTM/GA4 calls. `api` ∈ {gtm,ga4_admin,ga4_data}. |
| `sa_google_api_duration_seconds` | histogram | `api` | Google API latency. |
| `sa_runtime_captures_total` | counter | `outcome` | Headless captures. |
| `sa_worker_jobs_total` | counter | `outcome` | Jobs processed. `outcome` ∈ {succeeded,failed,retry}. |
| `sa_worker_queue_depth` | gauge | — | Queued jobs awaiting a lease. |
| `sa_worker_job_age_seconds` | histogram | — | Job age at lease time (queue latency). |
| `sa_vault_errors_total` | counter | `operation` | Token-vault errors. `operation` ∈ {read,write}. |
| `sa_cache_operations_total` | counter | `resource, result` | Cache ops. `result` ∈ {hit,miss,error}. |

Derived rates worth precomputing in the dashboard:

- **API error rate** = `rate(sa_http_requests_total{status_class="5xx"}) / rate(sa_http_requests_total)`
- **Audit failure rate** = `rate(sa_audit_runs_total{outcome="failed"}) / rate(sa_audit_runs_total)`
- **Cache hit ratio** = `rate(sa_cache_operations_total{result="hit"}) / rate(sa_cache_operations_total{result=~"hit|miss"})`
- **OAuth refresh failure rate** = `rate(sa_oauth_token_refresh_total{outcome="failed"}) / rate(sa_oauth_token_refresh_total)`

---

## 4. Recommended dashboards

**A. API / serverless health**
- Request rate by `status_class`; 5xx error-rate % (single-stat + trend).
- p50/p95/p99 `sa_http_request_duration_seconds` by `route`.
- `sa_function_invocation_failed_total` by `route` (Vercel cold-start / import
  failures surface here — see the `api/**` lazy-import rule in CLAUDE.md).

**B. OAuth & access**
- `sa_oauth_failures_total` by `phase` (start/callback/refresh).
- OAuth refresh failure-rate % (mass re-consent early warning).

**C. Audit pipeline**
- Audit runs by `outcome`; failure-rate %.
- p95 `sa_audit_run_duration_seconds` by `kind`.
- Top `sa_audit_tool_failures_total` by `resource` (which GTM/GA4 reads break).

**D. Google API health**
- Call volume + error-rate by `api`; p95 `sa_google_api_duration_seconds`
  (latency to Google, quota-pressure indicator).

**E. Worker / runtime capture**
- `sa_worker_queue_depth` gauge + p95 `sa_worker_job_age_seconds` (backlog/SLO).
- Job outcomes; `sa_runtime_captures_total{outcome="failed"}` rate.

**F. Vault / cache**
- `sa_vault_errors_total` by `operation`.
- Cache hit-ratio % and `sa_cache_operations_total{result="error"}` rate.

**G. Deploy readiness** (no metrics needed)
- Poll `/api/system/capabilities`: render `readiness` per subsystem and surface
  any `caveats` after a production deploy.

---

## 5. Alerts & thresholds

Thresholds are **starting points** — tune to observed baselines. Evaluate over a
5–10 min window unless noted; alert on rates/ratios, not single events.

| Alert | Condition | Severity |
| --- | --- | --- |
| **Vercel 5xx spike** | API 5xx error-rate > 2% for 5m (page at > 5%) | high |
| **FUNCTION_INVOCATION_FAILED** | `increase(sa_function_invocation_failed_total[5m]) > 0` on any route | high (any non-zero is a regression — usually a bad top-level import) |
| **OAuth failure spike** | `increase(sa_oauth_failures_total{phase="callback"}[10m]) > 10` | high |
| **OAuth refresh-failure spike** | refresh failure-rate > 20% for 10m | high (mass re-consent / revoked client) |
| **Audit failure rate** | audit failure-rate > 10% for 10m | medium |
| **Audit tool-failure surge** | `increase(sa_audit_tool_failures_total[10m])` > 3× the trailing-hour avg | medium (Google API degradation / scope loss) |
| **Worker job backlog** | `sa_worker_queue_depth > 50` for 10m, OR p95 `sa_worker_job_age_seconds > 300` | medium |
| **Runtime worker failures** | `sa_runtime_captures_total{outcome="failed"}` rate > 25% for 10m | medium |
| **Token vault errors** | `increase(sa_vault_errors_total[5m]) > 0` | high (auth-path integrity) |
| **Cache errors** | `sa_cache_operations_total{result="error"}` rate > 5% for 10m | low (degrades to source-of-truth; watch latency/quota) |
| **Google API latency** | p95 `sa_google_api_duration_seconds > 5` for 10m | low/medium |

### Vendor-specific notes

- **Vercel:** wire 5xx + `FUNCTION_INVOCATION_FAILED` from the Vercel
  Observability / Log Drains feed; these are the two that most often indicate a
  broken deploy (e.g. an unsafe top-level import in `api/**`). The `caveats[]`
  from `/api/system/capabilities` is a good post-deploy gate.
- **Prometheus/Grafana:** scrape a future `/metrics` exporter; the metric names
  above are already Prom-native. Use `alerting rules` with the conditions above.
- **Datadog:** the same names work as custom metrics (`sa.http.requests.total`
  with dots, or keep underscores via the Prometheus check). Map `status_class`
  and `outcome` to tags; build monitors from the table.

---

## 6. Health & readiness endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness — process is up, returns `ok:true` + minimal env presence. |
| `GET /api/system/capabilities` | Readiness — per-subsystem `readiness` (`ready`/`degraded`/`unconfigured`), capability flags, `sessionMode`, and production-mode `caveats[]`. Never returns a secret value. |

Both are unauthenticated, read-only descriptors derived purely from env
*presence* (never a secret value), and follow the `api/**` rule (only `node:*`
+ `import type` at module load).

**Smoke test:** `npm run smoke -- --base-url <url> --mcp dist/index.js` probes
`/api/health`, `/api/system/capabilities` (asserting shape + a no-secret guard),
`/api/oauth/status`, and an MCP `tools/list` over stdio. Exit code is non-zero
if any executed check fails; surfaces that aren't reachable are skipped, not
failed.
