/**
 * Per-request identity context for the MCP server.
 *
 * The hosted server is moving to multi-user mode (see
 * docs/adr/0001-hosted-mcp-oauth-authorization-server.md): a single process
 * serves many Google identities, each user acting on their own GTM/GA4
 * permissions. Tool handlers resolve their GTM/GA4 client lazily at call time,
 * so the active identity has to be carried implicitly across the async call
 * chain rather than threaded through every function signature.
 * `AsyncLocalStorage` does exactly that, and is concurrency-safe: two requests
 * for different users that are in flight at the same time each run inside their
 * own store, so `resolveAuth()` returns the correct client for each.
 *
 * This is the Phase 1 seam. The single-identity stdio path and the current
 * single-token HTTP path keep working unchanged: when no store is active,
 * `resolveAuth()` returns the fallback auth the server was built with. A later
 * phase sets the store per HTTP request to the user's brokered Google client.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OAuth2Client } from 'google-auth-library';

interface IdentityStore {
  auth: OAuth2Client;
}

const storage = new AsyncLocalStorage<IdentityStore>();

/** Run `fn` with `auth` as the active identity for the current async context. */
export function runWithAuth<T>(auth: OAuth2Client, fn: () => T): T {
  return storage.run({ auth }, fn);
}

/** The active per-request auth, or `undefined` outside any identity context. */
export function getActiveAuth(): OAuth2Client | undefined {
  return storage.getStore()?.auth;
}

/**
 * Resolve the auth to use right now: the active per-request identity if one is
 * set, otherwise `fallback` (the server's default/global identity).
 */
export function resolveAuth(fallback: OAuth2Client): OAuth2Client {
  return storage.getStore()?.auth ?? fallback;
}
