/**
 * Google Auth module for GTM MCP Server
 *
 * Supports three auth modes (resolved in this order):
 *   1. Service Account key file (limited GTM support — see notes below)
 *   2. OAuth 2.0 user credentials via env vars and/or local token file
 *   3. Application Default Credentials (fallback)
 *
 * OAUTH CLIENT RESOLUTION:
 * ────────────────────────
 * The OAuth client ID / secret can come from one of two namespaces:
 *
 *   a) `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`     (preferred new names)
 *      Legacy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` still work.
 *      Use this when YOU own the OAuth client (self-hosted / local dev).
 *
 *   b) `SAMARTH_GOOGLE_OAUTH_CLIENT_ID` / `SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET`
 *      Reserved for the Samarth-hosted public OAuth app. The secret is NEVER
 *      hardcoded in this repo — it MUST be injected at runtime on the hosted
 *      backend. Public/distributed installs should leave the secret unset and
 *      rely on the hosted Samarth backend to perform the token exchange.
 *
 * TOKEN STORAGE:
 * ──────────────
 * The browser-based onboarding script (`npm run auth:google`) writes tokens to
 * a local file (default: `./.gtm-mcp-tokens.json`, override with
 * `GTM_MCP_TOKEN_FILE`). The file is in `.gitignore`. Env-var tokens
 * (`GOOGLE_REFRESH_TOKEN`) always take precedence if set.
 *
 * SERVICE ACCOUNT NOTES:
 * ─────────────────────
 * The Google Tag Manager API is a user-data API — it manages resources owned
 * by individual Google accounts. Service accounts are NOT granted GTM access
 * by default and will receive 403 errors. Either add the service account email
 * as a GTM user, or use Google Workspace Domain-Wide Delegation. See README.
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

// GTM required OAuth scopes — least-privilege superset needed by the server's
// read + edit + publish tool surface. Read-only deployments can trim the
// edit/publish scopes by re-running the onboarding flow with a narrower set.
export const GTM_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.manage.accounts',
  'https://www.googleapis.com/auth/tagmanager.manage.users',
  'https://www.googleapis.com/auth/tagmanager.publish',
];

// Google Analytics Admin API (GA4) read-only scope. Powers the read-only
// ga4_* MCP tools (account/property summaries, data streams, custom
// dimensions/metrics, data retention, etc.). This is the ONLY GA4 scope the
// server requests — it grants no write/delete capability on GA4 resources.
export const GA4_ADMIN_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// Full set of scopes requested during the OAuth onboarding flow. A single
// consent grant covers both the GTM tool surface and the read-only GA4 Admin
// tools, so users only authorize once.
export const ALL_SCOPES = [...GTM_SCOPES, GA4_ADMIN_READONLY_SCOPE];

export type AuthMode = 'oauth2' | 'service_account';

export interface AuthOptions {
  mode?: AuthMode;
  /** Path to service account JSON key file */
  serviceAccountKeyFile?: string;
  /** Email to impersonate when using service account + DWD */
  impersonateEmail?: string;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Which env namespace the credentials came from. */
  source: 'self-hosted' | 'samarth-hosted';
}

export interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export const DEFAULT_REDIRECT_URI = 'http://localhost:3001/oauth/callback';
export const DEFAULT_TOKEN_FILE = '.gtm-mcp-tokens.json';

/**
 * Resolve OAuth client credentials from environment variables.
 *
 * Priority:
 *   1. SAMARTH_GOOGLE_OAUTH_CLIENT_ID/SECRET   (hosted Samarth app)
 *   2. GOOGLE_OAUTH_CLIENT_ID/SECRET           (preferred new names)
 *   3. GOOGLE_CLIENT_ID/SECRET                 (legacy)
 *
 * Returns null if no usable client is configured.
 */
export function resolveOAuthClient(): OAuthClientCredentials | null {
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GOOGLE_REDIRECT_URI ??
    DEFAULT_REDIRECT_URI;

  const samarthId = process.env.SAMARTH_GOOGLE_OAUTH_CLIENT_ID;
  const samarthSecret = process.env.SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET;
  if (samarthId && samarthSecret) {
    return {
      clientId: samarthId,
      clientSecret: samarthSecret,
      redirectUri,
      source: 'samarth-hosted',
    };
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUri, source: 'self-hosted' };
  }
  return null;
}

/** Resolve the local token file path (override with GTM_MCP_TOKEN_FILE). */
export function getTokenFilePath(): string {
  const configured = process.env.GTM_MCP_TOKEN_FILE;
  if (configured && configured.trim().length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), DEFAULT_TOKEN_FILE);
}

/** Read tokens from the local token file. Returns null if missing or unreadable. */
export function readStoredTokens(filePath: string = getTokenFilePath()): StoredTokens | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.refresh_token && !parsed.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write tokens to the local token file with restrictive permissions. */
export function writeStoredTokens(
  tokens: StoredTokens,
  filePath: string = getTokenFilePath()
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod best-effort on Windows
  }
}

/**
 * Build an authenticated Google API client.
 * Priority:
 *   1. Service account key file (if provided and file exists)
 *   2. OAuth2 — env tokens, then local token file, combined with resolved client
 *   3. Application Default Credentials
 */
export async function buildGoogleAuth(opts: AuthOptions = {}): Promise<OAuth2Client> {
  const {
    serviceAccountKeyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    impersonateEmail,
  } = opts;

  // ── Mode 1: Service account ─────────────────────────────────────────────
  if (serviceAccountKeyFile && fs.existsSync(serviceAccountKeyFile)) {
    console.error('[auth] Using service account credentials from:', serviceAccountKeyFile);
    console.error(
      '[auth] ⚠ WARNING: GTM API requires the service account to be explicitly granted access.' +
        ' See README → Service Account Limitations.'
    );
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountKeyFile,
      scopes: ALL_SCOPES,
      ...(impersonateEmail ? { clientOptions: { subject: impersonateEmail } } : {}),
    });
    return auth.getClient() as Promise<OAuth2Client>;
  }

  // ── Mode 2: OAuth2 with stored tokens ───────────────────────────────────
  const clientCreds = resolveOAuthClient();
  const envAccessToken = process.env.GOOGLE_ACCESS_TOKEN;
  const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const fileTokens = readStoredTokens();

  const accessToken = envAccessToken || fileTokens?.access_token;
  const refreshToken = envRefreshToken || fileTokens?.refresh_token;

  if (clientCreds && (accessToken || refreshToken)) {
    console.error(
      `[auth] Using OAuth2 user credentials (client: ${clientCreds.source}` +
        `${fileTokens && !envRefreshToken ? ', tokens: file' : ', tokens: env'})`
    );
    const oauth2Client = new OAuth2Client(
      clientCreds.clientId,
      clientCreds.clientSecret,
      clientCreds.redirectUri
    );
    oauth2Client.setCredentials({
      access_token: accessToken || undefined,
      refresh_token: refreshToken || undefined,
      expiry_date: fileTokens?.expiry_date,
    });

    // Persist refreshed tokens back to disk if we sourced them from the file.
    if (fileTokens && !envRefreshToken) {
      oauth2Client.on('tokens', (newTokens) => {
        const merged: StoredTokens = {
          access_token: (newTokens.access_token ?? fileTokens.access_token) || undefined,
          refresh_token: (newTokens.refresh_token ?? fileTokens.refresh_token) || undefined,
          expiry_date: (newTokens.expiry_date ?? fileTokens.expiry_date) || undefined,
          scope: (newTokens.scope ?? fileTokens.scope) || undefined,
          token_type: (newTokens.token_type ?? fileTokens.token_type) || undefined,
        };
        try {
          writeStoredTokens(merged);
        } catch (err) {
          console.error('[auth] Failed to persist refreshed tokens:', String(err));
        }
      });
    }
    return oauth2Client;
  }

  // ── Mode 3: Application Default Credentials ─────────────────────────────
  console.error(
    '[auth] No explicit credentials found. Falling back to Application Default Credentials.' +
      ' Run: gcloud auth application-default login --scopes=' +
      ALL_SCOPES.join(',')
  );
  const auth = new google.auth.GoogleAuth({ scopes: ALL_SCOPES });
  return auth.getClient() as Promise<OAuth2Client>;
}

/**
 * Build an OAuth2Client from resolved env credentials (no tokens set).
 * Throws if no client is configured.
 */
export function buildOAuth2ClientForFlow(): OAuth2Client {
  const creds = resolveOAuthClient();
  if (!creds) {
    throw new Error(
      'No OAuth client configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET ' +
        '(or the legacy GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) in your environment / .env file. ' +
        'See README → Friendly Google Auth Options for setup steps.'
    );
  }
  return new OAuth2Client(creds.clientId, creds.clientSecret, creds.redirectUri);
}

/**
 * Generate the OAuth2 authorization URL for first-time setup.
 */
export function getOAuthAuthorizationUrl(): string {
  const oauth2Client = buildOAuth2ClientForFlow();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ALL_SCOPES,
    prompt: 'consent',
  });
}

/**
 * Exchange an authorization code for tokens.
 * If `persist` is true (default), writes tokens to the local token file.
 * Always prints a summary so the user can also copy values into .env if they prefer.
 */
export async function exchangeCodeForTokens(
  code: string,
  options: { persist?: boolean } = {}
): Promise<StoredTokens> {
  const { persist = true } = options;
  const oauth2Client = buildOAuth2ClientForFlow();
  const { tokens } = await oauth2Client.getToken(code);

  const stored: StoredTokens = {
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
  };

  if (persist && stored.refresh_token) {
    const filePath = getTokenFilePath();
    writeStoredTokens(stored, filePath);
    console.error(`[auth] Saved tokens to ${filePath} (mode 0600, gitignored).`);
  } else if (persist && !stored.refresh_token) {
    console.error(
      '[auth] ⚠ No refresh_token returned. You may need to revoke prior access at ' +
        'https://myaccount.google.com/permissions and retry — Google only issues a refresh_token ' +
        'on the first consent unless prompt=consent forces a new one.'
    );
  }

  return stored;
}
