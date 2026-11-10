import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * GET /api/health
 * GET /api/system/capabilities
 *
 * One Vercel function answers both URLs. Vercel builds every .ts file under
 * api/ as one Serverless Function, and the Hobby plan allows 12 per deployment.
 * `/api/system/capabilities` has no file of its own: a rewrite in vercel.json
 * sends it here as `/api/health?capabilities=1`.
 *
 * Both documents are public and read-only. They are derived purely from env-var
 * PRESENCE: no secret value is read or returned, and no session is required.
 *
 * Follows the api/** rule (CLAUDE.md): only `node:*` and `import type` at module
 * load; no heavy imports. No auth-gated work happens here, so nothing is pulled
 * in lazily either.
 */
const CAPABILITIES_PATH = "/api/system/capabilities";
const CAPABILITIES_FLAG = "capabilities";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (wantsCapabilities(req)) capabilities(res);
  else health(res);
}

/**
 * True when the request is for /api/system/capabilities.
 *
 * After the rewrite this function can see either form, so both are accepted:
 *   - the URL the caller asked for (the path is /api/system/capabilities), or
 *   - the rewrite destination (the path is /api/health, the query has the flag).
 *
 * Only the PRESENCE of the flag counts, never its value. A caller's own
 * `?capabilities=...` can replace the value the rewrite adds (`vercel dev` does
 * this), so a check on the value could turn a capabilities request into a
 * health response. With this rule /api/system/capabilities always gets the
 * capabilities document, whatever the caller adds. A caller who types the flag
 * on /api/health gets that same public document. There is no third response.
 *
 * Never throws: a request this cannot read is answered as a health check.
 */
function wantsCapabilities(req: IncomingMessage): boolean {
  try {
    const raw = typeof req.url === "string" ? req.url : "";
    const hash = raw.indexOf("#");
    const target = hash === -1 ? raw : raw.slice(0, hash);
    const mark = target.indexOf("?");
    const pathname = mark === -1 ? target : target.slice(0, mark);
    if ((pathname.endsWith("/") ? pathname.slice(0, -1) : pathname) === CAPABILITIES_PATH) {
      return true;
    }
    if (mark !== -1 && new URLSearchParams(target.slice(mark + 1)).has(CAPABILITIES_FLAG)) {
      return true;
    }
    // `req.query` is the @vercel/node helper. It is absent on a plain request.
    const query: unknown = (req as IncomingMessage & { query?: unknown }).query;
    return (
      typeof query === "object" &&
      query !== null &&
      Object.prototype.hasOwnProperty.call(query, CAPABILITIES_FLAG)
    );
  } catch {
    return false;
  }
}

/** GET /api/health — liveness: the process is up, plus minimal env presence. */
function health(res: ServerResponse): void {
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

/**
 * GET /api/system/capabilities
 *
 * Vercel-safe capability probe. Reports which production subsystems are
 * configured on this deployment, derived purely from env-var PRESENCE — it
 * never reads or returns a secret value, and it requires no session (it is an
 * unauthenticated, read-only descriptor used by the client to decide which
 * panels/features to surface and by ops to verify a deployment's wiring).
 *
 * Shape is additive and backwards-compatible with the health document above.
 * Adding fields here does not change any existing route's response.
 */
function capabilities(res: ServerResponse): void {
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
    const vaultConfigured =
      present("TOKEN_VAULT_URL") ||
      present("GCP_SECRET_MANAGER_PROJECT") ||
      present("AWS_SECRETS_MANAGER_REGION");

    // Subsystem readiness: a subsystem is "ready" only when EVERYTHING it needs
    // to function is present, "degraded" when partially wired, and "unconfigured"
    // when absent (the expected state on the current signed-cookie deployment).
    // Derived purely from env presence — no probe, no secret value is read.
    const isProd = process.env.VERCEL_ENV === "production";

    const readiness = {
      auth: sessionConfigured && oauthConfigured
        ? "ready"
        : sessionConfigured || oauthConfigured
          ? "degraded"
          : "unconfigured",
      persistence: databaseConfigured ? "ready" : "unconfigured",
      cache: cacheConfigured ? "ready" : "unconfigured",
      tokenVault: vaultConfigured ? "ready" : "unconfigured",
      runtimeCapture: runtimeWorkerConfigured ? "ready" : "unconfigured",
    } as const;

    // Production-mode caveats: non-fatal advisories ops should see when running
    // in `VERCEL_ENV=production` without the durable subsystems wired. These
    // describe *operational* posture; they never block a request and never name
    // a secret. Empty in non-production or once everything is provisioned.
    const caveats: string[] = [];
    if (isProd && !databaseConfigured) {
      caveats.push(
        "No database configured: sessions are signed-cookie only and audit history is not persisted.",
      );
    }
    if (isProd && !cacheConfigured) {
      caveats.push(
        "No cache configured: every discovery read hits the Google API (no SWR, higher latency/quota use).",
      );
    }
    if (isProd && databaseConfigured && !vaultConfigured) {
      caveats.push(
        "Database present but no token vault: confirm OAuth token bytes are not being written to Postgres.",
      );
    }
    if (isProd && !runtimeWorkerConfigured) {
      caveats.push(
        "No runtime worker configured: runtime-capture (live tag) audits are unavailable.",
      );
    }

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
          tokenVault: vaultConfigured,
        },
        // Per-subsystem readiness for deploy verification / ops dashboards.
        readiness,
        // Operational advisories for production mode. Empty unless caveats apply.
        caveats,
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
