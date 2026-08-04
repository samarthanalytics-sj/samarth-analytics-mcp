/**
 * Which set of OAuth tokens do we hand to the OAuth2Client: the environment's, or the token file's?
 *
 * The answer has to be ONE OR THE OTHER, whole. The previous code chose per FIELD:
 *
 *   const accessToken  = envAccessToken  || fileTokens?.access_token;
 *   const refreshToken = envRefreshToken || fileTokens?.refresh_token;
 *   ...
 *   expiry_date: fileTokens?.expiry_date,
 *
 * With GOOGLE_ACCESS_TOKEN set, no GOOGLE_REFRESH_TOKEN, and a token file present, that produced a
 * credential assembled from two different grants:
 *
 *   - The env's access token, stamped with the FILE's expiry_date. google-auth-library only refreshes
 *     when expiry_date says the token is expiring, so an already-dead env token paired with a
 *     still-future file expiry means it never refreshes and every API call 401s, with nothing in the
 *     logs pointing at why.
 *   - The file's refresh token behind the env's access token. The two can belong to DIFFERENT Google
 *     accounts (this project is explicitly multi-account), so the first refresh silently switches
 *     identity: calls that started as account A continue as account B, against whichever GTM
 *     containers B can reach.
 *
 * Selecting atomically removes both. It also makes the "tokens: env/file" log line true, which the
 * old `fileTokens && !envRefreshToken` test was not for the mixed case.
 *
 * PURE - takes the env and the parsed file, touches neither.
 */

import type { StoredTokens } from './googleAuth.js';

export interface TokenSelection {
  /** Which source won, for logging. */
  source: 'env' | 'file';
  tokens: StoredTokens;
  /**
   * May refreshed tokens be written back to the token file? Only when the file IS the source: writing
   * env-sourced credentials into the file would graft the env identity onto the stored one.
   */
  persist: boolean;
}

/**
 * Pick the token source. The environment wins when it supplies EITHER token, on the principle that an
 * explicitly-set env var is a deliberate override of whatever is on disk. When it wins it wins
 * completely: no expiry_date, no scope, no token_type borrowed from the file.
 *
 * Returns undefined when neither source has a usable token, which is the caller's signal to fall
 * through to Application Default Credentials.
 */
export function selectTokenSource(
  env: { GOOGLE_ACCESS_TOKEN?: string; GOOGLE_REFRESH_TOKEN?: string },
  fileTokens: StoredTokens | null | undefined
): TokenSelection | undefined {
  const envAccess = env.GOOGLE_ACCESS_TOKEN?.trim();
  const envRefresh = env.GOOGLE_REFRESH_TOKEN?.trim();

  if (envAccess || envRefresh) {
    return {
      source: 'env',
      // No expiry_date on purpose. We do not know when an env-supplied access token expires, and
      // guessing is what caused the bug. With expiry_date absent, google-auth-library treats the
      // access token as usable and refreshes when there is only a refresh token, which is the honest
      // reading of what the environment told us.
      tokens: {
        access_token: envAccess || undefined,
        refresh_token: envRefresh || undefined,
      },
      persist: false,
    };
  }

  if (fileTokens?.access_token || fileTokens?.refresh_token) {
    return { source: 'file', tokens: fileTokens, persist: true };
  }

  return undefined;
}
