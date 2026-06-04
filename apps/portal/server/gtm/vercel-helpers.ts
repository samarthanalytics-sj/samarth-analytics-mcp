/**
 * Helpers shared by Vercel serverless API route handlers.
 *
 * Wraps cookie parsing, signed-cookie session reads/writes, and a tiny
 * Express-compatible Request/Response surface so the handlers stay short.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  hasSessionSecret,
} from "./session-cookie";
import {
  refreshAccessToken,
  type OAuthClientConfig,
  type SessionTokens,
} from "./oauth";
import { GtmApiError } from "./api";

export const SESSION_COOKIE = "samarth_portal_sid";
export const OAUTH_STATE_COOKIE = "samarth_portal_oauth_state";

export function parseCookies(header: string | undefined): Record<string, string> {
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

function appendSetCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, value]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), value]);
  }
}

export function setSessionCookie(res: ServerResponse, tokens: SessionTokens): void {
  const encoded = encodeSessionCookie(tokens);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(encoded)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function clearSessionCookie(res: ServerResponse): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function setOAuthStateCookie(res: ServerResponse, cookie: string): void {
  const parts = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(cookie)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function clearOAuthStateCookie(res: ServerResponse): void {
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function readSessionFromCookies(
  req: IncomingMessage,
): { tokens: SessionTokens | null; cookieValue: string | undefined } {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  return { tokens: decodeSessionCookie(raw), cookieValue: raw };
}

/**
 * Get a valid access token from the signed-cookie session, refreshing if
 * needed. If the token was refreshed, we rotate the cookie too so future
 * requests pick up the new expiry.
 */
export async function getValidAccessTokenFromCookie(
  req: IncomingMessage,
  res: ServerResponse,
  client: OAuthClientConfig,
): Promise<string | null> {
  const { tokens } = readSessionFromCookies(req);
  if (!tokens) return null;
  if (tokens.accessToken && Date.now() < tokens.expiresAt) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) return null;
  try {
    const { accessToken, expiresAt } = await refreshAccessToken(client, tokens.refreshToken);
    const updated: SessionTokens = { ...tokens, accessToken, expiresAt };
    setSessionCookie(res, updated);
    return accessToken;
  } catch {
    return null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendGtmError(res: ServerResponse, err: unknown, fallback = "GTM API request failed"): void {
  if (err instanceof GtmApiError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return sendJson(res, status, {
      error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "gtm_api_error",
      message: err.message,
    });
  }
  console.error("[portal] GTM error:", err);
  return sendJson(res, 500, { error: "internal_error", message: fallback });
}

export function renderConfigError(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Samarth Portal — Setup required</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#1a1a1a;line-height:1.55}h1{font-size:20px;margin-bottom:8px}p{color:#444}.box{border:1px solid #eee;border-radius:12px;padding:20px;background:#fafafa}a{color:#1e6feb}</style>
</head><body><div class="box"><h1>Samarth GTM Portal — setup required</h1><p>${safe}</p><p><a href="/">Back to portal</a></p></div></body></html>`;
}

export function ensureSessionSecret(): string | null {
  if (!hasSessionSecret()) {
    return "PORTAL_SESSION_SECRET must be set on Vercel to a 32+ character random value. Generate one with `openssl rand -hex 32`.";
  }
  return null;
}

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
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
  // Cap the buffered body so an oversized (or malicious) upload cannot exhaust
  // the function's memory. Matches the 12 MB ceiling enforced by the inline
  // readJsonBody copies in api/** and the Express json() limit in server/index.ts.
  const MAX_BODY_BYTES = 12 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(
        `Request body exceeds the ${Math.floor(MAX_BODY_BYTES / (1024 * 1024))}MB limit.`,
      );
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}
