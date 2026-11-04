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

/** The slice of dns.promises.lookup this module uses; injectable so the guard is testable offline. */
export type HostLookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

/**
 * True when every address `hostname` resolves to is public, false when any is private. Null when
 * the lookup itself failed: callers fail closed on it, but it is not an answer about the host, so a
 * memo must not keep it (one EAI_AGAIN would otherwise block that host for the rest of the scan).
 */
async function resolvesPublic(hostname: string, lookup: HostLookup): Promise<boolean | null> {
  try {
    const addrs = await lookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      const probe = family === 6 ? `http://[${address}]` : `http://${address}`;
      if (!urlAllowed(probe, []).ok) return false; // resolves to a private IP -> block
    }
    return addrs.length > 0;
  } catch {
    return null; // resolution error: refused by the caller, never remembered
  }
}

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
  return (await resolvesPublic(hostname, dnsLookup)) === true; // fail closed on a lookup error
}

/** Bound on remembered hosts, so a page that fans out to thousands of hosts cannot grow it forever. */
const MAX_GUARDED_HOSTS = 500;

/**
 * requestAllowed for a browser route interceptor, which sees every subresource: same verdict, but
 * the DNS answer is remembered per host (in-flight lookups shared), so a page pulling 200 assets
 * from one CDN costs one lookup rather than 200. Create one per browser context so the memo lives
 * no longer than the page load it serves.
 *
 * Only a real answer is remembered. A failed lookup refuses the requests waiting on it and is then
 * forgotten, so the next request for that host asks again: one guard can serve every page a scan
 * worker or crawl loads, and a transient resolver error must not block a host for all of them.
 *
 * This checks the name before Chromium resolves it itself, so a host that re-points between the
 * two lookups (DNS rebinding) is still not fully closed; that needs Chromium's own resolver pinned
 * (--host-resolver-rules) or an egress proxy. What it does close is the common case the string
 * check misses: a public-looking NAME that resolves inside (metadata.google.internal,
 * 127.0.0.1.nip.io, a docker service name).
 */
export function createRequestGuard(lookup: HostLookup = dnsLookup): (rawUrl: string) => Promise<boolean> {
  const byHost = new Map<string, Promise<boolean | null>>();
  return async (rawUrl: string): Promise<boolean> => {
    if (!urlAllowed(rawUrl, []).ok) return false;
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname;
    } catch {
      return false;
    }
    if (isIpLiteral(hostname)) return true; // already covered by urlAllowed above
    let verdict = byHost.get(hostname);
    if (!verdict) {
      if (byHost.size >= MAX_GUARDED_HOSTS) byHost.clear();
      const pending = resolvesPublic(hostname, lookup);
      verdict = pending;
      byHost.set(hostname, pending);
      // Registered before any caller awaits, so it runs first: by the time this request is
      // refused, the failed lookup is already gone and the next request retries it.
      void pending.then((v) => {
        if (v === null && byHost.get(hostname) === pending) byHost.delete(hostname);
      });
    }
    return (await verdict) === true; // a lookup error (null) still fails closed
  };
}

const UA = 'Mozilla/5.0 (compatible; SamarthTagSuggest/1.0; +read-only scan)';
const MAX_BODY_BYTES = 8_000_000; // cap response bodies (sitemaps/HTML) to bound memory

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  body: string;
}

/** Discard a body we will not read, so its socket is released now rather than at timeout or GC. */
async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/**
 * Read at most `max` bytes of the body, then cancel the rest. res.text() would buffer ALL of it
 * before any slice: a chunked body with no Content-Length, or a small gzip body that inflates (fetch
 * decodes Content-Encoding before res.body), costs hundreds of MB. res.body is already decoded, so
 * counting bytes here bounds the decoded size too.
 */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, max - kept);
    chunks.push(take === value.byteLength ? value : value.subarray(0, take));
    kept += take;
    if (kept >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
      await discardBody(res);
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, finalUrl: current, body: '' };
      current = new URL(loc, current).href;
      continue;
    }
    // Bound memory: reject a declared-huge body, and stop READING at the cap (a declared length
    // cannot be trusted: chunked bodies have none, and a gzip body declares its compressed size).
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      await discardBody(res);
      throw new Error('response too large');
    }
    if (res.status >= 400) {
      await discardBody(res);
      return { status: res.status, finalUrl: current, body: '' };
    }
    const body = await readCapped(res, MAX_BODY_BYTES);
    return { status: res.status, finalUrl: current, body };
  }
  throw new Error('too many redirects');
}
