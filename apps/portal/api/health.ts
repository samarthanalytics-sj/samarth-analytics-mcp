import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  try {
    const hasSessionSecret =
      (process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "").length >= 16;

    const clientId =
      process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
      process.env.GOOGLE_OAUTH_CLIENT_ID ??
      process.env.GOOGLE_CLIENT_ID ??
      "";
    const clientSecret =
      process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET ??
      "";
    const redirect =
      process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      "";
    const publicUrl = process.env.PORTAL_PUBLIC_URL ?? "";
    const oauthConfigured = Boolean(clientId && clientSecret && (redirect || publicUrl));

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        ok: true,
        runtime: "vercel",
        node: process.version,
        hasSessionSecret,
        oauthConfigured,
        envPresence: {
          PORTAL_SESSION_SECRET: Boolean(process.env.PORTAL_SESSION_SECRET),
          SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
          PORTAL_GOOGLE_OAUTH_CLIENT_ID: Boolean(process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID),
          PORTAL_GOOGLE_OAUTH_CLIENT_SECRET: Boolean(process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET),
          PORTAL_GOOGLE_OAUTH_REDIRECT_URI: Boolean(process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI),
          PORTAL_PUBLIC_URL: Boolean(process.env.PORTAL_PUBLIC_URL),
          VERCEL: Boolean(process.env.VERCEL),
          VERCEL_ENV: process.env.VERCEL_ENV ?? null,
        },
      }),
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: "health_check_failed",
        detail: e instanceof Error ? `${e.name}: ${e.message}` : "unknown_error",
      }),
    );
  }
}
