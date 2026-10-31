import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/oauth/logout
 *
 * Self-contained Vercel-safe handler. Clears the session cookie and returns
 * a small JSON body. Designed to never throw on a normal request.
 *
 * On a same-origin POST, which is what "Disconnect Google" sends, it can also
 * revoke the session's Google grant so a copy of the cookie taken earlier
 * stops working. Google revokes per user and Google Cloud project, so this
 * runs only when the operator has declared the portal's project its own and
 * the token proves it was issued to the portal's client. The rules are
 * explained in server/gtm/revoke.ts; this is a self-contained copy, keep them
 * in lockstep.
 */

// Session cookie `v1e`: AES-256-GCM sealed tokens + absolute lifetime. Must
// stay byte-compatible with server/gtm/session-cookie.ts and the other api/**
// copies (keep them in lockstep).
const SESSION_COOKIE_VERSION = "v1e";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SESSION_COOKIE = "samarth_portal_sid";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TIMEOUT_MS = 4_000;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let googleRevoked = false;
  if (req.method === "POST") {
    try {
      googleRevoked = await revokeSessionGrant(req);
    } catch (e) {
      console.error("[portal] oauth/logout: revocation failed:", safeErrorName(e));
    }
  }
  try {
    const parts = [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ connected: false, googleRevoked }));
  } catch (e) {
    console.error("[portal] oauth/logout: unrecoverable error:", safeErrorName(e));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ connected: false, error: "logout_failed" }));
  }
}

/** Same rule as shouldRevokeOnDisconnect() in server/gtm/revoke.ts. */
function shouldRevokeOnDisconnect(): boolean {
  if (process.env.PORTAL_REVOKE_GOOGLE_ON_DISCONNECT !== "true") return false;
  const own = process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID;
  if (!own || !process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET) return false;
  const project = googleProjectNumber(own);
  return ![
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
    process.env.SAMARTH_GOOGLE_OAUTH_CLIENT_ID,
  ].some((id) => id === own || (project !== undefined && googleProjectNumber(id) === project));
}

/** The project number a Google OAuth client ID starts with, if it has one. */
function googleProjectNumber(clientId: string | undefined): string | undefined {
  return clientId?.match(/^(\d+)-/)?.[1];
}

/** Same rule as isSameOriginPost() in server/gtm/revoke.ts. */
function isSameOriginPost(req: IncomingMessage): boolean {
  const origin = req.headers?.origin;
  if (req.method !== "POST" || typeof origin !== "string" || !origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwardedHost = req.headers["x-forwarded-host"];
  return originHost === req.headers.host || originHost === forwardedHost;
}

/** Same steps as revokeOnDisconnect() in server/gtm/revoke.ts. True when Google confirmed it. */
async function revokeSessionGrant(req: IncomingMessage): Promise<boolean> {
  if (!isSameOriginPost(req) || !shouldRevokeOnDisconnect()) return false;
  const secret = process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
  if (secret.length < 16) return false;
  const raw = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  if (!raw) return false;
  const parsed = openSessionPayload(raw, secret) as
    | { accessToken?: unknown; refreshToken?: unknown; iat?: unknown }
    | null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
    return false;
  }
  if (!isSessionFresh(parsed.iat) || typeof parsed.refreshToken !== "string") return false;
  const refreshed = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: parsed.refreshToken,
    client_id: process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  });
  if (!isOk(refreshed)) {
    console.warn(
      `[portal] oauth/logout: not revoking; the session's token did not refresh with PORTAL_GOOGLE_OAUTH_CLIENT_ID (${refreshed || "no response"})`,
    );
    return false;
  }
  const revoked = await postForm(REVOKE_URL, { token: parsed.refreshToken });
  if (!isOk(revoked)) {
    console.warn(`[portal] oauth/logout: Google did not confirm the revocation (${revoked || "no response"})`);
    return false;
  }
  return true;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** POST a form to Google. Returns the HTTP status, or 0 on a network error or timeout. */
async function postForm(url: string, form: Record<string, string>): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return 0;
  }
}

function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
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
