/**
 * Stateless encrypted-cookie session store for the portal.
 *
 * In a serverless environment (Vercel) we cannot rely on a process-local
 * `Map<sid, tokens>` because consecutive requests may land on different
 * function instances. Instead we put the OAuth tokens themselves into the
 * session cookie, sealed with AES-256-GCM under a key derived (HKDF-SHA256)
 * from PORTAL_SESSION_SECRET: the browser can neither read nor tamper with
 * them, so a leaked cookie value does not expose the Google tokens.
 *
 * The sealed payload carries `iat` (sign-in time). Decoding rejects a session
 * older than SESSION_MAX_AGE_MS (30 days) on the server, and refreshing the
 * access token keeps the original `iat`, so a copied cookie cannot be replayed
 * or extended indefinitely.
 *
 * Wire format: `v1e.<base64url(iv[12] | ciphertext | tag[16])>`, AAD = "v1e".
 * Every inlined copy under api/** must stay byte-compatible with this file.
 * The older signed-only `v1` format is rejected, so those users sign in again
 * once. The cookie is HttpOnly + SameSite=Lax + Secure in production.
 */

import crypto from "node:crypto";
import { isSessionFresh, type SessionTokens } from "./oauth";

/** OAuth `state` cookie format (HMAC-signed, 10-minute expiry). */
const COOKIE_VERSION = "v1";
/** Session cookie format: encrypted token-bearing cookie (supersedes `v1`). */
const SESSION_COOKIE_VERSION = "v1e";
const SESSION_KEY_SALT = "samarth-portal-session";
const SESSION_KEY_INFO = "samarth_portal_sid v1e aes-256-gcm";

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

function sessionCookieKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", secret, SESSION_KEY_SALT, SESSION_KEY_INFO, 32),
  );
}

function sealSessionPayload(payload: object, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionCookieKey(secret), iv, {
    authTagLength: 16,
  });
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

export function encodeSessionCookie(tokens: SessionTokens): string {
  const payload: SessionTokens = {
    ...tokens,
    iat: typeof tokens.iat === "number" ? tokens.iat : Date.now(),
  };
  return sealSessionPayload(payload, getSecret());
}

export function decodeSessionCookie(value: string | undefined): SessionTokens | null {
  if (!value) return null;
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const tokens = openSessionPayload(value, secret) as SessionTokens | null;
  if (!tokens || typeof tokens !== "object" || typeof tokens.accessToken !== "string") {
    return null;
  }
  if (!isSessionFresh(tokens.iat)) return null;
  return tokens;
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
