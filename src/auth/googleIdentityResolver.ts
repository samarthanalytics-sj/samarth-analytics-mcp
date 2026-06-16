/**
 * Google identity resolver — Phase 3, slice 1 (see docs/PHASE3_IMPLEMENTATION_SPEC.md).
 *
 * Given a Stytch (organizationId, memberId), returns an OAuth2Client carrying
 * that user's current Google access token, which Stytch vaults and refreshes on
 * our behalf. This is the data-plane core of multi-user mode: the validated
 * Stytch token (slice 2) yields org + member, this resolves the per-user Google
 * client, and the Phase 1 `runWithAuth` hook scopes it to the request.
 *
 * Verified endpoint + response shape: scripts/stytch-spike.mjs confirmed
 *   GET /v1/b2b/organizations/{org}/members/{member}/oauth_providers/google
 * returns { access_token, access_token_expires_in, scopes, ... } and that the
 * token works against the live GTM API.
 *
 * IMPORTANT: we never request `include_refresh_token`. Pulling the raw refresh
 * token would disable Stytch's automatic refresh (per Stytch docs). We only use
 * the short-lived access token and re-pull a fresh one as it nears expiry.
 */
import { OAuth2Client } from 'google-auth-library';

export interface ResolverConfig {
  /** Stytch project id (e.g. project-test-… / project-live-…). */
  projectId: string;
  /** Stytch secret (server-only). */
  secret: string;
  /** API base override; defaults are derived from the project id prefix. */
  apiBase?: string;
  /** Clock injection for tests. */
  now?: () => number;
  /** fetch injection for tests. */
  fetchImpl?: typeof fetch;
  /** Seconds of headroom before access-token expiry that triggers a re-pull. */
  refreshBufferSeconds?: number;
  /**
   * If set, the member's granted Google scopes must include at least one of
   * these, or `resolve()` throws {@link GoogleScopeError}. Matched by the last
   * path segment so a host-prefix difference doesn't cause a false negative.
   * Leave unset to skip the check (default).
   */
  requiredAnyScopes?: string[];
}

/**
 * Thrown when the member's Stytch-vaulted Google grant is missing every scope
 * the server needs. Distinct from a transport/Stytch error so callers can turn
 * it into a 403 with an actionable "re-consent" message instead of a 502.
 */
export class GoogleScopeError extends Error {
  readonly grantedScopes: string[];
  constructor(message: string, grantedScopes: string[]) {
    super(message);
    this.name = 'GoogleScopeError';
    this.grantedScopes = grantedScopes;
  }
}

export interface GoogleIdentityResolver {
  /** Resolve (and cache) the per-user Google OAuth2Client for a member. */
  resolve(organizationId: string, memberId: string): Promise<OAuth2Client>;
  /** Number of cached members (for tests/metrics). */
  cacheSize(): number;
}

interface CacheEntry {
  client: OAuth2Client;
  /** Epoch ms at which the cached access token should be considered stale. */
  expiresAtMs: number;
}

/** Live projects talk to api.stytch.com; everything else is the test host. */
export function deriveApiBase(projectId: string): string {
  return projectId.startsWith('project-live-')
    ? 'https://api.stytch.com'
    : 'https://test.stytch.com';
}

export function createGoogleIdentityResolver(cfg: ResolverConfig): GoogleIdentityResolver {
  const apiBase = (cfg.apiBase ?? deriveApiBase(cfg.projectId)).replace(/\/+$/, '');
  const now = cfg.now ?? (() => Date.now());
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const bufferMs = (cfg.refreshBufferSeconds ?? 60) * 1000;
  const authHeader =
    'Basic ' + Buffer.from(`${cfg.projectId}:${cfg.secret}`).toString('base64');
  const cache = new Map<string, CacheEntry>();

  const requiredAny = (cfg.requiredAnyScopes ?? []).filter(Boolean);
  const lastSeg = (s: string): string => s.split('/').pop() || s;
  function assertScopes(granted: string[]): void {
    if (requiredAny.length === 0) return;
    const grantedSegs = new Set(granted.map(lastSeg));
    if (requiredAny.some((r) => grantedSegs.has(lastSeg(r)))) return;
    throw new GoogleScopeError(
      `The signed-in Google account did not grant any scope this server needs ` +
        `(${requiredAny.map(lastSeg).join(', ')}). Granted: ` +
        `${granted.length ? granted.join(', ') : '(none)'}. Reconnect and approve ` +
        `Google Tag Manager / Analytics read access during sign-in.`,
      granted
    );
  }

  async function pullGoogleAccessToken(
    org: string,
    member: string
  ): Promise<{ accessToken: string; expiresInSec: number; scopes: string[] }> {
    const url =
      `${apiBase}/v1/b2b/organizations/${encodeURIComponent(org)}` +
      `/members/${encodeURIComponent(member)}/oauth_providers/google`;
    // No include_refresh_token — see file header.
    const res = await fetchImpl(url, { headers: { Authorization: authHeader } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Stytch get-google-access-token failed: HTTP ${res.status} ${body.slice(0, 200)}`
      );
    }
    const json = (await res.json()) as {
      access_token?: unknown;
      access_token_expires_in?: unknown;
      scopes?: unknown;
    };
    const accessToken = json.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Stytch get-google-access-token response had no access_token');
    }
    const expiresInSec =
      typeof json.access_token_expires_in === 'number' && json.access_token_expires_in > 0
        ? json.access_token_expires_in
        : 3600;
    const scopes = Array.isArray(json.scopes)
      ? json.scopes.filter((s): s is string => typeof s === 'string')
      : [];
    return { accessToken, expiresInSec, scopes };
  }

  return {
    async resolve(organizationId: string, memberId: string): Promise<OAuth2Client> {
      const key = `${organizationId}:${memberId}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAtMs > now()) {
        return hit.client;
      }

      const { accessToken, expiresInSec, scopes } = await pullGoogleAccessToken(
        organizationId,
        memberId
      );
      // Fail fast with an actionable error if the grant lacks every scope we
      // use, rather than letting a raw Google 403 surface deep in a tool call.
      assertScopes(scopes);
      const expiresAtMs = now() + expiresInSec * 1000 - bufferMs;

      if (hit) {
        // Reuse the same OAuth2Client instance across refreshes so the
        // downstream gtmClient/ga4Client WeakMaps (keyed by the instance)
        // stay valid — just swap in the fresh credentials.
        hit.client.setCredentials({ access_token: accessToken });
        hit.expiresAtMs = expiresAtMs;
        return hit.client;
      }

      // Bring-up aid: log the granted Google scopes once per member (stderr →
      // Render logs), so a missing tagmanager/analytics scope is visible without
      // STYTCH_DEBUG_CLAIMS. Member/org ids are identifiers, not secrets.
      console.error(
        `[samarth-gtm-mcp] resolved Google identity ${key} — granted scopes: ` +
          `${scopes.length ? scopes.join(' ') : '(none)'}`
      );
      const client = new OAuth2Client();
      client.setCredentials({ access_token: accessToken });
      cache.set(key, { client, expiresAtMs });
      return client;
    },

    cacheSize(): number {
      return cache.size;
    },
  };
}
