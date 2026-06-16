import { createHash, randomBytes } from 'node:crypto';

// Pure OAuth helpers for the desktop loopback flow — no I/O, no Electron, so all
// of this is unit-testable in plain Node. The orchestration (HTTP server, browser,
// fetch) lives in loopback.ts.

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

// Read-only by default, matching the MCP server's guardrails. openid/email/profile
// identify the account; tagmanager.readonly + analytics.readonly authorize reads.
// (Enabling GTM writes later would require adding the edit/publish scopes here.)
export const DESKTOP_GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 PKCE pair: random verifier + its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque anti-CSRF state value. */
export function createState(): string {
  return base64url(randomBytes(16));
}

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scopes.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // offline → refresh token; select_account so the chooser always lists the
  // browser's signed-in Google accounts (and "Use another account").
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'select_account consent');
  return u.toString();
}

export function buildTokenExchangeBody(p: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): string {
  const body = new URLSearchParams();
  body.set('client_id', p.clientId);
  body.set('client_secret', p.clientSecret);
  body.set('code', p.code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', p.redirectUri);
  body.set('code_verifier', p.codeVerifier);
  return body.toString();
}

// Token JSON we vault. Shape matches google-auth-library Credentials so Phase 3
// can feed it straight into an OAuth2Client for auto-refresh.
export interface StoredGoogleToken {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export function parseTokenResponse(json: unknown, nowMs: number): StoredGoogleToken {
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.error === 'string') {
    const desc = typeof j.error_description === 'string' ? ` - ${j.error_description}` : '';
    throw new Error(`Google token error: ${j.error}${desc}`);
  }
  if (typeof j.access_token !== 'string' || j.access_token.length === 0) {
    throw new Error('Google token response had no access_token');
  }
  const token: StoredGoogleToken = { access_token: j.access_token };
  if (typeof j.refresh_token === 'string') token.refresh_token = j.refresh_token;
  if (typeof j.scope === 'string') token.scope = j.scope;
  if (typeof j.token_type === 'string') token.token_type = j.token_type;
  if (typeof j.expires_in === 'number') token.expiry_date = nowMs + j.expires_in * 1000;
  return token;
}

export interface GoogleUserinfo {
  email: string;
  name?: string;
  picture?: string;
  sub?: string;
}

export function parseUserinfo(json: unknown): GoogleUserinfo {
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.email !== 'string' || !j.email.includes('@')) {
    throw new Error('Google userinfo had no email (was the email scope granted?)');
  }
  return {
    email: j.email,
    name: typeof j.name === 'string' ? j.name : undefined,
    picture: typeof j.picture === 'string' ? j.picture : undefined,
    sub: typeof j.sub === 'string' ? j.sub : undefined,
  };
}
