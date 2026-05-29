import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ensureSessionSecret,
  getValidAccessTokenFromCookie,
  listAccounts,
  resolvePortalOAuthClient,
  safeErrorName,
  sendGtmError,
  sendJson,
} from "../../_lib/portal-session";

/**
 * /api/gtm/accounts
 *
 * Self-contained Vercel-safe handler. All helpers live under `api/_lib` so
 * the bundler stays inside the `api/` tree — avoids the
 * FUNCTION_INVOCATION_FAILED class of failures we saw when reaching out to
 * `server/gtm/*`. The whole body is wrapped in try/catch so any unexpected
 * runtime issue still returns a clean JSON 500.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const secretErr = ensureSessionSecret();
    if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });
    const client = resolvePortalOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });
    const token = await getValidAccessTokenFromCookie(req, res, client);
    if (!token) return sendJson(res, 401, { error: "not_connected" });
    try {
      const accounts = await listAccounts(token);
      return sendJson(res, 200, {
        accounts: accounts.map((a) => ({
          accountId: a.accountId,
          name: a.name ?? a.accountId,
          path: a.path,
        })),
      });
    } catch (e) {
      return sendGtmError(res, e, "Failed to list GTM accounts");
    }
  } catch (e) {
    console.error("[portal] /api/gtm/accounts: unrecoverable error:", safeErrorName(e));
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/gtm/accounts handler failed",
      detail: safeErrorName(e),
    });
  }
}
