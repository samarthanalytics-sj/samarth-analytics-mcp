import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type {
  ConsentAuditResult,
  ConsentConfigInput,
  ConsentFinding,
  ConsentStateLabel,
  RuntimeConsentEvent,
  RuntimeCookie,
  RuntimeHit as ConsentRuntimeHit,
  RuntimeInput as ConsentRuntimeInput,
  RuntimePage as ConsentRuntimePage,
} from "../../shared/consent-audit";

/**
 * /api/gtm/consent-audit
 *
 * Dedicated, focused Consent Mode v2 auditor. Read-only against the GTM API v2.
 *
 * This is the narrow sibling of /api/gtm/audit: it validates the session, reads
 * the chosen GTM workspace, and returns ONLY the Consent Mode v2 output from the
 * shared consent engine (shared/consent-audit.ts). It deliberately does NOT run
 * the GA4 architecture / sGTM / naming / general QC rules — the Consent v2 page
 * surfaces consent findings alone. Use /api/gtm/audit for the full audit.
 *
 * Vercel-safe by construction (mirrors /api/gtm/audit and /api/gtm/sgtm):
 * - Self-contained at module load — only `node:*` runtime imports. The consent
 *   engine is referenced for *types* only at the top level and is pulled in
 *   lazily via `await import(...)` AFTER session validation, so an
 *   unauthenticated probe gets a clean 401 before the shared module is ever
 *   evaluated and any import failure surfaces as JSON, not a platform
 *   FUNCTION_INVOCATION_FAILED.
 *
 * Hard rules:
 * - ONLY list/get calls. No create/update/delete. No `confirm`. Nothing in GTM
 *   is ever mutated.
 * - Never fabricate runtime coverage: RUNTIME / reconciliation checks only run
 *   when a parseable capture is supplied. Without one, this is config-only.
 *
 * Request body: { accountId, containerId, workspaceId, containerPublicId?,
 *                 runtimeCapture? }
 */

const COOKIE_VERSION = "v1";
const SESSION_COOKIE = "samarth_portal_sid";

interface SessionTokensShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  scopes?: string[];
}

interface OAuthClientShape {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ── GTM v2 subset types (only what the consent engine inspects) ────────────

interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

interface GtmTag {
  tagId?: string;
  name?: string;
  type?: string;
  firingTriggerId?: string[];
  parameter?: GtmParameter[];
  parentFolderId?: string;
  consentSettings?: { consentStatus?: string; consentType?: { value?: string } };
  setupTag?: { tagName?: string }[];
}

interface GtmTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: unknown[];
  customEventFilter?: unknown[];
}

interface GtmVariable {
  variableId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
}

interface GtmContainer {
  containerId?: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
}

// ── Runtime capture (RUNTIME source) ─────────────────────────────────────
// Parsed/normalized from an uploaded runtime-worker artifact. NEVER fabricated
// — RUNTIME stays unverified unless a capture is provided.
interface RuntimeTrackerHit {
  url?: string;
  method?: string;
  matched?: string[];
  groups?: string[];
  query?: Record<string, string>;
  tMs?: number;
}
interface RuntimePageCapture {
  requestedUrl?: string;
  finalUrl?: string | null;
  consentState?: ConsentStateLabel;
  consoleErrors?: string[];
  pageErrors?: string[];
  trackerHits?: RuntimeTrackerHit[];
  dataLayerEvents?: string[];
  dataLayerKeys?: string[];
  consentEvents?: RuntimeConsentEvent[];
  cookies?: RuntimeCookie[];
  firstMeasurementTMs?: number;
}
interface RuntimeState {
  capturedAt?: string;
  pages: RuntimePageCapture[];
  states: ConsentStateLabel[];
  ok: boolean;
}

// ── Workspace read ────────────────────────────────────────────────────────

interface WorkspaceContents {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
}

interface ConsentToolFailure {
  resource: string;
  message: string;
  status?: number;
}

interface ConsentAuditState {
  contents: WorkspaceContents;
  container: GtmContainer | null;
  toolFailures: ConsentToolFailure[];
}

// ── Response shape ─────────────────────────────────────────────────────────

type ConsentSourceFlag = "CONFIG" | "RUNTIME";

interface ConsentAuditResponseFinding {
  id: string;
  severity: ConsentFinding["severity"];
  confidence: ConsentFinding["confidence"];
  sources: ConsentSourceFlag[];
  finding: string;
  whyItMatters: string;
  suggestedFix: string;
  businessImpact: string;
  effort: ConsentFinding["effort"];
  needsManualReview?: boolean;
  parameter?: string;
  entity?: { name?: string; id?: string; path?: string };
  affected?: string[];
  evidence?: string[];
  /** "config" | "runtime" | "reconcile" — which layer produced the finding. */
  layer: "config" | "runtime" | "reconcile";
}

interface ConsentAuditResponse {
  containerId: string;
  containerPublicId?: string;
  containerType?: string;
  generatedAt: string;
  coverage: ConsentAuditResult["coverage"];
  runtimeStates: string[];
  stateCoverage: { denied: boolean; granted: boolean; partial: boolean };
  counts: { tags: number; triggers: number; variables: number };
  findingCount: number;
  severityCounts: Record<ConsentFinding["severity"], number>;
  findings: ConsentAuditResponseFinding[];
  toolFailures?: ConsentToolFailure[];
}

// ════════════════════════════════════════════════════════════════════════════
// Handler
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendJson(res, 500, {
        error: "config_error",
        message: "PORTAL_SESSION_SECRET must be set on Vercel.",
      });
    }

    const client = resolveOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });

    const token = await getValidAccessToken(req, res, client, secret);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    const body = await readJsonBody<{
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
      containerPublicId?: string;
      runtimeCapture?: unknown;
    }>(req);
    const { accountId, containerId, workspaceId, containerPublicId } = body;
    if (!accountId || !containerId || !workspaceId) {
      return sendJson(res, 400, {
        error: "missing_params",
        message:
          "accountId, containerId and workspaceId are required. Use /api/gtm/accounts, /api/gtm/accounts/:id/containers, and the workspaces list to choose them, then retry.",
      });
    }

    // Parse an uploaded runtime capture (RUNTIME source). Never fabricated —
    // null unless the caller supplies a parseable artifact.
    const runtime = parseRuntimeCapture(body.runtimeCapture);

    try {
      const state = await pullConsentState(
        token,
        accountId,
        containerId,
        workspaceId,
      );

      // Pure consent engine — loaded lazily, only after the session has been
      // validated, so an import failure surfaces as JSON (not a crash).
      const { runConsentAudit } = await import("../../shared/consent-audit");
      const result = runConsentAudit(
        toConsentConfigInput(state),
        toConsentRuntimeInput(runtime),
      );

      const response = buildResponse(state, result, {
        containerId,
        containerPublicId: containerPublicId ?? containerId,
      });
      return sendJson(res, 200, response);
    } catch (e) {
      return sendGtmError(res, e, "Failed to run Consent Mode v2 audit");
    }
  } catch (e) {
    console.error(
      "[portal] /api/gtm/consent-audit: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/gtm/consent-audit handler failed",
      detail: safeErrorName(e),
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Consent engine bridge
// ════════════════════════════════════════════════════════════════════════════

function collectTextBlob(c: WorkspaceContents): string {
  const parts: string[] = [];
  const walk = (p: GtmParameter): void => {
    if (p.key) parts.push(p.key);
    if (p.value) parts.push(p.value);
    for (const child of p.list ?? []) walk(child);
    for (const child of p.map ?? []) walk(child);
  };
  for (const t of c.tags) {
    parts.push(t.name ?? "", t.type ?? "");
    for (const p of t.parameter ?? []) walk(p);
  }
  for (const v of c.variables) {
    parts.push(v.name ?? "", v.type ?? "");
    for (const p of v.parameter ?? []) walk(p);
  }
  return parts.join("\n").toLowerCase();
}

function toConsentConfigInput(state: ConsentAuditState): ConsentConfigInput {
  return {
    tags: state.contents.tags as unknown as ConsentConfigInput["tags"],
    triggers: state.contents.triggers as unknown as ConsentConfigInput["triggers"],
    variables: state.contents.variables as unknown as ConsentConfigInput["variables"],
    textBlob: collectTextBlob(state.contents),
    usageContexts: (state.container?.usageContext ?? []).map((u) =>
      u.toLowerCase(),
    ),
  };
}

function toConsentRuntimeInput(
  rt: RuntimeState | null,
): ConsentRuntimeInput | null {
  if (!rt?.ok) return null;
  const pages: ConsentRuntimePage[] = rt.pages.map((p) => ({
    requestedUrl: p.requestedUrl,
    finalUrl: p.finalUrl,
    consentState: p.consentState,
    consoleErrors: p.consoleErrors,
    pageErrors: p.pageErrors,
    trackerHits: (p.trackerHits ?? []) as unknown as ConsentRuntimeHit[],
    dataLayerEvents: p.dataLayerEvents,
    dataLayerKeys: p.dataLayerKeys,
    consentEvents: p.consentEvents,
    cookies: p.cookies,
    firstMeasurementTMs: p.firstMeasurementTMs,
  }));
  return { capturedAt: rt.capturedAt, pages, states: rt.states, ok: true };
}

function findingLayer(
  f: ConsentFinding,
): "config" | "runtime" | "reconcile" {
  const hasConfig = f.sources.includes("CONFIG");
  const hasRuntime = f.sources.includes("RUNTIME");
  if (hasConfig && hasRuntime) return "reconcile";
  if (hasRuntime) return "runtime";
  return "config";
}

function buildResponse(
  state: ConsentAuditState,
  result: ConsentAuditResult,
  opts: { containerId: string; containerPublicId?: string },
): ConsentAuditResponse {
  const severityCounts: Record<ConsentFinding["severity"], number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const findings: ConsentAuditResponseFinding[] = result.findings.map((f) => {
    severityCounts[f.severity] += 1;
    return {
      id: fid(`consent:${f.id}`),
      severity: f.severity,
      confidence: f.confidence,
      sources: f.sources,
      finding: f.finding,
      whyItMatters: f.whyItMatters,
      suggestedFix: f.suggestedFix,
      businessImpact: f.businessImpact,
      effort: f.effort,
      needsManualReview: f.needsManualReview,
      parameter: f.parameter,
      entity: f.entity,
      affected: f.affected,
      evidence: f.evidence,
      layer: findingLayer(f),
    };
  });

  return {
    containerId: opts.containerId,
    containerPublicId: opts.containerPublicId,
    containerType: (state.container?.usageContext ?? []).join(", ") || undefined,
    generatedAt: new Date().toISOString(),
    coverage: result.coverage,
    runtimeStates: result.runtimeStates,
    stateCoverage: result.stateCoverage,
    counts: {
      tags: state.contents.tags.length,
      triggers: state.contents.triggers.length,
      variables: state.contents.variables.length,
    },
    findingCount: result.findings.length,
    severityCounts,
    findings,
    toolFailures: state.toolFailures.length ? state.toolFailures : undefined,
  };
}

function fid(seed: string): string {
  return (
    "f_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)
  );
}

// ════════════════════════════════════════════════════════════════════════════
// GTM reads (read-only)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetch one workspace list (tags/triggers/variables). On a 401/403 the caller
 * has no read access to this container, so we rethrow to abort the whole run
 * (sendGtmError turns it into a precise unauthorized/forbidden response). Any
 * other failure is recorded in `toolFailures` and yields an empty list so the
 * remaining sources can still be audited.
 */
async function pullList<T>(
  token: string,
  path: string,
  itemKey: string,
  resource: string,
  toolFailures: ConsentToolFailure[],
): Promise<T[]> {
  try {
    const data = await gtmFetch<Record<string, T[] | undefined>>(token, path);
    return data[itemKey] ?? [];
  } catch (e) {
    if (e instanceof GtmApiError && (e.status === 401 || e.status === 403)) {
      throw e;
    }
    toolFailures.push({
      resource,
      message: e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
    return [];
  }
}

async function pullConsentState(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<ConsentAuditState> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const containerBase = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}`;
  const toolFailures: ConsentToolFailure[] = [];

  // Workspace contents. Each list is fetched independently so one transient or
  // 404 list failure degrades to a partial audit (reported via toolFailures)
  // instead of blanking the whole run. Auth/permission failures (401/403) are
  // fatal — they mean the caller can't read this container at all, so we throw
  // and let sendGtmError surface a precise unauthorized/forbidden response
  // rather than a misleading "0 findings" result.
  const [tagsRes, triggersRes, variablesRes] = await Promise.all([
    pullList<GtmTag>(token, `${base}/tags`, "tag", "tags", toolFailures),
    pullList<GtmTrigger>(token, `${base}/triggers`, "trigger", "triggers", toolFailures),
    pullList<GtmVariable>(token, `${base}/variables`, "variable", "variables", toolFailures),
  ]);

  const contents: WorkspaceContents = {
    tags: tagsRes,
    triggers: triggersRes,
    variables: variablesRes,
  };

  // Container metadata (for usageContext / type). Best-effort.
  let container: GtmContainer | null = null;
  try {
    container = await gtmFetch<GtmContainer>(token, containerBase);
  } catch (e) {
    toolFailures.push({
      resource: "container",
      message: e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  }

  return { contents, container, toolFailures };
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime capture parsing (RUNTIME source) — mirrors /api/gtm/audit.
// ════════════════════════════════════════════════════════════════════════════

function parseRuntimeCapture(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const normalizePage = (p: Record<string, unknown>): RuntimePageCapture => {
    const hits = Array.isArray(p.trackerHits)
      ? (p.trackerHits as Record<string, unknown>[]).map((h) => {
          const matched = Array.isArray(h.matched)
            ? (h.matched as unknown[]).filter(
                (m): m is string => typeof m === "string",
              )
            : [];
          const groups = Array.isArray(h.groups)
            ? (h.groups as unknown[]).filter(
                (g): g is string => typeof g === "string",
              )
            : matched
                .map((id) =>
                  id.includes("ga4") ||
                  id.includes("collect") ||
                  id === "ua_collect"
                    ? "ga4"
                    : id.includes("meta")
                      ? "meta"
                      : id,
                )
                .filter(Boolean);
          const query =
            h.query && typeof h.query === "object" && !Array.isArray(h.query)
              ? Object.fromEntries(
                  Object.entries(h.query as Record<string, unknown>)
                    .filter(([, v]) => typeof v === "string")
                    .map(([k, v]) => [k, v as string]),
                )
              : undefined;
          return {
            url: typeof h.url === "string" ? h.url : undefined,
            method: typeof h.method === "string" ? h.method : undefined,
            matched,
            groups,
            query,
            tMs: typeof h.tMs === "number" ? h.tMs : undefined,
          };
        })
      : [];
    const strArr = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const consentEvents: RuntimeConsentEvent[] = Array.isArray(p.consentEvents)
      ? (p.consentEvents as Record<string, unknown>[]).map((e) => {
          const fields =
            e.fields && typeof e.fields === "object" && !Array.isArray(e.fields)
              ? (Object.fromEntries(
                  Object.entries(e.fields as Record<string, unknown>).filter(
                    ([, v]) => v === "granted" || v === "denied",
                  ),
                ) as RuntimeConsentEvent["fields"])
              : undefined;
          return {
            kind: typeof e.kind === "string" ? e.kind : undefined,
            tMs: typeof e.tMs === "number" ? e.tMs : undefined,
            fields,
          };
        })
      : [];
    const cookies: RuntimeCookie[] = Array.isArray(p.cookies)
      ? (p.cookies as unknown[]).map((c) => {
          if (typeof c === "string") return { name: c };
          const cobj = (c ?? {}) as Record<string, unknown>;
          return {
            name: typeof cobj.name === "string" ? cobj.name : undefined,
            tMs: typeof cobj.tMs === "number" ? cobj.tMs : undefined,
          };
        })
      : [];
    return {
      requestedUrl:
        typeof p.requestedUrl === "string" ? p.requestedUrl : undefined,
      finalUrl: typeof p.finalUrl === "string" ? p.finalUrl : null,
      consentState:
        typeof p.consentState === "string" ? p.consentState : undefined,
      consoleErrors: strArr(p.consoleErrors),
      pageErrors: strArr(p.pageErrors),
      trackerHits: hits,
      dataLayerEvents: strArr(p.dataLayerEvents),
      dataLayerKeys: strArr(p.dataLayerKeys),
      consentEvents,
      cookies,
      firstMeasurementTMs:
        typeof p.firstMeasurementTMs === "number"
          ? p.firstMeasurementTMs
          : undefined,
    };
  };

  let pages: RuntimePageCapture[] = [];
  if (Array.isArray(obj.states)) {
    // v3 grouped-by-state artifact: states: [{ state, pages: [...] }, ...].
    for (const block of obj.states as Record<string, unknown>[]) {
      const stateLabel =
        typeof block.state === "string" ? block.state : undefined;
      const blockPages = Array.isArray(block.pages)
        ? (block.pages as Record<string, unknown>[])
        : [];
      for (const p of blockPages) {
        const np = normalizePage(p);
        if (!np.consentState && stateLabel) np.consentState = stateLabel;
        pages.push(np);
      }
    }
  } else if (Array.isArray(obj.pages)) {
    pages = (obj.pages as Record<string, unknown>[]).map(normalizePage);
    const topState =
      typeof obj.declaredConsentState === "string"
        ? (obj.declaredConsentState as string)
        : typeof obj.consentStateLabel === "string"
          ? (obj.consentStateLabel as string)
          : undefined;
    if (topState) {
      for (const p of pages) if (!p.consentState) p.consentState = topState;
    }
  } else if (typeof obj.requestedUrl === "string" || obj.trackerHits) {
    const single = normalizePage(obj);
    if (
      (single.dataLayerEvents ?? []).length === 0 &&
      Array.isArray(obj.dataLayerAfter)
    ) {
      const evs: string[] = [];
      for (const entry of obj.dataLayerAfter as unknown[]) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const ev = (entry as Record<string, unknown>).event;
          if (typeof ev === "string") evs.push(ev);
        }
      }
      single.dataLayerEvents = evs;
    }
    pages = [single];
  }

  if (pages.length === 0) return null;
  const states = Array.from(
    new Set(
      pages
        .map((p) => p.consentState)
        .filter(
          (s): s is ConsentStateLabel => typeof s === "string" && s.length > 0,
        ),
    ),
  );
  return {
    capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : undefined,
    pages,
    states,
    ok: true,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HTTP + session helpers (inlined, mirrors /api/gtm/audit — Vercel-safe).
// ════════════════════════════════════════════════════════════════════════════

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const maybeParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (maybeParsed !== undefined && maybeParsed !== null) {
    if (typeof maybeParsed === "string") {
      try {
        return JSON.parse(maybeParsed) as T;
      } catch {
        return {} as T;
      }
    }
    return maybeParsed as T;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  } catch {
    try {
      res.statusCode = 500;
      res.end(`{"error":"internal_error","message":"serialize_failed"}`);
    } catch {
      /* nothing else to do */
    }
  }
}

function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
}

class GtmApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GTM API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

function sendGtmError(
  res: ServerResponse,
  err: unknown,
  fallback: string,
): void {
  if (err instanceof GtmApiError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return sendJson(res, status, {
      error:
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : "gtm_api_error",
      message: err.message,
    });
  }
  console.error("[portal] consent audit error:", safeErrorName(err));
  return sendJson(res, 500, { error: "internal_error", message: fallback });
}

function resolveOAuthClient(): OAuthClientShape | null {
  const clientId =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET;
  const explicit =
    process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const publicUrl = process.env.PORTAL_PUBLIC_URL;
  const redirectUri = explicit
    ? explicit
    : publicUrl
      ? `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`
      : undefined;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const rawV = part.slice(idx + 1).trim();
    let v = rawV;
    try {
      v = decodeURIComponent(rawV);
    } catch {
      v = rawV;
    }
    if (k) out[k] = v;
  }
  return out;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4;
  const padded = pad ? input + "=".repeat(4 - pad) : input;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signPayload(payload: string, secret: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest(),
  );
}

function safeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function decodeSessionCookie(
  value: string | undefined,
  secret: string,
): SessionTokensShape | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, body, sig] = parts;
  if (version !== COOKIE_VERSION) return null;
  let expected: string;
  try {
    expected = signPayload(`${version}.${body}`, secret);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = base64UrlDecode(body).toString("utf8");
    const parsed = JSON.parse(json) as Partial<SessionTokensShape> | null;
    if (!parsed || typeof parsed.accessToken !== "string") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken:
        typeof parsed.refreshToken === "string"
          ? parsed.refreshToken
          : undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
    };
  } catch {
    return null;
  }
}

function encodeSessionCookie(
  tokens: SessionTokensShape,
  secret: string,
): string {
  const payload = `${COOKIE_VERSION}.${base64UrlEncode(JSON.stringify(tokens))}`;
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

function setSessionCookie(res: ServerResponse, value: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    parts.push("Secure");
  }
  const existing = res.getHeader("Set-Cookie");
  const next = parts.join("; ");
  if (!existing) res.setHeader("Set-Cookie", next);
  else if (Array.isArray(existing))
    res.setHeader("Set-Cookie", [...existing, next]);
  else res.setHeader("Set-Cookie", [String(existing), next]);
}

async function refreshAccessToken(
  client: OAuthClientShape,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${text}`);
  }
  const data = (await r.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

async function getValidAccessToken(
  req: IncomingMessage,
  res: ServerResponse,
  client: OAuthClientShape,
  secret: string,
): Promise<string | null> {
  const cookies = parseCookies(req.headers?.cookie);
  const tokens = decodeSessionCookie(cookies[SESSION_COOKIE], secret);
  if (!tokens) return null;
  if (tokens.accessToken && Date.now() < tokens.expiresAt) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) return null;
  try {
    const { accessToken, expiresAt } = await refreshAccessToken(
      client,
      tokens.refreshToken,
    );
    const updated: SessionTokensShape = { ...tokens, accessToken, expiresAt };
    setSessionCookie(res, encodeSessionCookie(updated, secret));
    return accessToken;
  } catch {
    return null;
  }
}

async function gtmFetch<T>(accessToken: string, path: string): Promise<T> {
  const r = await fetch(
    `https://tagmanager.googleapis.com/tagmanager/v2${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new GtmApiError(r.status, text);
  }
  return (await r.json()) as T;
}
