import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAuthUrl, resolvePortalOAuthClient } from "../../server/gtm/oauth";
import { encodeOAuthStateCookie } from "../../server/gtm/session-cookie";
import {
  ensureSessionSecret,
  renderConfigError,
  setOAuthStateCookie,
} from "../../server/gtm/vercel-helpers";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  const secretErr = ensureSessionSecret();
  if (secretErr) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderConfigError(secretErr));
  }
  const client = resolvePortalOAuthClient();
  if (!client) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(
      renderConfigError(
        "Google OAuth is not configured on this portal. The administrator must set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI before sign-in is available.",
      ),
    );
  }
  const { state, cookie } = encodeOAuthStateCookie();
  setOAuthStateCookie(res, cookie);
  res.statusCode = 302;
  res.setHeader("Location", buildAuthUrl(client, state));
  res.end();
}
