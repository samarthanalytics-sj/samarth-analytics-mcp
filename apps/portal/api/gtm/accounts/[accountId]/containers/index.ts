import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  ensureSessionSecret,
  getValidAccessTokenFromCookie,
  listContainers,
  resolvePortalOAuthClient,
  safeErrorName,
  sendGtmError,
  sendJson,
} from "../../../../_lib/portal-session";

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
  try {
    const secretErr = ensureSessionSecret();
    if (secretErr) return sendJson(res, 500, { error: "config_error", message: secretErr });
    const accountId = getParam(req, "accountId");
    if (!accountId) return sendJson(res, 400, { error: "missing_account_id" });
    const client = resolvePortalOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });
    const token = await getValidAccessTokenFromCookie(req, res, client);
    if (!token) return sendJson(res, 401, { error: "not_connected" });
    try {
      const containers = await listContainers(token, accountId);
      return sendJson(res, 200, {
        containers: containers.map((c) => ({
          accountId: c.accountId,
          containerId: c.containerId,
          publicId: c.publicId ?? c.containerId,
          name: c.name ?? c.publicId ?? c.containerId,
          usageContext: c.usageContext ?? [],
          domainName: c.domainName ?? [],
        })),
      });
    } catch (e) {
      return sendGtmError(res, e, "Failed to list GTM containers");
    }
  } catch (e) {
    console.error("[portal] /api/gtm/.../containers: unrecoverable error:", safeErrorName(e));
    return sendJson(res, 500, {
      error: "internal_error",
      message: "containers handler failed",
      detail: safeErrorName(e),
    });
  }
}
