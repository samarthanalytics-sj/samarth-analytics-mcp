import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

const COOKIE_VERSION = "v1";
const SESSION_COOKIE = "samarth_portal_sid";

interface SessionTokensShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
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

function signPayload(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readSessionTokens(
  req: IncomingMessage,
  secret: string,
): SessionTokensShape | null {
  const cookieHeader = req.headers?.cookie;
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SESSION_COOKIE];
  if (!raw || typeof raw !== "string") return null;

  const parts = raw.split(".");
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
        typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt:
        typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
    };
  } catch {
    return null;
  }
}
