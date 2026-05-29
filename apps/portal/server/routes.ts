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
  fetchWorkspaceContents,
  GtmApiError,
  listAccounts,
  listContainers,
  listWorkspaces,
} from "./gtm/api";
import { runAudit } from "./gtm/audit";

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

    const body = (req.body ?? {}) as {
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
      containerPublicId?: string;
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

  // Suppress unused-var warning while keeping the storage import wired
  void storage;
  return httpServer;
}

function renderConfigError(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Samarth Portal — Setup required</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#1a1a1a;line-height:1.55}h1{font-size:20px;margin-bottom:8px}p{color:#444}.box{border:1px solid #eee;border-radius:12px;padding:20px;background:#fafafa}a{color:#1e6feb}</style>
</head><body><div class="box"><h1>Samarth GTM Portal — setup required</h1><p>${safe}</p><p><a href="/">Back to portal</a></p></div></body></html>`;
}
