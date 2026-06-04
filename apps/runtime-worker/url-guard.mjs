// SSRF URL guard for the runtime capture worker.
//
// The worker loads attacker-influenced URLs in a real browser, so it is a prime
// SSRF target: a request can be steered at cloud metadata (169.254.169.254),
// loopback, or RFC-1918 hosts to read internal services. This module is the
// single source of truth for "is this URL safe to load", used both at request
// admission (server.mjs) and — critically — on every in-browser navigation so a
// redirect from an allowlisted page to an internal host is still blocked
// (capture.mjs route interceptor).
//
// It is intentionally dependency-free (only `node:*`) so it can be `node --check`ed
// and unit-tested without installing the browser.

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
  // Strip IPv6 brackets for the literal-name comparisons below.
  const bareHost = host.replace(/^\[/, "").replace(/\]$/, "");

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
