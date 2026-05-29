import type { IncomingMessage, ServerResponse } from "node:http";
import { listAccounts } from "../../../server/gtm/api";
import { resolvePortalOAuthClient } from "../../../server/gtm/oauth";
import {
  ensureSessionSecret,
  getValidAccessTokenFromCookie,
  sendGtmError,
  sendJson,
} from "../../../server/gtm/vercel-helpers";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const secretErr = ensureSessionSecret();
  if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });
  const client = resolvePortalOAuthClient();
  if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });
  const token = await getValidAccessTokenFromCookie(req, res, client);
  if (!token) return sendJson(res, 401, { error: "not_connected" });
  try {
    const accounts = await listAccounts(token);
    sendJson(res, 200, {
      accounts: accounts.map((a) => ({
        accountId: a.accountId,
        name: a.name ?? a.accountId,
        path: a.path,
      })),
    });
  } catch (e) {
    sendGtmError(res, e, "Failed to list GTM accounts");
  }
}
