/**
 * Per-user Google identity.
 *
 * Every tool call must run as the signed-in user's own Google account, never as a shared service
 * identity. The platform already stores each user's Google tokens encrypted at rest and exposes a
 * decrypt endpoint that authorizes on the caller's own JWT, so this module borrows that path rather
 * than duplicating key management: the orchestrator never sees the encryption key and never stores
 * a token.
 */
import type { OrchestratorConfig } from './config.js';

export interface GoogleIdentity {
  accessToken: string;
  /** Epoch milliseconds, when the provider reports it. Used only to refresh proactively. */
  expiresAt?: number;
}

export class GoogleIdentityError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_connected'
      | 'refresh_failed'
      | 'provider_unavailable'
      | 'scope_missing' = 'not_connected',
  ) {
    super(message);
  }
}

export interface GoogleTokenProvider {
  /**
   * Resolves the caller's Google access token.
   * @param userJwt the end user's own access token, forwarded so the platform authorizes the
   *        decrypt against that user and nobody else.
   */
  getIdentity(userId: string, userJwt: string): Promise<GoogleIdentity>;
  /** Forces a new access token after the current one is rejected. */
  refresh(userId: string, userJwt: string): Promise<GoogleIdentity>;
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface TokenManagerResponse {
  success?: boolean;
  token?: string;
  tokenType?: string;
  error?: string;
}

/**
 * Talks to the platform's `secure-token-manager` Supabase function.
 *
 * That function derives the target user from the verified JWT and ignores any user id in the body,
 * so a caller can only ever reach its own tokens.
 *
 * Two properties of that function shape this code and are easy to get wrong:
 *   - it exposes `store | retrieve | delete | get_token | check_permission` and has no refresh
 *     action, so the Google refresh exchange happens here;
 *   - it reports "no token" as HTTP 200 with `success: false`, not as a 404.
 */
export class SupabaseTokenProvider implements GoogleTokenProvider {
  constructor(
    private readonly functionsUrl: string,
    private readonly anonKey: string,
    private readonly oauthClient: { clientId: string; clientSecret: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getIdentity(_userId: string, userJwt: string): Promise<GoogleIdentity> {
    const token = await this.retrieve('google_access_token', userJwt);
    if (!token) {
      throw new GoogleIdentityError(
        'No Google account is connected to this profile. Connect Google to let the assistant read your container.',
        'not_connected',
      );
    }
    // The function returns the token alone with no expiry, so expiry is discovered by Google
    // rejecting it, which the turn loop handles with a single refresh and retry.
    return { accessToken: token };
  }

  /**
   * Exchanges the user's stored refresh token with Google for a new access token, then writes the
   * new token back through the platform so the rest of the product benefits from it too.
   *
   * The refresh token exists in this process only for the duration of the exchange. It is never
   * logged, never persisted here, and never passed into an MCP child.
   */
  async refresh(_userId: string, userJwt: string): Promise<GoogleIdentity> {
    if (!this.oauthClient.clientId || !this.oauthClient.clientSecret) {
      throw new GoogleIdentityError(
        'Cannot refresh the Google token: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not configured.',
        'refresh_failed',
      );
    }

    const refreshToken = await this.retrieve('google_refresh_token', userJwt);
    if (!refreshToken) {
      // Users who signed up through a flow that omitted offline access have no refresh token, so
      // this is a re-consent prompt rather than a transient failure.
      throw new GoogleIdentityError(
        'Your Google connection has expired and cannot be renewed automatically. Please reconnect your Google account.',
        'not_connected',
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.oauthClient.clientId,
          client_secret: this.oauthClient.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } catch (err) {
      throw new GoogleIdentityError(
        `Could not reach Google to refresh the token: ${err instanceof Error ? err.message : String(err)}`,
        'provider_unavailable',
      );
    }

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (!res.ok || !body.access_token) {
      // invalid_grant means the user revoked access or changed their password. Reconnecting is the
      // only fix, so say that rather than retrying.
      const revoked = body.error === 'invalid_grant';
      throw new GoogleIdentityError(
        revoked
          ? 'Your Google authorization was revoked. Please reconnect your Google account.'
          : `Google refused the token refresh: ${body.error ?? res.status}`,
        revoked ? 'not_connected' : 'refresh_failed',
      );
    }

    const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    // Best effort: a failed write-back costs one extra refresh next turn, not the current one.
    await this.store('google_access_token', body.access_token, expiresAt, userJwt).catch(() => {});

    return { accessToken: body.access_token, expiresAt };
  }

  private async retrieve(tokenType: string, userJwt: string): Promise<string | null> {
    const body = await this.call({ action: 'retrieve', token_type: tokenType }, userJwt);
    if (body.success === false || !body.token) return null;
    return body.token;
  }

  private async store(
    tokenType: string,
    token: string,
    expiresAt: number,
    userJwt: string,
  ): Promise<void> {
    await this.call(
      {
        action: 'store',
        token_type: tokenType,
        token,
        expires_at: new Date(expiresAt).toISOString(),
      },
      userJwt,
    );
  }

  private async call(
    payload: Record<string, unknown>,
    userJwt: string,
  ): Promise<TokenManagerResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.functionsUrl}/secure-token-manager`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userJwt}`,
          apikey: this.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new GoogleIdentityError(
        `Could not reach the token service: ${err instanceof Error ? err.message : String(err)}`,
        'provider_unavailable',
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new GoogleIdentityError(
        'The token service rejected this session. Please sign in again.',
        'provider_unavailable',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GoogleIdentityError(
        `Token service returned ${res.status}: ${text.slice(0, 200)}`,
        'provider_unavailable',
      );
    }

    return (await res.json().catch(() => ({}))) as TokenManagerResponse;
  }
}

/**
 * Development provider: every user resolves to the single account configured in the environment.
 *
 * Intended only for local testing before the platform link is wired. It is refused in production
 * because it would let one user read another user's Google data.
 */
export class StaticTokenProvider implements GoogleTokenProvider {
  constructor(private readonly accessToken: string) {}

  async getIdentity(): Promise<GoogleIdentity> {
    return { accessToken: this.accessToken };
  }

  async refresh(): Promise<GoogleIdentity> {
    throw new GoogleIdentityError(
      'The static development token expired. Re-run npm run auth:google and restart.',
      'refresh_failed',
    );
  }
}

export function createTokenProvider(cfg: OrchestratorConfig): GoogleTokenProvider | null {
  if (cfg.googleIdentity.mode === 'supabase') {
    return new SupabaseTokenProvider(cfg.googleIdentity.functionsUrl, cfg.googleIdentity.anonKey, {
      clientId: cfg.googleIdentity.oauthClientId,
      clientSecret: cfg.googleIdentity.oauthClientSecret,
    });
  }
  if (cfg.googleIdentity.mode === 'static') {
    return new StaticTokenProvider(cfg.googleIdentity.staticAccessToken);
  }
  // 'inherit': no per-user identity; the MCP child uses whatever credentials it finds itself.
  return null;
}

/**
 * Recognizes a Google authentication failure in an MCP tool result.
 *
 * Tool errors come back as text, so this is string matching by necessity. It is deliberately narrow:
 * a false positive would burn a refresh and a retry on an unrelated failure.
 */
export function isGoogleAuthFailure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('invalid credentials') ||
    t.includes('invalid authentication credentials') ||
    t.includes('invalid_grant') ||
    t.includes('access token has expired') ||
    t.includes('request is missing required authentication credential') ||
    (t.includes('401') && t.includes('unauthenticated')) ||
    t.includes('could not load the default credentials')
  );
}
