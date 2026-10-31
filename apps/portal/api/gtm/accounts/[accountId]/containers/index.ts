import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

/**
 * /api/gtm/accounts/[accountId]/containers
 *
 * Fully self-contained — no imports outside of `node:*`. See
 * /api/gtm/accounts for the rationale (Vercel module-evaluation crashes
 * when GTM routes imported from `api/_lib/portal-session`).
 */

// Session cookie `v1e`: AES-256-GCM sealed tokens + absolute lifetime. Must
// stay byte-compatible with server/gtm/session-cookie.ts and the other api/**
// copies (keep them in lockstep). Sealed, not just signed, so a leaked cookie
// does not expose the Google tokens; `iat` (sign-in time) caps a session at
// SESSION_MAX_AGE_MS on the server however often the access token refreshes.
// Signed-only `v1` session cookies are rejected (those users sign in again).
const SESSION_COOKIE_VERSION = "v1e";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SESSION_COOKIE = "samarth_portal_sid";

interface SessionTokensShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /** Sign-in time (ms epoch); bounds the session to SESSION_MAX_AGE_MS. */
  iat?: number;
  email?: string;
  userName?: string;
  picture?: string;
  scopes?: string[];
}

interface OAuthClientShape {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface GtmContainer {
  path?: string;
  accountId: string;
  containerId: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
  domainName?: string[];
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
    if (!accountId) return sendJson(res, 400, { error: "missing_account_id" });

    const client = resolveOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });

    const token = await getValidAccessToken(req, res, client, secret);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    try {
      const { items: containers, truncated } = await gtmListAll<GtmContainer>(
        token,
        `/accounts/${encodeURIComponent(accountId)}/containers`,
        "container",
      );
      return sendJson(res, 200, {
        containers: containers.map((c) => ({
          accountId: c.accountId,
          containerId: c.containerId,
          publicId: c.publicId ?? c.containerId,
          name: c.name ?? c.publicId ?? c.containerId,
          usageContext: c.usageContext ?? [],
          domainName: c.domainName ?? [],
        })),
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (e) {
      return sendGtmError(res, e, "Failed to list GTM containers");
    }
  } catch (e) {
    console.error(
      "[portal] /api/gtm/.../containers: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 500, {
      error: "internal_error",
      message: "containers handler failed",
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

function sessionCookieKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      secret,
      "samarth-portal-session",
      "samarth_portal_sid v1e aes-256-gcm",
      32,
    ),
  );
}

function isSessionFresh(iat: unknown, now: number = Date.now()): iat is number {
  return (
    typeof iat === "number" &&
    Number.isFinite(iat) &&
    iat <= now + SESSION_CLOCK_SKEW_MS &&
    now - iat <= SESSION_MAX_AGE_MS
  );
}

function sealSessionPayload(payload: object, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    sessionCookieKey(secret),
    iv,
    { authTagLength: 16 },
  );
  cipher.setAAD(Buffer.from(SESSION_COOKIE_VERSION, "utf8"));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return `${SESSION_COOKIE_VERSION}.${base64UrlEncode(
    Buffer.concat([iv, body, cipher.getAuthTag()]),
  )}`;
}

function openSessionPayload(value: string, secret: string): unknown {
  const parts = value.split(".");
  if (parts.length !== 2 || parts[0] !== SESSION_COOKIE_VERSION) return null;
  try {
    const raw = base64UrlDecode(parts[1]);
    if (raw.length <= 12 + 16) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      sessionCookieKey(secret),
      raw.subarray(0, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(SESSION_COOKIE_VERSION, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeSessionCookie(
  value: string | undefined,
  secret: string,
): SessionTokensShape | null {
  if (!value) return null;
  const parsed = openSessionPayload(value, secret) as Partial<SessionTokensShape> | null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
    return null;
  }
  const iat = parsed.iat;
  if (!isSessionFresh(iat)) return null;
  return {
    accessToken: parsed.accessToken,
    refreshToken:
      typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
    iat,
    email: typeof parsed.email === "string" ? parsed.email : undefined,
    userName: typeof parsed.userName === "string" ? parsed.userName : undefined,
    picture: typeof parsed.picture === "string" ? parsed.picture : undefined,
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
  };
}

function encodeSessionCookie(
  tokens: SessionTokensShape,
  secret: string,
): string {
  return sealSessionPayload(
    { ...tokens, iat: typeof tokens.iat === "number" ? tokens.iat : Date.now() },
    secret,
  );
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

/**
 * GTM list endpoints return a `nextPageToken` when more results exist, so a
 * single call is ONE page. Follow it (bounded) so the selector never silently
 * drops items past the first page. Inlined: api/** may only import node:* at
 * module load.
 */
const GTM_LIST_MAX_PAGES = 50;

async function gtmListAll<T>(
  accessToken: string,
  path: string,
  key: string,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < GTM_LIST_MAX_PAGES; i++) {
    const data = await gtmFetch<Record<string, unknown>>(
      accessToken,
      pageToken ? `${path}?pageToken=${encodeURIComponent(pageToken)}` : path,
    );
    items.push(...((data[key] as T[] | undefined) ?? []));
    const next = data.nextPageToken;
    if (typeof next !== "string" || !next) return { items, truncated: false };
    pageToken = next;
  }
  return { items, truncated: true };
}
