import { openInBrowser } from './browser-launch';
import type { RegistryService } from './registry-service';
import { runLoopbackOAuth } from '../google/loopback';
import { loadGoogleOAuthClient, loadGoogleOAuthClientWithSource } from '../google/oauth-config';
import type { AccountView, GoogleClientStatus } from '../../shared/ipc';

// Orchestrates per-account Google sign-in: resolve the OAuth client, run the
// loopback flow (opens the SYSTEM browser → the user's real, already-signed-in
// Chrome → account chooser), then upsert the account + vault the token via the
// registry. One flow at a time. (Tag Assistant signs in separately, on demand —
// it needs a session in its OWN automated browser, which can't reuse the user's
// running Chrome; see ta-driver.)
export class GoogleAuthService {
  /** The in-flight sign-in, if any. A new connect() cancels it (rather than
   *  refusing) so a blocked/denied consent screen that never redirected back
   *  can't wedge sign-in until an app restart. */
  private current: AbortController | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly configPath: string,
    /** Called on disconnect so a cached per-account client is dropped. */
    private readonly onDisconnect?: (accountId: string) => void
  ) {}

  status(): GoogleClientStatus {
    const { client, source } = loadGoogleOAuthClientWithSource(this.configPath);
    return {
      configured: client !== null,
      configPath: this.configPath,
      source,
      clientId: client?.clientId,
      clientIdLooksValid: client
        ? client.clientId.endsWith('.apps.googleusercontent.com')
        : undefined,
    };
  }

  /** @param scopes Overrides the default scope set. Used by "Connect Google Ads", which passes
   *  adsAuthScopes() (the UNION with the defaults, never the Ads scope alone: a second authorization
   *  returns a token that REPLACES the vaulted one, so asking for adwords by itself would silently drop
   *  the Tag Manager and Analytics grants). */
  async connect(scopes?: string[], browserExe?: string): Promise<AccountView> {
    const client = loadGoogleOAuthClient(this.configPath);
    if (!client) {
      throw new Error(
        `Google OAuth client not configured. Create ${this.configPath} with ` +
          '{"clientId":"…","clientSecret":"…"} (a Google "Desktop app" client), ' +
          'or set GOOGLE_DESKTOP_CLIENT_ID / GOOGLE_DESKTOP_CLIENT_SECRET, then retry.'
      );
    }

    // Cancel any prior in-flight sign-in (e.g. one stuck on a denied/blocked
    // consent screen that never redirected back) and start a fresh one.
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    try {
      const { token, userinfo } = await runLoopbackOAuth(client, {
        // Open the Google consent URL in the browser the operator chose (empty = OS default) - so
        // sign-in lands in the browser that holds their signed-in Google session, not always Comet.
        openBrowser: async (url) => { openInBrowser(url, browserExe ?? ''); },
        signal: controller.signal,
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      });
      const account = this.registry.upsertGoogleAccount(
        userinfo.email,
        userinfo.name,
        JSON.stringify(token)
      );
      // Drop any cached OAuth2Client for this account, because upsert is idempotent by email and so a
      // re-connect REUSES the cache key. Without this the stale client keeps presenting the OLD access
      // token, and on its next refresh (google-auth-library refreshes eagerly ~5 minutes before expiry)
      // its 'tokens' listener re-serializes its own closure snapshot over the token we just vaulted,
      // silently reverting both the refresh token and the granted SCOPE string.
      // This is not hypothetical for the Google Ads work: a scope upgrade is a voluntary re-consent, so
      // it is never preceded by invalid_grant, which is the only path that currently invalidates the
      // cache. The newly granted adwords scope would be dropped within the hour.
      this.onDisconnect?.(account.id);
      return account;
    } finally {
      // Only clear if a later connect() hasn't already replaced us.
      if (this.current === controller) this.current = null;
    }
  }

  /** Cancel an in-flight sign-in (the user clicked Cancel, or abandoned a consent
   *  screen that never redirected back). Aborts the loopback flow, so the pending
   *  connect() rejects with "Google sign-in cancelled." and the local server closes.
   *  A no-op when nothing is in flight. */
  cancelConnect(): void {
    this.current?.abort();
  }

  disconnect(id: string): void {
    this.registry.clearGoogleToken(id);
    this.onDisconnect?.(id);
  }
}
