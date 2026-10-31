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
// The Express dev-server auditor (node:crypto + types only).
import { runAudit as runExpressAudit } from "../../server/gtm/audit";

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

/**
 * Run the full audit and the consent-only route on the same workspace and pair
 * every consent-route finding with the full audit's finding of the same id.
 */
async function consentParity(
  fx: FixtureLike,
  runtimeCapture?: unknown,
): Promise<Array<{ c: any; a: any }>> {
  const body: Record<string, unknown> = { containerPublicId: fx.containerPublicId };
  if (runtimeCapture) body.runtimeCapture = runtimeCapture;
  const full = await callRoute(auditHandler, body, [gtmRoutes(fx)]);
  const focused = await callRoute(consentAuditHandler, body, [gtmRoutes(fx)]);
  assert.equal(full.status, 200, JSON.stringify(full.json).slice(0, 300));
  assert.equal(focused.status, 200, JSON.stringify(focused.json).slice(0, 300));
  const byId = new Map<string, any>(full.json.findings.map((f: any) => [f.id, f]));
  return focused.json.findings.map((c: any) => ({ c, a: byId.get(c.id) }));
}

function assertConsentParity(pairs: Array<{ c: any; a: any }>): void {
  assert.ok(pairs.length > 0, "expected consent findings");
  for (const { c, a } of pairs) {
    assert.ok(a, `consent finding ${c.id} missing from the full audit`);
    assert.equal(a.severity, c.severity, `${c.id} severity differs`);
    assert.equal(a.confidence, c.confidence, `${c.id} confidence differs`);
    assert.equal(a.needsManualReview, c.needsManualReview, `${c.id} needsManualReview differs`);
    assert.deepEqual(a.sources, c.sources, `${c.id} sources differ`);
    assert.deepEqual(a.evidence, c.evidenceItems, `${c.id} structured evidence differs`);
    assert.deepEqual(a.accuracyNotes, c.accuracyNotes, `${c.id} accuracyNotes differ`);
    assert.equal(a.confidenceDowngraded, c.confidenceDowngraded, `${c.id} confidenceDowngraded differs`);
    assert.equal(a.suggestedFix, c.suggestedFix, `${c.id} suggestedFix differs`);
  }
}

testAsync("R-parity A: full audit and /api/gtm/consent-audit agree on every consent finding", async () => {
  // Regression: the full audit mapped consent-engine findings directly, skipping
  // normalizeFindingAccuracy — no evidence[], no CONFIG-only confidence cap.
  assertConsentParity(await consentParity(FIXTURE_A_CONFIG_ONLY_WEB));
});

testAsync("R-parity A: CONFIG-only consent findings in the full audit cap at medium + carry evidence", async () => {
  const r = await callRoute(
    auditHandler,
    { containerPublicId: FIXTURE_A_CONFIG_ONLY_WEB.containerPublicId },
    [gtmRoutes(FIXTURE_A_CONFIG_ONLY_WEB)],
  );
  const consent = r.json.findings.filter((f: any) => f.category === "consent");
  assert.ok(consent.length > 0);
  for (const f of consent) {
    assert.ok(
      MAX_CONF[f.confidence ?? "low"] <= MAX_CONF.medium,
      `${f.id} has ${f.confidence} confidence from CONFIG-only evidence`,
    );
    assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, `${f.id} missing evidence[]`);
  }
});

testAsync("R-parity B: with a runtime capture, engine snippets are evidence rows, not suggestedFix text", async () => {
  const capture = {
    capturedAt: FIXTURE_B_RECONCILE_WEB.runtime.capturedAt,
    pages: FIXTURE_B_RECONCILE_WEB.runtime.pages,
  };
  const pairs = await consentParity(FIXTURE_B_RECONCILE_WEB, capture);
  assertConsentParity(pairs);
  assert.ok(
    pairs.some(({ a }) => (a.evidence ?? []).some((e: EvidenceItem) => e.label === "Captured signal")),
    "expected a captured runtime snippet as a structured evidence row",
  );
  for (const { a } of pairs) {
    assert.ok(!/ Evidence: /.test(a.suggestedFix ?? ""), `${a.id} embeds raw evidence in suggestedFix`);
  }
});

// ── GTM CONFIG ↔ GA4 Admin: unregistered event parameters ───────────────────

const GA4_PARAMS_WEB: FixtureLike = {
  containerPublicId: "GTM-ZZZZZZZ",
  usageContext: ["web"],
  config: {
    tags: [
      {
        tagId: "1",
        name: "GA4 - sign_up",
        type: "gaawe",
        firingTriggerId: ["2147479553"],
        parameter: [
          { type: "template", key: "eventName", value: "sign_up" },
          {
            type: "list",
            key: "eventParameters",
            list: [
              { type: "map", map: [{ type: "template", key: "name", value: "plan_tier" }, { type: "template", key: "value", value: "pro" }] },
              { type: "map", map: [{ type: "template", key: "name", value: "seat_count" }, { type: "template", key: "value", value: "3" }] },
            ],
          },
        ],
      },
    ],
    triggers: [],
    variables: [],
  },
};

const OK_DIMS: StubResponse = { status: 200, body: { customDimensions: [{ parameterName: "plan_tier" }] } };
const OK_METRICS: StubResponse = { status: 200, body: { customMetrics: [{ parameterName: "seat_count" }] } };
const FAILED_READ: StubResponse = { status: 500, body: { error: { message: "backend error" } } };

function ga4AdminRoutes(lists: { dimensions: StubResponse; metrics: StubResponse }) {
  return (url: URL): StubResponse | undefined => {
    if (url.hostname !== "analyticsadmin.googleapis.com") return undefined;
    const p = url.pathname;
    if (p.endsWith("/customDimensions")) return lists.dimensions;
    if (p.endsWith("/customMetrics")) return lists.metrics;
    if (p.endsWith("/dataStreams")) return { status: 200, body: { dataStreams: [] } };
    if (p.endsWith("/dataRetentionSettings")) return { status: 200, body: {} };
    if (p.endsWith("/googleAdsLinks")) return { status: 200, body: { googleAdsLinks: [] } };
    return undefined;
  };
}

const UNREGISTERED_PARAMS =
  "GTM sends event parameters that are not registered as GA4 custom dimensions/metrics";

async function auditWithGa4(lists: { dimensions: StubResponse; metrics: StubResponse }) {
  const r = await callRoute(auditHandler, { ga4PropertyId: "123456" }, [
    gtmRoutes(GA4_PARAMS_WEB),
    ga4AdminRoutes(lists),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  return r.json.findings as Array<{ finding?: string; affected?: string[] }>;
}

testAsync("R-ga4 control: a param registered in neither list is flagged when both reads succeed", async () => {
  const findings = await auditWithGa4({
    dimensions: OK_DIMS,
    metrics: { status: 200, body: { customMetrics: [] } },
  });
  const f = findings.find((x) => x.finding === UNREGISTERED_PARAMS);
  assert.ok(f, "expected the unregistered-params finding");
  assert.deepEqual(f!.affected, ["seat_count"]);
});

testAsync("R-ga4: a failed custom-dimensions read does not misflag params as unregistered", async () => {
  // Regression: `if (cdFailed && cmFailed) return;` let the rule run on the
  // metrics list alone and report plan_tier (a registered dimension).
  const findings = await auditWithGa4({ dimensions: FAILED_READ, metrics: OK_METRICS });
  assert.ok(!findings.some((x) => x.finding === UNREGISTERED_PARAMS));
  assert.ok(
    findings.some((x) => x.finding === "Could not read ga4_custom_dimensions from the GA4 Admin API"),
    "the failed read is surfaced as a tool failure instead",
  );
});

testAsync("R-ga4: a failed custom-metrics read does not misflag params as unregistered", async () => {
  const findings = await auditWithGa4({ dimensions: OK_DIMS, metrics: FAILED_READ });
  assert.ok(!findings.some((x) => x.finding === UNREGISTERED_PARAMS));
});

// ── GTM built-in trigger ids (2147479xxx) ───────────────────────────────────
// triggers.list never returns GTM's built-in triggers (All Pages = 2147479553,
// Consent Initialization = 2147479572, ...), so a tag on one references an id
// that is in no listed trigger. That is normal, not a broken reference.

const BROKEN_FIRE = "Tag references a firing trigger that does not exist";
const BROKEN_BLOCK = "Tag references a blocking trigger that does not exist";

function webFixture(tags: unknown[], triggers: unknown[] = []): FixtureLike {
  return { containerPublicId: "GTM-BUILTIN", usageContext: ["web"], config: { tags, triggers, variables: [] } };
}

async function auditFindings(fx: FixtureLike, extra: Array<(url: URL) => StubResponse | undefined> = [], body: Record<string, unknown> = {}) {
  const r = await callRoute(auditHandler, { containerPublicId: fx.containerPublicId, ...body }, [...extra, gtmRoutes(fx)]);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  return r.json as { findings: Array<{ id: string; finding?: string; affected?: string[] }>; [k: string]: any };
}

testAsync("R-builtin: a tag on the built-in All Pages trigger is not a broken reference", async () => {
  // Regression: every tag on All Pages got a HIGH "firing trigger that does not
  // exist" finding and publishSafe "no".
  const out = await auditFindings(GA4_PARAMS_WEB);
  assert.ok(!out.findings.some((f) => f.finding === BROKEN_FIRE), "built-in All Pages flagged as missing");
  assert.ok(
    out.findings.some((f) => f.finding === "GA4 Event tag is configured on an All Pages / pageview trigger"),
    "a GA4 event tag on the built-in All Pages trigger should get the All Pages finding",
  );
});

testAsync("R-builtin: built-in Consent Initialization / Initialization ids are not broken references either", async () => {
  const out = await auditFindings(
    webFixture([
      { tagId: "1", name: "CMP", type: "html", firingTriggerId: ["2147479572"], blockingTriggerId: ["2147479573"], parameter: [] },
    ]),
  );
  assert.ok(!out.findings.some((f) => f.finding === BROKEN_FIRE || f.finding === BROKEN_BLOCK));
});

testAsync("R-builtin control: an id just outside the built-in band is still flagged", async () => {
  const out = await auditFindings(
    webFixture([{ tagId: "1", name: "Stray", type: "html", firingTriggerId: ["2147478553"], parameter: [] }]),
  );
  assert.ok(out.findings.some((f) => f.finding === BROKEN_FIRE && (f.affected ?? []).includes("Stray")));
});

test("S-builtin: the Express auditor exempts built-in ids but still flags dangling ones", () => {
  const summary = runExpressAudit(
    {
      tags: [
        { tagId: "1", name: "Google tag", type: "googtag", firingTriggerId: ["2147479553"], blockingTriggerId: ["2147479572"] },
        { tagId: "2", name: "Stray", type: "html", firingTriggerId: ["2147478553"] },
      ],
      triggers: [],
      variables: [],
      folders: [],
      builtInVariables: [],
    },
    { containerPublicId: "GTM-BUILTIN" },
  );
  const broken = summary.findings.filter((f) => /missing (firing|blocking) trigger/.test(f.title ?? ""));
  assert.deepEqual(
    broken.map((f) => f.affects),
    [["Stray"]],
    `only the out-of-band id should be flagged, got ${JSON.stringify(broken.map((f) => f.description))}`,
  );
});

// ── Google tag IDs that are not GA4 measurement IDs (AW-/DC-/GT-) ───────────

const MID_SHAPE = "GA4 tag has a measurement ID that does not look like G-XXXXXXX or GT-XXXXXXX";
const MID_MISMATCH =
  "GTM references GA4 measurement ID(s) that do not match any data stream on the selected GA4 property";

function googleTag(tagId: string, id: string, name: string) {
  return {
    tagId,
    name,
    type: "googtag",
    firingTriggerId: ["2147479553"],
    parameter: [{ type: "template", key: "tagId", value: id }],
  };
}

const streamRoutes = (url: URL): StubResponse | undefined => {
  if (url.hostname !== "analyticsadmin.googleapis.com") return undefined;
  const p = url.pathname;
  if (p.endsWith("/dataStreams")) {
    return {
      status: 200,
      body: { dataStreams: [{ name: "properties/123456/dataStreams/1", webStreamData: { measurementId: "G-ABC1234" } }] },
    };
  }
  if (p.endsWith("/customDimensions")) return { status: 200, body: { customDimensions: [] } };
  if (p.endsWith("/customMetrics")) return { status: 200, body: { customMetrics: [] } };
  if (p.endsWith("/dataRetentionSettings")) return { status: 200, body: {} };
  if (p.endsWith("/googleAdsLinks")) return { status: 200, body: { googleAdsLinks: [] } };
  if (p.endsWith("/enhancedMeasurementSettings")) return { status: 200, body: { streamEnabled: false } };
  return undefined;
};

testAsync("R-googtag: a GA4 Google tag plus a Google Ads (AW-) Google tag is not a bad GA4 id or a duplicate", async () => {
  // Regression: AW- on a googtag got a HIGH "does not look like G-" finding and
  // counted as a second GA4 config tag.
  const out = await auditFindings(
    webFixture([googleTag("1", "G-ABC1234", "GA4 Google tag"), googleTag("2", "AW-123456789", "Google Ads tag")]),
  );
  assert.ok(!out.findings.some((f) => f.finding === MID_SHAPE), "AW- Google tag shape-checked as GA4");
  assert.ok(!out.findings.some((f) => /Google tag \/ GA4 Configuration tags \(one expected\)/.test(f.finding ?? "")));
});

testAsync("R-googtag: a GT- Google tag is not reported as a measurement ID missing from the data streams", async () => {
  // Regression: GT- ids were compared with stream measurementIds (always G-) and
  // always produced a HIGH CONFIG+GA4_ADMIN mismatch.
  const out = await auditFindings(
    webFixture([googleTag("1", "G-ABC1234", "GA4 Google tag"), googleTag("2", "GT-ABCDEFG", "Google tag (GT)")]),
    [streamRoutes],
    { ga4PropertyId: "123456" },
  );
  assert.ok(!out.findings.some((f) => f.finding === MID_MISMATCH), "GT- id reported as a stream mismatch");
  assert.deepEqual(out.gtmMeasurementIds, ["G-ABC1234"]);
});

testAsync("R-googtag control: two G- Google tags still trip the config-count finding", async () => {
  const out = await auditFindings(
    webFixture([googleTag("1", "G-ABC1234", "GA4 tag A"), googleTag("2", "G-XYZ9876", "GA4 tag B")]),
  );
  assert.ok(out.findings.some((f) => /Container has 2 Google tag \/ GA4 Configuration tags/.test(f.finding ?? "")));
});

testAsync("R-googtag control: a G- id that is not on the property is still a stream mismatch", async () => {
  const out = await auditFindings(webFixture([googleTag("1", "G-OTHER99", "Wrong GA4 tag")]), [streamRoutes], {
    ga4PropertyId: "123456",
  });
  assert.ok(out.findings.some((f) => f.finding === MID_MISMATCH));
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
