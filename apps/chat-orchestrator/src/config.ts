/**
 * Environment configuration for the chat orchestrator.
 *
 * Every value is read once at boot and validated, so a misconfigured deployment fails loudly at
 * startup instead of at the first user message.
 */
import { parse as parseEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads configuration from two .env files, nearest first.
 *
 * This service's own .env is primary; the repo-root .env fills whatever it leaves blank. The root
 * file matters because the Google OAuth client lives there: `npm run auth:google` writes the token
 * file at the repo root and reads its client id and secret from the root .env.
 *
 * Written by hand rather than with `dotenv/config` because of one specific trap. dotenv treats a key
 * as "already set" if it exists at all, including when its value is the empty string. `.env.example`
 * ships `GOOGLE_OAUTH_CLIENT_ID=` with no value, so a copied .env would shadow the real credential
 * in the root file with an empty one, and dotenv would then refuse to fill it. The visible symptom
 * is the MCP child reporting "No explicit credentials found" and falling back to Application Default
 * Credentials, long after a successful sign-in, with a token file sitting right there on disk.
 *
 * So: an empty value counts as absent, at every layer. Precedence is real environment, then this
 * package's .env, then the repo root's. Paths resolve from the module, not the working directory,
 * so behaviour does not depend on how the process was launched. Missing files are ignored.
 */
function loadEnvironment(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const layers = [resolve(packageRoot, '.env'), resolve(packageRoot, '../../.env')];

  for (const path of layers) {
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const existing = process.env[key];
      if (value.trim() && !existing?.trim()) process.env[key] = value;
    }
  }
}

loadEnvironment();

export type Product = 'gtm' | 'ga4';

export interface OrchestratorConfig {
  port: number;
  host: string;
  allowedOrigins: string[];
  openai: {
    apiKey: string;
    model: string;
    lightModel: string;
    baseUrl: string;
    maxOutputTokens: number;
    requestTimeoutMs: number;
  };
  mcp: {
    /** 'stdio' spawns the MCP server as a child process; 'http' connects to a running instance. */
    transport: 'stdio' | 'http';
    command: string;
    args: string[];
    url?: string;
    authToken?: string;
    /** Extra env passed to the spawned MCP process (Google credentials, guardrail flags). */
    env: Record<string, string>;
  };
  supabase: {
    /**
     * Project base URL, e.g. https://abc.supabase.co. Needed for the audit trail, which writes
     * through PostgREST. Derived from the functions URL when not given explicitly.
     */
    url?: string;
    /**
     * Service role key. Bypasses RLS, so it lives only on this host and never reaches a browser.
     * Without it the audit trail is off: the tables deny every client write by design, and the
     * orchestrator is the only thing that may add a row.
     */
    serviceRoleKey?: string;
    /** JWKS endpoint used to verify user access tokens. Empty in dev-bypass mode. */
    jwksUrl?: string;
    issuer?: string;
    audience?: string;
    /** Supabase auth base. Used to verify tokens when the project publishes no public keys. */
    authUrl?: string;
    anonKey?: string;
  };
  googleIdentity: {
    /**
     * 'supabase' resolves each user's own Google token from the platform (production).
     * 'static'   makes every user share one token from the environment (local testing only).
     * 'inherit'  gives the MCP child whatever credentials it finds itself (single-identity dev).
     */
    mode: 'supabase' | 'static' | 'inherit';
    functionsUrl: string;
    anonKey: string;
    staticAccessToken: string;
    /** Used to exchange a user's refresh token with Google. The platform has no refresh action. */
    oauthClientId: string;
    oauthClientSecret: string;
  };
  pool: {
    maxSessions: number;
    idleTtlMs: number;
  };
  /** Skips JWT verification. Refuses to start when NODE_ENV=production. */
  devNoAuth: boolean;
  limits: {
    maxToolCallsPerTurn: number;
    maxTurnMs: number;
    maxHistoryMessages: number;
    maxToolResultChars: number;
    maxToolHistoryChars: number;
    turnsPerMinutePerUser: number;
  };
  /**
   * Write tools are withheld from the model unless this is true. Independent of the MCP's own
   * guardrail flags, which stay authoritative: this only controls what the model can see.
   */
  enableWriteTools: boolean;
  /**
   * Offers GTM deletes, behind a typed confirmation. Separate from writes on purpose: creating a tag
   * and removing one are different decisions, and this toolset has no revert for the second.
   */
  enableDeleteTools: boolean;
  /**
   * Whether a create or update that is immediately live still stops for a plain approval card.
   *
   * OFF by default, which is the uniform CRUD model: create, read and update apply directly on both
   * products, and only a removal stops. Set ORCHESTRATOR_APPROVE_LIVE_WRITES=true to restore the
   * middle tier, where anything with no draft behind it (all GA4 Admin config, and GTM container,
   * version, environment and permission changes) shows an approval card first.
   *
   * On is the stricter setting. Deletes and archives are gated regardless and this flag cannot
   * reach them.
   */
  approveLiveWrites: boolean;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(name: string): boolean {
  return process.env[name] === 'true';
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Google/guardrail env forwarded to a spawned MCP child process. */
const FORWARDED_MCP_ENV = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GTM_MCP_TOKEN_FILE',
  'GTM_MCP_ENABLE_WRITES',
  'GTM_MCP_ENABLE_PUBLISH',
  'GTM_MCP_ENABLE_DELETES',
  'GA4_MCP_ENABLE_WRITES',
  'GA4_MCP_ENABLE_DELETES',
  'DRY_RUN',
] as const;

export function loadConfig(): OrchestratorConfig {
  const devNoAuth = bool('ORCHESTRATOR_DEV_NO_AUTH');
  if (devNoAuth && process.env.NODE_ENV === 'production') {
    throw new Error(
      'ORCHESTRATOR_DEV_NO_AUTH=true is refused when NODE_ENV=production. Unset it or configure SUPABASE_JWKS_URL.',
    );
  }

  const jwksUrl = process.env.SUPABASE_JWKS_URL?.trim();
  if (!devNoAuth && !jwksUrl) {
    throw new Error(
      'Set SUPABASE_JWKS_URL so user tokens can be verified, or set ORCHESTRATOR_DEV_NO_AUTH=true for local testing.',
    );
  }

  const mcpEnv: Record<string, string> = {};
  for (const key of FORWARDED_MCP_ENV) {
    const v = process.env[key];
    if (v) mcpEnv[key] = v;
  }
  // The child is an MCP stdio server regardless of how this process is configured.
  mcpEnv.GTM_MCP_TRANSPORT = 'stdio';

  // Explicit wins; otherwise fall back to the functions URL, which is the same origin with a
  // /functions/v1 suffix. Deriving it saves configuring the same host twice and getting it wrong.
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() ||
    process.env.SUPABASE_FUNCTIONS_URL?.trim().replace(/\/functions\/v1\/?$/, '') ||
    '';

  const identityMode = (process.env.GOOGLE_IDENTITY_MODE?.trim() ?? 'inherit') as
    | 'supabase'
    | 'static'
    | 'inherit';
  if (!['supabase', 'static', 'inherit'].includes(identityMode)) {
    throw new Error(
      `GOOGLE_IDENTITY_MODE must be one of supabase, static, inherit (got "${identityMode}").`,
    );
  }
  // Anything other than per-user identity means one Google account answers for everybody, which is
  // a cross-tenant data leak the moment a second user signs in.
  if (identityMode !== 'supabase' && process.env.NODE_ENV === 'production') {
    throw new Error(
      `GOOGLE_IDENTITY_MODE=${identityMode} is refused when NODE_ENV=production: every user would ` +
        'share one Google account. Set GOOGLE_IDENTITY_MODE=supabase.',
    );
  }
  const functionsUrl = process.env.SUPABASE_FUNCTIONS_URL?.trim() ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? '';
  if (identityMode === 'supabase' && (!functionsUrl || !anonKey)) {
    throw new Error(
      'GOOGLE_IDENTITY_MODE=supabase requires SUPABASE_FUNCTIONS_URL and SUPABASE_ANON_KEY.',
    );
  }
  // The platform's token function has no refresh action, so the orchestrator performs the Google
  // exchange itself. Without the OAuth client, every session dies the hour its token expires.
  if (
    identityMode === 'supabase' &&
    !(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() && process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim())
  ) {
    throw new Error(
      'GOOGLE_IDENTITY_MODE=supabase requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET ' +
        'so expired user tokens can be refreshed. Use the same OAuth client the website signs users in with.',
    );
  }
  if (identityMode === 'supabase' && devNoAuth) {
    // Without a verified JWT there is no user to resolve a token for, and forwarding an
    // unverified token to the platform would defeat its own authorization.
    throw new Error(
      'GOOGLE_IDENTITY_MODE=supabase cannot be combined with ORCHESTRATOR_DEV_NO_AUTH=true.',
    );
  }
  const staticAccessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim() ?? '';
  if (identityMode === 'static' && !staticAccessToken) {
    throw new Error('GOOGLE_IDENTITY_MODE=static requires GOOGLE_ACCESS_TOKEN.');
  }

  return {
    port: num('PORT', 8787),
    host: process.env.ORCHESTRATOR_HOST ?? '127.0.0.1',
    allowedOrigins: list('ALLOWED_ORIGINS', [
      'https://aitagmanager.com',
      'https://www.aitagmanager.com',
      'http://localhost:8080',
      'http://localhost:5173',
    ]),
    openai: {
      apiKey: req('OPENAI_API_KEY'),
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.4',
      lightModel: process.env.OPENAI_LIGHT_MODEL?.trim() || 'gpt-5.4-mini',
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
      maxOutputTokens: num('OPENAI_MAX_OUTPUT_TOKENS', 4096),
      requestTimeoutMs: num('OPENAI_TIMEOUT_MS', 120_000),
    },
    mcp: {
      transport: (process.env.MCP_TRANSPORT as 'stdio' | 'http') ?? 'stdio',
      command: process.env.MCP_COMMAND?.trim() || process.execPath,
      args: list('MCP_ARGS', ['../../dist/index.js']),
      url: process.env.MCP_URL?.trim(),
      authToken: process.env.MCP_AUTH_TOKEN?.trim(),
      env: mcpEnv,
    },
    supabase: {
      jwksUrl,
      url: supabaseUrl,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
      issuer: process.env.SUPABASE_JWT_ISSUER?.trim(),
      audience: process.env.SUPABASE_JWT_AUDIENCE?.trim() || 'authenticated',
      // Derived from the JWKS URL when not given, since both live under the same auth base.
      authUrl:
        process.env.SUPABASE_AUTH_URL?.trim() ||
        jwksUrl?.replace(/\/\.well-known\/jwks\.json$/, ''),
      anonKey,
    },
    googleIdentity: {
      mode: identityMode,
      functionsUrl,
      anonKey,
      staticAccessToken,
      oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '',
      oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '',
    },
    pool: {
      maxSessions: num('MCP_POOL_MAX_SESSIONS', 25),
      idleTtlMs: num('MCP_POOL_IDLE_TTL_MS', 15 * 60_000),
    },
    devNoAuth,
    limits: {
      maxToolCallsPerTurn: num('MAX_TOOL_CALLS_PER_TURN', 12),
      maxTurnMs: num('MAX_TURN_MS', 120_000),
      /*
       * Both lowered from 20 / 24,000 while looking at real usage: 71% of input tokens were cache
       * hits, so the cacheable prefix was already efficient and the remaining cost was the
       * UNCACHEABLE tail - conversation history and tool results, re-sent on every tool round.
       *
       * 10 messages is roughly five exchanges. Dropping older ones is announced to the model (see
       * boundHistory), so the failure mode is "I cannot see that, please restate it" rather than a
       * confident answer about a message it no longer has.
       *
       * 16,000 characters is about 4,000 tokens: comfortably above a normal list, low enough to
       * clip a runaway one. capToolResult marks the cut explicitly and tells the model to say the
       * list is incomplete, so a truncated result can never be presented as the whole set.
       *
       * PROVISIONAL. These were set from reasoning about where the tokens were, not from a
       * measured before/after: at the time of the change there was no post-change traffic to
       * compare. If the assistant starts losing the thread of multi-step work, raise
       * MAX_HISTORY_MESSAGES back toward 20 - that is the one with a real usability cost.
       */
      maxHistoryMessages: num('MAX_HISTORY_MESSAGES', 10),
      maxToolResultChars: num('MAX_TOOL_RESULT_CHARS', 16_000),
      /*
       * Total size of tool results carried into ONE model call, oldest shortened first.
       *
       * maxToolResultChars caps a single result; this caps their SUM. Without it a multi-step turn
       * re-sends every result on every round trip and the prompt grows quadratically — a measured
       * tag-creation turn spent 117 of its 125 seconds inside the model, with round-trip gaps
       * climbing 3s, 4s, 26s, 26s, 30s as the array filled up.
       *
       * 24,000 characters is about 6,000 tokens: room for the newest result at full size plus the
       * working set around it, while an old container listing is reduced to a digest that still
       * says what it was.
       */
      maxToolHistoryChars: num('MAX_TOOL_HISTORY_CHARS', 24_000),
      turnsPerMinutePerUser: num('TURNS_PER_MINUTE_PER_USER', 10),
    },
    enableWriteTools: bool('ORCHESTRATOR_ENABLE_WRITE_TOOLS'),
    // Deletes require writes. Enabling deletes alone would be incoherent.
    enableDeleteTools: bool('ORCHESTRATOR_ENABLE_WRITE_TOOLS') && bool('ORCHESTRATOR_ENABLE_DELETE_TOOLS'),
    // Opt IN. The uniform CRUD model is the requested default; this flag re-adds the stricter tier.
    approveLiveWrites: process.env.ORCHESTRATOR_APPROVE_LIVE_WRITES?.trim() === 'true',
  };
}
