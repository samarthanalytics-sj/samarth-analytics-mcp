// SSRF-safe plain HTTP GET, for the things that do not need a browser: robots.txt, sitemap XML.
//
// Beyond the hostname-STRING check (urlAllowed) it RESOLVES named hosts and blocks when any
// resolved IP is private/loopback/metadata, closing the DNS-rebind and internal-name vector a
// string check misses. Fails closed.
//
// Lives here rather than in the desktop, which is where it was written, because its only dependency
// is this package's own urlGuard and both the desktop and this server need it. The desktop's
// suggestions/ssrf.ts now re-exports this, so there is one guard to fix rather than two to keep in
// step.

import { lookup as dnsLookup } from 'node:dns/promises';
import { urlAllowed } from './urlGuard.js';

const isIpLiteral = (hostname: string): boolean => /^[\d.]+$/.test(hostname) || hostname.includes(':');

/** True if rawUrl is allowed AND (for named hosts) every resolved IP is public. */
export async function requestAllowed(rawUrl: string): Promise<boolean> {
  // String check first: scheme, allowlist, IP-LITERAL private ranges.
  if (!urlAllowed(rawUrl, []).ok) return false;
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (isIpLiteral(hostname)) return true; // already covered by urlAllowed above
  try {
    const addrs = await dnsLookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      const probe = family === 6 ? `http://[${address}]` : `http://${address}`;
      if (!urlAllowed(probe, []).ok) return false; // resolves to a private IP -> block
    }
    return addrs.length > 0;
  } catch {
    return false; // fail closed on resolution error
  }
}

const UA = 'Mozilla/5.0 (compatible; SamarthTagSuggest/1.0; +read-only scan)';
const MAX_BODY_BYTES = 8_000_000; // cap response bodies (sitemaps/HTML) to bound memory

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  body: string;
}

/**
 * SSRF-safe HTTP GET: follows redirects MANUALLY, re-checking requestAllowed at every hop, so a
 * public host cannot redirect us at a private/loopback/metadata address. Returns the final status
 * and body (empty for >=400). Throws on a blocked URL, network error, or too many redirects.
 */
export async function safeFetch(
  url: string,
  timeoutMs = 15_000,
  accept = 'text/html,application/xhtml+xml',
): Promise<SafeFetchResult> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!(await requestAllowed(current))) throw new Error('blocked by SSRF guard');
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, finalUrl: current, body: '' };
      current = new URL(loc, current).href;
      continue;
    }
    // Bound memory: reject a declared-huge body, and cap what we keep/parse.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) throw new Error('response too large');
    const body = res.status >= 400 ? '' : (await res.text()).slice(0, MAX_BODY_BYTES);
    return { status: res.status, finalUrl: current, body };
  }
  throw new Error('too many redirects');
}
