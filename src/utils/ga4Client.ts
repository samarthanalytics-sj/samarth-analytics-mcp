/**
 * Google Analytics Admin API (GA4) client factory.
 *
 * Wraps the googleapis analyticsadmin v1beta client. The server only ever uses
 * read methods (list/get) on this client — no GA4 resource is created, updated,
 * or deleted. The same OAuth2 credentials used for GTM authorize these calls,
 * provided the `analytics.readonly` scope was granted during onboarding.
 */

// Import only the analytics sub-APIs instead of the full `googleapis` aggregate.
// The aggregate eagerly evaluates every Google API (~560ms / ~125MB RSS at
// startup); these per-API entrypoints expose the same factory functions and
// namespaces at a fraction of the cost. See gtmClient.ts for the same pattern.
import {
  analyticsadmin,
  analyticsadmin_v1beta,
  analyticsadmin_v1alpha,
} from 'googleapis/build/src/apis/analyticsadmin/index.js';
import {
  analyticsdata,
  analyticsdata_v1beta,
} from 'googleapis/build/src/apis/analyticsdata/index.js';
import type { OAuth2Client } from 'google-auth-library';

export type Ga4AdminClient = analyticsadmin_v1beta.Analyticsadmin;
export type Ga4AdminAlphaClient = analyticsadmin_v1alpha.Analyticsadmin;
export type Ga4DataClient = analyticsdata_v1beta.Analyticsdata;

let _client: Ga4AdminClient | null = null;
let _alphaClient: Ga4AdminAlphaClient | null = null;
let _dataClient: Ga4DataClient | null = null;

export function getGa4AdminClient(auth: OAuth2Client): Ga4AdminClient {
  if (!_client) {
    _client = analyticsadmin({ version: 'v1beta', auth });
  }
  return _client;
}

/**
 * v1alpha client — used only for read methods that v1beta does not yet expose
 * (currently: enhanced measurement settings). Same read-only scope applies.
 */
export function getGa4AdminAlphaClient(auth: OAuth2Client): Ga4AdminAlphaClient {
  if (!_alphaClient) {
    _alphaClient = analyticsadmin({ version: 'v1alpha', auth });
  }
  return _alphaClient;
}

/**
 * GA4 Data API client (analyticsdata v1beta). Used ONLY for read-only reporting
 * (`runReport`, `runRealtimeReport`). The same `analytics.readonly` scope that
 * authorizes the Admin client also authorizes Data API reads — no extra scope.
 */
export function getGa4DataClient(auth: OAuth2Client): Ga4DataClient {
  if (!_dataClient) {
    _dataClient = analyticsdata({ version: 'v1beta', auth });
  }
  return _dataClient;
}

/** Reset clients (useful in tests). */
export function resetGa4AdminClient(): void {
  _client = null;
  _alphaClient = null;
  _dataClient = null;
}
