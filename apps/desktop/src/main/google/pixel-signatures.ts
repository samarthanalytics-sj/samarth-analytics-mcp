// B6 — advertising-pixel signature registry, kept as DATA so signatures can be updated
// without touching audit logic. Each network has STRONG signals (the pixel actually
// initialising/firing) and WEAK signals (a domain reference, ambiguous on its own).
//
// Short strong tokens (rdt(, twq(, uetq) can false-match unrelated code, so those three
// networks require a strong AND a weak (domain) signal to CO-OCCUR before they count as a
// pixel. For every other network a strong signal alone is enough.
//
// Corpus-validated against 562 real GTM containers.

export type PixelClassification =
  | 'advertising_pixel' // strong (or strong+weak) signal — a real pixel
  | 'possible_pixel_review' // a network domain seen, but no clear init — review, don't score
  | 'opaque_review' // injects an external <script src> the engine can't read — manual review
  | 'not_a_pixel';

export interface PixelSignature {
  network: string;
  category: 'advertising';
  /** The pixel actually initialising/firing. */
  strong: RegExp[];
  /** A domain reference — ambiguous alone. */
  weak: RegExp[];
  /** Consent types this network needs before it may fire. */
  requiredConsent: string[];
  /** Short/ambiguous strong token — only a pixel when a weak (domain) signal co-occurs. */
  requireCooccurrence?: boolean;
}

export const PIXEL_SIGNATURES: PixelSignature[] = [
  {
    network: 'Meta / Facebook',
    category: 'advertising',
    strong: [/fbq\s*\(\s*['"]init['"]/, /fbq\s*\(\s*['"]track['"]/],
    weak: [/connect\.facebook\.net/, /fbevents\.js/],
    requiredConsent: ['ad_storage', 'ad_user_data', 'ad_personalization'],
  },
  {
    network: 'TikTok',
    category: 'advertising',
    strong: [/ttq\s*\.\s*load\s*\(/, /ttq\s*\.\s*(track|page)\s*\(/],
    weak: [/analytics\.tiktok\.com/],
    requiredConsent: ['ad_storage', 'ad_user_data', 'ad_personalization'],
  },
  {
    network: 'LinkedIn',
    category: 'advertising',
    strong: [/_linkedin_partner_id/],
    weak: [/snap\.licdn\.com/],
    requiredConsent: ['ad_storage', 'ad_user_data'],
  },
  {
    network: 'Pinterest',
    category: 'advertising',
    strong: [/pintrk\s*\(/],
    weak: [/s\.pinimg\.com/],
    requiredConsent: ['ad_storage', 'ad_user_data'],
  },
  {
    network: 'Snapchat',
    category: 'advertising',
    strong: [/snaptr\s*\(/],
    weak: [/sc-static\.net/],
    requiredConsent: ['ad_storage', 'ad_user_data'],
  },
  {
    network: 'X / Twitter',
    category: 'advertising',
    strong: [/twq\s*\(/],
    weak: [/static\.ads-twitter\.com/],
    requiredConsent: ['ad_storage', 'ad_user_data'],
    requireCooccurrence: true,
  },
  {
    network: 'Reddit',
    category: 'advertising',
    strong: [/rdt\s*\(/],
    weak: [/redditstatic\.com/],
    requiredConsent: ['ad_storage', 'ad_user_data'],
    requireCooccurrence: true,
  },
  {
    network: 'Microsoft / Bing UET',
    category: 'advertising',
    strong: [/uetq/],
    weak: [/bat\.bing\.com/],
    requiredConsent: ['ad_storage'],
    requireCooccurrence: true,
  },
];

export interface PixelMatch {
  classification: PixelClassification;
  network?: string;
  requiredConsent?: string[];
}

/**
 * Opaque-script guard: does the snippet inject an external `<script src=…>` (inline tag or
 * dynamic `createElement('script')…src=`) that the engine cannot read? Used only when no
 * registry signal matches — such a tag is NOT passed as clean, it is marked for review.
 */
export function hasOpaqueExternalScript(snippet: string): boolean {
  if (/<script\b[^>]*\bsrc\s*=/i.test(snippet)) return true;
  return /createElement\s*\(\s*['"]script['"]\s*\)/i.test(snippet) && /\.\s*src\s*=/.test(snippet);
}

/**
 * Deterministically classify a Custom HTML snippet against the registry.
 *
 * Stops at the FIRST entry that matches as an advertising pixel — one tag → one network →
 * one finding. If nothing is a pixel but a network domain (weak signal) is present, returns
 * `possible_pixel_review`; if an unreadable external script is injected with no signal,
 * `opaque_review`; otherwise `not_a_pixel`.
 */
export function classifyPixel(snippet: string): PixelMatch {
  let possible: string | undefined;
  for (const e of PIXEL_SIGNATURES) {
    const strongHit = e.strong.some((re) => re.test(snippet));
    const weakHit = e.weak.some((re) => re.test(snippet));
    const isPixel = e.requireCooccurrence ? strongHit && weakHit : strongHit;
    if (isPixel) {
      return { classification: 'advertising_pixel', network: e.network, requiredConsent: e.requiredConsent };
    }
    // Per the spec: a weak (domain) signal with no qualifying strong signal → "possible".
    if (!possible && weakHit) possible = e.network;
  }
  if (possible) return { classification: 'possible_pixel_review', network: possible };
  if (hasOpaqueExternalScript(snippet)) return { classification: 'opaque_review' };
  return { classification: 'not_a_pixel' };
}
