/**
 * Portal Google OAuth helpers.
 *
 * Uses raw fetch against Google's OAuth2 endpoints — no extra dependencies.
 * Tokens are stored in an in-memory session map keyed by a random session id
 * that is sent to the browser as an httpOnly cookie. This is fine for the
 * MVP/single-process deployment. For production multi-instance deployments
 * back this with Redis / a database (see README).
 */

import crypto from "node:crypto";

export const GTM_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "openid",
  "email",
  "profile",
];

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch */
  expiresAt: number;
  email?: string;
  userName?: string;
  picture?: string;
  scopes: string[];
}

interface UserInfoShape {
  email?: string;
  name?: string;
  picture?: string;
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
    process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ?? process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const publicUrl = process.env.PORTAL_PUBLIC_URL;
  const redirectUri = explicitRedirect
    ? explicitRedirect
    : publicUrl
      ? `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`
      : undefined;

  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

// ── In-memory session store ──────────────────────────────────────────────
// Keys: random session id (cookie). Values: tokens + profile.
const sessions = new Map<string, SessionTokens>();
// Pending OAuth state values (for CSRF protection).
const pendingStates = new Map<string, number>(); // state -> created ms

function purgeOldStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  pendingStates.forEach((v, k) => {
    if (v < cutoff) pendingStates.delete(k);
  });
}

export function newOAuthState(): string {
  purgeOldStates();
  const s = crypto.randomBytes(24).toString("hex");
  pendingStates.set(s, Date.now());
  return s;
}

export function consumeOAuthState(state: string): boolean {
  const ok = pendingStates.delete(state);
  return ok;
}

export function newSessionId(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function getSession(sid: string | undefined): SessionTokens | null {
  if (!sid) return null;
  return sessions.get(sid) ?? null;
}

export function setSession(sid: string, tokens: SessionTokens): void {
  sessions.set(sid, tokens);
}

export function clearSession(sid: string | undefined): void {
  if (!sid) return;
  sessions.delete(sid);
}

// ── Token exchange / refresh ─────────────────────────────────────────────

export function buildAuthUrl(client: OAuthClientConfig, state: string): string {
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

export async function exchangeCodeForTokens(
  client: OAuthClientConfig,
  code: string,
): Promise<SessionTokens> {
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
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };

  const fromIdToken = data.id_token ? parseIdTokenProfile(data.id_token) : {};
  let email = fromIdToken.email;
  let userName = fromIdToken.name;
  let picture = fromIdToken.picture;
  if ((!email || !userName || !picture) && data.access_token) {
    const fromUserInfo = await fetchUserInfo(data.access_token);
    email = email ?? fromUserInfo.email;
    userName = userName ?? fromUserInfo.name;
    picture = picture ?? fromUserInfo.picture;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
    email,
    userName,
    picture,
    scopes: data.scope ? data.scope.split(" ") : GTM_SCOPES,
  };
}

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

function parseIdTokenProfile(idToken: string): UserInfoShape {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return {};
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { email?: string; name?: string; picture?: string };
    return {
      email: typeof decoded.email === "string" ? decoded.email : undefined,
      name: typeof decoded.name === "string" ? decoded.name : undefined,
      picture: typeof decoded.picture === "string" ? decoded.picture : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchUserInfo(accessToken: string): Promise<UserInfoShape> {
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    return {
      email: typeof data.email === "string" ? data.email : undefined,
      name: typeof data.name === "string" ? data.name : undefined,
      picture: typeof data.picture === "string" ? data.picture : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Get a valid access token for a session, refreshing it if expired.
 * Returns null if the session has no credentials or refresh fails.
 */
export async function getValidAccessToken(
  sid: string | undefined,
  client: OAuthClientConfig,
): Promise<string | null> {
  const sess = getSession(sid);
  if (!sess) return null;
  if (sess.accessToken && Date.now() < sess.expiresAt) {
    return sess.accessToken;
  }
  if (!sess.refreshToken) return null;
  try {
    const { accessToken, expiresAt } = await refreshAccessToken(client, sess.refreshToken);
    sess.accessToken = accessToken;
    sess.expiresAt = expiresAt;
    setSession(sid!, sess);
    return accessToken;
  } catch {
    return null;
  }
}
