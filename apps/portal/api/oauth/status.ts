import type { IncomingMessage, ServerResponse } from "node:http";
import { resolvePortalOAuthClient } from "../../server/gtm/oauth";
import {
  hasSessionSecret,
} from "../../server/gtm/session-cookie";
import {
  readSessionFromCookies,
  sendJson,
} from "../../server/gtm/vercel-helpers";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const sessionSecretSet = hasSessionSecret();
    const client = resolvePortalOAuthClient();
    const configured = Boolean(client);

    if (!sessionSecretSet) {
      return sendJson(res, 200, {
        connected: false,
        configured,
        sessionSecretSet: false,
        message:
          "PORTAL_SESSION_SECRET is not set (or shorter than 16 chars). Sign-in is disabled until it is configured.",
      });
    }

    if (!client) {
      return sendJson(res, 200, {
        connected: false,
        configured: false,
        sessionSecretSet: true,
        message:
          "Google OAuth is not configured on this portal. Set PORTAL_GOOGLE_OAUTH_CLIENT_ID, PORTAL_GOOGLE_OAUTH_CLIENT_SECRET, and PORTAL_GOOGLE_OAUTH_REDIRECT_URI.",
      });
    }

    let tokens = null;
    try {
      tokens = readSessionFromCookies(req).tokens;
    } catch (e) {
      console.error("[portal] oauth/status: failed to read session cookie:", safeErrorName(e));
      tokens = null;
    }

    if (!tokens) {
      return sendJson(res, 200, {
        connected: false,
        configured: true,
        sessionSecretSet: true,
      });
    }

    return sendJson(res, 200, {
      connected: true,
      configured: true,
      sessionSecretSet: true,
      email: tokens.email,
      scopes: tokens.scopes,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
    });
  } catch (e) {
    console.error("[portal] oauth/status: unrecoverable error:", safeErrorName(e));
    return sendJson(res, 500, {
      error: "internal_error",
      message: "oauth/status handler failed",
      detail: safeErrorName(e),
    });
  }
}

function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
}
