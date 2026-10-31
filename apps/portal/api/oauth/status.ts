import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

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

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    const sessionSecretSet = secret.length >= 16;

    const clientId =
      process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
      process.env.GOOGLE_OAUTH_CLIENT_ID ??
      process.env.GOOGLE_CLIENT_ID ??
      "";
    const clientSecret =
      process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET ??
      "";
    const explicitRedirect =
      process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      "";
    const publicUrl = process.env.PORTAL_PUBLIC_URL ?? "";
    const hasRedirect = Boolean(explicitRedirect || publicUrl);
    const configured = Boolean(clientId && clientSecret && hasRedirect);

    if (!sessionSecretSet) {
      return sendJson(res, 200, {
        connected: false,
        configured,
        sessionSecretSet: false,
        message:
          "PORTAL_SESSION_SECRET is not set (or shorter than 16 chars). Sign-in is disabled until it is configured.",
      });
    }

    if (!configured) {
      return sendJson(res, 200, {
        connected: false,
        configured: false,
        sessionSecretSet: true,
        message:
          "Google OAuth is not configured on this portal. Set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI.",
      });
    }

    let tokens: SessionTokensShape | null = null;
    try {
      tokens = readSessionTokens(req, secret);
    } catch (e) {
      console.error(
        "[portal] oauth/status: failed to read session cookie:",
        safeErrorName(e),
      );
      tokens = null;
    }

    if (!tokens) {
      return sendJson(res, 200, {
        connected: false,
        configured: true,
        sessionSecretSet: true,
      });
    }

    let expiresAtIso: string | null = null;
    try {
      if (typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)) {
        expiresAtIso = new Date(tokens.expiresAt).toISOString();
      }
    } catch {
      expiresAtIso = null;
    }

    return sendJson(res, 200, {
      connected: true,
      configured: true,
      sessionSecretSet: true,
      email: tokens.email ?? null,
      userName: tokens.userName ?? null,
      picture: tokens.picture ?? null,
      scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [],
      expiresAt: expiresAtIso,
    });
  } catch (e) {
    console.error(
      "[portal] oauth/status: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 200, {
      connected: false,
      configured: false,
      sessionSecretSet: false,
      error: "internal_error",
      message: "oauth/status handler failed",
      detail: safeErrorName(e),
    });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
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

function readSessionTokens(
  req: IncomingMessage,
  secret: string,
): SessionTokensShape | null {
  const cookieHeader = req.headers?.cookie;
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SESSION_COOKIE];
  if (!raw || typeof raw !== "string") return null;

  const parsed = openSessionPayload(raw, secret) as Partial<SessionTokensShape> | null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
    return null;
  }
  const iat = parsed.iat;
  if (!isSessionFresh(iat)) return null;
  return {
    accessToken: parsed.accessToken,
    refreshToken:
      typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
    expiresAt:
      typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
    iat,
    email: typeof parsed.email === "string" ? parsed.email : undefined,
    userName: typeof parsed.userName === "string" ? parsed.userName : undefined,
    picture: typeof parsed.picture === "string" ? parsed.picture : undefined,
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
  };
}
