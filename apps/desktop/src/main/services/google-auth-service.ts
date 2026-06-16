import { shell } from 'electron';
import type { RegistryService } from './registry-service';
import { runLoopbackOAuth } from '../google/loopback';
import { loadGoogleOAuthClient, loadGoogleOAuthClientWithSource } from '../google/oauth-config';
import type { AccountView, GoogleClientStatus } from '../../shared/ipc';

// Orchestrates per-account Google sign-in: resolve the OAuth client, run the
// loopback flow (opens the system browser → account chooser), then upsert the
// account + vault the token via the registry. One flow at a time.
export class GoogleAuthService {
  private connecting = false;

  constructor(
    private readonly registry: RegistryService,
    private readonly configPath: string
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
    if (this.connecting) throw new Error('A Google sign-in is already in progress.');
    const client = loadGoogleOAuthClient(this.configPath);
    if (!client) {
      throw new Error(
        `Google OAuth client not configured. Create ${this.configPath} with ` +
          '{"clientId":"…","clientSecret":"…"} (a Google "Desktop app" client), ' +
          'or set GOOGLE_DESKTOP_CLIENT_ID / GOOGLE_DESKTOP_CLIENT_SECRET, then retry.'
      );
    }

    this.connecting = true;
    try {
      const { token, userinfo } = await runLoopbackOAuth(client, {
        openBrowser: (url) => shell.openExternal(url),
      });
      return this.registry.upsertGoogleAccount(
        userinfo.email,
        userinfo.name,
        JSON.stringify(token)
      );
    } finally {
      this.connecting = false;
    }
  }

  disconnect(id: string): void {
    this.registry.clearGoogleToken(id);
  }
}
