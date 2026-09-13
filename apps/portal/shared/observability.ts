// Structured logging + event taxonomy for the Samarth Analytics platform.
//
// FORWARD-LOOKING foundation: pure, dependency-free helpers that define the
// canonical structured-log event shapes and a redaction pass that strips
// secrets/tokens/PII before anything is emitted. This file opens NO connection
// and imports NO external SDK — it only describes event shapes and formats a
// JSON line, so it is safe to import from the Vercel serverless `api/**` routes
// (no heavy top-level import), from the local Express server, and from the
// worker.
//
// Why this exists: today the codebase logs with ad-hoc `console.error("[tag]
// ...")` strings. Those are unstructured (not queryable in a log sink), have no
// stable event names to alert on, and have no redaction guarantee. This module
// gives every subsystem a stable `event` name + typed fields + a redaction
// guarantee, WITHOUT changing any runtime behavior: call sites can adopt
// `logEvent(...)` incrementally; nothing here is wired into a hot path by this
// change.
//
// See docs/OBSERVABILITY.md for the event catalog, metric names, and the
// recommended dashboards + alert thresholds that consume these events.

// ── Severity ─────────────────────────────────────────────────────────────────

/** Log levels, ordered least→most severe. Maps cleanly to most log sinks. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Numeric rank for a level, for threshold comparisons (higher = more severe). */
export function levelRank(level: LogLevel): number {
  return LEVEL_RANK[level];
}

// ── Event taxonomy ─────────────────────────────────────────────────────────

/**
 * The subsystem a log/event originated from. Used as a stable, low-cardinality
 * dimension for dashboards and routing (one panel/alert per subsystem).
 */
export type Subsystem =
  | "audit" // GTM/Consent audit runs (api/gtm/audit, src/tools/audit)
  | "oauth" // Google OAuth start/callback/refresh
  | "gtm" // Google Tag Manager API calls
  | "ga4" // GA4 Admin + Data API calls
  | "runtime" // headless-Chromium runtime capture
  | "worker" // background job queue / leasing
  | "vault" // token vault / session-token storage
  | "cache" // discovery/job-status cache layer
  | "system"; // health, capabilities, server lifecycle

/**
 * Stable event names. These are the strings dashboards and alerts key on, so
 * treat them as a contract: add new ones freely, but renaming an existing value
 * breaks any saved query/alert that references it. Grouped by subsystem.
 */
export type ObservabilityEvent =
  // audit
  | "audit.run.started"
  | "audit.run.succeeded"
  | "audit.run.failed"
  | "audit.tool.failure" // a single read inside a run failed (recorded, run continues)
  // oauth
  | "oauth.start"
  | "oauth.callback.succeeded"
  | "oauth.callback.failed"
  | "oauth.token.refreshed"
  | "oauth.token.refresh_failed"
  // gtm / ga4 upstream API calls
  | "gtm.api.call"
  | "gtm.api.error"
  | "ga4.api.call"
  | "ga4.api.error"
  // runtime capture
  | "runtime.capture.started"
  | "runtime.capture.succeeded"
  | "runtime.capture.failed"
  // worker queue
  | "worker.job.enqueued"
  | "worker.job.leased"
  | "worker.job.succeeded"
  | "worker.job.failed"
  | "worker.job.retry"
  // vault / cache
  | "vault.read"
  | "vault.write"
  | "vault.error"
  | "cache.hit"
  | "cache.miss"
  | "cache.error"
  // system lifecycle
  | "system.startup"
  | "system.shutdown";

/**
 * A structured log record. Only low-cardinality, non-sensitive fields are
 * first-class; everything else goes in `fields`, which is redacted before
 * emit. `orgId`/`userId` are opaque identifiers (UUID / Google `sub`), never an
 * email or token. Durations are milliseconds.
 */
export interface LogRecord {
  level: LogLevel;
  subsystem: Subsystem;
  event: ObservabilityEvent;
  /** Human-readable message. Keep it static (no interpolated secrets/ids). */
  message: string;
  /** Correlation id propagated across a request → upstream call chain. */
  traceId?: string;
  /** Opaque tenant id. Never an email/domain. */
  orgId?: string;
  /** Opaque user id (Google `sub`). Never an email. */
  userId?: string;
  /** Operation duration in milliseconds, when the event closes a span. */
  durationMs?: number;
  /** Upstream/HTTP status code, when applicable. */
  statusCode?: number;
  /** Error class name only (e.g. "TypeError") — never the raw message/stack. */
  errorName?: string;
  /** Arbitrary extra context. REDACTED before emit — see `redact()`. */
  fields?: Record<string, unknown>;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * Field-name fragments that mark a value as secret/PII. Matching is
 * case-insensitive and substring-based, so `accessToken`, `ACCESS_TOKEN`, and
 * `google_access_token` all match `token`. Kept deliberately broad: a false
 * positive (over-redaction) is harmless; a false negative leaks a secret.
 */
export const REDACT_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "credential",
  "client_secret",
  "clientsecret",
  "refresh",
  "access_token",
  "id_token",
  "apikey",
  "api_key",
  "private_key",
  "email", // PII — opaque ids are fine, addresses are not
] as const;

/** The string substituted for any redacted value. */
export const REDACTED = "[REDACTED]";

/** Max recursion depth for redaction; guards against cyclic/huge objects. */
const MAX_DEPTH = 6;

function keyIsSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

/**
 * Heuristic value-level redaction for values that look like bearer/OAuth
 * tokens even under an innocuous key. Catches `ya29.*` (Google access tokens),
 * long JWTs (`xxx.yyy.zzz`), and `Bearer <token>` strings. Conservative on
 * purpose: only redacts strings that strongly resemble a credential, so normal
 * free text (messages, URLs, ids) passes through.
 */
function valueLooksSensitive(value: string): boolean {
  if (value.length < 12) return false;
  if (/^ya29\./.test(value)) return true; // Google OAuth access token
  if (/^bearer\s+\S+/i.test(value)) return true;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value))
    return true; // JWT-shaped
  return false;
}

/**
 * Recursively redact a value: any object key whose name matches
 * `REDACT_KEY_FRAGMENTS` has its value replaced with `[REDACTED]`, and any
 * string value that *looks* like a token is redacted regardless of key. Arrays
 * and nested objects are walked. Non-plain values (numbers, booleans, null) are
 * returned as-is. Pure — never mutates the input.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (typeof value === "string") {
    return valueLooksSensitive(value) ? REDACTED : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keyIsSensitive(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  // functions, symbols, bigint, etc. — never log these verbatim.
  return undefined;
}

// ── Formatting / emit ────────────────────────────────────────────────────────

/** Shape after redaction is applied — what actually gets serialized. */
export interface SerializedLogRecord extends Omit<LogRecord, "fields"> {
  /** Always present; ISO-8601 timestamp added at format time. */
  ts: string;
  /** Redacted copy of `fields`. */
  fields?: Record<string, unknown>;
}

/**
 * Build the redacted, serializable record for a log event. Adds a UTC ISO
 * timestamp and runs `fields` through `redact()`. Does NOT emit — `logEvent`
 * does that. Exposed separately so tests (and any custom sink) can assert on
 * the exact record without capturing stdout.
 */
export function buildRecord(
  record: LogRecord,
  now: Date = new Date(),
): SerializedLogRecord {
  const { fields, ...rest } = record;
  const serialized: SerializedLogRecord = {
    ts: now.toISOString(),
    ...rest,
  };
  if (fields !== undefined) {
    serialized.fields = redact(fields) as Record<string, unknown>;
  }
  return serialized;
}

/**
 * Serialize a record to a single JSON line. Falls back to a minimal record if
 * the input contains something unserializable (e.g. a circular ref that slipped
 * past redaction), so logging can never throw on the caller's hot path.
 */
export function formatLine(record: SerializedLogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      subsystem: record.subsystem,
      event: record.event,
      message: record.message,
      errorName: "log_serialization_failed",
    });
  }
}

/** Sink signature — defaults to console, but injectable for tests/custom sinks. */
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
  // Route warn/error to stderr, info/debug to stdout — standard for log drains.
  // eslint-disable-next-line no-console
  if (level === "error" || level === "warn") console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
};

/**
 * The single minimum level that gets emitted. Read from `LOG_LEVEL` (env) at
 * call time so it can be tuned per-deployment without a redeploy of this
 * module. Defaults to `info`. Unknown values fall back to `info`.
 */
export function minLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

/**
 * Emit a structured, redacted log line. Safe to call from anywhere: it never
 * throws, never blocks, and never emits a secret (redaction is mandatory).
 * Below-threshold records are dropped cheaply. The sink is injectable for tests.
 */
export function logEvent(record: LogRecord, sink: LogSink = consoleSink): void {
  try {
    if (levelRank(record.level) < levelRank(minLevel())) return;
    const line = formatLine(buildRecord(record));
    sink(record.level, line);
  } catch {
    // Logging must never break the caller. Swallow.
  }
}

/**
 * Reduce any thrown value to a safe, low-cardinality error class name. Never
 * returns the message or stack (which can contain tokens, URLs with creds, or
 * PII). Use this to populate `LogRecord.errorName`.
 */
export function safeErrorName(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && err.name) {
    return err.name;
  }
  return "UnknownError";
}
