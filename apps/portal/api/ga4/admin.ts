import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/ga4/admin
 *
 * Read-only GA4 Admin API proxy for the browser portal. A single
 * action-dispatched POST endpoint keeps Vercel bundling simple: this is one
 * serverless function with no imports outside of `node:*` (the session-cookie
 * helpers are inlined to mirror /api/gtm/accounts and avoid
 * FUNCTION_INVOCATION_FAILED at module-evaluation time).
 *
 * It calls the public REST surface of the Google Analytics Admin API
 * (analyticsadmin.googleapis.com v1beta, plus v1alpha only for enhanced
 * measurement) using the user's OAuth access token from the signed session
 * cookie. The `analytics.readonly` scope is required; when it is missing Google
 * returns 403 and we surface a clear "reconnect Google" hint.
 *
 * Hard rules:
 * - ONLY list/get calls. No create/update/delete. No `confirm`. Nothing in GA4
 *   is ever mutated.
 * - Never fabricate coverage: if a call fails, the error is returned verbatim
 *   (sanitised) so the audit can mark the area Partial / Not Covered.
 *
 * Request body: { action: string, ...params }
 * Supported actions:
 *   - "account_summaries"            → accounts + property summaries
 *   - "data_streams"   { propertyId }
 *   - "custom_dimensions" { propertyId }
 *   - "custom_metrics" { propertyId }
 *   - "data_retention" { propertyId }
 *   - "google_ads_links" { propertyId }
 *   - "key_events"     { propertyId }
 *   - "enhanced_measurement" { propertyId, dataStreamId }
 */

const COOKIE_VERSION = "v1";
const SESSION_COOKIE = "samarth_portal_sid";
const GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const ADMIN_V1BETA = "https://analyticsadmin.googleapis.com/v1beta";
const ADMIN_V1ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

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

interface AdminRequestBody {
  action?: string;
  propertyId?: string;
  dataStreamId?: string;
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

    const session = readSession(req, secret);
    if (!session) return sendJson(res, 401, { error: "not_connected" });

    // Require the GA4 read scope before making any network call. If the user
    // connected before GA4_ADMIN coverage shipped, their session lacks this
    // scope and they must reconnect Google to grant it.
    if (!hasGa4Scope(session)) {
      return sendJson(res, 403, {
        error: "ga4_scope_missing",
        message:
          "GA4 Admin access requires the Google Analytics read-only scope. Reconnect Google to grant analytics.readonly, then retry.",
        reconnect: true,
      });
    }

    const token = await getValidAccessToken(req, res, client, secret, session);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    const body = await readJsonBody<AdminRequestBody>(req);
    const action = (body.action ?? "").trim();
    if (!action) {
      return sendJson(res, 400, {
        error: "missing_action",
        message: "An `action` is required.",
      });
    }

    try {
      const result = await dispatch(token, action, body);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendGa4Error(res, e, "GA4 Admin request failed");
    }
  } catch (e) {
    console.error("[portal] /api/ga4/admin: unrecoverable error:", safeErrorName(e));
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/ga4/admin handler failed",
      detail: safeErrorName(e),
    });
  }
}

// ── GA4 Admin types (subset we use) ──────────────────────────────────────

interface Ga4PropertySummary {
  property?: string; // "properties/123"
  displayName?: string;
  propertyType?: string;
  parent?: string;
}
interface Ga4AccountSummary {
  account?: string; // "accounts/456"
  displayName?: string;
  propertySummaries?: Ga4PropertySummary[];
}
interface Ga4DataStream {
  name?: string; // "properties/123/dataStreams/456"
  type?: string; // WEB_DATA_STREAM | ANDROID_APP_DATA_STREAM | IOS_APP_DATA_STREAM
  displayName?: string;
  webStreamData?: { measurementId?: string; defaultUri?: string };
  androidAppStreamData?: { packageName?: string };
  iosAppStreamData?: { bundleId?: string };
}
interface Ga4CustomDimension {
  name?: string;
  parameterName?: string;
  displayName?: string;
  scope?: string;
}
interface Ga4CustomMetric {
  name?: string;
  parameterName?: string;
  displayName?: string;
  measurementUnit?: string;
  scope?: string;
}
interface Ga4DataRetention {
  name?: string;
  eventDataRetention?: string;
  resetUserDataOnNewActivity?: boolean;
}
interface Ga4GoogleAdsLink {
  name?: string;
  customerId?: string;
  adsPersonalizationEnabled?: boolean;
  canManageClients?: boolean;
}
interface Ga4KeyEvent {
  name?: string;
  eventName?: string;
  countingMethod?: string;
  deletable?: boolean;
}
interface Ga4EnhancedMeasurement {
  name?: string;
  streamEnabled?: boolean;
  scrollsEnabled?: boolean;
  outboundClicksEnabled?: boolean;
  siteSearchEnabled?: boolean;
  videoEngagementEnabled?: boolean;
  fileDownloadsEnabled?: boolean;
  pageChangesEnabled?: boolean;
  formInteractionsEnabled?: boolean;
}

// ── Action dispatch ──────────────────────────────────────────────────────

async function dispatch(
  token: string,
  action: string,
  body: AdminRequestBody,
): Promise<unknown> {
  switch (action) {
    case "account_summaries": {
      const items = await listAll<Ga4AccountSummary>(
        token,
        `${ADMIN_V1BETA}/accountSummaries`,
        "accountSummaries",
      );
      // Flatten into a property-centric list the portal can render directly.
      const properties: {
        propertyId: string;
        displayName: string;
        accountName: string;
        accountId: string;
      }[] = [];
      for (const acc of items) {
        const accountId = (acc.account ?? "").replace(/^accounts\//, "");
        for (const p of acc.propertySummaries ?? []) {
          const propertyId = (p.property ?? "").replace(/^properties\//, "");
          if (!propertyId) continue;
          properties.push({
            propertyId,
            displayName: p.displayName ?? propertyId,
            accountName: acc.displayName ?? accountId,
            accountId,
          });
        }
      }
      return { accountSummaries: items, properties };
    }
    case "data_streams": {
      const property = requireProperty(body);
      const items = await listAll<Ga4DataStream>(
        token,
        `${ADMIN_V1BETA}/${property}/dataStreams`,
        "dataStreams",
      );
      return { dataStreams: items };
    }
    case "custom_dimensions": {
      const property = requireProperty(body);
      const items = await listAll<Ga4CustomDimension>(
        token,
        `${ADMIN_V1BETA}/${property}/customDimensions`,
        "customDimensions",
      );
      return { customDimensions: items };
    }
    case "custom_metrics": {
      const property = requireProperty(body);
      const items = await listAll<Ga4CustomMetric>(
        token,
        `${ADMIN_V1BETA}/${property}/customMetrics`,
        "customMetrics",
      );
      return { customMetrics: items };
    }
    case "data_retention": {
      const property = requireProperty(body);
      const data = await ga4Fetch<Ga4DataRetention>(
        token,
        `${ADMIN_V1BETA}/${property}/dataRetentionSettings`,
      );
      return { dataRetention: data };
    }
    case "google_ads_links": {
      const property = requireProperty(body);
      const items = await listAll<Ga4GoogleAdsLink>(
        token,
        `${ADMIN_V1BETA}/${property}/googleAdsLinks`,
        "googleAdsLinks",
      );
      return { googleAdsLinks: items };
    }
    case "key_events": {
      const property = requireProperty(body);
      const items = await listAll<Ga4KeyEvent>(
        token,
        `${ADMIN_V1BETA}/${property}/keyEvents`,
        "keyEvents",
      );
      return { keyEvents: items };
    }
    case "enhanced_measurement": {
      const property = requireProperty(body);
      const streamId = (body.dataStreamId ?? "").trim();
      if (!streamId) {
        throw new Ga4ApiError(400, "dataStreamId is required for enhanced_measurement.");
      }
      const streamSuffix = streamId.startsWith("dataStreams/")
        ? streamId
        : `dataStreams/${streamId}`;
      const data = await ga4Fetch<Ga4EnhancedMeasurement>(
        token,
        `${ADMIN_V1ALPHA}/${property}/${streamSuffix}/enhancedMeasurementSettings`,
      );
      return { enhancedMeasurement: data };
    }
    default:
      throw new Ga4ApiError(400, `Unknown action "${action}".`);
  }
}

function requireProperty(body: AdminRequestBody): string {
  const raw = (body.propertyId ?? "").trim();
  if (!raw) throw new Ga4ApiError(400, "propertyId is required for this action.");
  return raw.startsWith("properties/") ? raw : `properties/${raw}`;
}

// ── GA4 Admin REST fetch ─────────────────────────────────────────────────

class Ga4ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GA4 Admin API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

async function ga4Fetch<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Ga4ApiError(r.status, text);
  }
  return (await r.json()) as T;
}

/**
 * Paginated list helper. Caps at 10 pages to stay well inside the serverless
 * time budget; GA4 admin collections are small in practice.
 */
async function listAll<T>(
  token: string,
  baseUrl: string,
  field: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await ga4Fetch<Record<string, unknown>>(token, url.toString());
    const items = (data[field] as T[] | undefined) ?? [];
    out.push(...items);
    const next = data.nextPageToken;
    if (typeof next === "string" && next) pageToken = next;
    else break;
  }
  return out;
}

function sendGa4Error(res: ServerResponse, err: unknown, fallback: string): void {
  if (err instanceof Ga4ApiError) {
    const scopeIssue =
      err.status === 403 ||
      /insufficient|permission_denied|permission denied|scope|access_token_scope_insufficient/i.test(
        err.body,
      );
    if (err.status === 401) {
      return sendJson(res, 401, { error: "unauthorized", message: err.message });
    }
    if (scopeIssue) {
      return sendJson(res, 403, {
        error: "ga4_scope_missing",
        message:
          "GA4 Admin denied access. This usually means the analytics.readonly scope is missing or the account lacks GA4 access. Reconnect Google to grant the scope.",
        reconnect: true,
        detail: err.message,
      });
    }
    if (err.status === 400 || err.status === 404) {
      return sendJson(res, err.status, {
        error: err.status === 404 ? "not_found" : "bad_request",
        message: err.message,
      });
    }
    return sendJson(res, 502, { error: "ga4_api_error", message: err.message });
  }
  console.error("[portal] GA4 error:", safeErrorName(err));
  return sendJson(res, 500, { error: "internal_error", message: fallback });
}

// ── Shared helpers (inlined; keep in sync with other GTM/GA4 routes) ──────

function hasGa4Scope(session: SessionTokensShape): boolean {
  const scopes = session.scopes ?? [];
  // If scopes are unknown (older session), let the live call decide — Google
  // will 403 and we surface the reconnect hint.
  if (scopes.length === 0) return true;
  return scopes.includes(GA4_READONLY_SCOPE);
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
        typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
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

function readSession(
  req: IncomingMessage,
  secret: string,
): SessionTokensShape | null {
  const cookies = parseCookies(req.headers?.cookie);
  return decodeSessionCookie(cookies[SESSION_COOKIE], secret);
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
  tokens: SessionTokensShape,
): Promise<string | null> {
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
  // Cap the buffered body so an oversized (or malicious) upload cannot exhaust
  // the serverless function's memory. GA4 admin bodies are tiny; reject well
  // before Buffer.concat materializes anything unreasonable.
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
