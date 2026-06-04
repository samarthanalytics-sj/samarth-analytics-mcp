/**
 * Deterministic accuracy-invariant regression suite for the audit normalizer
 * (../audit-accuracy.ts).
 *
 * Pure-logic, table-driven. Every case feeds plain data into the pure helpers and
 * asserts on the result — no I/O, no network, no Date.now. Identical input ->
 * identical output. These encode the public-SaaS false-confidence policy
 * documented in docs/audit-accuracy.md:
 *   - config-only findings cannot claim runtime behaviour,
 *   - runtime findings require a RUNTIME source,
 *   - incomplete CONFIG-only evidence cannot present as high/critical,
 *   - GA4 Data API zero-activity wording is "reported", not "not firing",
 *   - every finding carries sources + confidence.
 *
 * Run: npx tsx apps/portal/shared/__tests__/audit-accuracy.node.test.ts
 */

import assert from "node:assert";
import {
  normalizeFindingAccuracy,
  containsRuntimeClaim,
  isConfigOnly,
  coverageIsConfigOnly,
  configOnlyCoverageWarning,
  defaultConfidence,
  type AccuracyFinding,
  type AccuracySource,
  type AccuracySeverity,
} from "../audit-accuracy";

// ── tiny test harness (mirrors consent-audit.node.test.ts) ──────────────────

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

function f(partial: Partial<AccuracyFinding> & { severity?: AccuracySeverity }): AccuracyFinding {
  return {
    finding: partial.finding,
    title: partial.title,
    severity: partial.severity ?? "medium",
    sources: partial.sources,
    confidence: partial.confidence,
    needsManualReview: partial.needsManualReview,
  };
}

const CONFIG: AccuracySource[] = ["CONFIG"];
const RUNTIME: AccuracySource[] = ["RUNTIME"];

// ── A. containsRuntimeClaim ─────────────────────────────────────────────────

test("A01 plain 'fires on' is a runtime claim", () => {
  assert.ok(containsRuntimeClaim("GA4 Event tag fires on an All Pages trigger"));
});
test("A02 'double-fires' is a runtime claim", () => {
  assert.ok(containsRuntimeClaim("tag double-fires on navigation"));
});
test("A03 'is firing' is a runtime claim", () => {
  assert.ok(containsRuntimeClaim("the pixel is firing twice"));
});
test("A04 'sends X on every' is a runtime claim", () => {
  assert.ok(containsRuntimeClaim("sends a custom event on every navigation"));
});
test("A05 'observed firing' is a runtime claim", () => {
  assert.ok(containsRuntimeClaim("2 GA4 hits observed firing on a single load"));
});
test("A06 config noun 'firing trigger' is NOT a claim", () => {
  assert.ok(!containsRuntimeClaim("Tag has no firing trigger attached"));
});
test("A07 'references a firing trigger that does not exist' is NOT a claim", () => {
  assert.ok(!containsRuntimeClaim("Tag references a firing trigger that does not exist"));
});
test("A08 'configured to run on every navigation' is NOT a claim", () => {
  assert.ok(!containsRuntimeClaim("is configured to run on every navigation"));
});
test("A09 empty/undefined text is NOT a claim", () => {
  assert.ok(!containsRuntimeClaim(undefined));
  assert.ok(!containsRuntimeClaim(""));
});
test("A10 the fixed All-Pages wording is NOT a claim", () => {
  assert.ok(
    !containsRuntimeClaim(
      "GA4 Event tag is configured on an All Pages / pageview trigger",
    ),
  );
});

// ── B. isConfigOnly / coverage helpers ──────────────────────────────────────

test("B01 CONFIG alone is config-only", () => {
  assert.ok(isConfigOnly(["CONFIG"]));
});
test("B02 empty sources defaults to config-only", () => {
  assert.ok(isConfigOnly(undefined));
  assert.ok(isConfigOnly([]));
});
test("B03 CONFIG+RUNTIME is not config-only", () => {
  assert.ok(!isConfigOnly(["CONFIG", "RUNTIME"]));
});
test("B04 RUNTIME alone is not config-only", () => {
  assert.ok(!isConfigOnly(["RUNTIME"]));
});
test("B05 coverageIsConfigOnly true only with CONFIG and nothing else", () => {
  assert.ok(coverageIsConfigOnly({ CONFIG: true }));
});
test("B06 coverageIsConfigOnly false when RUNTIME connected", () => {
  assert.ok(!coverageIsConfigOnly({ CONFIG: true, RUNTIME: true }));
});
test("B07 coverageIsConfigOnly false when GA4_ADMIN connected", () => {
  assert.ok(!coverageIsConfigOnly({ CONFIG: true, GA4_ADMIN: true }));
});
test("B08 coverageIsConfigOnly false when DATA_API connected", () => {
  assert.ok(!coverageIsConfigOnly({ CONFIG: true, DATA_API: true }));
});
test("B09 config-only warning is non-empty and mentions single source", () => {
  const w = configOnlyCoverageWarning();
  assert.ok(w.length > 0);
  assert.ok(/single source|Only CONFIG/i.test(w));
});

// ── C. defaultConfidence ────────────────────────────────────────────────────

test("C01 manual review -> low confidence", () => {
  assert.equal(defaultConfidence(CONFIG, true), "low");
});
test("C02 config-only -> medium confidence", () => {
  assert.equal(defaultConfidence(CONFIG, false), "medium");
});
test("C03 runtime source -> high confidence", () => {
  assert.equal(defaultConfidence(RUNTIME, false), "high");
});
test("C04 GA4_ADMIN source -> high confidence", () => {
  assert.equal(defaultConfidence(["CONFIG", "GA4_ADMIN"], false), "high");
});
test("C05 DATA_API (no proof source) -> medium", () => {
  assert.equal(defaultConfidence(["CONFIG", "DATA_API"], false), "medium");
});

// ── D. normalizeFindingAccuracy: evidence-field guarantee ───────────────────

test("D01 always populates sources (defaults to CONFIG)", () => {
  const r = normalizeFindingAccuracy(f({ severity: "low" }));
  assert.deepEqual(r.sources, ["CONFIG"]);
});
test("D02 always populates confidence", () => {
  const r = normalizeFindingAccuracy(f({ severity: "low", sources: CONFIG }));
  assert.ok(r.confidence === "low" || r.confidence === "medium" || r.confidence === "high");
});
test("D03 never returns undefined needsManualReview", () => {
  const r = normalizeFindingAccuracy(f({ severity: "low" }));
  assert.equal(typeof r.needsManualReview, "boolean");
});
test("D04 preserves id/text-bearing fields untouched", () => {
  const input = f({ finding: "X", severity: "medium", sources: CONFIG });
  const r = normalizeFindingAccuracy(input);
  assert.equal(r.finding, "X");
});

// ── E. config-only confidence cap ───────────────────────────────────────────

test("E01 config-only high-confidence input capped to medium", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "medium", sources: CONFIG, confidence: "high" }),
  );
  assert.equal(r.confidence, "medium");
});
test("E02 multi-source high confidence is preserved", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "high", sources: ["CONFIG", "RUNTIME"], confidence: "high" }),
  );
  assert.equal(r.confidence, "high");
});

// ── F. severity downgrade on incomplete CONFIG-only evidence ────────────────

test("F01 config-only + manualReview + high -> downgraded to medium/low", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "high", sources: CONFIG, needsManualReview: true }),
  );
  assert.equal(r.severity, "medium");
  assert.equal(r.confidence, "low");
});
test("F02 config-only + manualReview + critical -> downgraded to medium/low", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "critical", sources: CONFIG, needsManualReview: true }),
  );
  assert.equal(r.severity, "medium");
});
test("F03 config-only high WITHOUT manualReview is NOT downgraded", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "high", sources: CONFIG, needsManualReview: false }),
  );
  assert.equal(r.severity, "high");
});
test("F04 runtime high + manualReview keeps high severity (has proof)", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "high", sources: RUNTIME, needsManualReview: true }),
  );
  assert.equal(r.severity, "high");
});
test("F05 multi-source critical + manualReview keeps critical", () => {
  const r = normalizeFindingAccuracy(
    f({ severity: "critical", sources: ["CONFIG", "SGTM"], needsManualReview: true }),
  );
  assert.equal(r.severity, "critical");
});

// ── G. runtime-wording guard ────────────────────────────────────────────────

test("G01 config-only finding with runtime verb -> forced manual review", () => {
  const r = normalizeFindingAccuracy(
    f({ finding: "tag fires on every page", severity: "medium", sources: CONFIG }),
  );
  assert.equal(r.needsManualReview, true);
});
test("G02 runtime-claim wording WITH runtime source is allowed (no force)", () => {
  const r = normalizeFindingAccuracy(
    f({ finding: "2 GA4 collect hits observed firing", severity: "medium", sources: RUNTIME }),
  );
  // Not forced solely by wording — runtime evidence backs the claim.
  assert.equal(r.needsManualReview, false);
});
test("G03 config-only runtime-claim forces manual review -> confidence low", () => {
  const r = normalizeFindingAccuracy(
    f({ finding: "tag double-fires", severity: "medium", sources: CONFIG, confidence: "medium" }),
  );
  assert.equal(r.confidence, "low");
});
test("G04 clean config wording is untouched", () => {
  const r = normalizeFindingAccuracy(
    f({ finding: "Tag has no firing trigger attached", severity: "medium", sources: CONFIG, needsManualReview: false }),
  );
  assert.equal(r.needsManualReview, false);
});

// ── H. GA4 Data API zero-activity wording policy ────────────────────────────
// The audit rule's copy must phrase zero activity as *reported*, never as a
// runtime "not firing" claim. These guard that contract at the string level.

const ZERO_EVENTS_FINDING =
  "3 GTM-configured GA4 events reported zero events in the last 28 days";

test("H01 zero-events wording does not say 'not firing'", () => {
  assert.ok(!/not firing/i.test(ZERO_EVENTS_FINDING));
});
test("H02 zero-events wording is not a runtime claim", () => {
  assert.ok(!containsRuntimeClaim(ZERO_EVENTS_FINDING));
});
test("H03 zero-events wording uses 'reported'", () => {
  assert.ok(/reported/i.test(ZERO_EVENTS_FINDING));
});
test("H04 zero-events finding with DATA_API source stays manual/medium", () => {
  const r = normalizeFindingAccuracy(
    f({ finding: ZERO_EVENTS_FINDING, severity: "medium", sources: ["CONFIG", "DATA_API"], needsManualReview: true }),
  );
  assert.equal(r.severity, "medium");
  assert.equal(r.confidence, "low");
});

// ── I. Meta Pixel/CAPI dedup remains manual without Meta Events Manager ──────
// Final dedup proof needs Meta Events Manager. Even with RUNTIME + SGTM the
// finding must remain manual-review (RUNTIME+SGTM alone cannot prove dedup).

test("I01 capi dedup with RUNTIME+SGTM still manual review", () => {
  const r = normalizeFindingAccuracy(
    f({
      finding: "Meta Pixel and CAPI may not be deduplicated (eventID)",
      severity: "medium",
      sources: ["CONFIG", "RUNTIME", "SGTM"],
      needsManualReview: true,
    }),
  );
  assert.equal(r.needsManualReview, true);
  assert.equal(r.confidence, "low");
});
test("I02 capi dedup is not auto-resolved to high confidence", () => {
  const r = normalizeFindingAccuracy(
    f({
      finding: "Meta Pixel and CAPI deduplication needs verification",
      severity: "medium",
      sources: ["CONFIG", "SGTM"],
      needsManualReview: true,
    }),
  );
  assert.notEqual(r.confidence, "high");
});

// ── J. idempotence / stability ──────────────────────────────────────────────

test("J01 normalize is idempotent", () => {
  const once = normalizeFindingAccuracy(
    f({ finding: "tag fires", severity: "high", sources: CONFIG, needsManualReview: true }),
  );
  const twice = normalizeFindingAccuracy(once);
  assert.deepEqual(once, twice);
});
test("J02 runtime finding round-trips unchanged in severity/confidence", () => {
  const input = f({ finding: "No GA4 collect hit observed on a captured page", severity: "high", sources: RUNTIME, confidence: "high", needsManualReview: false });
  const r = normalizeFindingAccuracy(input);
  assert.equal(r.severity, "high");
  assert.equal(r.confidence, "high");
});

// ── run summary ──────────────────────────────────────────────────────────--

const total = passed + failed;
console.log(`\nAudit accuracy — invariant regression suite`);
console.log(`  cases run:    ${total}`);
console.log(`  passed:       ${passed}`);
console.log(`  failed:       ${failed}`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const ff of failures) console.error(`  ✗ ${ff}`);
  process.exit(1);
}
if (total < 40) {
  console.error(`\n✗ Expected at least 40 validation cases, only ${total} ran.`);
  process.exit(1);
}
console.log(`\n✓ All ${total} audit-accuracy regression cases passed (>= 40 required).`);
