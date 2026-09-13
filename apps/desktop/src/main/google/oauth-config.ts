import { existsSync, readFileSync } from 'node:fs';

// The OAuth client identity (a Google "Desktop app" client). For installed apps
// the "secret" is not truly confidential — security comes from PKCE + the
// loopback redirect — but Google's token endpoint still wants it, so we carry it.
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export type ClientSource = 'env' | 'file' | 'none';

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Pull a client id/secret out of any of the shapes a user is likely to have:
 *   - our format:        { "clientId": "...", "clientSecret": "..." }
 *   - snake_case:        { "client_id": "...", "client_secret": "..." }
 *   - Google's download: { "installed": { "client_id": "...", "client_secret": "..." } }
 *     (or a "web" wrapper). This is the file you get from Cloud Console → Download JSON.
 */
export function extractClient(parsed: unknown): GoogleOAuthClient | null {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const node = (root.installed ?? root.web ?? root) as Record<string, unknown>;
  const clientId = asTrimmedString(node.clientId) || asTrimmedString(node.client_id);
  const clientSecret = asTrimmedString(node.clientSecret) || asTrimmedString(node.client_secret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Resolve the OAuth client from (1) env vars — handy in dev — then (2) a JSON
 * config file in the app data dir. Strips a UTF-8 BOM (PowerShell/Notepad add
 * one, which breaks JSON.parse) and accepts Google's native download shapes.
 * Logs why a present file was rejected. Returns client=null when unconfigured.
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
      const raw = readFileSync(configPath, 'utf8').replace(/^﻿/, ''); // strip BOM
      const client = extractClient(JSON.parse(raw));
      if (client) return { client, source: 'file' };
      console.error(
        `[samarth-desktop] ${configPath} parsed but had no usable client id/secret. ` +
          'Accepts {"clientId","clientSecret"}, snake_case, or Google\'s {"installed":{...}} download.'
      );
    }
  } catch (e) {
    console.error(`[samarth-desktop] could not read ${configPath}: ${(e as Error).message}`);
  }
  return { client: null, source: 'none' };
}


/**
 * Parse the KEY=VALUE lines of a .env file. Supports comments (#), blank
 * lines, `export ` prefixes, and single/double quotes around the value -
 * enough for the two OAuth client lines this app reads; not a full dotenv.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash);
    }
    out[m[1]] = v.trim();
  }
  return out;
}

/**
 * Load .env files into process.env WITHOUT overriding variables that are
 * already set (a real shell export always wins). Later paths never override
 * earlier ones either - pass the highest-priority file first. Missing or
 * unreadable files are skipped silently: .env is an optional convenience.
 */
export function loadEnvFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      for (const [k, v] of Object.entries(parseEnvFile(readFileSync(p, 'utf8')))) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      // optional file - ignore
    }
  }
}

export function loadGoogleOAuthClient(configPath: string): GoogleOAuthClient | null {
  return loadGoogleOAuthClientWithSource(configPath).client;
}
