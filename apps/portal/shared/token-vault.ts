// Encrypted token vault — provider interface + safe dev stub.
//
// FORWARD-LOOKING foundation. The product NEVER stores raw OAuth token bytes in
// Postgres or in a cookie at the production target (see
// docs/PRODUCTION_ARCHITECTURE.md §3). Postgres holds only metadata + an opaque
// `token_ref` (oauth_connections.token_ref); the bytes live in an external
// secret manager / KMS-encrypted vault resolvable ONLY by the backend service
// identity. This module defines the seam for that vault and ships a dev stub
// that is inert by default.
//
// Dependency-free and framework-free on purpose: safe to `import type` from the
// Vercel `api/**` routes. The CONCRETE provider (KMS, Supabase Vault, etc.) is
// pulled in lazily inside a handler after auth, exactly like the DB client.
//
// Recommended production providers (see the doc for the trade-offs):
//   * Supabase Vault            — pgsodium-backed, co-located with Postgres.
//   * GCP Secret Manager / KMS  — natural fit when on GCP; IAM-scoped.
//   * AWS Secrets Manager / KMS — natural fit when on AWS.
//   * HashiCorp Vault           — cloud-agnostic, dynamic secrets.
//   * 1Password Secrets Automation — small-team friendly.

/** The secret payload the vault stores. Token BYTES — never persisted to Postgres. */
export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (drives refresh timing). */
  accessExpiresAt?: number;
  scopes?: string[];
}

/**
 * Non-secret metadata the application keeps in Postgres (oauth_connections). The
 * vault returns this from `store()` so the caller can persist the reference and
 * expiry WITHOUT ever touching the bytes again.
 */
export interface TokenMetadata {
  /** Opaque pointer into the vault. Goes into oauth_connections.token_ref. */
  tokenRef: string;
  scopes: string[];
  accessExpiresAt: number | null;
  hasRefresh: boolean;
}

/**
 * The vault contract. Implementations resolve `tokenRef` against an external
 * secret store. `store` returns the metadata to persist; `get` resolves bytes
 * for an outbound Google call; `delete` revokes on disconnect.
 *
 * Invariants every implementation must hold:
 *   * `tokenRef` is opaque and unguessable — never derived from user input in a
 *     way the browser could forge, and never the token value itself.
 *   * bytes returned by `get` are never logged, cached, or sent to the browser.
 *   * `delete` is idempotent (deleting an absent ref is a no-op, not an error).
 */
export interface TokenVault {
  /** Store token bytes, returning the metadata to persist in Postgres. */
  store(token: StoredToken): Promise<TokenMetadata>;
  /** Resolve token bytes by reference, or null if absent/revoked. */
  get(tokenRef: string): Promise<StoredToken | null>;
  /** Idempotently delete the secret behind a reference. */
  delete(tokenRef: string): Promise<void>;
}

/** Derive the non-secret metadata view of a token (no bytes). */
export function metadataOf(tokenRef: string, token: StoredToken): TokenMetadata {
  return {
    tokenRef,
    scopes: token.scopes ?? [],
    accessExpiresAt: token.accessExpiresAt ?? null,
    hasRefresh: Boolean(token.refreshToken),
  };
}

/**
 * Generate an opaque, unguessable token reference. Uses Web Crypto
 * (`crypto.getRandomValues`), available in Node 18+ and the edge runtime, so no
 * `node:crypto` top-level import is needed (keeps this file `api/**`-safe).
 */
export function newTokenRef(prefix = "tok"): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `${prefix}_${hex}`;
}

/**
 * In-memory dev/test stub. INERT BY DEFAULT: constructing it without
 * `{ allowInMemoryTokens: true }` produces a vault that refuses to store bytes
 * and resolves nothing — so a misconfigured production deployment can never
 * silently hold real tokens in process memory. Tests and local dev opt in
 * explicitly.
 *
 * This stub holds bytes in a process-local Map; it is NOT durable and NOT for
 * production. It exists so route/worker code can be written against `TokenVault`
 * and exercised in tests without a live secret manager.
 */
export interface InMemoryVaultOptions {
  /** Must be explicitly true to store bytes; otherwise the vault is inert. */
  allowInMemoryTokens?: boolean;
}

export class InMemoryTokenVault implements TokenVault {
  private readonly enabled: boolean;
  private readonly store_ = new Map<string, StoredToken>();

  constructor(opts: InMemoryVaultOptions = {}) {
    this.enabled = opts.allowInMemoryTokens === true;
  }

  async store(token: StoredToken): Promise<TokenMetadata> {
    if (!this.enabled) {
      throw new TokenVaultDisabledError();
    }
    const ref = newTokenRef();
    // Copy so a later mutation of the caller's object can't change stored bytes.
    this.store_.set(ref, { ...token, scopes: token.scopes ? [...token.scopes] : undefined });
    return metadataOf(ref, token);
  }

  async get(tokenRef: string): Promise<StoredToken | null> {
    if (!this.enabled) return null;
    const t = this.store_.get(tokenRef);
    return t ? { ...t } : null;
  }

  async delete(tokenRef: string): Promise<void> {
    // Idempotent: absent ref is fine.
    this.store_.delete(tokenRef);
  }

  /** Test-only: how many secrets are held. Not part of the TokenVault contract. */
  get size(): number {
    return this.store_.size;
  }
}

/** Thrown when an inert in-memory vault is asked to store bytes. */
export class TokenVaultDisabledError extends Error {
  constructor() {
    super(
      "InMemoryTokenVault is inert: refusing to store token bytes. Pass " +
        "{ allowInMemoryTokens: true } for dev/test, or configure a real vault " +
        "provider in production.",
    );
    this.name = "TokenVaultDisabledError";
  }
}

/**
 * Vault provider selector. Reads env PRESENCE only (never a secret value) to
 * decide which provider a deployment intends to use. Returns a descriptor; the
 * concrete client is loaded lazily by the caller after auth (kept out of this
 * pure module so it stays `api/**`-import-safe).
 *
 * Today every production provider is "unconfigured" — the portal runs on
 * signed cookies and this returns `none`, matching
 * /api/system/capabilities `sessionMode: "signed_cookie"`.
 */
export type VaultProvider =
  | "none"
  | "supabase_vault"
  | "gcp_secret_manager"
  | "aws_secrets_manager"
  | "hashicorp_vault"
  | "memory";

export function detectVaultProvider(
  env: Record<string, string | undefined> = readEnv(),
): VaultProvider {
  const has = (k: string) => typeof env[k] === "string" && env[k]!.length > 0;
  if (has("SUPABASE_VAULT_URL") || has("SUPABASE_SERVICE_ROLE_KEY")) {
    return "supabase_vault";
  }
  if (has("GCP_KMS_KEY") || has("GOOGLE_CLOUD_PROJECT")) return "gcp_secret_manager";
  if (has("AWS_SECRETS_MANAGER_REGION") || has("AWS_KMS_KEY_ID")) {
    return "aws_secrets_manager";
  }
  if (has("VAULT_ADDR")) return "hashicorp_vault";
  if (has("TOKEN_VAULT_ALLOW_MEMORY")) return "memory";
  return "none";
}

function readEnv(): Record<string, string | undefined> {
  // Guarded so this module is import-safe even where `process` is absent.
  return typeof process !== "undefined" && process.env ? process.env : {};
}
