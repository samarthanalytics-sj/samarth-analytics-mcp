/**
 * Stateless signed-cookie session store for the portal.
 *
 * In a serverless environment (Vercel) we cannot rely on a process-local
 * `Map<sid, tokens>` because consecutive requests may land on different
 * function instances. Instead we put the OAuth tokens themselves into the
 * session cookie, signed with HMAC-SHA256 using PORTAL_SESSION_SECRET so the
 * browser cannot tamper with them.
 *
 * The cookie is HttpOnly + SameSite=Lax + Secure in production. Tokens never
 * leave the user's browser unencoded — only the access/refresh tokens that
 * the portal would otherwise hold server-side are stored, base64url-encoded
 * with an HMAC signature.
 */

import crypto from "node:crypto";
import type { SessionTokens } from "./oauth";

const COOKIE_VERSION = "v1";

function getSecret(): string {
  const secret =
    process.env.PORTAL_SESSION_SECRET ??
    process.env.SESSION_SECRET ??
    "";
  if (!secret) {
    throw new Error(
      "PORTAL_SESSION_SECRET (or SESSION_SECRET) must be set when using the signed-cookie session store.",
    );
  }
  if (secret.length < 16) {
    throw new Error(
      "PORTAL_SESSION_SECRET must be at least 16 characters. Generate one with `openssl rand -hex 32`.",
    );
  }
  return secret;
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

function sign(payload: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", getSecret()).update(payload).digest(),
  );
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function encodeSessionCookie(tokens: SessionTokens): string {
  const payload = `${COOKIE_VERSION}.${base64UrlEncode(JSON.stringify(tokens))}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function decodeSessionCookie(value: string | undefined): SessionTokens | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, body, sig] = parts;
  if (version !== COOKIE_VERSION) return null;
  let expected: string;
  try {
    expected = sign(`${version}.${body}`);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = base64UrlDecode(body).toString("utf8");
    const tokens = JSON.parse(json) as SessionTokens;
    if (!tokens || typeof tokens.accessToken !== "string") return null;
    return tokens;
  } catch {
    return null;
  }
}

export function encodeOAuthStateCookie(): { state: string; cookie: string } {
  const state = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = `${COOKIE_VERSION}.${state}.${expiresAt}`;
  const sig = sign(payload);
  return { state, cookie: `${payload}.${sig}` };
}

export function verifyOAuthStateCookie(
  cookieValue: string | undefined,
  presented: string | undefined,
): boolean {
  if (!cookieValue || !presented) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return false;
  const [version, state, expiresAt, sig] = parts;
  if (version !== COOKIE_VERSION) return false;
  let expected: string;
  try {
    expected = sign(`${version}.${state}.${expiresAt}`);
  } catch {
    return false;
  }
  if (!safeEqual(sig, expected)) return false;
  if (Number(expiresAt) < Date.now()) return false;
  return safeEqual(state, presented);
}

export function hasSessionSecret(): boolean {
  const secret = process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
  return secret.length >= 16;
}
