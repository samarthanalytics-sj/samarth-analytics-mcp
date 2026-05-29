import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/oauth/start
 *
 * Self-contained Vercel-safe handler. Avoids any non-trivial top-level
 * imports so module-evaluation cannot crash with FUNCTION_INVOCATION_FAILED.
 *
 * Behavior:
 *  - If PORTAL_SESSION_SECRET is missing/too short: 503 HTML setup page.
 *  - If Google OAuth env vars are missing: 503 HTML setup page.
 *  - Otherwise: sets an HMAC-signed state cookie and 302-redirects to Google.
 */

const COOKIE_VERSION = "v1";
const OAUTH_STATE_COOKIE = "samarth_portal_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

const GTM_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "openid",
  "email",
  "profile",
];

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendHtml(
        res,
        503,
        renderSetupPage(
          "PORTAL_SESSION_SECRET must be set on Vercel to a 32+ character random value. Generate one with `openssl rand -hex 32`.",
          ["PORTAL_SESSION_SECRET"],
          inferRedirectUri(req),
        ),
      );
    }

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
    const redirectUri = explicitRedirect
      ? explicitRedirect
      : publicUrl
        ? `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`
        : "";

    const missing: string[] = [];
    if (!clientId) missing.push("PORTAL_GOOGLE_OAUTH_CLIENT_ID");
    if (!clientSecret) missing.push("PORTAL_GOOGLE_OAUTH_CLIENT_SECRET");
    if (!redirectUri)
      missing.push("PORTAL_GOOGLE_OAUTH_REDIRECT_URI (or PORTAL_PUBLIC_URL)");

    if (missing.length > 0) {
      return sendHtml(
        res,
        503,
        renderSetupPage(
          "Google OAuth is not configured on this portal. The administrator must set the variables listed below in the Vercel project, then redeploy.",
          missing,
          inferRedirectUri(req),
        ),
      );
    }

    const { state, cookie } = encodeStateCookie(secret);
    setStateCookie(res, cookie);

    const authUrl = buildAuthUrl({ clientId, redirectUri }, state);
    res.statusCode = 302;
    res.setHeader("Location", authUrl);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  } catch (e) {
    console.error(
      "[portal] oauth/start: unrecoverable error:",
      safeErrorName(e),
    );
    sendHtml(
      res,
      500,
      renderSetupPage(
        "An unexpected error occurred starting the Google sign-in flow. Check the Vercel function logs for details.",
        [],
        inferRedirectUri(req),
        safeErrorName(e),
      ),
    );
  }
}

function buildAuthUrl(
  client: { clientId: string; redirectUri: string },
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GTM_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signPayload(payload: string, secret: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest(),
  );
}

function encodeStateCookie(secret: string): { state: string; cookie: string } {
  const state = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + STATE_TTL_MS;
  const payload = `${COOKIE_VERSION}.${state}.${expiresAt}`;
  const sig = signPayload(payload, secret);
  return { state, cookie: `${payload}.${sig}` };
}

function setStateCookie(res: ServerResponse, cookie: string): void {
  const parts = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(cookie)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function inferRedirectUri(req: IncomingMessage): string {
  const explicit =
    process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    "";
  if (explicit) return explicit;
  const publicUrl = process.env.PORTAL_PUBLIC_URL ?? "";
  if (publicUrl) return `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`;
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "") as string;
  const proto = ((req.headers["x-forwarded-proto"] as string) ?? "https").split(",")[0].trim();
  if (host) return `${proto}://${host}/api/oauth/callback`;
  return "<your-portal-url>/api/oauth/callback";
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
}

function renderSetupPage(
  message: string,
  missingVars: string[],
  redirectUri: string,
  detail?: string,
): string {
  const missingHtml = missingVars.length
    ? `<h2>Missing environment variables</h2><ul>${missingVars
        .map((v) => `<li><code>${escapeHtml(v)}</code></li>`)
        .join("")}</ul>`
    : "";
  const detailHtml = detail
    ? `<p><strong>Detail:</strong> <code>${escapeHtml(detail)}</code></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Samarth Portal — Setup required</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#1a1a1a;line-height:1.55}
  h1{font-size:22px;margin:0 0 12px}
  h2{font-size:16px;margin:20px 0 6px;color:#222}
  p{color:#333}
  .box{border:1px solid #e6e6e6;border-radius:12px;padding:24px;background:#fafafa}
  code{background:#f0f0f0;border-radius:4px;padding:2px 6px;font-size:13px}
  ul{padding-left:20px}
  a{color:#1e6feb;text-decoration:none}
  a:hover{text-decoration:underline}
  .muted{color:#666;font-size:13px;margin-top:18px}
</style>
</head><body><div class="box">
<h1>Samarth GTM Portal — setup required</h1>
<p>${escapeHtml(message)}</p>
${missingHtml}
<h2>Required Google OAuth redirect URI</h2>
<p>Add this exact URI to the <em>Authorized redirect URIs</em> list in your Google Cloud OAuth client:</p>
<p><code>${escapeHtml(redirectUri)}</code></p>
${detailHtml}
<p class="muted">After setting the variables in the Vercel project settings, redeploy the portal and refresh this page.</p>
<p><a href="/">← Back to portal</a></p>
</div></body></html>`;
}
