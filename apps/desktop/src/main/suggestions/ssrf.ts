// Shared SSRF guard for every scraping engine (Electron / Cheerio / Playwright).
// Beyond the hostname-STRING check (urlAllowed), it RESOLVES named hosts and
// blocks when any resolved IP is private/loopback/metadata — closing the common
// DNS-rebind / internal-name vector a string check misses. Fails closed.

import { lookup as dnsLookup } from 'node:dns/promises';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';

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
      if (!urlAllowed(probe, []).ok) return false; // resolves to a private IP → block
    }
    return addrs.length > 0;
  } catch {
    return false; // fail closed on resolution error
  }
}
