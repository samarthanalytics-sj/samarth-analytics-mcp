/**
 * Google grant revocation for "Disconnect Google" (Express dev server; the
 * Vercel route api/oauth/logout.ts carries its own copy, keep them in lockstep).
 *
 * Google revokes a user's grant for a whole Google Cloud project, whichever
 * token is sent: every OAuth client in that project loses the user's tokens,
 * and so do the user's other portal sessions. If the MCP server (or any other
 * app) signs users in with a client in the portal client's project, revoking
 * would sign the user out there too. These checks keep that from happening:
 *
 * - Opt-in. The portal cannot see another deployment's settings, so the
 *   operator sets PORTAL_REVOKE_GOOGLE_ON_DISCONNECT=true to declare that the
 *   project behind PORTAL_GOOGLE_OAUTH_CLIENT_ID is used by the portal alone.
 * - A shared client variable visible in this environment that names the same
 *   client, or a client in the same project, refuses. Client IDs start with
 *   the project number ("<number>-<hash>.apps.googleusercontent.com").
 * - The session's refresh token must refresh with the portal's own client
 *   credentials first. Google refreshes a token only for the client that issued
 *   it, so a session minted before the portal moved to its own client is left
 *   alone.
 *
 * Only a same-origin POST revokes, which is what the portal's own button sends.
 * Each Google call gets 4 s, so both fit inside a 10 s function limit.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TIMEOUT_MS = 4_000;

export interface DisconnectRequest {
  method: string | undefined;
  origin: string | undefined;
  host: string | undefined;
  forwardedHost: string | undefined;
}

/** True when the operator opted in and the portal has a client, secret and project of its own. */
export function shouldRevokeOnDisconnect(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PORTAL_REVOKE_GOOGLE_ON_DISCONNECT !== "true") return false;
  const own = env.PORTAL_GOOGLE_OAUTH_CLIENT_ID;
  if (!own || !env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET) return false;
  const project = googleProjectNumber(own);
  return ![env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_CLIENT_ID, env.SAMARTH_GOOGLE_OAUTH_CLIENT_ID].some(
    (id) => id === own || (project !== undefined && googleProjectNumber(id) === project),
  );
}

/** The project number a Google OAuth client ID starts with, if it has one. */
function googleProjectNumber(clientId: string | undefined): string | undefined {
  return clientId?.match(/^(\d+)-/)?.[1];
}

/** True for a POST whose Origin is the host it was sent to. */
export function isSameOriginPost(req: DisconnectRequest): boolean {
  if (req.method !== "POST" || !req.origin) return false;
  let originHost: string;
  try {
    originHost = new URL(req.origin).host;
  } catch {
    return false;
  }
  return originHost === req.host || originHost === req.forwardedHost;
}

/** Revoke the grant behind a session's refresh token when every check passes. Never throws. */
export async function revokeOnDisconnect(
  req: DisconnectRequest,
  refreshToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!refreshToken || !isSameOriginPost(req) || !shouldRevokeOnDisconnect(env)) return false;
  const refreshed = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ?? "",
    client_secret: env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  });
  if (!isOk(refreshed)) {
    console.warn(
      `[portal] oauth/logout: not revoking; the session's token did not refresh with PORTAL_GOOGLE_OAUTH_CLIENT_ID (${refreshed || "no response"})`,
    );
    return false;
  }
  const revoked = await postForm(REVOKE_URL, { token: refreshToken });
  if (!isOk(revoked)) {
    console.warn(`[portal] oauth/logout: Google did not confirm the revocation (${revoked || "no response"})`);
    return false;
  }
  return true;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** POST a form to Google. Returns the HTTP status, or 0 on a network error or timeout. */
async function postForm(url: string, form: Record<string, string>): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return 0;
  }
}
