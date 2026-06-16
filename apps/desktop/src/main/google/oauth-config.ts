import { existsSync, readFileSync } from 'node:fs';

// The OAuth client identity (a Google "Desktop app" client). For installed apps
// the "secret" is not truly confidential — security comes from PKCE + the
// loopback redirect — but Google's token endpoint still wants it, so we carry it.
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export type ClientSource = 'env' | 'file' | 'none';

/**
 * Resolve the OAuth client from (1) env vars — handy in dev — then (2) a JSON
 * config file in the app data dir. Values are trimmed: a stray newline/space in
 * a pasted client_id is a common cause of Google's `invalid_client` ("OAuth
 * client was not found"). Reports the source so the UI can show where it came
 * from. Returns client=null when nothing usable is configured.
 */
export function loadGoogleOAuthClientWithSource(configPath: string): {
  client: GoogleOAuthClient | null;
  source: ClientSource;
} {
  const envId = (process.env.GOOGLE_DESKTOP_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const envSecret = (
    process.env.GOOGLE_DESKTOP_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    ''
  ).trim();
  if (envId && envSecret) return { client: { clientId: envId, clientSecret: envSecret }, source: 'env' };

  try {
    if (existsSync(configPath)) {
      const j = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GoogleOAuthClient>;
      const clientId = (j.clientId ?? '').trim();
      const clientSecret = (j.clientSecret ?? '').trim();
      if (clientId && clientSecret) return { client: { clientId, clientSecret }, source: 'file' };
    }
  } catch {
    // Malformed config file → treat as unconfigured rather than crashing.
  }
  return { client: null, source: 'none' };
}

export function loadGoogleOAuthClient(configPath: string): GoogleOAuthClient | null {
  return loadGoogleOAuthClientWithSource(configPath).client;
}
