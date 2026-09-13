/**
 * SSRF URL guard — TypeScript port of apps/runtime-worker/url-guard.mjs.
 *
 * This server loads attacker-influenced URLs in a real browser, so it is a
 * prime SSRF target: a request can be steered at cloud metadata
 * (169.254.169.254), loopback, or RFC-1918 hosts to read internal services.
 * Used both at tool admission (with the operator allowlist) and on every
 * in-browser request (private-range rules only) so a redirect from an
 * allowlisted page to an internal host is still blocked.
 *
 * Behaviour intentionally mirrors the runtime-worker guard; if you fix a
 * bypass here, fix it there too.
 */

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map((n) => Number(n));
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIpv6(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  const mappedDotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
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

function parseIpOctet(tok: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
  if (/^0[0-7]+$/.test(tok)) return parseInt(tok, 8);
  if (/^[0-9]+$/.test(tok)) return parseInt(tok, 10);
  return null;
}

/** Decode decimal/octal/hex IPv4 encodings (2130706433 → 127.0.0.1). */
function normalizeNumericHost(host: string): string | null {
  if (/^[0-9a-fx.]+$/i.test(host) && host.includes(".")) {
    const parts = host.split(".");
    if (parts.length === 4) {
      const nums = parts.map(parseIpOctet);
      if (nums.every((n) => n !== null && n >= 0 && n <= 255)) {
        return nums.join(".");
      }
    }
  }
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(host)) {
    const n = parseIpOctet(host);
    if (n !== null && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  return null;
}

/**
 * Decide whether a URL is safe to load. `allowlist` holds lower-cased host
 * suffixes; when non-empty the host must match one. Private/loopback/metadata
 * ranges are always blocked regardless of allowlist.
 */
export function urlAllowed(rawUrl: string, allowlist: string[] = []): UrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http(s) URLs are allowed" };
  }

  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[/, "").replace(/\]$/, "");

  if (
    bareHost === "localhost" ||
    bareHost === "ip6-localhost" ||
    bareHost === "ip6-loopback" ||
    bareHost.endsWith(".localhost")
  ) {
    return { ok: false, reason: "private/loopback addresses are not allowed" };
  }

  if (host.includes(":")) {
    if (isPrivateIpv6(host)) {
      return { ok: false, reason: "private/loopback addresses are not allowed" };
    }
  } else {
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
      return { ok: false, reason: "host not in WEB_AUDIT_ALLOWLIST" };
    }
  }
  return { ok: true };
}
