import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { exchangeCodeForTokens, resolvePortalOAuthClient } from "../../server/gtm/oauth";
import { verifyOAuthStateCookie } from "../../server/gtm/session-cookie";
import {
  clearOAuthStateCookie,
  ensureSessionSecret,
  OAUTH_STATE_COOKIE,
  parseCookies,
  renderConfigError,
  setSessionCookie,
} from "../../server/gtm/vercel-helpers";

function htmlError(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderConfigError(message));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const secretErr = ensureSessionSecret();
  if (secretErr) return htmlError(res, 500, secretErr);

  const client = resolvePortalOAuthClient();
  if (!client) return htmlError(res, 503, "OAuth not configured.");

  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  if (error) return htmlError(res, 400, `Google returned an error: ${error}`);

  const cookies = parseCookies(req.headers.cookie);
  const stateCookie = cookies[OAUTH_STATE_COOKIE];
  if (!code || !state || !verifyOAuthStateCookie(stateCookie, state)) {
    clearOAuthStateCookie(res);
    return htmlError(res, 400, "Invalid or expired OAuth state.");
  }
  clearOAuthStateCookie(res);

  try {
    const tokens = await exchangeCodeForTokens(client, code);
    setSessionCookie(res, tokens);
    res.statusCode = 302;
    res.setHeader("Location", "/#/?connected=1");
    res.end();
  } catch (e) {
    console.error("[portal] OAuth callback error:", e);
    htmlError(res, 500, "Failed to complete Google sign-in. Please try again.");
  }
}
