// Connectivity "Run Test": probes the endpoints this app actually depends on (Google APIs, tag
// serving, analytics collection) with one timed HTTPS request each. ANY HTTP status counts as
// reachable - what matters is DNS + TCP + TLS + a response; a 404 on a HEAD still proves the
// network path works. The prober is injectable so the mapping logic is unit-testable offline.

import { request } from 'node:https';

export interface EndpointCheck {
  host: string;
  label: string;
}

export interface EndpointResult {
  host: string;
  label: string;
  ok: boolean;
  /** Round-trip time to first response (or time-to-failure), in milliseconds. */
  ms: number;
  error?: string;
}

/** The service endpoints the app's features live on. Reachability here = audits/chat will work. */
export const DEFAULT_ENDPOINTS: EndpointCheck[] = [
  { host: 'www.googleapis.com', label: 'Google APIs (OAuth)' },
  { host: 'tagmanager.googleapis.com', label: 'GTM API' },
  { host: 'analyticsadmin.googleapis.com', label: 'GA4 Admin API' },
  { host: 'analyticsdata.googleapis.com', label: 'GA4 Data API' },
  { host: 'www.googletagmanager.com', label: 'Tag serving (gtm.js / gtag.js)' },
  { host: 'www.google-analytics.com', label: 'GA4 collection' },
];

export function probeHost(host: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = request({ method: 'HEAD', host, path: '/', timeout: timeoutMs }, (res) => {
      res.resume(); // drain - only the timing matters
      resolve({ ok: true, ms: Date.now() - started });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timed out'));
    });
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, error: (e as Error).message }));
    req.end();
  });
}

/** Probe every endpoint concurrently; result order always mirrors the endpoint list. */
export async function runNetworkTest(
  prober: (host: string) => Promise<{ ok: boolean; ms: number; error?: string }> = probeHost,
  endpoints: EndpointCheck[] = DEFAULT_ENDPOINTS
): Promise<EndpointResult[]> {
  return Promise.all(endpoints.map(async (e) => ({ ...e, ...(await prober(e.host)) })));
}
