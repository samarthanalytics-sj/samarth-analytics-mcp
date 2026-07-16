import { shell } from 'electron';
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

  async connect(): Promise<AccountView> {
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
        openBrowser: (url) => shell.openExternal(url),
        signal: controller.signal,
      });
      return this.registry.upsertGoogleAccount(
        userinfo.email,
        userinfo.name,
        JSON.stringify(token)
      );
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
