import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/oauth/callback
 *
 * Self-contained Vercel-safe handler. Avoids non-trivial top-level imports
 * so module-evaluation cannot crash with FUNCTION_INVOCATION_FAILED.
 *
 * Returns friendly HTML errors for invalid state / missing config / token
 * exchange failures rather than platform 500s.
 */

const COOKIE_VERSION = "v1";
const SESSION_COOKIE = "samarth_portal_sid";
const OAUTH_STATE_COOKIE = "samarth_portal_oauth_state";

interface SessionTokensShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  scopes: string[];
}

const GTM_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "openid",
  "email",
  "profile",
];

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendHtml(
        res,
        503,
        renderErrorPage(
          "PORTAL_SESSION_SECRET is not configured. Sign-in cannot complete until the administrator sets a 32+ character secret.",
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

    if (!clientId || !clientSecret || !redirectUri) {
      return sendHtml(
        res,
        503,
        renderErrorPage(
          "Google OAuth is not configured on this portal. Set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI (or PORTAL_PUBLIC_URL).",
        ),
      );
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const oauthError = url.searchParams.get("error") ?? "";
    if (oauthError) {
      return sendHtml(
        res,
        400,
        renderErrorPage(
          `Google returned an error during sign-in: ${oauthError}. Please try again.`,
        ),
      );
    }

    const cookies = parseCookies(req.headers.cookie);
    const stateCookie = cookies[OAUTH_STATE_COOKIE];
    if (!code || !state || !verifyStateCookie(stateCookie, state, secret)) {
      clearStateCookie(res);
      return sendHtml(
        res,
        400,
        renderErrorPage(
          "Invalid or expired OAuth state. Please return to the portal and start sign-in again.",
        ),
      );
    }
    clearStateCookie(res);

    let tokens: SessionTokensShape;
    try {
      tokens = await exchangeCodeForTokens(
        { clientId, clientSecret, redirectUri },
        code,
      );
    } catch (e) {
      console.error(
        "[portal] oauth/callback: token exchange failed:",
        safeErrorName(e),
      );
      return sendHtml(
        res,
        502,
        renderErrorPage(
          "Failed to complete Google sign-in. The token exchange with Google failed. Please try again in a moment.",
        ),
      );
    }

    try {
      setSessionCookie(res, tokens, secret);
    } catch (e) {
      console.error(
        "[portal] oauth/callback: failed to set session cookie:",
        safeErrorName(e),
      );
      return sendHtml(
        res,
        500,
        renderErrorPage(
          "Sign-in completed but the session cookie could not be written. Please contact support.",
        ),
      );
    }

    res.statusCode = 302;
    res.setHeader("Location", "/#/?connected=1");
    res.setHeader("Cache-Control", "no-store");
    res.end();
  } catch (e) {
    console.error(
      "[portal] oauth/callback: unrecoverable error:",
      safeErrorName(e),
    );
    sendHtml(
      res,
      500,
      renderErrorPage(
        "An unexpected error occurred completing Google sign-in. Check the Vercel function logs for details.",
        safeErrorName(e),
      ),
    );
  }
}

async function exchangeCodeForTokens(
  client: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
): Promise<SessionTokensShape> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };

  let email: string | undefined;
  if (data.id_token) email = parseIdTokenEmail(data.id_token);
  if (!email && data.access_token) email = await fetchUserEmail(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
    email,
    scopes: data.scope ? data.scope.split(" ") : GTM_SCOPES,
  };
}

function parseIdTokenEmail(idToken: string): string | undefined {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { email?: string };
    return decoded.email;
  } catch {
    return undefined;
  }
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
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

function verifyStateCookie(
  cookieValue: string | undefined,
  presented: string,
  secret: string,
): boolean {
  if (!cookieValue || !presented) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return false;
  const [version, state, expiresAt, sig] = parts;
  if (version !== COOKIE_VERSION) return false;
  let expected: string;
  try {
    expected = signPayload(`${version}.${state}.${expiresAt}`, secret);
  } catch {
    return false;
  }
  if (!safeEqual(sig, expected)) return false;
  if (Number(expiresAt) < Date.now()) return false;
  return safeEqual(state, presented);
}

function setSessionCookie(
  res: ServerResponse,
  tokens: SessionTokensShape,
  secret: string,
): void {
  const payload = `${COOKIE_VERSION}.${base64UrlEncode(JSON.stringify(tokens))}`;
  const sig = signPayload(payload, secret);
  const value = `${payload}.${sig}`;
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
  appendSetCookie(res, parts.join("; "));
}

function clearStateCookie(res: ServerResponse): void {
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    parts.push("Secure");
  }
  appendSetCookie(res, parts.join("; "));
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

function renderErrorPage(message: string, detail?: string): string {
  const detailHtml = detail
    ? `<p><strong>Detail:</strong> <code>${escapeHtml(detail)}</code></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Samarth Portal — Sign-in error</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1a1a1a;line-height:1.55}
  h1{font-size:22px;margin:0 0 12px}
  .box{border:1px solid #e6e6e6;border-radius:12px;padding:24px;background:#fafafa}
  code{background:#f0f0f0;border-radius:4px;padding:2px 6px;font-size:13px}
  a{color:#1e6feb;text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head><body><div class="box">
<h1>Samarth GTM Portal — sign-in error</h1>
<p>${escapeHtml(message)}</p>
${detailHtml}
<p><a href="/">← Back to portal</a> &nbsp;·&nbsp; <a href="/api/oauth/start">Try sign-in again</a></p>
</div></body></html>`;
}
