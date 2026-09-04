/**
 * Stytch Connected App access-token validator — Phase 3, slice 2.
 *
 * Validates the JWT an MCP client presents on /mcp (issued by Stytch as the
 * Authorization Server). Dependency-free: uses Node's built-in crypto to verify
 * the RS256 signature against Stytch's JWKS, then checks expiry/issuer/audience
 * and extracts the member + organization + scopes.
 *
 * Why no library: keeps the MCP server's dependency surface minimal (matching
 * the rest of src/), and avoids editing package.json. The verification is
 * standard JWKS/RS256 — the security-sensitive bits (alg pinning, signature,
 * expiry) are all enforced here.
 *
 * Bring-up: set STYTCH_DEBUG_CLAIMS=true to log the decoded claims (to stderr)
 * the first time a real token arrives, so we can confirm the exact claim names
 * Stytch uses for organization_id / member_id and then pin issuer/audience.
 */
import crypto from 'node:crypto';

export interface StytchClaims {
  /** The full decoded JWT payload. */
  raw: Record<string, unknown>;
  /** Member id — the per-user identity (maps to Stytch member_id). */
  memberId: string;
  /** Organization id the member belongs to. */
  organizationId: string;
  /** Granted scopes. */
  scopes: string[];
}

export interface ValidatorConfig {
  /** Stytch JWKS URL for this project. */
  jwksUrl: string;
  /** If set, the token's `iss` must equal this. */
  issuer?: string;
  /** If set, the token's `aud` must include this. */
  audience?: string;
  /** Clock injection (ms epoch). */
  now?: () => number;
  /** fetch injection (tests). */
  fetchImpl?: typeof fetch;
  /** JWKS cache lifetime (ms). Default 1h. */
  jwksCacheMs?: number;
  /** Allowed clock skew for exp/nbf (seconds). Default 30. */
  clockSkewSeconds?: number;
  /** Log decoded claims to stderr (bring-up only). */
  debugClaims?: boolean;
}

export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenValidationError';
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  [k: string]: unknown;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(b64urlToBuffer(part).toString('utf8')) as Record<string, unknown>;
}

export interface StytchTokenValidator {
  validate(token: string): Promise<StytchClaims>;
}

export function createStytchTokenValidator(cfg: ValidatorConfig): StytchTokenValidator {
  const now = cfg.now ?? (() => Date.now());
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const cacheMs = cfg.jwksCacheMs ?? 3_600_000;
  const skew = (cfg.clockSkewSeconds ?? 30) * 1000;

  let cachedKeys: Jwk[] | null = null;
  let fetchedAt = 0;
  // Throttle for kid-miss refreshes. A kid we have never seen used to force a JWKS
  // fetch on EVERY request, so anyone who can reach /mcp could turn unauthenticated
  // traffic into the same volume of outbound requests to Stytch, and once Stytch rate
  // limits the JWKS endpoint a real token arriving after the cache TTL is rejected.
  // A genuine key rotation is still picked up within one cooldown window.
  const forcedRefreshCooldownMs = 60_000;
  // -Infinity so the first kid miss of the process always refreshes, whatever the clock.
  let lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

  async function getKeys(forceRefresh: boolean): Promise<Jwk[]> {
    if (!forceRefresh && cachedKeys && now() - fetchedAt < cacheMs) {
      return cachedKeys;
    }
    const res = await fetchImpl(cfg.jwksUrl);
    if (!res.ok) {
      throw new TokenValidationError(`JWKS fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    cachedKeys = Array.isArray(body.keys) ? body.keys : [];
    fetchedAt = now();
    return cachedKeys;
  }

  async function findKey(kid: string | undefined): Promise<Jwk> {
    let keys = await getKeys(false);
    let key = keys.find((k) => k.kid === kid) ?? (kid ? undefined : keys[0]);
    if (!key) {
      // Key not found: keys may have rotated, so refresh once, but at most once per
      // cooldown window (see forcedRefreshCooldownMs). Claim the window BEFORE awaiting
      // the fetch so a burst of concurrent unknown-kid requests cannot all get through.
      if (now() - lastForcedRefreshAt >= forcedRefreshCooldownMs) {
        lastForcedRefreshAt = now();
        keys = await getKeys(true);
        key = keys.find((k) => k.kid === kid) ?? (kid ? undefined : keys[0]);
      }
    }
    if (!key) throw new TokenValidationError(`no JWKS key for kid=${kid ?? '(none)'}`);
    return key;
  }

  function extract(payload: Record<string, unknown>): StytchClaims {
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    // Candidate locations for organization_id across Stytch token shapes.
    const orgClaim =
      (payload['organization_id'] as string | undefined) ??
      ((payload['https://stytch.com/organization'] as { organization_id?: string } | undefined)
        ?.organization_id) ??
      ((payload['organization'] as { organization_id?: string } | undefined)?.organization_id);
    const scopeRaw = payload['scope'] ?? payload['scopes'];
    const scopes =
      typeof scopeRaw === 'string'
        ? scopeRaw.split(' ').filter(Boolean)
        : Array.isArray(scopeRaw)
          ? (scopeRaw as string[])
          : [];

    if (cfg.debugClaims) {
      // stderr only — never the JSON-RPC stdout channel.
      console.error('[samarth-gtm-mcp] Stytch token claims:', JSON.stringify(payload));
    }
    if (!sub) throw new TokenValidationError('token has no sub (member id)');
    if (!orgClaim) throw new TokenValidationError('token has no organization_id claim');
    return { raw: payload, memberId: sub, organizationId: orgClaim, scopes };
  }

  return {
    async validate(token: string): Promise<StytchClaims> {
      if (!token || typeof token !== 'string') {
        throw new TokenValidationError('missing token');
      }
      const parts = token.split('.');
      if (parts.length !== 3) throw new TokenValidationError('malformed JWT');
      const [headerB64, payloadB64, sigB64] = parts;

      const header = decodeJson(headerB64) as { alg?: string; kid?: string };
      // Pin the algorithm — reject "none" and HMAC (algorithm-confusion defense).
      if (header.alg !== 'RS256') {
        throw new TokenValidationError(`unsupported alg: ${header.alg}`);
      }

      const jwk = await findKey(header.kid);
      let keyObject: crypto.KeyObject;
      try {
        keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      } catch {
        throw new TokenValidationError('invalid JWKS key');
      }

      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
      const ok = crypto.verify(
        'RSA-SHA256',
        signingInput,
        keyObject,
        b64urlToBuffer(sigB64)
      );
      if (!ok) throw new TokenValidationError('signature verification failed');

      const payload = decodeJson(payloadB64);

      const nowSec = now() / 1000;
      const skewSec = skew / 1000;
      // Require a numeric exp: a validly-signed token that OMITS exp (or encodes it as a string) must be
      // REJECTED, not accepted with an unbounded lifetime — otherwise it would authenticate forever,
      // defeating the short-lived-token model. (The signature is already pinned to RS256 above.)
      if (typeof payload.exp !== 'number') {
        throw new TokenValidationError('token missing a numeric exp claim');
      }
      if (payload.exp + skewSec < nowSec) {
        throw new TokenValidationError('token expired');
      }
      if (typeof payload.nbf === 'number' && payload.nbf - skewSec > nowSec) {
        throw new TokenValidationError('token not yet valid');
      }
      if (cfg.issuer && payload.iss !== cfg.issuer) {
        throw new TokenValidationError('issuer mismatch');
      }
      if (cfg.audience) {
        const aud = payload.aud;
        const audOk =
          aud === cfg.audience ||
          (Array.isArray(aud) && (aud as unknown[]).includes(cfg.audience));
        if (!audOk) throw new TokenValidationError('audience mismatch');
      }

      return extract(payload);
    },
  };
}
