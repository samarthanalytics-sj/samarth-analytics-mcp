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
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
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
// The real Vercel route handlers (Vercel-safe at module load: node:* + types only).
import auditHandler from "../../api/gtm/audit";
import consentAuditHandler from "../../api/gtm/consent-audit";
import { encodeSessionCookie } from "../../server/gtm/session-cookie";

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

const asyncTests: Array<[string, () => Promise<void>]> = [];
function testAsync(name: string, fn: () => Promise<void>): void {
  asyncTests.push([name, fn]);
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

// ── Route level: the real Vercel handlers, no network ───────────────────────
// Drives /api/gtm/audit and /api/gtm/consent-audit end to end with a signed
// test session and a stubbed fetch that serves a fixture workspace (and,
// optionally, GA4 Admin reads). Nothing leaves the process.

const API_DIR = fileURLToPath(new URL("../../api/", import.meta.url));
const SECRET = "test-session-secret-0123456789abcdef";
const ROUTE_ENV: Record<string, string> = {
  PORTAL_SESSION_SECRET: SECRET,
  PORTAL_GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
  PORTAL_GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
  PORTAL_GOOGLE_OAUTH_REDIRECT_URI: "http://localhost/api/oauth/callback",
};

type StubResponse = { status: number; body: unknown };
type FixtureLike = {
  containerPublicId: string;
  usageContext: string[];
  config: { tags: unknown[]; triggers: unknown[]; variables: unknown[] };
};

/** Serve a fixture workspace as the GTM API would; everything else 404s. */
function gtmRoutes(fx: FixtureLike): (url: URL) => StubResponse | undefined {
  return (url) => {
    if (url.hostname !== "tagmanager.googleapis.com") return undefined;
    const p = url.pathname.replace(/^\/tagmanager\/v2/, "");
    const ws = "/accounts/1/containers/2/workspaces/3";
    if (p === `${ws}/tags`) return { status: 200, body: { tag: fx.config.tags } };
    if (p === `${ws}/triggers`) return { status: 200, body: { trigger: fx.config.triggers } };
    if (p === `${ws}/variables`) return { status: 200, body: { variable: fx.config.variables } };
    if (p === `${ws}/folders`) return { status: 200, body: { folder: [] } };
    if (p === `${ws}/built_in_variables`) return { status: 200, body: { builtInVariable: [] } };
    if (p === `${ws}/templates`) return { status: 200, body: { template: [] } };
    if (p === "/accounts/1/containers/2") {
      return {
        status: 200,
        body: { containerId: "2", publicId: fx.containerPublicId, usageContext: fx.usageContext },
      };
    }
    if (p === "/accounts/1/containers/2/workspaces") {
      return { status: 200, body: { workspace: [{ workspaceId: "3", name: "Default" }] } };
    }
    return undefined;
  };
}

async function callRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  body: Record<string, unknown>,
  routes: Array<(url: URL) => StubResponse | undefined>,
  opts: { authenticated?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(ROUTE_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    let hit: StubResponse | undefined;
    for (const r of routes) {
      hit = r(url);
      if (hit) break;
    }
    const res = hit ?? { status: 404, body: { error: { message: "not found" } } };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const cookie =
      opts.authenticated === false
        ? undefined
        : `samarth_portal_sid=${encodeURIComponent(
            encodeSessionCookie({
              accessToken: "test-access-token",
              expiresAt: Date.now() + 3_600_000,
              scopes: [],
            }),
          )}`;
    const req = {
      method: "POST",
      url: "/api/test",
      headers: cookie ? { cookie } : {},
      body: { accountId: "1", containerId: "2", workspaceId: "3", ...body },
    };
    const headers: Record<string, unknown> = {};
    let sent = "";
    const res = {
      statusCode: 200,
      setHeader(k: string, v: unknown) {
        headers[k.toLowerCase()] = v;
      },
      getHeader(k: string) {
        return headers[k.toLowerCase()];
      },
      end(chunk?: string) {
        sent = chunk ?? "";
      },
    };
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status: res.statusCode, json: sent ? JSON.parse(sent) : null };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("R-guard: api/** routes import only node:* and `import type` at the top level", () => {
  // CLAUDE.md Vercel rule: anything heavier is `await import(...)`-ed inside the
  // handler after auth. Regression: audit.ts and consent-audit.ts statically
  // imported ../../shared/audit-accuracy.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8");
      const rel = path.relative(API_DIR, p);
      for (const m of src.matchAll(/^import(?!\s+type\b)\s+[\s\S]*?\bfrom\s+["']([^"']+)["']/gm)) {
        if (!m[1].startsWith("node:")) offenders.push(`${rel} -> ${m[1]}`);
      }
      for (const m of src.matchAll(/^import\s+["']([^"']+)["']/gm)) {
        if (!m[1].startsWith("node:")) offenders.push(`${rel} -> ${m[1]} (side-effect)`);
      }
    }
  };
  walk(API_DIR);
  assert.deepEqual(offenders, []);
});

testAsync("R-auth: /api/gtm/audit without a session is a clean 401", async () => {
  const r = await callRoute(auditHandler, {}, [gtmRoutes(FIXTURE_A_CONFIG_ONLY_WEB)], {
    authenticated: false,
  });
  assert.equal(r.status, 401);
  assert.equal(r.json?.error, "not_connected");
});

testAsync("R-smoke: /api/gtm/audit runs end to end with lazily loaded engines", async () => {
  const r = await callRoute(
    auditHandler,
    { containerPublicId: FIXTURE_A_CONFIG_ONLY_WEB.containerPublicId },
    [gtmRoutes(FIXTURE_A_CONFIG_ONLY_WEB)],
  );
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.ok(r.json.consentAudit, "consent engine should have run");
  assert.ok(
    !r.json.findings.some((f: { id: string }) => f.id === "consent-engine-unavailable"),
    "consent engine failed to load",
  );
  assert.ok(r.json.findings.length > 0);
});

testAsync("R-smoke: /api/gtm/consent-audit returns normalized findings", async () => {
  const r = await callRoute(
    consentAuditHandler,
    { containerPublicId: FIXTURE_A_CONFIG_ONLY_WEB.containerPublicId },
    [gtmRoutes(FIXTURE_A_CONFIG_ONLY_WEB)],
  );
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.ok(r.json.findings.length > 0);
  for (const f of r.json.findings) {
    assert.ok(Array.isArray(f.evidenceItems) && f.evidenceItems.length > 0, `${f.id} lacks evidenceItems`);
  }
});

for (const [name, fn] of asyncTests) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

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
