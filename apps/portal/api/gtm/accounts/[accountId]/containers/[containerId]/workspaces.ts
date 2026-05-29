import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

/**
 * /api/gtm/accounts/[accountId]/containers/[containerId]/workspaces
 *
 * Fully self-contained — no imports outside of `node:*`. See
 * /api/gtm/accounts for the rationale.
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

interface GtmWorkspace {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  name?: string;
  description?: string;
}

type VercelRequest = IncomingMessage & {
  query?: Record<string, string | string[]>;
};

export default async function handler(
  req: VercelRequest,
  res: ServerResponse,
) {
  try {
    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendJson(res, 500, {
        error: "config_error",
        message: "PORTAL_SESSION_SECRET must be set on Vercel.",
      });
    }

    const accountId = getParam(req, "accountId");
    const containerId = getParam(req, "containerId");
    if (!accountId || !containerId) {
      return sendJson(res, 400, { error: "missing_params" });
    }

    const client = resolveOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });

    const token = await getValidAccessToken(req, res, client, secret);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    try {
      const data = await gtmFetch<{ workspace?: GtmWorkspace[] }>(
        token,
        `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
          containerId,
        )}/workspaces`,
      );
      const workspaces = data.workspace ?? [];
      return sendJson(res, 200, {
        workspaces: workspaces.map((w) => ({
          accountId: w.accountId,
          containerId: w.containerId,
          workspaceId: w.workspaceId,
          name: w.name ?? `Workspace ${w.workspaceId}`,
          description: w.description,
        })),
      });
    } catch (e) {
      return sendGtmError(res, e, "Failed to list GTM workspaces");
    }
  } catch (e) {
    console.error(
      "[portal] /api/gtm/.../workspaces: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 500, {
      error: "internal_error",
      message: "workspaces handler failed",
      detail: safeErrorName(e),
    });
  }
}

function getParam(req: VercelRequest, name: string): string | undefined {
  const fromQuery = req.query?.[name];
  if (typeof fromQuery === "string") return fromQuery;
  if (Array.isArray(fromQuery)) return fromQuery[0];
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      const v = u.searchParams.get(name);
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  return undefined;
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
  console.error("[portal] GTM error:", safeErrorName(err));
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
