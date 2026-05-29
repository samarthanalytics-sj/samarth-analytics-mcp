import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * /api/oauth/logout
 *
 * Self-contained Vercel-safe handler. Clears the session cookie and returns
 * a small JSON body. Designed to never throw on a normal request.
 */

const SESSION_COOKIE = "samarth_portal_sid";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  try {
    const parts = [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ connected: false }));
  } catch (e) {
    console.error(
      "[portal] oauth/logout: unrecoverable error:",
      e instanceof Error ? `${e.name}: ${e.message}` : "unknown_error",
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ connected: false, error: "logout_failed" }));
  }
}
