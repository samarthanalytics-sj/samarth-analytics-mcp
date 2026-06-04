/**
 * Standalone Node test for the metric naming conventions + catalog.
 * Run: node apps/portal/shared/__tests__/metrics.node.test.mjs
 *
 * Mirrors the runtime behaviour of apps/portal/shared/metrics.ts without
 * importing TS (kept dependency-free like the other .node.test.mjs files in
 * this repo). If the .ts logic/catalog changes, update this mirror.
 */

import assert from "node:assert";

// ── inlined logic (mirror of metrics.ts) ────────────────────────────────────

const FORBIDDEN_LABEL_KEYS = [
  "org_id",
  "orgid",
  "user_id",
  "userid",
  "email",
  "url",
  "token",
  "trace_id",
  "container_id",
  "property_id",
];

// Mirror of the catalog (names + label sets only — enough to assert invariants).
const METRICS = {
  http_requests_total: {
    name: "sa_http_requests_total",
    type: "counter",
    labels: ["route", "method", "status_class"],
  },
  http_request_duration_seconds: {
    name: "sa_http_request_duration_seconds",
    type: "histogram",
    labels: ["route", "method"],
  },
  function_invocation_failed_total: {
    name: "sa_function_invocation_failed_total",
    type: "counter",
    labels: ["route"],
  },
  oauth_failures_total: {
    name: "sa_oauth_failures_total",
    type: "counter",
    labels: ["phase", "reason"],
  },
  oauth_token_refresh_total: {
    name: "sa_oauth_token_refresh_total",
    type: "counter",
    labels: ["outcome"],
  },
  audit_runs_total: {
    name: "sa_audit_runs_total",
    type: "counter",
    labels: ["kind", "outcome"],
  },
  audit_run_duration_seconds: {
    name: "sa_audit_run_duration_seconds",
    type: "histogram",
    labels: ["kind"],
  },
  audit_tool_failures_total: {
    name: "sa_audit_tool_failures_total",
    type: "counter",
    labels: ["resource"],
  },
  google_api_calls_total: {
    name: "sa_google_api_calls_total",
    type: "counter",
    labels: ["api", "outcome"],
  },
  google_api_duration_seconds: {
    name: "sa_google_api_duration_seconds",
    type: "histogram",
    labels: ["api"],
  },
  runtime_captures_total: {
    name: "sa_runtime_captures_total",
    type: "counter",
    labels: ["outcome"],
  },
  worker_jobs_total: {
    name: "sa_worker_jobs_total",
    type: "counter",
    labels: ["outcome"],
  },
  worker_queue_depth: {
    name: "sa_worker_queue_depth",
    type: "gauge",
    labels: [],
  },
  worker_job_age_seconds: {
    name: "sa_worker_job_age_seconds",
    type: "histogram",
    labels: [],
  },
  vault_errors_total: {
    name: "sa_vault_errors_total",
    type: "counter",
    labels: ["operation"],
  },
  cache_operations_total: {
    name: "sa_cache_operations_total",
    type: "counter",
    labels: ["resource", "result"],
  },
};

const isValidMetricName = (name) =>
  /^sa_[a-z][a-z0-9_]*[a-z0-9]$/.test(name) && !name.includes("__");

const isForbiddenLabel = (key) =>
  FORBIDDEN_LABEL_KEYS.includes(key.toLowerCase());

function escapeLabelValue(v) {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatPromLine(name, labels, value) {
  const entries = Object.entries(labels).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const labelStr = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  const head = labelStr ? `${name}{${labelStr}}` : name;
  return `${head} ${value}`;
}

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok ${name}`);
}

// ── name convention ──────────────────────────────────────────────────────────
check("every catalog metric name follows the sa_ snake_case convention", () => {
  for (const def of Object.values(METRICS)) {
    assert.ok(isValidMetricName(def.name), `${def.name} is invalid`);
  }
});

check("counters end in _total; duration histograms end in _seconds", () => {
  for (const def of Object.values(METRICS)) {
    if (def.type === "counter") {
      assert.ok(def.name.endsWith("_total"), `${def.name} counter needs _total`);
    }
    if (def.type === "histogram" && def.name.includes("duration")) {
      assert.ok(
        def.name.endsWith("_seconds"),
        `${def.name} duration must be _seconds (base unit)`,
      );
    }
  }
});

check("rejects invalid metric names", () => {
  assert.ok(!isValidMetricName("audit_runs_total"), "missing sa_ prefix");
  assert.ok(!isValidMetricName("sa_Audit_Runs"), "no uppercase");
  assert.ok(!isValidMetricName("sa_audit__runs"), "no double underscore");
  assert.ok(!isValidMetricName("sa_audit_runs_"), "no trailing underscore");
  assert.ok(!isValidMetricName("sa.audit.runs"), "no dots");
});

// ── label safety ─────────────────────────────────────────────────────────────
check("no catalog metric uses a forbidden (high-card/sensitive) label", () => {
  for (const def of Object.values(METRICS)) {
    for (const label of def.labels) {
      assert.ok(
        !isForbiddenLabel(label),
        `${def.name} must not use forbidden label "${label}"`,
      );
    }
  }
});

check("forbidden-label detection is case-insensitive", () => {
  assert.ok(isForbiddenLabel("org_id"));
  assert.ok(isForbiddenLabel("ORG_ID"));
  assert.ok(isForbiddenLabel("Email"));
  assert.ok(!isForbiddenLabel("route"));
  assert.ok(!isForbiddenLabel("outcome"));
});

check("metric names are unique across the catalog", () => {
  const names = Object.values(METRICS).map((d) => d.name);
  assert.strictEqual(new Set(names).size, names.length, "duplicate metric name");
});

// ── prometheus line formatting ───────────────────────────────────────────────
check("formats a labelled prometheus line with sorted labels", () => {
  const line = formatPromLine(
    "sa_audit_runs_total",
    { outcome: "ok", kind: "consent" },
    3,
  );
  assert.strictEqual(
    line,
    'sa_audit_runs_total{kind="consent",outcome="ok"} 3',
  );
});

check("formats an unlabelled gauge line", () => {
  assert.strictEqual(formatPromLine("sa_worker_queue_depth", {}, 7), "sa_worker_queue_depth 7");
});

check("escapes quotes/backslashes/newlines in label values", () => {
  const line = formatPromLine("sa_http_requests_total", { route: 'a"b\\c\nd' }, 1);
  assert.ok(line.includes('route="a\\"b\\\\c\\nd"'));
});

// eslint-disable-next-line no-console
console.log(`\nmetrics: ${passed} checks passed.`);
