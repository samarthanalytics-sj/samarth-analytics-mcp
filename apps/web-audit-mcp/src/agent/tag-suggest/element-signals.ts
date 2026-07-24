// Signals that decide WHAT an element is, for elements the classifier previously misread or missed.
//
// PURE + framework-free, so both the browser collector and the cheerio (no-JS) driver can share them.
//
// Two gaps motivated this, both found on a real dealer-locator page:
//
// 1. A "get directions" address link is an <a> pointing at Google Maps. The classifier saw an
//    external host and filed it under `outbound`, so an address click was indistinguishable from a
//    click on any third-party link. Maps links are their own interaction and deserve their own tag.
//
// 2. Cloudflare Email Obfuscation rewrites `<a href="mailto:x@y.com">` at the ORIGIN into
//    `<a class="__cf_email__" data-cfemail="HEX" href="/cdn-cgi/l/email-protection#HEX">`, and its
//    own script restores the real mailto in the browser. A JS-enabled scan therefore sees a normal
//    mailto link, while a no-JS scan of the same page sees zero. Decoding the hex here makes both
//    paths agree instead of silently disagreeing.

/** Map/directions providers. A link to one of these is an address interaction, not a plain outbound. */
const MAPS_HOST_RE = /(^|\.)(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.apple\.com|waze\.com|bing\.com\/maps|openstreetmap\.org|mapquest\.com|here\.com|what3words\.com)/i;

/** True when the URL opens a map / directions view for an address. */
export function isMapsUrl(href: string): boolean {
  if (!href) return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(u.protocol)) return false;
  const hostPath = `${u.hostname}${u.pathname}`;
  if (MAPS_HOST_RE.test(hostPath)) return true;
  // google.com/maps is matched above via host+path; bare maps.google.* hosts too. Also accept the
  // geo: scheme's http equivalents used by some CMS plugins.
  return /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/maps(\/|$)/i.test(u.pathname);
}

/**
 * Decode a Cloudflare `data-cfemail` / email-protection hex payload back to the real address.
 *
 * The scheme is a single-byte XOR: the first byte is the key, every following byte is one character
 * of the address XORed with it. Returns null on anything that does not decode to a plausible
 * address, so a malformed payload degrades to "not an email" rather than to a junk trigger value.
 */
export function decodeCfEmail(hex: string): string | null {
  const h = (hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,}$/.test(h) || h.length % 2 !== 0) return null;
  const key = parseInt(h.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < h.length; i += 2) {
    const code = parseInt(h.slice(i, i + 2), 16) ^ key;
    // Control characters mean the payload was not a cfemail blob.
    if (code < 32 || code > 126) return null;
    out += String.fromCharCode(code);
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : null;
}

/** The hex payload carried on a Cloudflare email-protection href, if this is one. */
export function cfEmailHexFromHref(href: string): string | null {
  const m = /\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/.exec(href ?? '');
  return m ? m[1] : null;
}

/**
 * Resolve an element's REAL mailto href, seeing through Cloudflare obfuscation.
 *
 * Accepts the href and the `data-cfemail` attribute (either may be absent). Returns a `mailto:`
 * URL, or null when this is not an email link at all.
 */
export function resolveEmailHref(href: string | undefined, cfemail?: string): string | null {
  const h = href ?? '';
  if (/^mailto:/i.test(h)) return h;
  const hex = (cfemail ?? '').trim() || cfEmailHexFromHref(h);
  if (!hex) return null;
  const addr = decodeCfEmail(hex);
  return addr ? `mailto:${addr}` : null;
}

// ── Non-link contact elements ────────────────────────────────────────────────
// Plenty of sites render a phone number or an address as a <div>/<span>/<p> with a meaningful class
// and no href. GTM can still fire on it (All Elements + a CSS selector), but the collector only ever
// looked at links, buttons and [onclick], so those elements were never even seen.
//
// The vocabulary is deliberately NARROW. Capturing every classed <div> would flood the scan and bury
// the real interactions, so this matches only contact-intent nouns, and the caller additionally
// requires the element to carry text and to be reasonably short.

/** Class/data-attribute tokens that mark a contact or location block worth tracking. */
const CONTACT_CLASS_RE = /(^|[-_])(address|addr|location|directions|direction|map|maps|phone|tel|telephone|mobile|call|contact|email|mail|hours|whatsapp|store-locator|dealer)([-_]|$)/i;

/** True when a non-link element's class marks it as a contact/location block. */
export function isContactClass(classAttr: string | undefined): boolean {
  const cls = (classAttr ?? '').trim();
  if (!cls) return false;
  return cls.split(/\s+/).some((c) => CONTACT_CLASS_RE.test(c));
}

/** What KIND of contact block a class attribute describes, for naming the tag. */
export function contactKindOf(classAttr: string | undefined): 'address' | 'phone' | 'email' | 'hours' | null {
  const cls = (classAttr ?? '').toLowerCase();
  if (!cls) return null;
  // Most specific first: "dealer-address" and "dealer-phone" both contain "dealer".
  if (/(^|[-_\s])(address|addr|location|directions?|maps?)([-_\s]|$)/.test(cls)) return 'address';
  if (/(^|[-_\s])(phone|tel|telephone|mobile|call|whatsapp)([-_\s]|$)/.test(cls)) return 'phone';
  if (/(^|[-_\s])(e?mail)([-_\s]|$)/.test(cls)) return 'email';
  if (/(^|[-_\s])(hours|opening|timings?)([-_\s]|$)/.test(cls)) return 'hours';
  return null;
}

/** Text that plausibly IS a postal address, used to avoid tagging a heading as one. */
export function looksLikeAddress(text: string): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t.length > 200) return false;
  // A street address almost always carries a number and a comma or a postcode-ish token.
  return /\d/.test(t) && (/,/.test(t) || /\b[A-Z]{2,3}\s*\d{3,6}\b/.test(t) || /\b\d{4,6}\b/.test(t));
}
