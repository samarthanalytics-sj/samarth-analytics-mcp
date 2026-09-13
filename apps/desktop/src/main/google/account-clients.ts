import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import { loadGoogleOAuthClient } from './oauth-config';

// Just the slice of the registry this needs — keeps the manager testable with a
// tiny fake instead of a full RegistryService.
export interface TokenStore {
  getGoogleToken(accountId: string): string | null;
  setGoogleToken(accountId: string, tokenJson: string): void;
}

/**
 * Merge a refresh response into the stored credentials. Google does NOT resend
 * the refresh_token on a normal refresh, so we preserve the existing one and
 * take the fresh access_token/expiry.
 */
export function mergeGoogleTokens(current: Credentials, incoming: Credentials): Credentials {
  return {
    ...current,
    ...incoming,
    refresh_token: incoming.refresh_token ?? current.refresh_token,
  };
}

/**
 * True when an error is Google's `invalid_grant` — the refresh token is
 * permanently expired or revoked (NOT a transient network/quota failure).
 * The consent screen being in "Testing" makes this fire ~weekly (7-day refresh
 * token lifetime), and a user revoking access triggers it too. Detected across
 * the shapes google-auth-library / gaxios surface it in.
 */
export function isInvalidGrant(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown; cause?: { message?: unknown } };
  if (e?.response?.data?.error === 'invalid_grant') return true;
  const texts = [e?.message, e?.cause?.message].filter((t): t is string => typeof t === 'string');
  return texts.some((t) => /invalid_grant|token has been expired or revoked/i.test(t));
}

/**
 * Thrown in place of a raw Gaxios `invalid_grant` stack once the dead token has
 * been cleared — a clean, one-line signal the UI turns into a "Re-connect Google"
 * prompt. `code` lets callers detect it without string-matching.
 */
export class GoogleAuthExpiredError extends Error {
  readonly code = 'AUTH_EXPIRED';
  constructor(message = 'Your Google connection has expired or was revoked. Re-connect this account (sidebar → the account, or Settings → Connect) to continue.') {
    super(message);
    this.name = 'GoogleAuthExpiredError';
  }
}

/**
 * Builds and caches one auto-refreshing OAuth2Client per account from its
 * vaulted token. google-auth-library refreshes the access token on demand using
 * the refresh_token + the OAuth client id/secret; we persist the refreshed
 * credentials back to the vault so they survive restarts. This is the data-plane
 * foundation every API call (and later the embedded MCP server) goes through.
 */
export class AccountClientManager {
  private readonly cache = new Map<string, OAuth2Client>();

  constructor(
    private readonly store: TokenStore,
    private readonly configPath: string,
    private readonly factory: (id: string, secret: string) => OAuth2Client = (id, secret) =>
      new OAuth2Client(id, secret),
    /** Invoked once when an account's refresh token is rejected (invalid_grant),
     *  after its cached client is dropped — the wiring clears the vaulted token and
     *  tells the renderer to prompt a re-connect. */
    private readonly onAuthExpired?: (accountId: string) => void
  ) {}

  getClient(accountId: string): OAuth2Client {
    const cached = this.cache.get(accountId);
    if (cached) return cached;

    const tokenJson = this.store.getGoogleToken(accountId);
    if (!tokenJson) {
      throw new Error('This account is not signed in to Google. Connect it first.');
    }
    const oauthClient = loadGoogleOAuthClient(this.configPath);
    if (!oauthClient) {
      throw new Error('Google OAuth client is not configured.');
    }

    let current = JSON.parse(tokenJson) as Credentials;
    const client = this.factory(oauthClient.clientId, oauthClient.clientSecret);
    client.setCredentials(current);
    client.on('tokens', (incoming) => {
      current = mergeGoogleTokens(current, incoming);
      try {
        this.store.setGoogleToken(accountId, JSON.stringify(current));
      } catch {
        // Best-effort persistence; a failed re-vault still leaves the in-memory
        // client usable for the rest of the session.
      }
    });

    // Single chokepoint: every googleapis REST call goes through client.request, and a
    // dead refresh token surfaces as invalid_grant here. Turn that into a clean, typed
    // error (once), drop the client, and fire onAuthExpired so the token is cleared and
    // the UI prompts a re-connect — instead of every handler dumping a raw Gaxios stack.
    const originalRequest = client.request.bind(client) as OAuth2Client['request'];
    let notified = false;
    client.request = (async (opts: Parameters<OAuth2Client['request']>[0]) => {
      try {
        return await originalRequest(opts);
      } catch (err) {
        if (isInvalidGrant(err)) {
          if (!notified) {
            notified = true;
            this.invalidate(accountId);
            try { this.onAuthExpired?.(accountId); } catch { /* best-effort notify */ }
          }
          throw new GoogleAuthExpiredError();
        }
        throw err;
      }
    }) as OAuth2Client['request'];

    this.cache.set(accountId, client);
    return client;
  }

  /** Drop a cached client (on disconnect/token change) so it's rebuilt fresh. */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
