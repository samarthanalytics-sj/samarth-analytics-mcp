import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  buildAuthUrl,
  clearSession,
  consumeOAuthState,
  exchangeCodeForTokens,
  getSession,
  getValidAccessToken,
  newOAuthState,
  newSessionId,
  resolvePortalOAuthClient,
  setSession,
} from "./gtm/oauth";
import {
  fetchServerOverview,
  fetchWorkspaceContents,
  GtmApiError,
  listAccounts,
  listContainers,
  listWorkspaces,
} from "./gtm/api";
import { runAudit } from "./gtm/audit";
import {
  runConsentAudit,
  type ConsentConfigInput,
  type ConsentFinding,
  type ConsentStateLabel,
  type RuntimeConsentEvent,
  type RuntimeCookie,
  type RuntimeHit,
  type RuntimeInput,
  type RuntimePage,
} from "../shared/consent-audit";

const SESSION_COOKIE = "samarth_portal_sid";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

function getSid(req: Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE];
}

function setSessionCookie(res: Response, sid: string) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: Response) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function sendGtmError(res: Response, err: unknown, fallback = "GTM API request failed") {
  if (err instanceof GtmApiError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return res.status(status).json({
      error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "gtm_api_error",
      message: err.message,
    });
  }
  console.error("[portal] GTM error:", err);
  return res.status(500).json({ error: "internal_error", message: fallback });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ── OAuth: status ──────────────────────────────────────────────────────
  app.get("/api/oauth/status", (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) {
      return res.json({
        connected: false,
        configured: false,
        message:
          "Google OAuth is not configured on this portal. Set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI (or PORTAL_PUBLIC_URL).",
      });
    }
    const sess = getSession(getSid(req));
    if (!sess) {
      return res.json({ connected: false, configured: true });
    }
    res.json({
      connected: true,
      configured: true,
      email: sess.email,
      userName: sess.userName,
      picture: sess.picture,
      scopes: sess.scopes,
      expiresAt: new Date(sess.expiresAt).toISOString(),
    });
  });

  // ── OAuth: start ──────────────────────────────────────────────────────
  app.get("/api/oauth/start", (_req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) {
      return res.status(503).send(
        renderConfigError(
          "Google OAuth is not configured on this portal. The administrator must set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI before sign-in is available.",
        ),
      );
    }
    const state = newOAuthState();
    res.redirect(buildAuthUrl(client, state));
  });

  // ── OAuth: callback ───────────────────────────────────────────────────
  app.get("/api/oauth/callback", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) {
      return res.status(503).send(renderConfigError("OAuth not configured."));
    }
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    if (error) {
      return res.status(400).send(renderConfigError(`Google returned an error: ${error}`));
    }
    if (!code || !state || !consumeOAuthState(state)) {
      return res.status(400).send(renderConfigError("Invalid or expired OAuth state."));
    }
    try {
      const tokens = await exchangeCodeForTokens(client, code);
      const sid = newSessionId();
      setSession(sid, tokens);
      setSessionCookie(res, sid);
      // Redirect back to portal home (hash router lives at "/")
      res.redirect("/#/?connected=1");
    } catch (e) {
      console.error("[portal] OAuth callback error:", e);
      res.status(500).send(renderConfigError("Failed to complete Google sign-in. Please try again."));
    }
  });

  // ── OAuth: logout ─────────────────────────────────────────────────────
  app.post("/api/oauth/logout", (req, res) => {
    clearSession(getSid(req));
    clearSessionCookie(res);
    res.json({ connected: false });
  });

  // ── GTM discovery ──────────────────────────────────────────────────────
  app.get("/api/gtm/accounts", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const token = await getValidAccessToken(getSid(req), client);
    if (!token) return res.status(401).json({ error: "not_connected" });
    try {
      const accounts = await listAccounts(token);
      res.json({
        accounts: accounts.map((a) => ({
          accountId: a.accountId,
          name: a.name ?? a.accountId,
          path: a.path,
        })),
      });
    } catch (e) {
      sendGtmError(res, e, "Failed to list GTM accounts");
    }
  });

  app.get("/api/gtm/accounts/:accountId/containers", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const token = await getValidAccessToken(getSid(req), client);
    if (!token) return res.status(401).json({ error: "not_connected" });
    try {
      const containers = await listContainers(token, req.params.accountId);
      res.json({
        containers: containers.map((c) => ({
          accountId: c.accountId,
          containerId: c.containerId,
          publicId: c.publicId ?? c.containerId,
          name: c.name ?? c.publicId ?? c.containerId,
          usageContext: c.usageContext ?? [],
          domainName: c.domainName ?? [],
        })),
      });
    } catch (e) {
      sendGtmError(res, e, "Failed to list GTM containers");
    }
  });

  app.get(
    "/api/gtm/accounts/:accountId/containers/:containerId/workspaces",
    async (req, res) => {
      const client = resolvePortalOAuthClient();
      if (!client) return res.status(503).json({ error: "oauth_not_configured" });
      const token = await getValidAccessToken(getSid(req), client);
      if (!token) return res.status(401).json({ error: "not_connected" });
      try {
        const workspaces = await listWorkspaces(
          token,
          req.params.accountId,
          req.params.containerId,
        );
        res.json({
          workspaces: workspaces.map((w) => ({
            accountId: w.accountId,
            containerId: w.containerId,
            workspaceId: w.workspaceId,
            name: w.name ?? `Workspace ${w.workspaceId}`,
            description: w.description,
          })),
        });
      } catch (e) {
        sendGtmError(res, e, "Failed to list GTM workspaces");
      }
    },
  );

  // ── Audit ──────────────────────────────────────────────────────────────
  app.post("/api/gtm/audit", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const token = await getValidAccessToken(getSid(req), client);
    if (!token) return res.status(401).json({ error: "not_connected" });

    // NOTE: this dev-server route uses the legacy CONFIG-only auditor in
    // server/gtm/audit.ts. The capability-aware engine (GA4_ADMIN / RUNTIME /
    // SGTM / DATA_API cross-source reconciliation) lives in the Vercel route
    // apps/portal/api/gtm/audit.ts. We accept the cross-source body fields here
    // so the portal UI works against `npm run dev`, but they are intentionally
    // ignored — the dev auditor never claims coverage it cannot produce.
    const body = (req.body ?? {}) as {
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
      containerPublicId?: string;
      ga4PropertyId?: string;
      runtimeCapture?: unknown;
      serverContext?: unknown;
      enableDataApi?: boolean;
    };
    const { accountId, containerId, workspaceId, containerPublicId } = body;
    if (!accountId || !containerId || !workspaceId) {
      return res.status(400).json({
        error: "missing_params",
        message: "accountId, containerId and workspaceId are required.",
      });
    }
    try {
      const contents = await fetchWorkspaceContents(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      const summary = runAudit(contents, {
        containerPublicId: containerPublicId ?? containerId,
      });
      res.json(summary);
    } catch (e) {
      sendGtmError(res, e, "Failed to run GTM audit");
    }
  });

  // ── Consent Mode v2 audit (read-only, focused) ───────────────────────────
  // Dev-server parity with the Vercel route at apps/portal/api/gtm/consent-audit.ts.
  // Reads the chosen workspace (tags/triggers/variables) and returns ONLY the
  // Consent Mode v2 output from the shared engine — no GA4/sGTM/naming findings.
  // Unlike the general audit, the consent engine is a pure import here (Express
  // has no module-evaluation crash constraint); the Vercel route lazy-imports it.
  app.post("/api/gtm/consent-audit", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const token = await getValidAccessToken(getSid(req), client);
    if (!token) return res.status(401).json({ error: "not_connected" });

    const body = (req.body ?? {}) as {
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
      containerPublicId?: string;
      runtimeCapture?: unknown;
    };
    const { accountId, containerId, workspaceId, containerPublicId } = body;
    if (!accountId || !containerId || !workspaceId) {
      return res.status(400).json({
        error: "missing_params",
        message: "accountId, containerId and workspaceId are required.",
      });
    }

    try {
      const contents = await fetchWorkspaceContents(
        token,
        accountId,
        containerId,
        workspaceId,
      );

      // Container metadata is best-effort (for usageContext / display type).
      const toolFailures: { resource: string; message: string; status?: number }[] = [];
      let usageContexts: string[] = [];
      let containerType: string | undefined;
      try {
        const containers = await listContainers(token, accountId);
        const match = containers.find((c) => c.containerId === containerId);
        usageContexts = (match?.usageContext ?? []).map((u) => u.toLowerCase());
        containerType = (match?.usageContext ?? []).join(", ") || undefined;
      } catch (e) {
        toolFailures.push({
          resource: "container",
          message: e instanceof GtmApiError ? e.message : String(e),
          status: e instanceof GtmApiError ? e.status : undefined,
        });
      }

      const runtime = parseConsentRuntimeCapture(body.runtimeCapture);
      const cfg: ConsentConfigInput = {
        tags: contents.tags as unknown as ConsentConfigInput["tags"],
        triggers: contents.triggers as unknown as ConsentConfigInput["triggers"],
        variables: contents.variables as unknown as ConsentConfigInput["variables"],
        textBlob: collectConsentTextBlob(contents),
        usageContexts,
      };
      const result = runConsentAudit(cfg, runtime);

      const severityCounts: Record<ConsentFinding["severity"], number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      };
      const findings = result.findings.map((f) => {
        severityCounts[f.severity] += 1;
        const hasConfig = f.sources.includes("CONFIG");
        const hasRuntime = f.sources.includes("RUNTIME");
        const layer =
          hasConfig && hasRuntime ? "reconcile" : hasRuntime ? "runtime" : "config";
        return {
          id: f.id,
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
          layer,
        };
      });

      res.json({
        containerId,
        containerPublicId: containerPublicId ?? containerId,
        containerType,
        generatedAt: new Date().toISOString(),
        coverage: result.coverage,
        runtimeStates: result.runtimeStates,
        stateCoverage: result.stateCoverage,
        counts: {
          tags: contents.tags.length,
          triggers: contents.triggers.length,
          variables: contents.variables.length,
        },
        findingCount: result.findings.length,
        severityCounts,
        findings,
        toolFailures: toolFailures.length ? toolFailures : undefined,
      });
    } catch (e) {
      sendGtmError(res, e, "Failed to run Consent Mode v2 audit");
    }
  });

  // ── Server-side GTM (sGTM) visibility (read-only) ────────────────────────
  // Dev-server parity with the Vercel route at apps/portal/api/gtm/sgtm.ts.
  // Only list/get calls; never mutates GTM. Action-dispatched POST.
  app.post("/api/gtm/sgtm", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const token = await getValidAccessToken(getSid(req), client);
    if (!token) return res.status(401).json({ error: "not_connected" });

    const body = (req.body ?? {}) as {
      action?: string;
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
    };
    const action = (body.action ?? "overview").trim();
    const accountId = (body.accountId ?? "").trim();
    const containerId = (body.containerId ?? "").trim();
    const workspaceId = (body.workspaceId ?? "").trim();
    if (!accountId || !containerId || !workspaceId) {
      return res.status(400).json({
        error: "missing_params",
        message:
          "accountId, containerId and workspaceId are required. Select a server container/workspace first.",
      });
    }
    if (action !== "overview") {
      return res
        .status(400)
        .json({ error: "bad_request", message: `Unknown action "${action}".` });
    }
    try {
      const overview = await fetchServerOverview(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      res.json(overview);
    } catch (e) {
      sendGtmError(res, e, "Failed to read server-side container");
    }
  });

  // ── GA4 Admin (read-only) ───────────────────────────────────────────────
  // Dev-server parity with the Vercel route at apps/portal/api/ga4/admin.ts.
  // Only list/get calls; never mutates GA4. Requires the analytics.readonly
  // scope (the OAuth flow now requests it). Action-dispatched POST.
  app.post("/api/ga4/admin", async (req, res) => {
    const client = resolvePortalOAuthClient();
    if (!client) return res.status(503).json({ error: "oauth_not_configured" });
    const sid = getSid(req);
    const sess = getSession(sid);
    if (!sess) return res.status(401).json({ error: "not_connected" });

    const GA4_READONLY = "https://www.googleapis.com/auth/analytics.readonly";
    const scopes = sess.scopes ?? [];
    if (scopes.length > 0 && !scopes.includes(GA4_READONLY)) {
      return res.status(403).json({
        error: "ga4_scope_missing",
        message:
          "GA4 Admin access requires the Google Analytics read-only scope. Reconnect Google to grant analytics.readonly, then retry.",
        reconnect: true,
      });
    }

    const token = await getValidAccessToken(sid, client);
    if (!token) return res.status(401).json({ error: "not_connected" });

    const body = (req.body ?? {}) as { action?: string; propertyId?: string };
    const action = (body.action ?? "").trim();
    const v1beta = "https://analyticsadmin.googleapis.com/v1beta";

    const ga4Get = async (url: string): Promise<unknown> => {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) {
        const text = await r.text();
        const status = r.status === 401 ? 401 : r.status === 403 ? 403 : 502;
        throw Object.assign(new Error(text.slice(0, 300)), { httpStatus: status });
      }
      return r.json();
    };

    try {
      if (action === "account_summaries") {
        const data = (await ga4Get(`${v1beta}/accountSummaries?pageSize=200`)) as {
          accountSummaries?: {
            account?: string;
            displayName?: string;
            propertySummaries?: { property?: string; displayName?: string }[];
          }[];
        };
        const properties: {
          propertyId: string;
          displayName: string;
          accountName: string;
          accountId: string;
        }[] = [];
        for (const acc of data.accountSummaries ?? []) {
          const accountId = (acc.account ?? "").replace(/^accounts\//, "");
          for (const p of acc.propertySummaries ?? []) {
            const propertyId = (p.property ?? "").replace(/^properties\//, "");
            if (!propertyId) continue;
            properties.push({
              propertyId,
              displayName: p.displayName ?? propertyId,
              accountName: acc.displayName ?? accountId,
              accountId,
            });
          }
        }
        return res.json({
          accountSummaries: data.accountSummaries ?? [],
          properties,
        });
      }
      if (action === "data_streams") {
        const propertyId = (body.propertyId ?? "").trim();
        if (!propertyId) {
          return res
            .status(400)
            .json({ error: "bad_request", message: "propertyId is required." });
        }
        const property = propertyId.startsWith("properties/")
          ? propertyId
          : `properties/${propertyId}`;
        const data = (await ga4Get(
          `${v1beta}/${property}/dataStreams?pageSize=200`,
        )) as { dataStreams?: unknown[] };
        return res.json({ dataStreams: data.dataStreams ?? [] });
      }
      return res
        .status(400)
        .json({ error: "bad_request", message: `Unknown action "${action}".` });
    } catch (e) {
      const status = (e as { httpStatus?: number }).httpStatus ?? 500;
      const message = e instanceof Error ? e.message : "GA4 Admin request failed";
      if (status === 403) {
        return res.status(403).json({
          error: "ga4_scope_missing",
          message:
            "GA4 Admin denied access. The analytics.readonly scope may be missing or the account lacks GA4 access. Reconnect Google.",
          reconnect: true,
          detail: message,
        });
      }
      return res
        .status(status === 401 ? 401 : 502)
        .json({
          error: status === 401 ? "unauthorized" : "ga4_api_error",
          message,
        });
    }
  });

  // Suppress unused-var warning while keeping the storage import wired
  void storage;
  return httpServer;
}

// ── Consent audit helpers (dev-server parity) ─────────────────────────────

function collectConsentTextBlob(c: {
  tags: { name?: string; type?: string; parameter?: unknown[] }[];
  variables: { name?: string; type?: string; parameter?: unknown[] }[];
}): string {
  const parts: string[] = [];
  const walk = (p: { key?: string; value?: string; list?: unknown[]; map?: unknown[] }): void => {
    if (p.key) parts.push(p.key);
    if (p.value) parts.push(p.value);
    for (const child of (p.list ?? []) as typeof p[]) walk(child);
    for (const child of (p.map ?? []) as typeof p[]) walk(child);
  };
  for (const t of c.tags) {
    parts.push(t.name ?? "", t.type ?? "");
    for (const p of (t.parameter ?? []) as Parameters<typeof walk>[0][]) walk(p);
  }
  for (const v of c.variables) {
    parts.push(v.name ?? "", v.type ?? "");
    for (const p of (v.parameter ?? []) as Parameters<typeof walk>[0][]) walk(p);
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Parse an uploaded runtime capture into the consent engine's RuntimeInput.
 * Returns null unless a parseable artifact with at least one page is supplied —
 * RUNTIME coverage is never fabricated.
 */
function parseConsentRuntimeCapture(raw: unknown): RuntimeInput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const normalizePage = (p: Record<string, unknown>): RuntimePage => {
    const hits: RuntimeHit[] = Array.isArray(p.trackerHits)
      ? (p.trackerHits as Record<string, unknown>[]).map((h) => {
          const matched = strArr(h.matched);
          const groups = strArr(h.groups).length
            ? strArr(h.groups)
            : matched
                .map((id) =>
                  id.includes("ga4") || id.includes("collect") || id === "ua_collect"
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
      requestedUrl: typeof p.requestedUrl === "string" ? p.requestedUrl : undefined,
      finalUrl: typeof p.finalUrl === "string" ? p.finalUrl : null,
      consentState:
        typeof p.consentState === "string"
          ? (p.consentState as ConsentStateLabel)
          : undefined,
      consoleErrors: strArr(p.consoleErrors),
      pageErrors: strArr(p.pageErrors),
      trackerHits: hits,
      dataLayerEvents: strArr(p.dataLayerEvents),
      dataLayerKeys: strArr(p.dataLayerKeys),
      consentEvents,
      cookies,
      firstMeasurementTMs:
        typeof p.firstMeasurementTMs === "number" ? p.firstMeasurementTMs : undefined,
    };
  };

  let pages: RuntimePage[] = [];
  if (Array.isArray(obj.states)) {
    for (const block of obj.states as Record<string, unknown>[]) {
      const stateLabel = typeof block.state === "string" ? block.state : undefined;
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
    if (topState) for (const p of pages) if (!p.consentState) p.consentState = topState;
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
        .filter((s): s is ConsentStateLabel => typeof s === "string" && s.length > 0),
    ),
  );
  return {
    capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : undefined,
    pages,
    states,
    ok: true,
  };
}

function renderConfigError(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Samarth Portal — Setup required</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#1a1a1a;line-height:1.55}h1{font-size:20px;margin-bottom:8px}p{color:#444}.box{border:1px solid #eee;border-radius:12px;padding:20px;background:#fafafa}a{color:#1e6feb}</style>
</head><body><div class="box"><h1>Samarth GTM Portal — setup required</h1><p>${safe}</p><p><a href="/">Back to portal</a></p></div></body></html>`;
}
