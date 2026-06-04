import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * GET /api/system/capabilities
 *
 * Vercel-safe capability probe. Reports which production subsystems are
 * configured on this deployment, derived purely from env-var PRESENCE — it
 * never reads or returns a secret value, and it requires no session (it is an
 * unauthenticated, read-only descriptor used by the client to decide which
 * panels/features to surface and by ops to verify a deployment's wiring).
 *
 * Follows the api/** rule (CLAUDE.md): only `node:*` and `import type` at module
 * load; no heavy imports. No auth-gated work happens here, so nothing is pulled
 * in lazily either.
 *
 * Shape is additive and backwards-compatible with api/health.ts. Adding fields
 * here does not change any existing route's response.
 */
export default function handler(_req: IncomingMessage, res: ServerResponse) {
  try {
    const present = (name: string): boolean =>
      typeof process.env[name] === "string" && process.env[name]!.length > 0;

    const sessionConfigured =
      (process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "")
        .length >= 16;

    const oauthConfigured = Boolean(
      (process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
        process.env.GOOGLE_OAUTH_CLIENT_ID ??
        process.env.GOOGLE_CLIENT_ID ??
        "") &&
        (process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
          process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
          process.env.GOOGLE_CLIENT_SECRET ??
          "") &&
        (present("PORTAL_GOOGLE_OAUTH_REDIRECT_URI") ||
          present("PORTAL_PUBLIC_URL")),
    );

    // Optional production subsystems. Presence only — these are forward-looking
    // and absent on the current signed-cookie deployment, which is expected.
    const databaseConfigured =
      present("DATABASE_URL") || present("PORTAL_DATABASE_URL");
    const cacheConfigured =
      present("REDIS_URL") ||
      present("UPSTASH_REDIS_REST_URL") ||
      present("KV_REST_API_URL");
    const runtimeWorkerConfigured =
      present("RUNTIME_WORKER_URL") || present("PORTAL_RUNTIME_WORKER_URL");

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        ok: true,
        runtime: "vercel",
        node: process.version,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        // Capability flags the client can read to gate UI without leaking config.
        capabilities: {
          session: sessionConfigured,
          oauth: oauthConfigured,
          database: databaseConfigured,
          cache: cacheConfigured,
          runtimeWorker: runtimeWorkerConfigured,
        },
        // Current persistence mode. Until a DB is wired this is "signed_cookie".
        sessionMode: databaseConfigured ? "database" : "signed_cookie",
      }),
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        ok: false,
        error: "capabilities_check_failed",
        detail: e instanceof Error ? `${e.name}: ${e.message}` : "unknown_error",
      }),
    );
  }
}
