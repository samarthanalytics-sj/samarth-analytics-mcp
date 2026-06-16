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
      new OAuth2Client(id, secret)
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
    this.cache.set(accountId, client);
    return client;
  }

  /** Drop a cached client (on disconnect/token change) so it's rebuilt fresh. */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
