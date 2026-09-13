/**
 * GTM API v2 client factory.
 * Wraps the googleapis tagmanager v2 client with sensible defaults.
 */

// Import only the tagmanager sub-API rather than the full `googleapis` aggregate.
// The aggregate eagerly loads hundreds of API surfaces (~560ms / ~125MB RSS at
// startup); the per-API entrypoint exposes the same `tagmanager()` factory and
// `tagmanager_v2` types at a fraction of the cost (~90ms / ~57MB).
import { tagmanager, tagmanager_v2 } from 'googleapis/build/src/apis/tagmanager/index.js';
import type { OAuth2Client } from 'google-auth-library';
import { buildRetryOptions } from './apiRetry.js';

export type GtmClient = tagmanager_v2.Tagmanager;

// Cache one client per auth identity (not a single global) so the same process
// can serve multiple Google identities — see auth/identityContext.ts and
// docs/adr/0001. Keyed by the OAuth2Client instance; entries are GC'd when an
// auth goes out of scope. Same auth → same cached client; new auth → new client.
let _clients = new WeakMap<OAuth2Client, GtmClient>();

export function getGtmClient(auth: OAuth2Client): GtmClient {
  let client = _clients.get(auth);
  if (!client) {
    // Retry options apply to every request: transient 429/5xx on READ methods
    // back off and retry; mutations are never auto-retried. See apiRetry.ts.
    client = tagmanager({ version: 'v2', auth, ...buildRetryOptions() });
    _clients.set(auth, client);
  }
  return client;
}

/** Reset cached clients (useful in tests) */
export function resetGtmClient(): void {
  _clients = new WeakMap();
}
