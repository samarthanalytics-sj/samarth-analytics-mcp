/**
 * Retention policy + cutoff invariant suite for ../retention.ts.
 *
 * Pure-logic, deterministic — every cutoff is computed against an injected
 * `now`, never Date.now(). Encodes the retention contract:
 *   - captures (PII) expire fastest and via an explicit expires_at,
 *   - audit history is bounded but generous,
 *   - cutoff math is exact,
 *   - a row with an unknown age is NEVER deleted (fail-safe).
 *
 * Run: npx tsx apps/portal/shared/__tests__/retention.node.test.ts
 */

import assert from "node:assert";
import {
  RETENTION_POLICY,
  policyFor,
  cutoffFor,
  expiresAtFor,
  isExpired,
  type RetentionClass,
} from "../retention";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const NOW = new Date("2026-06-04T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const CLASSES: RetentionClass[] = [
  "runtime_capture",
  "audit_run",
  "audit_finding",
  "worker_job",
  "log",
];

// ── A. policy shape ─────────────────────────────────────────────────────────

test("A01 every class has a policy with a positive window", () => {
  for (const c of CLASSES) {
    const p = policyFor(c);
    assert.ok(p.retentionDays > 0, `${c} retentionDays must be > 0`);
    assert.ok(typeof p.ageColumn === "string" && p.ageColumn.length > 0);
  }
});
test("A02 runtime_capture uses an explicit expires_at column", () => {
  assert.strictEqual(RETENTION_POLICY.runtime_capture.hasExplicitExpiry, true);
  assert.strictEqual(RETENTION_POLICY.runtime_capture.ageColumn, "expires_at");
});
test("A03 captures expire fastest among durable rows (privacy)", () => {
  assert.ok(
    RETENTION_POLICY.runtime_capture.retentionDays <=
      RETENTION_POLICY.audit_run.retentionDays,
  );
});
test("A04 audit history is bounded but generous (>= captures)", () => {
  assert.ok(RETENTION_POLICY.audit_run.retentionDays >= 30);
});
test("A05 logs are short-lived", () => {
  assert.ok(RETENTION_POLICY.log.retentionDays <= 30);
});

// ── B. cutoff math ──────────────────────────────────────────────────────────

test("B01 cutoffFor subtracts exactly retentionDays", () => {
  const cut = cutoffFor("runtime_capture", NOW);
  assert.strictEqual(
    cut.getTime(),
    NOW.getTime() - RETENTION_POLICY.runtime_capture.retentionDays * DAY,
  );
});
test("B02 cutoff for a 365-day class is one (non-leap) year back", () => {
  const cut = cutoffFor("audit_run", NOW);
  assert.strictEqual(cut.getTime(), NOW.getTime() - 365 * DAY);
});
test("B03 cutoff is pure (same now → same cutoff)", () => {
  assert.strictEqual(
    cutoffFor("log", NOW).getTime(),
    cutoffFor("log", NOW).getTime(),
  );
});

// ── C. expiresAtFor (writer-stamped expiry) ──────────────────────────────────

test("C01 explicit-expiry class returns createdAt + window", () => {
  const created = new Date("2026-05-01T00:00:00Z");
  const exp = expiresAtFor("runtime_capture", created);
  assert.ok(exp);
  assert.strictEqual(exp!.getTime(), created.getTime() + 30 * DAY);
});
test("C02 age-swept class returns null (no up-front expiry)", () => {
  assert.strictEqual(expiresAtFor("audit_run", NOW), null);
  assert.strictEqual(expiresAtFor("log", NOW), null);
});

// ── D. isExpired — explicit-expiry path ──────────────────────────────────────

test("D01 capture past its expires_at is expired", () => {
  const exp = new Date(NOW.getTime() - 1000);
  assert.ok(isExpired("runtime_capture", { expiresAt: exp }, NOW));
});
test("D02 capture before its expires_at is not expired", () => {
  const exp = new Date(NOW.getTime() + DAY);
  assert.ok(!isExpired("runtime_capture", { expiresAt: exp }, NOW));
});
test("D03 capture exactly at expires_at is expired (<=)", () => {
  assert.ok(isExpired("runtime_capture", { expiresAt: NOW }, NOW));
});
test("D04 capture with null expires_at is NOT expired (fail-safe)", () => {
  assert.ok(!isExpired("runtime_capture", { expiresAt: null }, NOW));
});
test("D05 accepts ISO string timestamps", () => {
  const exp = new Date(NOW.getTime() - DAY).toISOString();
  assert.ok(isExpired("runtime_capture", { expiresAt: exp }, NOW));
});

// ── E. isExpired — age-swept path ────────────────────────────────────────────

test("E01 audit_run older than cutoff is expired", () => {
  const old = new Date(NOW.getTime() - 366 * DAY);
  assert.ok(isExpired("audit_run", { ageTimestamp: old }, NOW));
});
test("E02 audit_run inside window is not expired", () => {
  const recent = new Date(NOW.getTime() - 364 * DAY);
  assert.ok(!isExpired("audit_run", { ageTimestamp: recent }, NOW));
});
test("E03 row exactly at cutoff is NOT expired (strict older-than)", () => {
  const atCutoff = cutoffFor("audit_run", NOW);
  assert.ok(!isExpired("audit_run", { ageTimestamp: atCutoff }, NOW));
});
test("E04 age-swept row with null timestamp is NOT expired (fail-safe)", () => {
  assert.ok(!isExpired("audit_run", { ageTimestamp: null }, NOW));
  assert.ok(!isExpired("worker_job", {}, NOW));
});
test("E05 worker_job swept on finished_at window", () => {
  const old = new Date(NOW.getTime() - 31 * DAY);
  assert.ok(isExpired("worker_job", { ageTimestamp: old }, NOW));
});
test("E06 invalid timestamp string is treated as unknown → not expired", () => {
  assert.ok(!isExpired("audit_run", { ageTimestamp: "not-a-date" }, NOW));
});

// ── run summary ──────────────────────────────────────────────────────────--

const total = passed + failed;
console.log(`\nRetention — policy + cutoff suite`);
console.log(`  cases run:    ${total}`);
console.log(`  passed:       ${passed}`);
console.log(`  failed:       ${failed}`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const ff of failures) console.error(`  ✗ ${ff}`);
  process.exit(1);
}
if (total < 20) {
  console.error(`\n✗ Expected at least 20 retention cases, only ${total} ran.`);
  process.exit(1);
}
console.log(`\n✓ All ${total} retention cases passed (>= 20 required).`);
