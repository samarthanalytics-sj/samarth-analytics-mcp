import { existsSync, readFileSync } from 'node:fs';

// The OAuth client identity (a Google "Desktop app" client). For installed apps
// the "secret" is not truly confidential — security comes from PKCE + the
// loopback redirect — but Google's token endpoint still wants it, so we carry it.
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the OAuth client from (1) env vars — handy in dev — then (2) a JSON
 * config file in the app data dir, so a packaged build can be configured without
 * a rebuild. Returns null when nothing is configured; the caller turns that into
 * an actionable error pointing at `configPath`.
 */
export function loadGoogleOAuthClient(configPath: string): GoogleOAuthClient | null {
  const envId = process.env.GOOGLE_DESKTOP_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envSecret =
    process.env.GOOGLE_DESKTOP_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

  try {
    if (existsSync(configPath)) {
      const j = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GoogleOAuthClient>;
      if (j.clientId && j.clientSecret) {
        return { clientId: j.clientId, clientSecret: j.clientSecret };
      }
    }
  } catch {
    // Malformed config file → treat as unconfigured rather than crashing.
  }
  return null;
}
