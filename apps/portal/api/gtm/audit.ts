import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ensureSessionSecret,
  fetchWorkspaceContents,
  getValidAccessTokenFromCookie,
  readJsonBody,
  resolvePortalOAuthClient,
  safeErrorName,
  sendGtmError,
  sendJson,
} from "../_lib/portal-session";

/**
 * /api/gtm/audit
 *
 * Self-contained handler. The heavy audit ruleset module is loaded with a
 * dynamic import *after* session validation so unauthenticated/probe
 * requests never trigger its module evaluation — that keeps platform-level
 * FUNCTION_INVOCATION_FAILED off the table for cold-call probes.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
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
      const contents = await fetchWorkspaceContents(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      // Dynamic import keeps the heavy audit module out of cold-start
      // module evaluation for unauthenticated probes.
      let runAudit: (
        contents: unknown,
        opts: { containerPublicId: string },
      ) => unknown;
      try {
        const mod = (await import("../../server/gtm/audit")) as {
          runAudit: typeof runAudit;
        };
        runAudit = mod.runAudit;
      } catch (e) {
        console.error("[portal] /api/gtm/audit: failed to load audit module:", safeErrorName(e));
        return sendJson(res, 500, {
          error: "internal_error",
          message: "Audit module failed to load.",
          detail: safeErrorName(e),
        });
      }
      const summary = runAudit(contents, {
        containerPublicId: containerPublicId ?? containerId,
      });
      return sendJson(res, 200, summary);
    } catch (e) {
      return sendGtmError(res, e, "Failed to run GTM audit");
    }
  } catch (e) {
    console.error("[portal] /api/gtm/audit: unrecoverable error:", safeErrorName(e));
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/gtm/audit handler failed",
      detail: safeErrorName(e),
    });
  }
}
