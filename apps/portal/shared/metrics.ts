// Metric naming conventions + the canonical metric catalog.
//
// FORWARD-LOOKING foundation: pure, dependency-free helpers that define the
// stable metric names, types, and allowed label keys the platform emits. This
// file talks to NO metrics backend (no StatsD/Prometheus/Datadog client) — it
// only describes the naming contract and validates/formats names, so it is safe
// to import from the Vercel serverless `api/**` routes, the Express server, and
// the worker.
//
// Why this exists: dashboards and alerts are only as stable as the metric names
// they query. Defining the names here once — with a single naming convention
// and a fixed, low-cardinality label set — means a metric exporter (when one is
// wired) and the docs in docs/OBSERVABILITY.md cannot drift from each other.
// Nothing here is on a hot path; adopting the names is incremental.
//
// Convention (Prometheus-style, the common denominator that maps cleanly to
// Datadog and StatsD too):
//   - lowercase snake_case, dot-free, prefixed with the app namespace `sa_`
//   - counters end in `_total`
//   - durations are histograms ending in `_seconds` (NOT milliseconds — the
//     Prometheus convention is base units)
//   - gauges describe a current value with no suffix rule, but read as a noun
//   - labels are low-cardinality only — NEVER an org id, user id, url, or token

/** Namespace prefix for every metric this platform emits. */
export const METRIC_NS = "sa";

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricDef {
  /** Fully-qualified metric name, e.g. `sa_audit_runs_total`. */
  name: string;
  type: MetricType;
  /** One-line description (shows up in `# HELP` / metric catalog). */
  help: string;
  /**
   * Allowed label keys. Kept tiny and low-cardinality on purpose — high
   * cardinality (ids, urls) explodes the time-series count and the bill.
   */
  labels: readonly string[];
}

/**
 * Label keys that must NEVER be attached to a metric — they are unbounded /
 * high-cardinality / sensitive and would blow up the series count or leak data.
 * Asserted by the test suite against every catalog entry.
 */
export const FORBIDDEN_LABEL_KEYS = [
  "org_id",
  "orgid",
  "user_id",
  "userid",
  "email",
  "url",
  "token",
  "trace_id", // belongs in logs/traces, not as a metric label
  "container_id",
  "property_id",
] as const;

/**
 * The canonical metric catalog. These names back the dashboards and alerts in
 * docs/OBSERVABILITY.md. Treat the `name` strings as a contract: renaming one
 * breaks saved queries/alerts. Add freely.
 */
export const METRICS = {
  // ── HTTP / serverless ──
  http_requests_total: {
    name: "sa_http_requests_total",
    type: "counter",
    help: "Total HTTP requests handled by the portal API, by route/method/status class.",
    labels: ["route", "method", "status_class"],
  },
  http_request_duration_seconds: {
    name: "sa_http_request_duration_seconds",
    type: "histogram",
    help: "Portal API request latency in seconds, by route/method.",
    labels: ["route", "method"],
  },
  function_invocation_failed_total: {
    name: "sa_function_invocation_failed_total",
    type: "counter",
    help: "Serverless invocations that failed before returning a response (FUNCTION_INVOCATION_FAILED proxy).",
    labels: ["route"],
  },

  // ── OAuth ──
  oauth_failures_total: {
    name: "sa_oauth_failures_total",
    type: "counter",
    help: "OAuth start/callback/refresh failures, by phase and reason class.",
    labels: ["phase", "reason"],
  },
  oauth_token_refresh_total: {
    name: "sa_oauth_token_refresh_total",
    type: "counter",
    help: "OAuth access-token refresh attempts, by outcome.",
    labels: ["outcome"],
  },

  // ── Audit ──
  audit_runs_total: {
    name: "sa_audit_runs_total",
    type: "counter",
    help: "Audit runs executed, by kind and outcome.",
    labels: ["kind", "outcome"],
  },
  audit_run_duration_seconds: {
    name: "sa_audit_run_duration_seconds",
    type: "histogram",
    help: "Audit run wall-clock duration in seconds, by kind.",
    labels: ["kind"],
  },
  audit_tool_failures_total: {
    name: "sa_audit_tool_failures_total",
    type: "counter",
    help: "Individual tool/read failures recorded during audit runs, by resource.",
    labels: ["resource"],
  },

  // ── GTM / GA4 upstream calls ──
  google_api_calls_total: {
    name: "sa_google_api_calls_total",
    type: "counter",
    help: "Calls to Google APIs (GTM/GA4), by api and outcome.",
    labels: ["api", "outcome"],
  },
  google_api_duration_seconds: {
    name: "sa_google_api_duration_seconds",
    type: "histogram",
    help: "Google API call latency in seconds, by api.",
    labels: ["api"],
  },

  // ── Runtime worker / capture ──
  runtime_captures_total: {
    name: "sa_runtime_captures_total",
    type: "counter",
    help: "Runtime (headless-Chromium) captures, by outcome.",
    labels: ["outcome"],
  },
  worker_jobs_total: {
    name: "sa_worker_jobs_total",
    type: "counter",
    help: "Worker jobs processed, by outcome (succeeded/failed/retry).",
    labels: ["outcome"],
  },
  worker_queue_depth: {
    name: "sa_worker_queue_depth",
    type: "gauge",
    help: "Current number of queued worker jobs awaiting a lease.",
    labels: [],
  },
  worker_job_age_seconds: {
    name: "sa_worker_job_age_seconds",
    type: "histogram",
    help: "Age in seconds of jobs at lease time (queue latency).",
    labels: [],
  },

  // ── Vault / cache ──
  vault_errors_total: {
    name: "sa_vault_errors_total",
    type: "counter",
    help: "Token-vault read/write errors, by operation.",
    labels: ["operation"],
  },
  cache_operations_total: {
    name: "sa_cache_operations_total",
    type: "counter",
    help: "Cache operations, by resource and result (hit/miss/error).",
    labels: ["resource", "result"],
  },
} as const satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof METRICS;

/** `true` if `name` follows the `sa_`-prefixed snake_case convention. */
export function isValidMetricName(name: string): boolean {
  return /^sa_[a-z][a-z0-9_]*[a-z0-9]$/.test(name) && !name.includes("__");
}

/** `true` if `key` is a forbidden (high-cardinality/sensitive) label key. */
export function isForbiddenLabel(key: string): boolean {
  const k = key.toLowerCase();
  return (FORBIDDEN_LABEL_KEYS as readonly string[]).includes(k);
}

/**
 * Render a Prometheus-style exposition line for a single sample. Pure string
 * builder — does not register or export anything. Labels are sorted for stable
 * output and label values are escaped per the Prometheus text format. Throws if
 * a label value is non-finite for a numeric metric only via `value` checks at
 * the call site; here we trust `value` is a finite number.
 *
 *   formatPromLine("sa_audit_runs_total", { kind: "consent", outcome: "ok" }, 3)
 *     → 'sa_audit_runs_total{kind="consent",outcome="ok"} 3'
 */
export function formatPromLine(
  name: string,
  labels: Record<string, string>,
  value: number,
): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  const labelStr = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  const head = labelStr ? `${name}{${labelStr}}` : name;
  return `${head} ${value}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
