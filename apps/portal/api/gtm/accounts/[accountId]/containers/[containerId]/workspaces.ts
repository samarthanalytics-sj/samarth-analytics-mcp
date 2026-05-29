import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { listWorkspaces } from "../../../../../../server/gtm/api";
import { resolvePortalOAuthClient } from "../../../../../../server/gtm/oauth";
import {
  ensureSessionSecret,
  getValidAccessTokenFromCookie,
  sendGtmError,
  sendJson,
} from "../../../../../../server/gtm/vercel-helpers";

type VercelRequest = IncomingMessage & { query?: Record<string, string | string[]> };

function getParam(req: VercelRequest, name: string): string | undefined {
  const fromQuery = req.query?.[name];
  if (typeof fromQuery === "string") return fromQuery;
  if (Array.isArray(fromQuery)) return fromQuery[0];
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      const v = u.searchParams.get(name);
      if (v) return v;
    } catch {}
  }
  return undefined;
}

export default async function handler(req: VercelRequest, res: ServerResponse) {
  const secretErr = ensureSessionSecret();
  if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });
  const accountId = getParam(req, "accountId");
  const containerId = getParam(req, "containerId");
  if (!accountId || !containerId) {
    return sendJson(res, 400, { error: "missing_params" });
  }
  const client = resolvePortalOAuthClient();
  if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });
  const token = await getValidAccessTokenFromCookie(req, res, client);
  if (!token) return sendJson(res, 401, { error: "not_connected" });
  try {
    const workspaces = await listWorkspaces(token, accountId, containerId);
    sendJson(res, 200, {
      workspaces: workspaces.map((w) => ({
        accountId: w.accountId,
        containerId: w.containerId,
        workspaceId: w.workspaceId,
        name: w.name ?? `Workspace ${w.workspaceId}`,
        description: w.description,
      })),
    });
  } catch (e) {
    sendGtmError(res, e, "Failed to list GTM workspaces");
  }
}
