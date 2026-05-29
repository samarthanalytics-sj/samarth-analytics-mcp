import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchWorkspaceContents } from "../../server/gtm/api";
import { resolvePortalOAuthClient } from "../../server/gtm/oauth";
import { runAudit } from "../../server/gtm/audit";
import {
  ensureSessionSecret,
  getValidAccessTokenFromCookie,
  readJsonBody,
  sendGtmError,
  sendJson,
} from "../../server/gtm/vercel-helpers";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }
  const secretErr = ensureSessionSecret();
  if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });

  const client = resolvePortalOAuthClient();
  if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });
  const token = await getValidAccessTokenFromCookie(req, res, client);
  if (!token) return sendJson(res, 401, { error: "not_connected" });

  const body = await readJsonBody<{
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    containerPublicId?: string;
  }>(req);
  const { accountId, containerId, workspaceId, containerPublicId } = body;
  if (!accountId || !containerId || !workspaceId) {
    return sendJson(res, 400, {
      error: "missing_params",
      message: "accountId, containerId and workspaceId are required.",
    });
  }
  try {
    const contents = await fetchWorkspaceContents(token, accountId, containerId, workspaceId);
    const summary = runAudit(contents, {
      containerPublicId: containerPublicId ?? containerId,
    });
    sendJson(res, 200, summary);
  } catch (e) {
    sendGtmError(res, e, "Failed to run GTM audit");
  }
}
