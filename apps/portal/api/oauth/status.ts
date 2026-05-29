import type { IncomingMessage, ServerResponse } from "node:http";
import { resolvePortalOAuthClient } from "../../server/gtm/oauth";
import {
  ensureSessionSecret,
  readSessionFromCookies,
  sendJson,
} from "../../server/gtm/vercel-helpers";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const secretErr = ensureSessionSecret();
  if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });
  const client = resolvePortalOAuthClient();
  if (!client) {
    return sendJson(res, 200, {
      connected: false,
      configured: false,
      message:
        "Google OAuth is not configured on this portal. Set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI.",
    });
  }
  const { tokens } = readSessionFromCookies(req);
  if (!tokens) return sendJson(res, 200, { connected: false, configured: true });
  return sendJson(res, 200, {
    connected: true,
    configured: true,
    email: tokens.email,
    scopes: tokens.scopes,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  });
}
