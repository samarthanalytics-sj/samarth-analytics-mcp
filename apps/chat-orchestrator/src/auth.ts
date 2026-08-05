/**
 * Supabase access-token verification.
 *
 * Dependency-free RS256/ES256 JWT validation against the project's JWKS, using node:crypto. The
 * platform's users already hold a Supabase session, so the browser sends that access token and the
 * orchestrator trusts nothing else: user and org identity always come from verified claims, never
 * from the request body.
 */
import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import type { AuthedUser } from './types.js';

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 30;
const SUPPORTED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'ES256']);

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code = 'unauthorized',
  ) {
    super(message);
  }
}

function b64uToBuf(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64uToJson<T>(input: string): T {
  return JSON.parse(b64uToBuf(input).toString('utf8')) as T;
}

export class SupabaseTokenVerifier {
  private keys: Jwk[] = [];
  private fetchedAt = 0;

  constructor(
    private readonly jwksUrl: string,
    private readonly opts: { issuer?: string; audience?: string } = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async loadKeys(force = false): Promise<Jwk[]> {
    const fresh = Date.now() - this.fetchedAt < JWKS_TTL_MS;
    if (!force && fresh && this.keys.length) return this.keys;

    const res = await this.fetchImpl(this.jwksUrl);
    if (!res.ok) {
      throw new AuthError(`JWKS fetch failed with ${res.status}`, 'jwks_unavailable');
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new AuthError('JWKS response contained no keys', 'jwks_unavailable');
    }
    this.keys = body.keys;
    this.fetchedAt = Date.now();
    return this.keys;
  }

  private async keyFor(kid: string | undefined): Promise<Jwk> {
    let keys = await this.loadKeys();
    let match = kid ? keys.find((k) => k.kid === kid) : keys[0];
    if (!match) {
      // A rotated key is the common cause of a kid miss; refresh once before giving up.
      keys = await this.loadKeys(true);
      match = kid ? keys.find((k) => k.kid === kid) : keys[0];
    }
    if (!match) throw new AuthError('No matching signing key for token', 'unknown_key');
    return match;
  }

  async verify(token: string): Promise<AuthedUser> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed token');

    const [rawHeader, rawPayload, rawSignature] = parts;
    const header = b64uToJson<{ alg?: string; kid?: string }>(rawHeader);

    // Pin the algorithm family: accepting "none" or an HMAC alg here would let a caller sign
    // their own token with the public key.
    if (!header.alg || !SUPPORTED_ALGS.has(header.alg)) {
      throw new AuthError(`Unsupported token algorithm ${header.alg ?? 'none'}`, 'bad_algorithm');
    }

    const jwk = await this.keyFor(header.kid);
    const keyObject = createPublicKey({ key: jwk as never, format: 'jwk' });

    const algo = header.alg === 'ES256' ? 'sha256' : `sha${header.alg.slice(2)}`;
    const verifier = createVerify(algo);
    verifier.update(`${rawHeader}.${rawPayload}`);
    verifier.end();

    const signature = b64uToBuf(rawSignature);
    const ok = verifier.verify(
      header.alg === 'ES256' ? { key: keyObject, dsaEncoding: 'ieee-p1363' } : keyObject,
      signature,
    );
    if (!ok) throw new AuthError('Token signature verification failed', 'bad_signature');

    const payload = b64uToJson<{
      sub?: string;
      email?: string;
      exp?: number;
      nbf?: number;
      iss?: string;
      aud?: string | string[];
    }>(rawPayload);

    const now = Math.floor(Date.now() / 1000);
    // An unbounded token is not acceptable even when correctly signed.
    if (typeof payload.exp !== 'number') throw new AuthError('Token has no exp claim', 'no_expiry');
    if (payload.exp + CLOCK_SKEW_SEC < now) throw new AuthError('Token expired', 'auth_expired');
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > now) {
      throw new AuthError('Token not yet valid', 'not_yet_valid');
    }
    if (this.opts.issuer && payload.iss !== this.opts.issuer) {
      throw new AuthError('Token issuer mismatch', 'bad_issuer');
    }
    if (this.opts.audience) {
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud ?? ''];
      const wanted = Buffer.from(this.opts.audience);
      const matched = auds.some((a) => {
        const got = Buffer.from(a ?? '');
        return got.length === wanted.length && timingSafeEqual(got, wanted);
      });
      if (!matched) throw new AuthError('Token audience mismatch', 'bad_audience');
    }
    if (!payload.sub) throw new AuthError('Token has no subject', 'no_subject');

    return { id: payload.sub, email: payload.email };
  }
}
