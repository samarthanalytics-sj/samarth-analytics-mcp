// Database connection configuration — pure parsing, no driver, no connection.
//
// FORWARD-LOOKING foundation. Resolves the durable-store configuration from env
// PRESENCE and shape only. It NEVER opens a socket and NEVER logs a secret. This
// is the single place that decides "is a database configured for this
// deployment", so the capability probe, the store factory, and tests all agree.
//
// Import-safe everywhere (no `node:*` beyond what's erased): the heavy `pg` /
// drizzle / supabase-js client is loaded lazily by the adapter, after this
// config says a DB is present and after request auth.

/** Which durable backend a deployment is wired for. */
export type DbDriver = "none" | "postgres";

export interface DbConfig {
  driver: DbDriver;
  /**
   * Present only when `driver !== "none"`. The raw connection string is kept
   * here for the lazy adapter to consume; it is a SECRET — never log it, never
   * send it to the browser, never write it to a cache.
   */
  connectionString?: string;
  /** Whether to enforce TLS to the database (managed Postgres should). */
  ssl: boolean;
  /** Max pool size hint for the lazy driver. Conservative for serverless. */
  poolMax: number;
  /** Statement timeout hint (ms) the adapter applies per query. */
  statementTimeoutMs: number;
}

/**
 * Build the DB config from an env bag (defaults to `process.env`). Recognizes
 * the same variables the capability probe reads (`DATABASE_URL` /
 * `PORTAL_DATABASE_URL`) so the two never disagree about whether a DB exists.
 *
 * Returns `{ driver: "none" }` when nothing is configured — the current
 * signed-cookie deployment. No throw on absence: absence is the normal state.
 */
export function loadDbConfig(
  env: Record<string, string | undefined> = readEnv(),
): DbConfig {
  const connectionString =
    firstNonEmpty(env.DATABASE_URL, env.PORTAL_DATABASE_URL) ?? undefined;

  if (!connectionString) {
    return {
      driver: "none",
      ssl: true,
      poolMax: defaultPoolMax(env),
      statementTimeoutMs: defaultStatementTimeout(env),
    };
  }

  return {
    driver: "postgres",
    connectionString,
    ssl: parseBool(env.DATABASE_SSL, true),
    poolMax: defaultPoolMax(env),
    statementTimeoutMs: defaultStatementTimeout(env),
  };
}

/** True when a durable database is configured for this deployment. */
export function isDatabaseConfigured(
  env: Record<string, string | undefined> = readEnv(),
): boolean {
  return loadDbConfig(env).driver !== "none";
}

function defaultPoolMax(env: Record<string, string | undefined>): number {
  const n = Number(env.DATABASE_POOL_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function defaultStatementTimeout(env: Record<string, string | undefined>): number {
  const n = Number(env.DATABASE_STATEMENT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

function readEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}
