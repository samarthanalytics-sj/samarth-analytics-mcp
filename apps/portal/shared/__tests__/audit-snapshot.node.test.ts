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
import crypto from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
import sgtmHandler from "../../api/gtm/sgtm";
import ga4AdminHandler from "../../api/ga4/admin";
import accountsHandler from "../../api/gtm/accounts/index";
import containersHandler from "../../api/gtm/accounts/[accountId]/containers/index";
import workspacesHandler from "../../api/gtm/accounts/[accountId]/containers/[containerId]/workspaces";
import oauthStatusHandler from "../../api/oauth/status";
import oauthCallbackHandler from "../../api/oauth/callback";
import oauthLogoutHandler from "../../api/oauth/logout";
import healthHandler from "../../api/health";
import {
  decodeSessionCookie,
  encodeOAuthStateCookie,
  encodeSessionCookie,
} from "../../server/gtm/session-cookie";
// The Express dev-server auditor (node:crypto + types only).
import { runAudit as runExpressAudit } from "../../server/gtm/audit";
import { revokeOnDisconnect } from "../../server/gtm/revoke";
import { fetchWorkspaceContents, listAccounts } from "../../server/gtm/api";

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
  routes: Array<(url: URL, init?: RequestInit) => StubResponse | undefined>,
  opts: {
    authenticated?: boolean;
    method?: string;
    url?: string;
    /** Extra/overriding session fields sealed into the default session cookie. */
    session?: Record<string, unknown>;
    /** Full Cookie header, built inside the route env; replaces the default. */
    cookieHeader?: () => string;
    /** Extra request headers (e.g. origin, host). */
    headers?: Record<string, string>;
    /** Env overrides on top of ROUTE_ENV; undefined unsets a variable. */
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{ status: number; json: any; setCookies: string[] }> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...ROUTE_ENV, ...opts.env })) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    let hit: StubResponse | undefined;
    for (const r of routes) {
      hit = r(url, init);
      if (hit) break;
    }
    const res = hit ?? { status: 404, body: { error: { message: "not found" } } };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const cookie = opts.cookieHeader
      ? opts.cookieHeader()
      : opts.authenticated === false
        ? undefined
        : `samarth_portal_sid=${encodeURIComponent(
            encodeSessionCookie({
              accessToken: "test-access-token",
              expiresAt: Date.now() + 3_600_000,
              scopes: [],
              ...opts.session,
            }),
          )}`;
    const req = {
      method: opts.method ?? "POST",
      url: opts.url ?? "/api/test",
      headers: { ...opts.headers, ...(cookie ? { cookie } : {}) },
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
    let json: any = null;
    try {
      json = sent ? JSON.parse(sent) : null;
    } catch {
      json = null; // HTML pages (OAuth callback errors) are not JSON
    }
    const rawSetCookie = headers["set-cookie"];
    const setCookies = rawSetCookie === undefined
      ? []
      : Array.isArray(rawSetCookie)
        ? rawSetCookie.map(String)
        : [String(rawSetCookie)];
    return { status: res.statusCode, json, setCookies };
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

test("R-guard: every relative runtime import reachable from api/** names its .js file", () => {
  // @vercel/node transpiles each .ts to its own .js ES module without bundling
  // or rewriting specifiers, and plain Node resolves no extensionless relative
  // import: `await import("../../shared/consent-audit")` built and traced fine,
  // then threw ERR_MODULE_NOT_FOUND on every authenticated audit. tsx (tests,
  // `vercel dev`, the Express server) resolves either form, hiding it.
  // Read from the AST, so comments, strings and type positions such as
  // `typeof import("…")` are ignored. A load whose target is not a string
  // literal cannot be checked, so it is reported as `<non-literal …>`.
  const runtimeSpecifiers = (file: string): string[] => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: string[] = [];
    const literal = (n: ts.Node | undefined): string | undefined =>
      n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
    const isRequire = (callee: ts.Expression): boolean =>
      (ts.isIdentifier(callee) && callee.text === "require") ||
      (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire");
    const walkNode = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly =
          clause?.isTypeOnly ||
          (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) out.push(literal(node.moduleSpecifier) ?? "<non-literal import>");
      } else if (ts.isExportDeclaration(node)) {
        if (!node.isTypeOnly && node.moduleSpecifier) out.push(literal(node.moduleSpecifier) ?? "<non-literal export>");
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          out.push(literal(node.moduleReference.expression) ?? "<non-literal require>");
        }
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          out.push(literal(node.arguments[0]) ?? `<non-literal import(${node.arguments[0]?.getText(sf) ?? ""})>`);
        } else if (isRequire(node.expression)) {
          out.push(literal(node.arguments[0]) ?? `<non-literal require(${node.arguments[0]?.getText(sf) ?? ""})>`);
        }
      }
      ts.forEachChild(node, walkNode);
    };
    walkNode(sf);
    return out;
  };
  const offenders: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeSpecifiers(file)) {
      const rel = `${path.relative(API_DIR, file)} -> ${spec}`;
      // tsconfig path aliases exist only for tsc, tsx and bundlers.
      if (spec.startsWith("<non-literal") || spec.startsWith("@/") || spec.startsWith("@shared/")) {
        offenders.push(rel);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      if (!spec.endsWith(".js")) {
        offenders.push(rel);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
      try {
        statSync(target);
      } catch {
        offenders.push(`${rel} (no ${path.basename(target)})`);
        continue;
      }
      visit(target);
    }
  };
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) visit(p);
    }
  };
  walk(API_DIR);
  assert.deepEqual(offenders, []);
  // The lazy engine imports were followed, so their own imports were checked too.
  for (const engine of ["consent-audit.ts", "audit-accuracy.ts"]) {
    assert.ok([...seen].some((f) => f.endsWith(path.join("shared", engine))), `${engine} was not reached`);
  }
});

// ── Function budget: one function answers /api/health and /api/system/capabilities ──
// Vercel builds every .js, .mjs, .ts and .tsx file under api/ as one Serverless
// Function, and the Hobby plan refuses a deployment with more than 12. The
// capabilities probe has no file of its own: a rewrite in vercel.json sends its
// URL to the health function, and api/health.ts answers both.
// fixtures/system-probes.golden.json holds what the two separate handlers
// answered before the fold.

const MAX_ROUTE_FILES = 12;
const CAPABILITIES_URL = "/api/system/capabilities";
const CAPABILITIES_FLAG = "capabilities";
const PORTAL_DIR = fileURLToPath(new URL("../../", import.meta.url));

// True for a file that Vercel builds as a function. `rel` is the path below api/.
// Vercel's zero-config pattern for Node is api/**/*.+(js|mjs|ts|tsx). It skips
// names that end in .d.ts and paths with a segment that starts with "_" or ".".
function isRouteFile(rel: string): boolean {
  if (rel.split(path.sep).some((segment) => segment.startsWith("_") || segment.startsWith("."))) return false;
  return /\.(js|mjs|ts|tsx)$/.test(rel) && !rel.endsWith(".d.ts");
}

type ProbeGolden = { status: number; headers: Record<string, string>; body: Record<string, unknown> };
type ProbeCase = {
  name: string;
  env: Record<string, string>;
  failFirstSetHeader?: boolean;
  health: ProbeGolden;
  capabilities: ProbeGolden;
};
type ProbeResponse = { status: number; headers: Record<string, string>; body: string };

const PROBES = JSON.parse(
  readFileSync(new URL("./fixtures/system-probes.golden.json", import.meta.url), "utf8"),
) as { envKeys: string[]; cases: ProbeCase[] };

/** What the old handler sent for this case: status, headers and the exact body text. */
function probeGolden(g: ProbeGolden): ProbeResponse {
  const body = "node" in g.body ? { ...g.body, node: process.version } : g.body;
  return { status: g.status, headers: g.headers, body: JSON.stringify(body) };
}

/** Call the health function with only the case's env set. Nothing else is stubbed. */
async function callProbe(c: ProbeCase, req: object): Promise<ProbeResponse> {
  const saved: Record<string, string | undefined> = {};
  for (const k of PROBES.envKeys) {
    saved[k] = process.env[k];
    if (k in c.env) process.env[k] = c.env[k];
    else delete process.env[k];
  }
  try {
    const headers: Record<string, string> = {};
    let body = "";
    let ended = 0;
    let failNext = c.failFirstSetHeader === true;
    const res = {
      statusCode: 0,
      setHeader(k: string, v: unknown) {
        if (failNext) {
          failNext = false;
          throw new Error("setHeader failed");
        }
        headers[k.toLowerCase()] = String(v);
      },
      end(chunk?: string) {
        ended++;
        body = chunk ?? "";
      },
    };
    await healthHandler(req as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(ended, 1, "the handler must end the response once");
    return { status: res.statusCode, headers, body };
  } finally {
    for (const k of PROBES.envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** A request as the handler sees it. `query` is the @vercel/node helper; it may be absent. */
function probeReq(url: string | undefined, extra: Record<string, unknown> = {}): object {
  return { method: "GET", headers: {}, url, ...extra };
}

/** Every fixture case x every request must give the document `pick` names, unchanged. */
async function expectProbe(
  pick: "health" | "capabilities",
  requests: Array<[label: string, req: object]>,
): Promise<void> {
  for (const c of PROBES.cases) {
    for (const [label, req] of requests) {
      const got = await callProbe(c, req);
      try {
        assert.deepStrictEqual(got, probeGolden(c[pick]));
      } catch (e) {
        throw new Error(`[${c.name}] ${label} should answer the old ${pick} response: ${(e as Error).message}`);
      }
    }
  }
}

test("R-guard: api/** holds at most 12 route files (Vercel Hobby function limit)", () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = path.relative(API_DIR, p);
      if (statSync(p).isDirectory()) walk(p);
      else if (isRouteFile(rel)) found.push(rel);
    }
  };
  walk(API_DIR);
  assert.ok(
    found.length <= MAX_ROUTE_FILES,
    `apps/portal/api holds ${found.length} route files; the limit is ${MAX_ROUTE_FILES}. ` +
      `Vercel builds every .js, .mjs, .ts and .tsx file under api/ as one Serverless Function, and the Hobby plan ` +
      `refuses a deployment with more than ${MAX_ROUTE_FILES}. Do not add a route file for a new endpoint. ` +
      `Fold it into an existing function, the way /api/system/capabilities is served by api/health.ts: ` +
      `(1) in apps/portal/vercel.json add a rewrite from the new URL to the existing function with a query flag, ` +
      `before the SPA fallback; (2) in that handler choose the response from the request path or the flag; ` +
      `(3) cover both URLs in this file. Route files found: ${found.sort().join(", ")}`,
  );
});

test("R-guard: vercel.json rewrites /api/system/capabilities to the health function", () => {
  const config = JSON.parse(readFileSync(path.join(PORTAL_DIR, "vercel.json"), "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const rewrites = config.rewrites ?? [];
  const fallback = rewrites.findIndex((r) => r.destination === "/index.html");
  // A rewrite source matches the whole path, so the URL with a trailing slash
  // needs its own entry. Without it that form falls through to the /api 404.
  for (const source of [CAPABILITIES_URL, `${CAPABILITIES_URL}/`]) {
    const at = rewrites.findIndex((r) => r.source === source);
    assert.ok(at !== -1, `vercel.json has no rewrite with source ${source}`);
    assert.equal(rewrites[at].destination, `/api/health?${CAPABILITIES_FLAG}=1`);
    // Rewrites are tried in order and the first match wins.
    assert.ok(fallback === -1 || at < fallback, `the rewrite for ${source} must come before the SPA fallback`);
  }
  // The destination must be a function that Vercel builds.
  assert.ok(statSync(path.join(API_DIR, "health.ts")).isFile(), "api/health.ts is missing");
  // A file is served before any rewrite is tried, and it would be one more function.
  assert.ok(
    !existsSync(path.join(API_DIR, "system", "capabilities.ts")),
    "api/system/capabilities.ts is back: Vercel would serve the file, not the rewrite, and count it as a function",
  );
});

test("R-fold: the fixture holds two different documents and both error responses", () => {
  assert.ok(PROBES.cases.length >= 10, `only ${PROBES.cases.length} fixture cases`);
  for (const c of PROBES.cases) {
    assert.notEqual(probeGolden(c.health).body, probeGolden(c.capabilities).body, c.name);
  }
  const failing = PROBES.cases.filter((c) => c.failFirstSetHeader);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].health.status, 500);
  assert.equal(failing[0].health.body.error, "health_check_failed");
  // The old health handler sent no Cache-Control on its 500; the old capabilities handler did.
  assert.deepEqual(failing[0].health.headers, { "content-type": "application/json; charset=utf-8" });
  assert.equal(failing[0].capabilities.status, 500);
  assert.equal(failing[0].capabilities.body.error, "capabilities_check_failed");
  assert.deepEqual(failing[0].capabilities.headers, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
});

testAsync("R-fold: /api/health answers exactly as before the fold", async () => {
  await expectProbe("health", [
    ["GET /api/health", probeReq("/api/health")],
    ["GET /api/health with an empty query helper", probeReq("/api/health", { query: {} })],
    ["GET /api/health?t=… (cache buster)", probeReq("/api/health?t=1700000000000", { query: { t: "1700000000000" } })],
    ["GET /api/health/", probeReq("/api/health/")],
    ["HEAD /api/health", probeReq("/api/health", { method: "HEAD" })],
    ["POST /api/health", probeReq("/api/health", { method: "POST" })],
  ]);
});

testAsync("R-fold: /api/system/capabilities answers exactly as the old capabilities route", async () => {
  await expectProbe("capabilities", [
    // The function may see the URL the browser asked for, or the rewrite destination.
    ["original path", probeReq(CAPABILITIES_URL)],
    ["original path, empty query helper", probeReq(CAPABILITIES_URL, { query: {} })],
    [
      "original path with the rewrite query merged in",
      probeReq(`${CAPABILITIES_URL}?${CAPABILITIES_FLAG}=1`, { query: { [CAPABILITIES_FLAG]: "1" } }),
    ],
    [
      "rewrite destination",
      probeReq(`/api/health?${CAPABILITIES_FLAG}=1`, { query: { [CAPABILITIES_FLAG]: "1" } }),
    ],
    ["rewrite destination, no query helper", probeReq(`/api/health?${CAPABILITIES_FLAG}=1`)],
    ["rewrite flag only in the query helper", probeReq("/api/health", { query: { [CAPABILITIES_FLAG]: "1" } })],
    ["no url, rewrite flag in the query helper", probeReq(undefined, { query: { [CAPABILITIES_FLAG]: "1" } })],
    ["trailing slash", probeReq(`${CAPABILITIES_URL}/`)],
    ["the caller's own query", probeReq(`${CAPABILITIES_URL}?t=1&foo=bar`, { query: { t: "1", foo: "bar" } })],
    [
      "the caller's own query, rewrite destination",
      probeReq(`/api/health?${CAPABILITIES_FLAG}=1&t=1`, { query: { [CAPABILITIES_FLAG]: "1", t: "1" } }),
    ],
    ["HEAD", probeReq(CAPABILITIES_URL, { method: "HEAD" })],
    ["POST", probeReq(CAPABILITIES_URL, { method: "POST" })],
  ]);
});

testAsync("R-fold: a rewrite flag typed by hand cannot produce a third response", async () => {
  // `vercel dev` lets the caller's own query value replace the value the rewrite
  // adds, so the handler may only trust that the flag is there, never its value.
  const byHand = ["0", "", "false", "1", "health"];
  const stillCapabilities: Array<[string, object]> = [];
  for (const v of byHand) {
    const q = `${CAPABILITIES_FLAG}=${v}`;
    stillCapabilities.push(
      [`${CAPABILITIES_URL}?${q}`, probeReq(`${CAPABILITIES_URL}?${q}`, { query: { [CAPABILITIES_FLAG]: v } })],
      // The same request when the function sees the destination and the caller's value won.
      [`/api/health?${q}`, probeReq(`/api/health?${q}`, { query: { [CAPABILITIES_FLAG]: v } })],
      [`/api/health?${q} (no query helper)`, probeReq(`/api/health?${q}`)],
    );
  }
  stillCapabilities.push(
    ["flag without a value", probeReq(`${CAPABILITIES_URL}?${CAPABILITIES_FLAG}`)],
    ["flag without a value, destination", probeReq(`/api/health?${CAPABILITIES_FLAG}`)],
    [
      "flag given twice",
      probeReq(`/api/health?${CAPABILITIES_FLAG}=0&${CAPABILITIES_FLAG}=1`, { query: { [CAPABILITIES_FLAG]: ["0", "1"] } }),
    ],
    ["flag after another parameter", probeReq(`/api/health?t=1&${CAPABILITIES_FLAG}=0`)],
    ["percent-encoded flag", probeReq("/api/health?%63apabilities=0")],
    ["fragment after the path", probeReq(`${CAPABILITIES_URL}#top`)],
  );
  await expectProbe("capabilities", stillCapabilities);

  // Anything that is not the flag leaves /api/health alone.
  await expectProbe("health", [
    ["flag in another letter case", probeReq("/api/health?Capabilities=1", { query: { Capabilities: "1" } })],
    ["longer names", probeReq("/api/health?xcapabilities=1&capabilitiesx=1")],
    ["flag name used as a value", probeReq("/api/health?probe=capabilities", { query: { probe: "capabilities" } })],
    ["flag name in a fragment", probeReq("/api/health#capabilities")],
    ["flag inside a fragment", probeReq(`/api/health#?${CAPABILITIES_FLAG}=1`)],
    ["a path that only starts like the capabilities URL", probeReq(`${CAPABILITIES_URL}x`)],
    ["a path below the capabilities URL", probeReq(`${CAPABILITIES_URL}/extra`)],
  ]);
});

testAsync("R-fold: odd request shapes get the health response and never throw", async () => {
  const throwingQuery = probeReq("/api/health");
  Object.defineProperty(throwingQuery, "query", {
    get() {
      throw new TypeError("Invalid URL");
    },
  });
  await expectProbe("health", [
    ["no url", probeReq(undefined)],
    ["empty url", probeReq("")],
    ["url //", probeReq("//")],
    ["url ?", probeReq("?")],
    ["broken percent-encoding", probeReq("/api/health?%E0%A4%A=%")],
    ["query helper is null", probeReq("/api/health", { query: null })],
    ["query helper is a string", probeReq("/api/health", { query: CAPABILITIES_FLAG })],
    ["query helper is an array", probeReq("/api/health", { query: [CAPABILITIES_FLAG] })],
    ["query helper throws", throwingQuery],
    ["flag only on the query helper's prototype", probeReq("/api/health", { query: Object.create({ [CAPABILITIES_FLAG]: "1" }) })],
  ]);
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

// The same AW-/DC-/GT- gap in the enhanced-measurement and sGTM rules.
const EM_MANUAL_PV = "GA4 enhanced measurement is enabled while GTM appears to send page_view manually";
const SGTM_MISMATCH = "GA4 tag transport_url does not match the selected server container domain";
const SGTM_NO_CLIENT = "Web GA4 tags route to a server container, but no GA4 client was found there";

function googleTagWith(tagId: string, id: string, name: string, key: string, value: string) {
  const t = googleTag(tagId, id, name);
  t.parameter.push({ type: "template", key, value });
  return t;
}

const enhancedOnRoutes = (url: URL): StubResponse | undefined =>
  url.hostname === "analyticsadmin.googleapis.com" && url.pathname.endsWith("/enhancedMeasurementSettings")
    ? { status: 200, body: { streamEnabled: true } }
    : streamRoutes(url);

/** A selected server container (domain collect.example.com) with no GA4 client. */
const SERVER_CONTEXT = { accountId: "1", containerId: "9", workspaceId: "5" };
const serverContainerRoutes = (url: URL): StubResponse | undefined => {
  if (url.hostname !== "tagmanager.googleapis.com") return undefined;
  const p = url.pathname.replace(/^\/tagmanager\/v2/, "");
  if (p === "/accounts/1/containers/9") {
    return { status: 200, body: { containerId: "9", usageContext: ["server"], domainName: ["collect.example.com"] } };
  }
  if (p === "/accounts/1/containers/9/workspaces/5/clients") return { status: 200, body: { client: [] } };
  if (p === "/accounts/1/containers/9/workspaces/5/transformations") {
    return { status: 200, body: { transformation: [] } };
  }
  return undefined;
};

testAsync("R-googtag: an AW- Google tag's send_page_view=false is not GA4 manual page_view handling", async () => {
  // Regression: any googtag with send_page_view=false counted as GA4 sending
  // page_view manually, so an Ads Google tag raised the enhanced-measurement
  // double-count finding.
  const out = await auditFindings(
    webFixture([
      googleTag("1", "G-ABC1234", "GA4 Google tag"),
      googleTagWith("2", "AW-123456789", "Google Ads tag", "sendPageView", "false"),
    ]),
    [enhancedOnRoutes],
    { ga4PropertyId: "123456" },
  );
  assert.ok(!out.findings.some((f) => f.finding === EM_MANUAL_PV), "AW- send_page_view read as GA4 manual page_view");
});

testAsync("R-googtag control: a G- Google tag with send_page_view=false still trips the enhanced-measurement finding", async () => {
  const out = await auditFindings(
    webFixture([googleTagWith("1", "G-ABC1234", "GA4 Google tag", "sendPageView", "false")]),
    [enhancedOnRoutes],
    { ga4PropertyId: "123456" },
  );
  assert.ok(out.findings.some((f) => f.finding === EM_MANUAL_PV));
});

testAsync("R-googtag: an AW- Google tag's transport_url is not GA4 server routing", async () => {
  // Regression: an Ads Google tag pointing at another endpoint got a GA4
  // transport mismatch, and made the server container's missing GA4 client a
  // HIGH finding although no GA4 tag routes to it.
  const out = await auditFindings(
    webFixture([
      googleTag("1", "G-ABC1234", "GA4 Google tag"),
      googleTagWith("2", "AW-123456789", "Google Ads tag", "server_container_url", "https://other.example.net"),
    ]),
    [serverContainerRoutes],
    { serverContext: SERVER_CONTEXT },
  );
  assert.ok(!out.findings.some((f) => f.finding === SGTM_MISMATCH), "AW- transport_url reported as a GA4 mismatch");
  assert.ok(!out.findings.some((f) => f.finding === SGTM_NO_CLIENT), "AW- transport_url counted as GA4 server routing");
});

testAsync("R-googtag control: a G- Google tag's transport_url is still reconciled against the server container", async () => {
  const out = await auditFindings(
    webFixture([
      googleTagWith("1", "G-ABC1234", "GA4 Google tag", "server_container_url", "https://other.example.net"),
    ]),
    [serverContainerRoutes],
    { serverContext: SERVER_CONTEXT },
  );
  assert.ok(out.findings.some((f) => f.finding === SGTM_MISMATCH));
  assert.ok(out.findings.some((f) => f.finding === SGTM_NO_CLIENT));
});

test("S-googtag: the Express auditor does not treat AW-/GT- Google tags as GA4 config tags", () => {
  // Regression: an Ads Google tag got a CRITICAL "missing valid Measurement ID"
  // finding and, next to the GA4 Google tag, a HIGH duplicate-config finding.
  const express = (tags: unknown[]) =>
    runExpressAudit(
      { tags: tags as never, triggers: [], variables: [], folders: [], builtInVariables: [] },
      { containerPublicId: "GTM-GOOGTAG" },
    ).findings.map((f) => f.title);
  const mixed = express([
    googleTag("1", "G-ABC1234", "GA4 Google tag"),
    googleTag("2", "AW-123456789", "Google Ads tag"),
    googleTag("3", "GT-ABCDEFG", "Google tag (GT)"),
  ]);
  assert.ok(!mixed.includes("GA4 Config tag missing valid Measurement ID"), JSON.stringify(mixed));
  assert.ok(!mixed.includes("Multiple GA4 Config / Google Tag entries"), JSON.stringify(mixed));
  // Controls: two G- tags are still duplicates; a Google tag with no id still lacks one.
  const twoGa4 = express([googleTag("1", "G-ABC1234", "GA4 A"), googleTag("2", "G-XYZ9876", "GA4 B")]);
  assert.ok(twoGa4.includes("Multiple GA4 Config / Google Tag entries"));
  const noId = express([{ tagId: "1", name: "Bare Google tag", type: "googtag", firingTriggerId: ["2147479553"] }]);
  assert.ok(noId.includes("GA4 Config tag missing valid Measurement ID"));
});

// ── Paged GTM lists (nextPageToken) and the Data API report ─────────────────

const WS = "/tagmanager/v2/accounts/1/containers/2/workspaces/3";

/** Serve `pages` of one list at `pathname`, chained by nextPageToken. */
function pagedList(pathname: string, key: string, pages: unknown[][]) {
  return (url: URL): StubResponse | undefined => {
    if (url.hostname !== "tagmanager.googleapis.com" || url.pathname !== pathname) return undefined;
    const i = Number(url.searchParams.get("pageToken") ?? "0");
    const body: Record<string, unknown> = { [key]: pages[i] ?? [] };
    if (i + 1 < pages.length) body.nextPageToken = String(i + 1);
    return { status: 200, body };
  };
}

testAsync("R-paging: a trigger on page 2 of triggers.list is not a broken reference", async () => {
  // Regression: one call per list read only page 1, so tags referencing a
  // page-2 trigger got HIGH broken-reference findings and counts under-reported.
  const fx = webFixture([]);
  const out = await auditFindings(fx, [
    pagedList(`${WS}/tags`, "tag", [
      [{ tagId: "1", name: "Lead tag", type: "html", firingTriggerId: ["20"], parameter: [] }],
      [{ tagId: "2", name: "Late tag", type: "html", firingTriggerId: ["10"], parameter: [] }],
    ]),
    pagedList(`${WS}/triggers`, "trigger", [
      [{ triggerId: "10", name: "Click", type: "click" }],
      [{ triggerId: "20", name: "Form", type: "formSubmission" }],
    ]),
  ]);
  assert.ok(!out.findings.some((f) => f.finding === BROKEN_FIRE), "page-2 trigger reported missing");
  assert.ok(
    !out.findings.some((f) => f.finding === "Trigger is not referenced by any tag or variable"),
    "trigger used only by a page-2 tag reported unused",
  );
  assert.deepEqual(out.counts, { tags: 2, triggers: 2, variables: 0 });
});

testAsync("R-paging: a list cut off at the page cap is a tool failure, not a broken reference", async () => {
  const endless = (url: URL): StubResponse | undefined => {
    if (url.hostname !== "tagmanager.googleapis.com" || url.pathname !== `${WS}/triggers`) return undefined;
    return { status: 200, body: { trigger: [], nextPageToken: "more" } };
  };
  const out = await auditFindings(
    webFixture([{ tagId: "1", name: "Lead tag", type: "html", firingTriggerId: ["999"], parameter: [] }]),
    [endless],
  );
  assert.ok(!out.findings.some((f) => f.finding === BROKEN_FIRE), "partial trigger list produced a broken reference");
  assert.ok(
    (out.toolFailures ?? []).some((t: { resource: string }) => t.resource === "triggers"),
    "the truncated list must be recorded as a tool failure",
  );
  assert.notEqual(out.executiveSummary?.publishSafe, "yes");
});

testAsync("R-paging: the GA4 Data API report is read past its first page", async () => {
  // Regression: runReport was sent once with limit 250, so events beyond the
  // first page were reported as "zero events".
  let call = 0;
  const reportRows = [
    { rows: [{ dimensionValues: [{ value: "sign_up" }], metricValues: [{ value: "5" }] }], rowCount: 2 },
    { rows: [{ dimensionValues: [{ value: "purchase" }], metricValues: [{ value: "3" }] }], rowCount: 2 },
  ];
  const dataApi = (url: URL): StubResponse | undefined => {
    if (url.hostname !== "analyticsdata.googleapis.com") return undefined;
    return { status: 200, body: reportRows[call++] ?? { rows: [], rowCount: 2 } };
  };
  const eventTag = (tagId: string, ev: string) => ({
    tagId,
    name: `GA4 - ${ev}`,
    type: "gaawe",
    firingTriggerId: ["2147479553"],
    parameter: [
      { type: "template", key: "eventName", value: ev },
      { type: "template", key: "measurementIdOverride", value: "G-ABC1234" },
    ],
  });
  const out = await auditFindings(
    webFixture([googleTag("1", "G-ABC1234", "GA4 Google tag"), eventTag("2", "sign_up"), eventTag("3", "purchase")]),
    [dataApi, streamRoutes],
    { ga4PropertyId: "123456", enableDataApi: true },
  );
  assert.ok(call >= 2, `expected the report to be paged, got ${call} call(s)`);
  assert.ok(
    !out.findings.some((f) => /reported zero events/.test(f.finding ?? "")),
    `events on page 2 reported as zero: ${JSON.stringify(out.findings.filter((f) => /zero events/.test(f.finding ?? "")))}`,
  );
});

testAsync("R-paging: /api/gtm/consent-audit audits tags from every page", async () => {
  const ungated = (tagId: string, name: string) => googleTag(tagId, "G-ABC1234", name);
  const r = await callRoute(consentAuditHandler, { containerPublicId: "GTM-PAGED" }, [
    pagedList(`${WS}/tags`, "tag", [[ungated("1", "Page-1 Google tag")], [ungated("2", "Page-2 Google tag")]]),
    gtmRoutes(webFixture([])),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const perTag = r.json.findings.find((f: { finding?: string }) =>
    /marketing\/analytics tag\(s\) have no per-tag consent settings/.test(f.finding ?? ""),
  );
  assert.ok(perTag, "expected the per-tag consent finding");
  assert.ok(
    (perTag.affected ?? []).includes("Page-2 Google tag"),
    `ungated tag on page 2 was not audited: ${JSON.stringify(perTag.affected)}`,
  );
});

/** Run `fn` with global fetch served by `routes` (no network). */
async function withStubbedFetch<T>(
  routes: Array<(url: URL) => StubResponse | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const hit = routes.map((r) => r(url)).find(Boolean) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

testAsync("S-paging: the Express GTM client follows nextPageToken for lists and workspace contents", async () => {
  const accounts = await withStubbedFetch(
    [pagedList("/tagmanager/v2/accounts", "account", [[{ accountId: "1" }], [{ accountId: "2" }]])],
    () => listAccounts("t"),
  );
  assert.deepEqual(accounts.map((a) => a.accountId), ["1", "2"]);
  const contents = await withStubbedFetch(
    [
      pagedList(`${WS}/triggers`, "trigger", [[{ triggerId: "10" }], [{ triggerId: "20" }]]),
      gtmRoutes(webFixture([])),
    ],
    () => fetchWorkspaceContents("t", "1", "2", "3"),
  );
  assert.deepEqual(contents.triggers.map((t) => t.triggerId), ["10", "20"]);
});

testAsync("R-paging: /api/gtm/accounts returns accounts from every page", async () => {
  const out = await callRoute(accountsHandler, {}, [
    pagedList("/tagmanager/v2/accounts", "account", [
      [{ accountId: "1", name: "First" }],
      [{ accountId: "2", name: "Second" }],
    ]),
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.json).slice(0, 300));
  assert.deepEqual(
    out.json.accounts.map((a: { accountId: string }) => a.accountId),
    ["1", "2"],
  );
});

// ── Session cookie: every api/** copy agrees with server/gtm/session-cookie ──
// Regression: the session cookie was signed-only base64 JSON with no issued-at.
// Anyone holding a copy could read the Google tokens out of it, and every route
// accepted it forever (each refresh re-minted it with a new Max-Age). Now the
// tokens are sealed (AES-256-GCM) and every route enforces a 30-day absolute
// lifetime from sign-in that a refresh does not extend.

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => unknown;
const DAY_MS = 24 * 60 * 60 * 1000;
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const STATUS_ROUTE = "/api/oauth/status";

const SESSION_ROUTES: Array<{ name: string; handler: RouteHandler; method: string; url: string }> = [
  { name: STATUS_ROUTE, handler: oauthStatusHandler, method: "GET", url: "/api/oauth/status" },
  { name: "/api/gtm/accounts", handler: accountsHandler, method: "GET", url: "/api/gtm/accounts" },
  {
    name: "/api/gtm/accounts/:id/containers",
    handler: containersHandler as RouteHandler,
    method: "GET",
    url: "/api/gtm/accounts/1/containers?accountId=1",
  },
  {
    name: "/api/gtm/accounts/:id/containers/:id/workspaces",
    handler: workspacesHandler as RouteHandler,
    method: "GET",
    url: "/api/gtm/accounts/1/containers/2/workspaces?accountId=1&containerId=2",
  },
  { name: "/api/gtm/audit", handler: auditHandler, method: "POST", url: "/api/gtm/audit" },
  { name: "/api/gtm/consent-audit", handler: consentAuditHandler, method: "POST", url: "/api/gtm/consent-audit" },
  { name: "/api/gtm/sgtm", handler: sgtmHandler, method: "POST", url: "/api/gtm/sgtm" },
  { name: "/api/ga4/admin", handler: ga4AdminHandler, method: "POST", url: "/api/ga4/admin" },
];

function withRouteSecret<T>(fn: () => T): T {
  const prev = process.env.PORTAL_SESSION_SECRET;
  process.env.PORTAL_SESSION_SECRET = SECRET;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PORTAL_SESSION_SECRET;
    else process.env.PORTAL_SESSION_SECRET = prev;
  }
}

function sessionAccepted(route: { name: string }, r: { status: number; json: any }): boolean {
  if (route.name === STATUS_ROUTE) return r.json?.connected === true;
  return r.status !== 401 && r.json?.error !== "not_connected";
}

/** The pre-fix wire format: `v1.<base64url(json)>.<hmac>`, tokens readable. */
function legacySignedCookie(tokens: Record<string, unknown>): string {
  const payload = `v1.${Buffer.from(JSON.stringify(tokens)).toString("base64url")}`;
  return `${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

/** The session cookie a response set, decoded with the server module. */
function sessionFromSetCookie(setCookies: string[]) {
  const prefix = "samarth_portal_sid=";
  const line = setCookies.find((c) => c.startsWith(prefix) && !c.startsWith(`${prefix};`));
  if (!line) return null;
  const raw = decodeURIComponent(line.slice(prefix.length).split(";")[0]);
  return { raw, tokens: withRouteSecret(() => decodeSessionCookie(raw)) };
}

const tokenRefreshRoute = (url: URL): StubResponse | undefined =>
  url.hostname === "oauth2.googleapis.com" && url.pathname === "/token"
    ? { status: 200, body: { access_token: "refreshed-access-token", expires_in: 3600 } }
    : undefined;

for (const route of SESSION_ROUTES) {
  const call = { method: route.method, url: route.url };

  testAsync(`R-session ${route.name}: a fresh sealed session is accepted`, async () => {
    const r = await callRoute(route.handler, {}, [], { ...call, session: { scopes: [GA4_SCOPE] } });
    assert.ok(sessionAccepted(route, r), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  });

  testAsync(`R-session ${route.name}: a sealed session past the 30-day lifetime is rejected`, async () => {
    const r = await callRoute(route.handler, {}, [tokenRefreshRoute], {
      ...call,
      session: { scopes: [GA4_SCOPE], iat: Date.now() - 31 * DAY_MS, refreshToken: "1//old-refresh" },
    });
    assert.ok(!sessionAccepted(route, r), "a 31-day-old session must not be honoured");
    if (route.name !== STATUS_ROUTE) assert.equal(r.status, 401);
    assert.equal(sessionFromSetCookie(r.setCookies), null, "a stale session must not be re-minted");
  });

  testAsync(`R-session ${route.name}: a legacy signed-only v1 cookie is rejected`, async () => {
    const legacy = legacySignedCookie({
      accessToken: "test-access-token",
      expiresAt: Date.now() + 3_600_000,
      iat: Date.now(),
      scopes: [GA4_SCOPE],
    });
    const r = await callRoute(route.handler, {}, [], {
      ...call,
      cookieHeader: () => `samarth_portal_sid=${encodeURIComponent(legacy)}`,
    });
    assert.ok(!sessionAccepted(route, r), "unencrypted v1 cookies are no longer accepted");
  });

  if (route.name === STATUS_ROUTE) continue; // status never refreshes

  testAsync(`R-session ${route.name}: a token refresh keeps the original sign-in time`, async () => {
    const iat = Date.now() - 10 * DAY_MS;
    const r = await callRoute(route.handler, {}, [tokenRefreshRoute], {
      ...call,
      session: {
        scopes: [GA4_SCOPE],
        iat,
        accessToken: "expired-access-token",
        expiresAt: Date.now() - 1000,
        refreshToken: "1//refresh-token",
        email: "user@example.com",
        userName: "Example User",
        picture: "https://example.com/p.png",
      },
    });
    assert.ok(sessionAccepted(route, r), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    const rotated = sessionFromSetCookie(r.setCookies);
    assert.ok(rotated?.tokens, "the refreshed session cookie must decode");
    assert.equal(rotated.tokens.accessToken, "refreshed-access-token");
    assert.equal(rotated.tokens.refreshToken, "1//refresh-token");
    assert.equal(rotated.tokens.iat, iat, "refresh must not extend the session");
    // Regression: the route decoders dropped userName/picture, so the first
    // refresh outside /api/oauth/status erased the signed-in user's profile.
    assert.equal(rotated.tokens.email, "user@example.com");
    assert.equal(rotated.tokens.userName, "Example User", "refresh dropped userName");
    assert.equal(rotated.tokens.picture, "https://example.com/p.png", "refresh dropped picture");
    assert.ok(!rotated.raw.includes("refreshed-access-token"), "rotated cookie leaks the token");
  });
}

testAsync("R-session /api/oauth/callback mints a sealed session stamped with iat", async () => {
  const { state, cookie: stateCookie } = withRouteSecret(() => encodeOAuthStateCookie());
  const googleOAuth = (url: URL): StubResponse | undefined => {
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      return {
        status: 200,
        body: {
          access_token: "fresh-access-token",
          refresh_token: "1//fresh-refresh-token",
          expires_in: 3600,
          scope: `https://www.googleapis.com/auth/tagmanager.readonly ${GA4_SCOPE}`,
        },
      };
    }
    if (url.hostname === "openidconnect.googleapis.com") {
      return { status: 200, body: { email: "user@example.com", name: "User", picture: "https://example.com/p.png" } };
    }
    return undefined;
  };
  const before = Date.now();
  const r = await callRoute(oauthCallbackHandler, {}, [googleOAuth], {
    method: "GET",
    url: `/api/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    cookieHeader: () => `samarth_portal_oauth_state=${encodeURIComponent(stateCookie)}`,
  });
  assert.equal(r.status, 302);
  const minted = sessionFromSetCookie(r.setCookies);
  assert.ok(minted?.tokens, "callback must set a session cookie the server module decodes");
  assert.ok(minted.raw.startsWith("v1e."), minted.raw.slice(0, 8));
  assert.equal(minted.tokens.refreshToken, "1//fresh-refresh-token");
  assert.ok(
    typeof minted.tokens.iat === "number" && minted.tokens.iat >= before && minted.tokens.iat <= Date.now(),
    "iat must be the sign-in time",
  );
  const body = Buffer.from(minted.raw.split(".")[1], "base64url").toString("latin1");
  for (const secret of ["1//fresh-refresh-token", "fresh-access-token", "user@example.com"]) {
    assert.ok(!minted.raw.includes(secret) && !body.includes(secret), `session cookie exposes ${secret}`);
  }
});

// ── Disconnect Google: revoke the grant, but only in the portal's own project ──
// Google revokes a user's grant for a whole Google Cloud project. If the MCP
// server signs users in with a client in the portal's project, even a different
// client ID, revoking would sign the user out there too. The portal cannot see
// another deployment's settings, so revoking is opt-in, refuses a shared client
// or project it can see, and first proves the token refreshes with the portal's
// own client.

/** Clears variables an operator's shell might export, so the outcome depends only on the test. */
const LOGOUT_BASE_ENV: Record<string, string | undefined> = {
  PORTAL_REVOKE_GOOGLE_ON_DISCONNECT: undefined,
  GOOGLE_OAUTH_CLIENT_ID: undefined,
  GOOGLE_CLIENT_ID: undefined,
  SAMARTH_GOOGLE_OAUTH_CLIENT_ID: undefined,
};
const REVOKE_ON = { ...LOGOUT_BASE_ENV, PORTAL_REVOKE_GOOGLE_ON_DISCONNECT: "true" };
const SAME_ORIGIN = { origin: "https://portal.example", host: "portal.example" };
// Google client IDs start with their project number.
const PROJECT_A_PORTAL = "1111111111-portal.apps.googleusercontent.com";
const PROJECT_A_MCP = "1111111111-mcp.apps.googleusercontent.com";
const PROJECT_B_MCP = "2222222222-mcp.apps.googleusercontent.com";

type GoogleCall = [string, ...string[]];

/** Google's token and revoke endpoints. Records each call without the client secret. */
function googleStub(calls: GoogleCall[], status: { token?: number; revoke?: number } = {}) {
  return (url: URL, init?: RequestInit): StubResponse | undefined => {
    if (url.hostname !== "oauth2.googleapis.com") return undefined;
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (url.pathname === "/token" && form.get("grant_type") === "refresh_token") {
      calls.push(["token", form.get("client_id") ?? "", form.get("refresh_token") ?? ""]);
      return { status: status.token ?? 200, body: { access_token: "fresh", expires_in: 3600 } };
    }
    if (url.pathname === "/revoke") {
      calls.push(["revoke", form.get("token") ?? ""]);
      return { status: status.revoke ?? 200, body: {} };
    }
    return undefined;
  };
}

function clearsSessionCookie(setCookies: string[]): boolean {
  return setCookies.some((c) => c.startsWith("samarth_portal_sid=;") && c.includes("Max-Age=0"));
}

/** Runs fn with console.warn captured; returns what it logged. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const real = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return lines;
}

testAsync("R-logout: an opted-in same-origin POST proves the token is the portal's, then revokes it", async () => {
  const calls: GoogleCall[] = [];
  const r = await callRoute(oauthLogoutHandler, {}, [googleStub(calls)], {
    url: "/api/oauth/logout",
    session: { refreshToken: "1//portal-refresh-token" },
    headers: SAME_ORIGIN,
    env: REVOKE_ON,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { connected: false, googleRevoked: true });
  assert.deepEqual(calls, [
    ["token", ROUTE_ENV.PORTAL_GOOGLE_OAUTH_CLIENT_ID, "1//portal-refresh-token"],
    ["revoke", "1//portal-refresh-token"],
  ]);
  assert.ok(clearsSessionCookie(r.setCookies), r.setCookies.join(" | "));
  // A client of the MCP server in another project does not stop it.
  const other: GoogleCall[] = [];
  const otherProject = await callRoute(oauthLogoutHandler, {}, [googleStub(other)], {
    url: "/api/oauth/logout",
    session: { refreshToken: "1//portal-refresh-token" },
    headers: SAME_ORIGIN,
    env: { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, GOOGLE_OAUTH_CLIENT_ID: PROJECT_B_MCP },
  });
  assert.equal(otherProject.json?.googleRevoked, true);
  assert.deepEqual(other.map((c) => c[0]), ["token", "revoke"]);
});

testAsync("R-logout never revokes unless opted in, nor a client or project shared with the MCP server", async () => {
  const own = ROUTE_ENV.PORTAL_GOOGLE_OAUTH_CLIENT_ID;
  for (const env of [
    // The default: the portal cannot tell whether a separately deployed MCP server uses its client.
    LOGOUT_BASE_ENV,
    { ...LOGOUT_BASE_ENV, PORTAL_REVOKE_GOOGLE_ON_DISCONNECT: "1" },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_ID: "shared-client-id" },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET: undefined },
    { ...REVOKE_ON, GOOGLE_OAUTH_CLIENT_ID: own },
    { ...REVOKE_ON, GOOGLE_CLIENT_ID: own },
    { ...REVOKE_ON, SAMARTH_GOOGLE_OAUTH_CLIENT_ID: own },
    // A different client in the same Google Cloud project: Google revokes per project.
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_MCP },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, GOOGLE_CLIENT_ID: PROJECT_A_MCP },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, SAMARTH_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_MCP },
  ]) {
    const calls: GoogleCall[] = [];
    const r = await callRoute(oauthLogoutHandler, {}, [googleStub(calls)], {
      url: "/api/oauth/logout",
      session: { refreshToken: "1//shared-refresh-token" },
      headers: SAME_ORIGIN,
      env,
    });
    assert.equal(r.json?.googleRevoked, false, JSON.stringify(env));
    assert.deepEqual(calls, [], JSON.stringify(env));
    assert.ok(clearsSessionCookie(r.setCookies), JSON.stringify(env));
  }
});

testAsync("R-logout leaves alone a session whose token was issued to another client", async () => {
  // A cookie minted before the portal moved off a client it shared with the MCP server.
  const calls: GoogleCall[] = [];
  let r: Awaited<ReturnType<typeof callRoute>> | undefined;
  const warnings = await captureWarnings(async () => {
    r = await callRoute(oauthLogoutHandler, {}, [googleStub(calls, { token: 401 })], {
      url: "/api/oauth/logout",
      session: { refreshToken: "1//issued-to-the-shared-client" },
      headers: SAME_ORIGIN,
      env: REVOKE_ON,
    });
  });
  assert.deepEqual(r?.json, { connected: false, googleRevoked: false });
  assert.deepEqual(calls, [["token", ROUTE_ENV.PORTAL_GOOGLE_OAUTH_CLIENT_ID, "1//issued-to-the-shared-client"]]);
  assert.ok(clearsSessionCookie(r?.setCookies ?? []));
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.ok(/not revoking/.test(warnings[0]) && !warnings[0].includes("1//"), warnings[0]);
});

testAsync("R-logout revokes only on a same-origin POST", async () => {
  for (const [method, headers] of [
    ["GET", SAME_ORIGIN],
    ["POST", { host: "portal.example" }],
    ["POST", { origin: "https://evil.example", host: "portal.example" }],
    ["POST", { origin: "null", host: "portal.example" }],
    ["POST", { origin: "http://portal.example.evil.example", host: "portal.example" }],
  ] as Array<[string, Record<string, string>]>) {
    const calls: GoogleCall[] = [];
    const r = await callRoute(oauthLogoutHandler, {}, [googleStub(calls)], {
      method,
      url: "/api/oauth/logout",
      session: { refreshToken: "1//portal-refresh-token" },
      headers,
      env: REVOKE_ON,
    });
    assert.equal(r.json?.googleRevoked, false, `${method} ${JSON.stringify(headers)}`);
    assert.deepEqual(calls, [], `${method} ${JSON.stringify(headers)}`);
    assert.ok(clearsSessionCookie(r.setCookies));
  }
  // Behind a proxy the Origin may match the forwarded host instead.
  const calls: GoogleCall[] = [];
  const proxied = await callRoute(oauthLogoutHandler, {}, [googleStub(calls)], {
    url: "/api/oauth/logout",
    session: { refreshToken: "1//portal-refresh-token" },
    headers: { origin: "https://portal.example", host: "internal:3000", "x-forwarded-host": "portal.example" },
    env: REVOKE_ON,
  });
  assert.equal(proxied.json?.googleRevoked, true);
});

testAsync("R-logout still signs out, and logs, when Google refuses; no session revokes nothing", async () => {
  const calls: GoogleCall[] = [];
  let refused: Awaited<ReturnType<typeof callRoute>> | undefined;
  const warnings = await captureWarnings(async () => {
    refused = await callRoute(oauthLogoutHandler, {}, [googleStub(calls, { revoke: 400 })], {
      url: "/api/oauth/logout",
      session: { refreshToken: "1//already-revoked" },
      headers: SAME_ORIGIN,
      env: REVOKE_ON,
    });
  });
  assert.equal(refused?.status, 200);
  assert.deepEqual(refused?.json, { connected: false, googleRevoked: false });
  assert.ok(clearsSessionCookie(refused?.setCookies ?? []));
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.ok(/did not confirm/.test(warnings[0]) && !warnings[0].includes("1//"), warnings[0]);
  for (const opts of [{ authenticated: false }, { session: { refreshToken: undefined } }]) {
    const none: GoogleCall[] = [];
    const r = await callRoute(oauthLogoutHandler, {}, [googleStub(none)], {
      url: "/api/oauth/logout",
      headers: SAME_ORIGIN,
      env: REVOKE_ON,
      ...opts,
    });
    assert.deepEqual(r.json, { connected: false, googleRevoked: false }, JSON.stringify(opts));
    assert.deepEqual(none, [], JSON.stringify(opts));
  }
});

testAsync("R-logout: the Vercel route and the Express server's revokeOnDisconnect agree", async () => {
  const own = ROUTE_ENV.PORTAL_GOOGLE_OAUTH_CLIENT_ID;
  const envs = [
    LOGOUT_BASE_ENV,
    REVOKE_ON,
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: undefined },
    { ...REVOKE_ON, GOOGLE_OAUTH_CLIENT_ID: "another-client-id" },
    { ...REVOKE_ON, GOOGLE_OAUTH_CLIENT_ID: own },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_MCP },
    { ...REVOKE_ON, PORTAL_GOOGLE_OAUTH_CLIENT_ID: PROJECT_A_PORTAL, GOOGLE_OAUTH_CLIENT_ID: PROJECT_B_MCP },
  ];
  const requests: Array<[string, Record<string, string>]> = [
    ["POST", SAME_ORIGIN],
    ["GET", SAME_ORIGIN],
    ["POST", { origin: "https://evil.example", host: "portal.example" }],
  ];
  const statuses = [{}, { token: 400 }, { revoke: 400 }];
  for (const env of envs) {
    for (const [method, headers] of requests) {
      for (const status of statuses) {
        const label = JSON.stringify({ env, method, headers, status });
        const routeCalls: GoogleCall[] = [];
        const expressCalls: GoogleCall[] = [];
        let route: Awaited<ReturnType<typeof callRoute>> | undefined;
        let express = false;
        await captureWarnings(async () => {
          route = await callRoute(oauthLogoutHandler, {}, [googleStub(routeCalls, status)], {
            method,
            url: "/api/oauth/logout",
            session: { refreshToken: "1//lockstep" },
            headers,
            env,
          });
          const merged: NodeJS.ProcessEnv = { ...ROUTE_ENV };
          for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete merged[k];
            else merged[k] = v;
          }
          const stub = googleStub(expressCalls, status);
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
            const hit = stub(new URL(String(input)), init) ?? { status: 404, body: {} };
            return new Response(JSON.stringify(hit.body), { status: hit.status });
          }) as typeof fetch;
          try {
            express = await revokeOnDisconnect(
              { method, origin: headers.origin, host: headers.host, forwardedHost: undefined },
              "1//lockstep",
              merged,
            );
          } finally {
            globalThis.fetch = realFetch;
          }
        });
        assert.equal(route?.json?.googleRevoked, express, label);
        assert.deepEqual(routeCalls, expressCalls, label);
      }
    }
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
