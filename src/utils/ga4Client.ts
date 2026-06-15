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
import { buildRetryOptions } from './apiRetry.js';

export type Ga4AdminClient = analyticsadmin_v1beta.Analyticsadmin;
export type Ga4AdminAlphaClient = analyticsadmin_v1alpha.Analyticsadmin;
export type Ga4DataClient = analyticsdata_v1beta.Analyticsdata;

// One client per auth identity (not a single global), so the process can serve
// multiple Google identities — see auth/identityContext.ts and docs/adr/0001.
// Keyed by the OAuth2Client instance; entries GC'd when the auth goes away.
let _clients = new WeakMap<OAuth2Client, Ga4AdminClient>();
let _alphaClients = new WeakMap<OAuth2Client, Ga4AdminAlphaClient>();
let _dataClients = new WeakMap<OAuth2Client, Ga4DataClient>();

export function getGa4AdminClient(auth: OAuth2Client): Ga4AdminClient {
  let client = _clients.get(auth);
  if (!client) {
    // All GA4 tools are read-only (GET), so retry/backoff applies to every
    // call this client makes. See apiRetry.ts.
    client = analyticsadmin({ version: 'v1beta', auth, ...buildRetryOptions() });
    _clients.set(auth, client);
  }
  return client;
}

/**
 * v1alpha client — used only for read methods that v1beta does not yet expose
 * (currently: enhanced measurement settings). Same read-only scope applies.
 */
export function getGa4AdminAlphaClient(auth: OAuth2Client): Ga4AdminAlphaClient {
  let client = _alphaClients.get(auth);
  if (!client) {
    client = analyticsadmin({ version: 'v1alpha', auth, ...buildRetryOptions() });
    _alphaClients.set(auth, client);
  }
  return client;
}

/**
 * GA4 Data API client (analyticsdata v1beta). Used ONLY for read-only reporting
 * (`runReport`, `runRealtimeReport`). The same `analytics.readonly` scope that
 * authorizes the Admin client also authorizes Data API reads — no extra scope.
 */
export function getGa4DataClient(auth: OAuth2Client): Ga4DataClient {
  let client = _dataClients.get(auth);
  if (!client) {
    // runReport/runRealtimeReport are pure reads carried over POST, and this
    // client has no mutating surface, so POST retry is safe here (and only here).
    client = analyticsdata({
      version: 'v1beta',
      auth,
      ...buildRetryOptions(process.env, { extraMethodsToRetry: ['POST'] }),
    });
    _dataClients.set(auth, client);
  }
  return client;
}

/** Reset cached clients (useful in tests). */
export function resetGa4AdminClient(): void {
  _clients = new WeakMap();
  _alphaClients = new WeakMap();
  _dataClients = new WeakMap();
}
