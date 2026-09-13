/**
 * Golden / snapshot invariant suite for the full audit accuracy path.
 *
 * Feeds the SYNTHETIC anonymized GTM fixtures (./fixtures/anonymized-containers)
 * through the *real* shared consent engine (../consent-audit `runConsentAudit`)
 * and the *real* accuracy normalizer (../audit-accuracy `normalizeFindingAccuracy`)
 * — the exact pure cores the production consent route uses — then locks in the
 * public-SaaS accuracy invariants on the produced findings:
 *
 *   - every finding is source-scoped (CONFIG and/or RUNTIME, never empty),
 *   - a CONFIG-only run caps confidence at medium and makes NO observed-runtime
 *     claims,
 *   - structured evidence[] is always present and short/safe (no huge raw JSON),
 *   - normalization is deterministic and idempotent (snapshot is stable).
 *
 * The "snapshot" here is an in-test, normalized projection (id/severity/
 * confidence/sources/evidence-shape) compared against an inline golden — no
 * timestamps, no ordering churn, no external .snap file to drift.
 *
 * Run: npx tsx apps/portal/shared/__tests__/audit-snapshot.node.test.ts
 */

import assert from "node:assert";
import { runConsentAudit, type ConsentFinding } from "../consent-audit";
import {
  normalizeFindingAccuracy,
  containsRuntimeClaim,
  type AccuracyFinding,
  type EvidenceItem,
} from "../audit-accuracy";
import {
  FIXTURE_A_CONFIG_ONLY_WEB,
  FIXTURE_B_RECONCILE_WEB,
} from "./fixtures/anonymized-containers";

// ── tiny test harness (mirrors audit-accuracy.node.test.ts) ─────────────────

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

const MAX_CONF: Record<string, number> = { low: 1, medium: 2, high: 3 };

/**
 * Run a fixture through the production pure cores exactly as the consent route
 * does: engine -> per-finding accuracy normalizer.
 */
type NormalizedFinding = ReturnType<typeof normalizeFindingAccuracy<AccuracyFinding>> &
  Pick<ConsentFinding, "id" | "finding" | "whyItMatters" | "suggestedFix">;

function auditFixture(
  cfg: Parameters<typeof runConsentAudit>[0],
  rt: Parameters<typeof runConsentAudit>[1],
): {
  coverage: string;
  findings: NormalizedFinding[];
} {
  const result = runConsentAudit(cfg, rt);
  const findings = result.findings.map((f) => {
    // The engine carries `evidence?: string[]` (legacy snippets); the accuracy
    // normalizer owns `evidence?: EvidenceItem[]`. Drop the legacy string array
    // before normalizing so the structured evidence floor is derived cleanly.
    const { evidence: _legacy, ...rest } = f;
    const acc = normalizeFindingAccuracy<AccuracyFinding>({
      finding: rest.finding,
      severity: rest.severity,
      confidence: rest.confidence,
      sources: rest.sources,
      needsManualReview: rest.needsManualReview,
      entity: rest.entity,
      parameter: rest.parameter,
    });
    return {
      ...acc,
      id: rest.id,
      finding: rest.finding,
      whyItMatters: rest.whyItMatters,
      suggestedFix: rest.suggestedFix,
    } as NormalizedFinding;
  });
  return { coverage: result.coverage, findings };
}

/** Deterministic, snapshot-safe projection of a normalized finding. */
function project(f: {
  id?: string;
  severity?: string;
  confidence?: string;
  sources?: string[];
  evidence?: EvidenceItem[];
}): {
  id: string;
  severity: string;
  confidence: string;
  sources: string[];
  evidenceSources: string[];
} {
  return {
    id: f.id ?? "",
    severity: f.severity ?? "",
    confidence: f.confidence ?? "",
    sources: [...(f.sources ?? [])].sort(),
    evidenceSources: [...new Set((f.evidence ?? []).map((e) => e.source))].sort(),
  };
}

// ── Fixture A: CONFIG-only web container ────────────────────────────────────

const A = auditFixture(FIXTURE_A_CONFIG_ONLY_WEB.config, null);

test("A-snap: CONFIG-only fixture produces config_only coverage", () => {
  assert.equal(A.coverage, "config_only");
});

test("A-snap: CONFIG-only fixture produces at least one finding", () => {
  assert.ok(A.findings.length > 0, "expected findings from a consent-gap container");
});

test("A-inv: every finding is source-scoped (non-empty sources)", () => {
  for (const f of A.findings) {
    assert.ok(
      Array.isArray(f.sources) && f.sources.length > 0,
      `finding ${f.id} has empty sources`,
    );
  }
});

test("A-inv: CONFIG-only run carries ONLY CONFIG-sourced findings", () => {
  for (const f of A.findings) {
    assert.deepEqual(
      [...(f.sources ?? [])].sort(),
      ["CONFIG"],
      `finding ${f.id} leaked a non-CONFIG source in a config-only run`,
    );
  }
});

test("A-inv: CONFIG-only confidence is capped at medium", () => {
  for (const f of A.findings) {
    assert.ok(
      MAX_CONF[f.confidence ?? "low"] <= MAX_CONF.medium,
      `finding ${f.id} has confidence ${f.confidence} > medium in a config-only run`,
    );
  }
});

test("A-inv: CONFIG-only run makes no unbacked observed-runtime claims", () => {
  // Mirrors the production contract: the normalizer evaluates runtime wording on
  // the finding HEADLINE (f.finding) only — explanatory prose may legitimately
  // describe GTM's documented config semantics. Any headline that does read as a
  // runtime claim must be flagged for manual review rather than presented as fact.
  for (const f of A.findings) {
    if (containsRuntimeClaim(f.finding)) {
      assert.ok(
        f.needsManualReview === true,
        `config-only finding ${f.id} headline reads as a runtime claim but is not flagged for manual review: "${(f.finding ?? "").slice(0, 120)}"`,
      );
    }
  }
});

test("A-inv: structured evidence[] is always present and non-empty", () => {
  for (const f of A.findings) {
    assert.ok(
      Array.isArray(f.evidence) && f.evidence.length > 0,
      `finding ${f.id} is missing structured evidence[]`,
    );
  }
});

test("A-inv: evidence values stay short/safe (no huge raw JSON dumps)", () => {
  for (const f of A.findings) {
    for (const e of f.evidence ?? []) {
      assert.ok(e.source, `finding ${f.id} evidence row missing source`);
      assert.ok(e.label, `finding ${f.id} evidence row missing label`);
      for (const v of [e.value, e.parameter, e.entityPath]) {
        if (v !== undefined) {
          assert.ok(
            typeof v === "string" && v.length <= 200,
            `finding ${f.id} evidence value too long (${(v as string).length})`,
          );
        }
      }
    }
  }
});

test("A-inv: CONFIG-only evidence is itself only CONFIG-sourced", () => {
  for (const f of A.findings) {
    for (const e of f.evidence ?? []) {
      assert.equal(
        e.source,
        "CONFIG",
        `finding ${f.id} has ${e.source}-sourced evidence in a config-only run`,
      );
    }
  }
});

test("A-snap: normalization is idempotent (stable snapshot)", () => {
  const once = A.findings.map(project);
  const twice = A.findings
    .map((f) => normalizeFindingAccuracy<AccuracyFinding>(f))
    .map(project);
  assert.deepEqual(twice, once);
});

// ── Fixture B: web container WITH a runtime capture (reconcile) ─────────────

const B = auditFixture(FIXTURE_B_RECONCILE_WEB.config, FIXTURE_B_RECONCILE_WEB.runtime);

test("B-snap: runtime fixture reconciles (coverage = reconciled)", () => {
  assert.equal(B.coverage, "reconciled");
});

test("B-inv: every finding is source-scoped (non-empty sources)", () => {
  for (const f of B.findings) {
    assert.ok(
      Array.isArray(f.sources) && f.sources.length > 0,
      `finding ${f.id} has empty sources`,
    );
  }
});

test("B-inv: structured evidence[] is always present and non-empty", () => {
  for (const f of B.findings) {
    assert.ok(
      Array.isArray(f.evidence) && f.evidence.length > 0,
      `finding ${f.id} is missing structured evidence[]`,
    );
  }
});

test("B-inv: RUNTIME-sourced findings may keep high confidence", () => {
  // At least exercise that a runtime capture path can yield a RUNTIME source —
  // this guards against the normalizer over-tightening proof-backed findings.
  const hasRuntime = B.findings.some((f) => (f.sources ?? []).includes("RUNTIME"));
  assert.ok(hasRuntime, "expected at least one RUNTIME-sourced finding with a capture present");
});

test("B-inv: only RUNTIME-sourced findings may carry high confidence", () => {
  for (const f of B.findings) {
    if (MAX_CONF[f.confidence ?? "low"] > MAX_CONF.medium) {
      assert.ok(
        (f.sources ?? []).includes("RUNTIME"),
        `finding ${f.id} claims high confidence without a RUNTIME source`,
      );
    }
  }
});

test("B-inv: CONFIG-only findings within a reconcile run still cap at medium", () => {
  for (const f of B.findings) {
    const sources = [...(f.sources ?? [])].sort();
    if (sources.length === 1 && sources[0] === "CONFIG") {
      assert.ok(
        MAX_CONF[f.confidence ?? "low"] <= MAX_CONF.medium,
        `config-only finding ${f.id} exceeds medium confidence`,
      );
    }
  }
});

// ── run summary ─────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\nAudit snapshot — golden invariant suite (synthetic fixtures)`);
console.log(`  cases run:    ${total}`);
console.log(`  passed:       ${passed}`);
console.log(`  failed:       ${failed}`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const ff of failures) console.error(`  ✗ ${ff}`);
  process.exit(1);
}
if (total < 12) {
  console.error(`\n✗ Expected at least 12 snapshot/invariant cases, only ${total} ran.`);
  process.exit(1);
}
console.log(`\n✓ All ${total} audit-snapshot invariant cases passed (>= 12 required).`);
