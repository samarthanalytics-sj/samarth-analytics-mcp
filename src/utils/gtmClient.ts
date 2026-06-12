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

let _client: GtmClient | null = null;

export function getGtmClient(auth: OAuth2Client): GtmClient {
  if (!_client) {
    // Retry options apply to every request: transient 429/5xx on READ methods
    // back off and retry; mutations are never auto-retried. See apiRetry.ts.
    _client = tagmanager({ version: 'v2', auth, ...buildRetryOptions() });
  }
  return _client;
}

/** Reset client (useful in tests) */
export function resetGtmClient(): void {
  _client = null;
}
