// Classify an HTTP error response as a BOT-PROTECTION block, from its status + response headers. PURE.
//
// Why this exists: a site fronted by Cloudflare / Akamai / Imperva / DataDome answers a headless
// scanner with a 403 (or 503) CHALLENGE page. Reported as a bare "http 403" the user reads it as
// "the scanner found nothing on my site" and concludes form / element detection is broken, when
// in fact no page was ever read. Naming the block turns that into an actionable message.
//
// This only NAMES the block. It never tries to pass a challenge: that is the site owner's bot
// policy and the remedy is on their side (allowlist the scanner) or a real browser session.
//
// Shared by the Playwright crawler (web-audit) and the desktop Electron driver, so both report the
// same reason. Header values may be string OR string[] (Electron's webRequest shape).

export type HeaderBag = Record<string, string | string[] | undefined>;

/** Statuses a WAF uses for a block / challenge. 401 is deliberately NOT here: that is auth, not a bot check. */
const BLOCK_STATUSES = new Set([403, 429, 503]);

/** True for a status botBlockReason may classify as a block, so a caller fetches headers only for those. */
export const isBlockStatus = (status: number | null): boolean => status !== null && BLOCK_STATUSES.has(status);

const lower = (bag: HeaderBag): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = (Array.isArray(v) ? v.join('\n') : String(v)).toLowerCase();
  }
  return out;
};

/**
 * The block reason for an error response, or null when it is an ordinary HTTP error (a real 404,
 * an origin 403, a 500). Decisive vendor markers are checked first; a 403/429 behind a recognised
 * WAF but without a decisive marker still gets the vendor named, since an origin 403 through that
 * CDN is far rarer than the WAF's own block page. A 503 needs a decisive marker: the vendor-presence
 * signals ride on every response through those CDNs, origin outages included.
 */
export function botBlockReason(status: number | null, headers: HeaderBag): string | null {
  if (status === null || !BLOCK_STATUSES.has(status)) return null;
  const h = lower(headers);
  const server = h['server'] ?? '';
  const cookies = h['set-cookie'] ?? '';

  // Cloudflare: cf-mitigated is only ever set when Cloudflare itself served a challenge / block.
  if (h['cf-mitigated']) return `blocked by Cloudflare bot ${h['cf-mitigated'] === 'challenge' ? 'challenge' : 'protection'}`;
  // AWS sets x-amzn-waf-action only when its WAF took action (block / challenge), so it is decisive too.
  if (h['x-amzn-waf-action']) return 'blocked by AWS WAF';
  // A 503 with no challenge marker is far more often maintenance mode or a down / unreachable origin
  // (or an edge error such as AkamaiGHost "origin unreachable") than a bot block: keep it a plain
  // "http 503". cf-ray, server: cloudflare / AkamaiGHost, x-akamai-* and the Bot Manager cookies are
  // on every response through those CDNs, so they cannot tell the two apart.
  if (status === 503) return null;
  // Akamai Bot Manager: its sensor cookies ride on the challenge response.
  if (/_abck|ak_bmsc|bm_sz|bm_sv/.test(cookies) || /akamai/.test(server) || Object.keys(h).some((k) => k.startsWith('x-akamai'))) {
    return 'blocked by Akamai bot protection';
  }
  // Imperva / Incapsula.
  if (h['x-iinfo'] || /imperva|incapsula/.test(h['x-cdn'] ?? '') || /incap_ses|visid_incap/.test(cookies)) {
    return 'blocked by Imperva bot protection';
  }
  if (h['x-datadome'] || /datadome/.test(cookies)) return 'blocked by DataDome bot protection';
  if (Object.keys(h).some((k) => k.startsWith('x-px')) || /(^|\n|;\s*)_px/.test(cookies)) return 'blocked by PerimeterX bot protection';
  // Cloudflare-fronted block status with no cf-mitigated: name the CDN, but do not claim a challenge.
  if (/cloudflare/.test(server) || h['cf-ray']) return `blocked by Cloudflare (http ${status})`;
  return null;
}

/** True when a notScanned / DrivenPage reason came from botBlockReason (used to escalate the warning). */
export const isBotBlockReason = (reason: string | undefined | null): boolean => !!reason && reason.startsWith('blocked by ');

/**
 * The one-line, user-facing warning for a scan whose START page was blocked, so 0 pages were read.
 * Shared by the MCP report notes and the desktop scan warnings so the two surfaces say the same thing.
 */
export function blockedStartWarning(reason: string): string {
  return (
    `The site blocked the scanner on its start page (${reason}), so 0 pages were read and no forms or ` +
    'elements could be detected. This is the site\'s bot protection, not a detection gap: ask the site ' +
    'owner to allowlist the scanner, or scan from a browser session that has already passed the site\'s bot check.'
  );
}
