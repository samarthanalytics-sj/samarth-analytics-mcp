// SSRF URL guard for the runtime capture worker.
//
// The worker loads attacker-influenced URLs in a real browser, so it is a prime
// SSRF target: a request can be steered at cloud metadata (169.254.169.254),
// loopback, or RFC-1918 hosts to read internal services. This module is the
// single source of truth for "is this URL safe to load", used at request
// admission (server.mjs), on every routed in-browser request (capture.mjs route
// interceptor), and on every redirect hop after navigation (watchLanding).
// Playwright never routes a redirect hop, so a redirect from an allowlisted page
// to an internal host is NOT stopped in the browser (that needs egress control:
// an SSRF-filtering proxy or --host-resolver-rules); watchLanding makes sure
// nothing read from such a page is kept.
//
// It is intentionally dependency-free (only `node:*`) so it can be `node --check`ed
// and unit-tested without installing the browser.

import { lookup as dnsLookup } from "node:dns/promises";

// Literal private/loopback/link-local IP ranges we never load, independent of
// any allowlist. Link-local 169.254.0.0/16 includes the cloud metadata endpoint
// 169.254.169.254 (AWS/GCP/Azure), the highest-value SSRF target.
function isPrivateIpv4(host) {
  // Reject anything that is not a clean dotted-quad up front; encoded forms
  // (decimal/octal/hex) are normalized separately before this is called.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map((n) => Number(n));
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIpv6(host) {
  // Strip brackets and any zone id, lowercase.
  let h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped / -compatible in dotted form (::ffff:127.0.0.1): defer the
  // embedded v4 to the v4 checker.
  const mappedDotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
  // The URL parser often compresses ::ffff:127.0.0.1 to its hex form
  // (::ffff:7f00:1). Decode the trailing two hextets back to an IPv4 and check.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    return isPrivateIpv4(v4);
  }
  if (/^fc/.test(h) || /^fd/.test(h)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
  return false;
}

// Decode an integer/octal/hex IPv4 representation (e.g. http://2130706433/ =
// 127.0.0.1, http://0x7f000001/, http://0177.0.0.1/) into dotted-quad so the
// private-range check cannot be bypassed by an alternate encoding. Returns null
// if the host is not a single all-numeric token.
function normalizeNumericHost(host) {
  // Already dotted-quad with non-decimal octets (hex/octal) → normalize each.
  if (/^[0-9a-fx.]+$/i.test(host) && host.includes(".")) {
    const parts = host.split(".");
    if (parts.length === 4) {
      const nums = parts.map(parseIpOctet);
      if (nums.every((n) => n !== null && n >= 0 && n <= 255)) {
        return nums.join(".");
      }
    }
  }
  // Single integer (decimal/hex/octal) → 32-bit dotted-quad.
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(host)) {
    const n = parseIpOctet(host);
    if (n !== null && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(
        ".",
      );
    }
  }
  return null;
}

function parseIpOctet(tok) {
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
  if (/^0[0-7]+$/.test(tok)) return parseInt(tok, 8);
  if (/^[0-9]+$/.test(tok)) return parseInt(tok, 10);
  return null;
}

/**
 * Decide whether a URL is safe for the worker to load.
 *
 * @param {string} rawUrl
 * @param {string[]} [allowlist] host suffixes (lowercased). When non-empty the
 *   host must match one; when empty any non-private host is allowed.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function urlAllowed(rawUrl, allowlist = []) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http(s) URLs are allowed" };
  }

  let host = parsed.hostname.toLowerCase();
  // Strip IPv6 brackets for the literal-name comparisons below. Trailing dots
  // name the same host in absolute (FQDN) form — "localhost." and
  // "foo.localhost.." resolve to loopback — so strip them too, before the name
  // and allowlist checks.
  const bareHost = host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "");

  if (
    bareHost === "localhost" ||
    bareHost === "ip6-localhost" ||
    bareHost === "ip6-loopback" ||
    bareHost.endsWith(".localhost")
  ) {
    return { ok: false, reason: "private/loopback addresses are not allowed" };
  }

  // IPv6 literal (URL keeps the brackets in hostname).
  if (host.includes(":")) {
    if (isPrivateIpv6(host)) {
      return { ok: false, reason: "private/loopback addresses are not allowed" };
    }
  } else {
    // Normalize any alternate IPv4 encoding to dotted-quad before range checks.
    const normalized = normalizeNumericHost(bareHost) ?? bareHost;
    if (isPrivateIpv4(normalized)) {
      return { ok: false, reason: "private/loopback addresses are not allowed" };
    }
  }

  if (allowlist.length > 0) {
    const matches = allowlist.some(
      (suffix) => bareHost === suffix || bareHost.endsWith(`.${suffix}`),
    );
    if (!matches) {
      return { ok: false, reason: "host not in RUNTIME_WORKER_ALLOWLIST" };
    }
  }
  return { ok: true };
}

const isIpLiteral = (hostname) => /^[\d.]+$/.test(hostname) || hostname.includes(":");

// Bound on remembered hosts, so a page that fans out to thousands of hosts
// cannot grow the memo forever.
const MAX_GUARDED_HOSTS = 500;

/**
 * Build the per-request guard for the in-browser route interceptor.
 *
 * urlAllowed is a hostname-STRING check, so a public-looking NAME that resolves
 * inside (metadata.google.internal, 127.0.0.1.nip.io, a docker service name)
 * passes it. This guard additionally DNS-resolves named hosts and refuses the
 * request when any resolved address is private/loopback/metadata. It fails
 * closed on a resolution error. The answer is remembered per host (in-flight
 * lookups shared) because the interceptor sees every subresource; create one
 * guard per browser context so the memo lives no longer than the capture.
 * Only a real answer is remembered: a failed lookup refuses the requests
 * waiting on it and is then forgotten, so one transient resolver error
 * (EAI_AGAIN) does not block that host for every remaining URL in the state.
 *
 * The name is checked before Chromium resolves it itself, so a host that
 * re-points between the two lookups (DNS rebinding) is not fully closed; that
 * needs Chromium's resolver pinned (--host-resolver-rules) or an egress proxy.
 *
 * Mirrors createRequestGuard in apps/web-audit-mcp/src/utils/safeFetch.ts.
 *
 * @param {(hostname: string, options: { all: true }) => Promise<{ address: string, family: number }[]>} [lookup]
 *   injectable resolver (defaults to node:dns lookup) so this is testable offline.
 * @returns {(rawUrl: string) => Promise<boolean>}
 */
export function createRequestGuard(lookup = dnsLookup) {
  const byHost = new Map();
  // true = all public, false = resolves private, null = the lookup itself
  // failed (refused, but not an answer about the host, so never remembered).
  const resolvesPublic = async (hostname) => {
    try {
      const addrs = await lookup(hostname, { all: true });
      for (const { address, family } of addrs) {
        const probe = family === 6 ? `http://[${address}]` : `http://${address}`;
        if (!urlAllowed(probe, []).ok) return false; // resolves to a private IP -> block
      }
      return addrs.length > 0;
    } catch {
      return null; // resolution error: fail closed below, and forget it
    }
  };
  return async (rawUrl) => {
    if (!urlAllowed(rawUrl, []).ok) return false;
    let hostname;
    try {
      hostname = new URL(rawUrl).hostname;
    } catch {
      return false;
    }
    if (isIpLiteral(hostname)) return true; // already covered by urlAllowed above
    let verdict = byHost.get(hostname);
    if (!verdict) {
      if (byHost.size >= MAX_GUARDED_HOSTS) byHost.clear();
      const pending = resolvesPublic(hostname);
      verdict = pending;
      byHost.set(hostname, pending);
      // Registered before any caller awaits, so it runs first: by the time
      // this request is refused, the failed lookup is gone and the next
      // request for the host retries it.
      void pending.then((v) => {
        if (v === null && byHost.get(hostname) === pending) byHost.delete(hostname);
      });
    }
    return (await verdict) === true; // a lookup error (null) still fails closed
  };
}

const MAX_REDIRECT_CHAIN = 25;

/**
 * Re-check the redirect hops Playwright never routes.
 *
 * A context.route handler sees only the FIRST URL of a redirect chain; every
 * later hop is continued by Playwright itself, so a public URL that 302s to a
 * private/loopback/metadata address is loaded. Register this on the page before
 * goto, then call blockedLanding(resp) after goto and again after reading the
 * page: it returns a refusal note when any redirect hop the page saw (main
 * frame, iframe or subresource), the response's own redirect chain, or where the
 * page and its frames now are fails `requestAllowed`, else null. A refusal moves
 * the page to about:blank; the caller must discard whatever it read.
 *
 * Mirrors watchLanding in apps/web-audit-mcp/src/agent/browser.ts.
 *
 * @param {{ on(event: string, cb: (req: any) => void): void, url(): string, frames(): { url(): string }[], goto(url: string): Promise<unknown> }} page
 * @param {(rawUrl: string) => Promise<boolean>} requestAllowed
 * @returns {{ blockedLanding(resp?: { request?(): any } | null): Promise<string | null> }}
 */
export function watchLanding(page, requestAllowed) {
  let blocked = null;
  let left = false;
  const pending = new Set();
  const allowed = (url) => requestAllowed(url).catch(() => false);

  page.on("request", (req) => {
    if (!req.redirectedFrom?.()) return;
    const url = req.url();
    const check = allowed(url).then((ok) => {
      if (!ok && blocked === null) blocked = url;
    });
    pending.add(check);
    void check.finally(() => pending.delete(check));
  });

  return {
    async blockedLanding(resp) {
      if (blocked === null) {
        const urls = new Set();
        let req = resp?.request?.() ?? null;
        for (let i = 0; req && i < MAX_REDIRECT_CHAIN; i++) {
          urls.add(req.url());
          req = req.redirectedFrom?.() ?? null;
        }
        try {
          urls.add(page.url());
          for (const frame of page.frames()) urls.add(frame.url());
        } catch {
          // page closed: nothing more to read from it
        }
        await Promise.all([...pending]);
        for (const url of urls) {
          if (blocked !== null) break;
          // about:blank, data:, chrome-error:// (an aborted frame) reach no address.
          if (!/^https?:/i.test(url)) continue;
          if (!(await allowed(url))) blocked = url;
        }
      }
      if (blocked === null) return null;
      if (!left) {
        left = true;
        await page.goto("about:blank").catch(() => null);
      }
      let where;
      try {
        where = new URL(blocked).host;
      } catch {
        where = String(blocked).slice(0, 80);
      }
      return `Blocked: redirected to ${where}, which the SSRF guard refuses (private, loopback or metadata address); nothing was recorded from the page.`;
    },
  };
}
