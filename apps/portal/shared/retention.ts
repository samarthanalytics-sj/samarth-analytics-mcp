// Data retention policy + cutoff helpers.
//
// FORWARD-LOOKING foundation: pure, dependency-free policy describing how long
// each class of durable data lives before a retention sweep deletes it. This
// file opens no connection and reads no env; it only computes cutoff timestamps
// and decides expiry. The actual sweep is a scheduled job (pg_cron, a Vercel
// cron route, or the worker) that calls `cutoffFor(...)` and issues the deletes
// documented in infra/database/0001_init.sql.
//
// Why retention matters here specifically:
//   * runtime_captures may contain PII in dataLayer values (see the column
//     comment + cache-keys NEVER_CACHE). They MUST have a hard delete-after.
//   * audit history and findings are useful for trends but unbounded growth is a
//     cost + privacy liability; they age out on a generous window.
//   * logs are short-lived operational data.
//
// All durations are expressed in days and resolved against an injected `now`
// (never `Date.now()` directly) so the logic is deterministic and unit-testable.

/** Classes of retained data. Each maps to a policy below. */
export type RetentionClass =
  | "runtime_capture" // PII-sensitive capture artifacts (runtime_captures)
  | "audit_run" // audit_runs rows (+ cascade to audit_findings)
  | "audit_finding" // audit_findings (normally cascades with its run)
  | "worker_job" // terminal worker_jobs (succeeded/failed/cancelled)
  | "log"; // structured operational logs (external sink)

export interface RetentionPolicy {
  /** Hard retention window in days. Rows older than this are deleted by the sweep. */
  retentionDays: number;
  /**
   * Whether the row carries an explicit `expires_at` column the writer sets at
   * creation (true) or whether the sweep derives the cutoff from a timestamp
   * column (false). runtime_captures sets `expires_at` up front; the rest are
   * swept by age on `created_at`/`finished_at`.
   */
  hasExplicitExpiry: boolean;
  /** The timestamp column the sweep compares against when deriving age. */
  ageColumn: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default windows. Tuned conservatively: captures (highest privacy risk) expire
 * fastest; audit history lives long enough to be useful for trend reporting but
 * is still bounded. These are defaults — a deployment may shorten them via the
 * retention sweep config, but should not extend capture retention without a
 * documented data-protection reason.
 */
export const RETENTION_POLICY: Record<RetentionClass, RetentionPolicy> = {
  runtime_capture: {
    retentionDays: 30,
    hasExplicitExpiry: true,
    ageColumn: "expires_at",
  },
  audit_run: {
    retentionDays: 365,
    hasExplicitExpiry: false,
    ageColumn: "created_at",
  },
  audit_finding: {
    retentionDays: 365,
    hasExplicitExpiry: false,
    ageColumn: "created_at",
  },
  worker_job: {
    retentionDays: 30,
    hasExplicitExpiry: false,
    ageColumn: "finished_at",
  },
  log: {
    retentionDays: 14,
    hasExplicitExpiry: false,
    ageColumn: "created_at",
  },
};

/** Return the configured policy for a class. */
export function policyFor(cls: RetentionClass): RetentionPolicy {
  return RETENTION_POLICY[cls];
}

/**
 * The cutoff instant for a sweep run: rows whose age column is strictly OLDER
 * than this are deleted. Computed as `now - retentionDays`. `now` is injected so
 * the sweep (and tests) are deterministic.
 *
 *   cutoffFor("runtime_capture", new Date("2026-06-04T00:00:00Z"))
 *     → Date 2026-05-05T00:00:00Z   (30 days earlier)
 */
export function cutoffFor(cls: RetentionClass, now: Date): Date {
  const policy = RETENTION_POLICY[cls];
  return new Date(now.getTime() - policy.retentionDays * DAY_MS);
}

/**
 * The `expires_at` value a writer should stamp on a row of this class at
 * creation time, when the class uses explicit expiry. Returns null for classes
 * swept by age (no up-front expiry column to set).
 *
 *   expiresAtFor("runtime_capture", capturedAt) → capturedAt + 30 days
 */
export function expiresAtFor(cls: RetentionClass, createdAt: Date): Date | null {
  const policy = RETENTION_POLICY[cls];
  if (!policy.hasExplicitExpiry) return null;
  return new Date(createdAt.getTime() + policy.retentionDays * DAY_MS);
}

/**
 * Decide whether a single row is expired as of `now`. For explicit-expiry
 * classes, compares against the row's stamped `expiresAt`; for age-swept
 * classes, compares the row's age-column timestamp against the derived cutoff.
 * A null/absent timestamp is treated as NOT expired (fail-safe: never delete a
 * row whose age we can't establish).
 */
export function isExpired(
  cls: RetentionClass,
  row: { expiresAt?: Date | string | null; ageTimestamp?: Date | string | null },
  now: Date,
): boolean {
  const policy = RETENTION_POLICY[cls];
  if (policy.hasExplicitExpiry) {
    const exp = toDate(row.expiresAt);
    if (!exp) return false;
    return exp.getTime() <= now.getTime();
  }
  const ts = toDate(row.ageTimestamp);
  if (!ts) return false;
  return ts.getTime() < cutoffFor(cls, now).getTime();
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
