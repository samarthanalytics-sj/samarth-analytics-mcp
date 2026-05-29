/**
 * Self-contained portal session helpers for Vercel serverless routes.
 *
 * This file deliberately avoids importing from `apps/portal/server/**`. Vercel's
 * `@vercel/node` bundler scopes serverless functions to the `api/` tree, and
 * we previously saw `FUNCTION_INVOCATION_FAILED` (module-evaluation crash) on
 * routes that imported deeply nested helpers from `server/gtm/*`. Keeping
 * runtime-critical helpers inside `api/_lib` (the `_lib` prefix is excluded
 * from route generation) avoids that whole class of failure.
 *
 * Only `node:crypto` and `node:http` are used — no third-party imports, no
 * top-level side effects.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

export const SESSION_COOKIE = "samarth_portal_sid";
export const OAUTH_STATE_COOKIE = "samarth_portal_oauth_state";
const COOKIE_VERSION = "v1";

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch */
  expiresAt: number;
  email?: string;
  scopes: string[];
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ── Env / config ─────────────────────────────────────────────────────────

export function getSessionSecret(): string {
  return (
    process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? ""
  );
}

export function hasSessionSecret(): boolean {
  return getSessionSecret().length >= 16;
}

export function ensureSessionSecret(): string | null {
  if (!hasSessionSecret()) {
    return "PORTAL_SESSION_SECRET must be set on Vercel to a 32+ character random value. Generate one with `openssl rand -hex 32`.";
  }
  return null;
}

export function resolvePortalOAuthClient(): OAuthClientConfig | null {
  const clientId =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET;
  const explicitRedirect =
    process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const publicUrl = process.env.PORTAL_PUBLIC_URL;
  const redirectUri = explicitRedirect
    ? explicitRedirect
    : publicUrl
      ? `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`
      : undefined;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

// ── Cookie utilities ─────────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Record<string, string> {
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

// ── Signed cookie crypto ─────────────────────────────────────────────────

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

export function encodeSessionCookie(tokens: SessionTokens): string {
  const secret = getSessionSecret();
  const payload = `${COOKIE_VERSION}.${base64UrlEncode(JSON.stringify(tokens))}`;
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

export function decodeSessionCookie(value: string | undefined): SessionTokens | null {
  if (!value) return null;
  const secret = getSessionSecret();
  if (!secret) return null;
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
    const tokens = JSON.parse(json) as Partial<SessionTokens> | null;
    if (!tokens || typeof tokens.accessToken !== "string") return null;
    return {
      accessToken: tokens.accessToken,
      refreshToken:
        typeof tokens.refreshToken === "string" ? tokens.refreshToken : undefined,
      expiresAt: typeof tokens.expiresAt === "number" ? tokens.expiresAt : 0,
      email: typeof tokens.email === "string" ? tokens.email : undefined,
      scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [],
    };
  } catch {
    return null;
  }
}

// ── Token refresh ────────────────────────────────────────────────────────

export async function refreshAccessToken(
  client: OAuthClientConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

export async function getValidAccessTokenFromCookie(
  req: IncomingMessage,
  res: ServerResponse,
  client: OAuthClientConfig,
): Promise<string | null> {
  const cookies = parseCookies(req.headers?.cookie);
  const raw = cookies[SESSION_COOKIE];
  const tokens = decodeSessionCookie(raw);
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

// ── JSON / error helpers ────────────────────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  } catch (e) {
    try {
      res.statusCode = 500;
      res.end(`{"error":"internal_error","message":"failed to serialize response"}`);
    } catch {
      // give up — nothing else we can do
    }
  }
}

export class GtmApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GTM API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export function sendGtmError(
  res: ServerResponse,
  err: unknown,
  fallback = "GTM API request failed",
): void {
  if (err instanceof GtmApiError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return sendJson(res, status, {
      error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "gtm_api_error",
      message: err.message,
    });
  }
  console.error("[portal] GTM error:", safeErrorName(err));
  return sendJson(res, 500, { error: "internal_error", message: fallback });
}

export function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
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
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}

// ── Thin GTM API client (raw fetch) ──────────────────────────────────────

const GTM_BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

async function gtmFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GTM_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GtmApiError(res.status, text);
  }
  return (await res.json()) as T;
}

export interface GtmAccount {
  path?: string;
  accountId: string;
  name?: string;
}

export interface GtmContainer {
  path?: string;
  accountId: string;
  containerId: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
  domainName?: string[];
}

export interface GtmWorkspace {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  name?: string;
  description?: string;
}

export async function listAccounts(token: string): Promise<GtmAccount[]> {
  const data = await gtmFetch<{ account?: GtmAccount[] }>(token, `/accounts`);
  return data.account ?? [];
}

export async function listContainers(
  token: string,
  accountId: string,
): Promise<GtmContainer[]> {
  const data = await gtmFetch<{ container?: GtmContainer[] }>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/containers`,
  );
  return data.container ?? [];
}

export async function listWorkspaces(
  token: string,
  accountId: string,
  containerId: string,
): Promise<GtmWorkspace[]> {
  const data = await gtmFetch<{ workspace?: GtmWorkspace[] }>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
      containerId,
    )}/workspaces`,
  );
  return data.workspace ?? [];
}

export interface WorkspaceContentsShape {
  tags: unknown[];
  triggers: unknown[];
  variables: unknown[];
  folders: unknown[];
  builtInVariables: unknown[];
}

export async function fetchWorkspaceContents(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<WorkspaceContentsShape> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const [tagsRes, triggersRes, variablesRes, foldersRes, bivRes] = await Promise.all([
    gtmFetch<{ tag?: unknown[] }>(token, `${base}/tags`),
    gtmFetch<{ trigger?: unknown[] }>(token, `${base}/triggers`),
    gtmFetch<{ variable?: unknown[] }>(token, `${base}/variables`),
    gtmFetch<{ folder?: unknown[] }>(token, `${base}/folders`),
    gtmFetch<{ builtInVariable?: unknown[] }>(token, `${base}/built_in_variables`),
  ]);
  return {
    tags: tagsRes.tag ?? [],
    triggers: triggersRes.trigger ?? [],
    variables: variablesRes.variable ?? [],
    folders: foldersRes.folder ?? [],
    builtInVariables: bivRes.builtInVariable ?? [],
  };
}
