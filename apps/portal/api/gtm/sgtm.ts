import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/gtm/sgtm
 *
 * Read-only server-side GTM (sGTM) visibility proxy for the browser portal.
 * A single action-dispatched POST endpoint keeps Vercel bundling simple: this
 * is one serverless function with no imports outside of `node:*` (the
 * session-cookie + GTM-fetch helpers are inlined to mirror /api/gtm/audit and
 * /api/ga4/admin, avoiding FUNCTION_INVOCATION_FAILED at module-evaluation
 * time).
 *
 * It reads the server-side resources of a GTM **server** container/workspace
 * using the user's OAuth access token from the signed session cookie:
 *   - clients (with claim paths / criteria parameters where visible)
 *   - transformations
 *   - zones
 *   - templates
 *   - gtag config + (Google tag) destinations
 *
 * Hard rules:
 * - ONLY list/get calls. No create/update/delete. No `confirm`. Nothing in GTM
 *   is ever mutated.
 * - Never fabricate coverage: a server container must be confirmed before any
 *   resources are claimed, and per-resource failures are returned verbatim
 *   (sanitised) so the portal can show Partial / Not Covered rather than a
 *   false clean state.
 *
 * Request body: { action, accountId, containerId, workspaceId }
 * Supported actions:
 *   - "overview" → confirms the container is server-side and pulls every
 *     readable server resource in one round-trip, recording per-resource
 *     failures so coverage is honest.
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

interface SgtmRequestBody {
  action?: string;
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
}

// ── GTM v2 subset types ──────────────────────────────────────────────────

interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

interface GtmContainer {
  containerId?: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
}

interface GtmClient {
  clientId?: string;
  name?: string;
  type?: string;
  priority?: number;
  parameter?: GtmParameter[];
}

interface GtmTransformation {
  transformationId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
}

interface GtmZone {
  zoneId?: string;
  name?: string;
}

interface GtmTemplate {
  templateId?: string;
  name?: string;
  galleryReference?: { name?: string; host?: string };
}

interface GtmGtagConfig {
  gtagConfigId?: string;
  type?: string;
  parameter?: GtmParameter[];
}

interface GtmDestination {
  destinationId?: string;
  name?: string;
}

interface ResourceFailure {
  resource: string;
  message: string;
  status?: number;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendJson(res, 500, {
        error: "config_error",
        message: "PORTAL_SESSION_SECRET must be set on Vercel.",
      });
    }

    const client = resolveOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });

    const token = await getValidAccessToken(req, res, client, secret);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    const body = await readJsonBody<SgtmRequestBody>(req);
    const action = (body.action ?? "overview").trim();
    const accountId = (body.accountId ?? "").trim();
    const containerId = (body.containerId ?? "").trim();
    const workspaceId = (body.workspaceId ?? "").trim();
    if (!accountId || !containerId || !workspaceId) {
      return sendJson(res, 400, {
        error: "missing_params",
        message:
          "accountId, containerId and workspaceId are required. Select a server container/workspace first.",
      });
    }

    if (action !== "overview") {
      return sendJson(res, 400, {
        error: "bad_request",
        message: `Unknown action "${action}".`,
      });
    }

    try {
      const overview = await pullServerOverview(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      return sendJson(res, 200, overview);
    } catch (e) {
      return sendGtmError(res, e, "Failed to read server-side container");
    }
  } catch (e) {
    console.error(
      "[portal] /api/gtm/sgtm: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/gtm/sgtm handler failed",
      detail: safeErrorName(e),
    });
  }
}

// ── Server overview ──────────────────────────────────────────────────────

async function pullServerOverview(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<unknown> {
  const containerBase = `/accounts/${encodeURIComponent(
    accountId,
  )}/containers/${encodeURIComponent(containerId)}`;
  const base = `${containerBase}/workspaces/${encodeURIComponent(workspaceId)}`;

  // Confirm the container is server-side before claiming any sGTM resources.
  // Container metadata is required: if it cannot be read we cannot honestly
  // report server visibility, so surface the error.
  const container = await gtmFetch<GtmContainer>(token, containerBase);
  const isServer = (container.usageContext ?? []).some(
    (u) => u.toLowerCase() === "server",
  );
  if (!isServer) {
    return {
      isServer: false,
      container: {
        containerId: container.containerId,
        name: container.name,
        publicId: container.publicId,
        usageContext: container.usageContext ?? [],
      },
      message:
        "This container is not a server-side container. sGTM visibility requires selecting a server container and workspace.",
    };
  }

  const failures: ResourceFailure[] = [];
  const record = (resource: string, e: unknown) => {
    // 404 just means the resource is not supported on this container — skip it
    // silently rather than presenting it as a failure.
    if (e instanceof GtmApiError && e.status === 404) return;
    failures.push({
      resource,
      message: e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  };

  // These six reads are independent, so fetch them concurrently instead of
  // serially — turns ~6× round-trip latency into ~1× within the serverless
  // budget. Each still records its own failure (and skips 404s) so a single
  // failing resource degrades gracefully rather than failing the whole panel.
  const pull = async <T>(
    resource: string,
    path: string,
    extract: (r: never) => T[],
  ): Promise<T[]> => {
    try {
      const r = await gtmFetch<never>(token, path);
      return extract(r) ?? [];
    } catch (e) {
      record(resource, e);
      return [];
    }
  };

  const [clients, transformations, zones, templates, gtagConfig, destinations] =
    await Promise.all([
      pull<GtmClient>("clients", `${base}/clients`, (r) => (r as { client?: GtmClient[] }).client ?? []),
      pull<GtmTransformation>(
        "transformations",
        `${base}/transformations`,
        (r) => (r as { transformation?: GtmTransformation[] }).transformation ?? [],
      ),
      pull<GtmZone>("zones", `${base}/zones`, (r) => (r as { zone?: GtmZone[] }).zone ?? []),
      pull<GtmTemplate>(
        "templates",
        `${base}/templates`,
        (r) => (r as { template?: GtmTemplate[] }).template ?? [],
      ),
      pull<GtmGtagConfig>(
        "gtag_config",
        `${base}/gtag_config`,
        (r) => (r as { gtagConfig?: GtmGtagConfig[] }).gtagConfig ?? [],
      ),
      // Destinations live at the container level (linked Google tag destinations).
      pull<GtmDestination>(
        "destinations",
        `${containerBase}/destinations`,
        (r) => (r as { destination?: GtmDestination[] }).destination ?? [],
      ),
    ]);

  return {
    isServer: true,
    container: {
      containerId: container.containerId,
      name: container.name,
      publicId: container.publicId,
      usageContext: container.usageContext ?? [],
    },
    clients: clients.map((c) => ({
      clientId: c.clientId,
      name: c.name ?? "Unnamed client",
      type: c.type,
      priority: c.priority,
      claims: extractClaims(c),
    })),
    transformations: transformations.map((t) => ({
      transformationId: t.transformationId,
      name: t.name ?? "Unnamed transformation",
      type: t.type,
    })),
    zones: zones.map((z) => ({ zoneId: z.zoneId, name: z.name ?? "Unnamed zone" })),
    templates: templates.map((t) => ({
      templateId: t.templateId,
      name: t.name ?? "Unnamed template",
      gallery: t.galleryReference?.name,
    })),
    gtagConfig: gtagConfig.map((g) => ({
      gtagConfigId: g.gtagConfigId,
      type: g.type,
      tagId: paramValue(g.parameter, "tagId"),
    })),
    destinations: destinations.map((d) => ({
      destinationId: d.destinationId,
      name: d.name,
    })),
    failures,
    // Capability is true only when the container is server AND we actually read
    // at least one resource without it being an empty 404 surface. A fully
    // failed read leaves the panel honest about the gap.
    ok:
      clients.length +
        transformations.length +
        zones.length +
        templates.length +
        gtagConfig.length +
        destinations.length >
        0 || failures.length === 0,
  };
}

/**
 * Extract human-readable claim paths / criteria from a client's parameters.
 * sGTM clients vary by type; we surface any string-valued params whose key
 * hints at request matching (path, criteria, activationPath, etc.) plus simple
 * scalar values, without guessing at semantics.
 */
function extractClaims(client: GtmClient): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const CLAIM_HINT =
    /path|claim|criteria|activation|prefix|priority|cookie|measurement|param/i;
  const walk = (p?: GtmParameter) => {
    if (!p) return;
    if (
      p.key &&
      typeof p.value === "string" &&
      p.value.length > 0 &&
      CLAIM_HINT.test(p.key)
    ) {
      out.push({ key: p.key, value: p.value });
    }
    for (const c of p.list ?? []) walk(c);
    for (const c of p.map ?? []) walk(c);
  };
  for (const p of client.parameter ?? []) walk(p);
  return out.slice(0, 12);
}

function paramValue(
  params: GtmParameter[] | undefined,
  key: string,
): string | undefined {
  return params?.find((p) => p.key === key)?.value;
}

// ── HTTP/transport helpers (inlined; keep in sync with other GTM routes) ──

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
  console.error("[portal] sGTM error:", safeErrorName(err));
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

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
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
  // Cap the buffered body so a huge (or malicious) upload cannot exhaust the
  // serverless function's memory. We count bytes as they stream and reject once
  // the ceiling is crossed, before Buffer.concat materializes the whole payload.
  const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MB
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
