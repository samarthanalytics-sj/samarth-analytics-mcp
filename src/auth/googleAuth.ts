/**
 * Google Auth module for GTM MCP Server
 *
 * Supports two auth modes:
 *   1. OAuth 2.0 user credentials (recommended for GTM)
 *   2. Service Account (limited support — see notes below)
 *
 * SERVICE ACCOUNT NOTES:
 * ─────────────────────
 * The Google Tag Manager API is a user-data API — it manages resources owned
 * by individual Google accounts. Service accounts are NOT granted GTM access
 * by default and will receive 403 errors.
 *
 * To use a service account with GTM, you MUST either:
 *   a) Add the service account email as a GTM user (User Management → Add User)
 *      at the account or container level with appropriate permissions; OR
 *   b) Use Google Workspace Domain-Wide Delegation (DWD):
 *      - Requires a Google Workspace (formerly G Suite) org
 *      - Enable DWD in Google Workspace Admin console
 *      - Delegate the scopes: https://www.googleapis.com/auth/tagmanager.manage.accounts
 *        https://www.googleapis.com/auth/tagmanager.edit.containers
 *        https://www.googleapis.com/auth/tagmanager.publish
 *      - Impersonate a user who has GTM access: auth.subject = 'user@yourworkspace.com'
 *      - This is only available in paid Google Workspace accounts.
 *
 * For most setups (personal Google account, agency, freelance), use OAuth 2.0.
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';

// GTM required OAuth scopes
export const GTM_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.manage.accounts',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.manage.users',
  'https://www.googleapis.com/auth/tagmanager.publish',
  'https://www.googleapis.com/auth/tagmanager.readonly',
];

export type AuthMode = 'oauth2' | 'service_account';

export interface AuthOptions {
  mode?: AuthMode;
  /** Path to service account JSON key file */
  serviceAccountKeyFile?: string;
  /** Email to impersonate when using service account + DWD */
  impersonateEmail?: string;
}

/**
 * Build an authenticated Google API client.
 * Priority:
 *   1. Service account key file (if provided and file exists)
 *   2. OAuth2 via env tokens GOOGLE_ACCESS_TOKEN + GOOGLE_REFRESH_TOKEN
 *   3. Application Default Credentials (gcloud auth application-default login)
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
      scopes: GTM_SCOPES,
      ...(impersonateEmail ? { clientOptions: { subject: impersonateEmail } } : {}),
    });
    // GoogleAuth.getClient() returns an AuthClient — cast to OAuth2Client for consistent typing.
    // In practice for service accounts this will be a JWT client.
    return auth.getClient() as Promise<OAuth2Client>;
  }

  // ── Mode 2: OAuth2 with stored tokens ───────────────────────────────────
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/oauth/callback';
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && (accessToken || refreshToken)) {
    console.error('[auth] Using OAuth2 user credentials');
    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({
      access_token: accessToken || undefined,
      refresh_token: refreshToken || undefined,
    });
    return oauth2Client;
  }

  // ── Mode 3: Application Default Credentials ─────────────────────────────
  console.error(
    '[auth] No explicit credentials found. Falling back to Application Default Credentials.' +
      ' Run: gcloud auth application-default login --scopes=' +
      GTM_SCOPES.join(',')
  );
  const auth = new google.auth.GoogleAuth({ scopes: GTM_SCOPES });
  return auth.getClient() as Promise<OAuth2Client>;
}

/**
 * Generate the OAuth2 authorization URL for first-time setup.
 * Prints the URL; user visits it, authorizes, and pastes the code back.
 */
export function getOAuthAuthorizationUrl(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/oauth/callback';

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env to generate OAuth URL'
    );
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GTM_SCOPES,
    prompt: 'consent',
  });
}

/**
 * Exchange an authorization code for tokens.
 * Prints the tokens — copy them to .env as GOOGLE_ACCESS_TOKEN / GOOGLE_REFRESH_TOKEN.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/oauth/callback';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  console.log('=== OAuth Tokens (save to .env) ===');
  console.log('GOOGLE_ACCESS_TOKEN=' + tokens.access_token);
  console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
  console.log('===================================');
}
