/**
 * Consent Mode v2 signal decoding (gcs / gcd).
 *
 * The repo's portal engine only checks gcs/gcd *presence*; this genuinely
 * decodes them. gcs has a well-established, spec-confirmed format and is
 * decoded strictly. gcd's newer format is only partially documented, so it is
 * decoded best-effort and surfaced as evidence — it NEVER drives a Fail on its
 * own (the "never guess a Pass/Fail" determinism rule). Authoritative per-field
 * default/update assertions use the dataLayer consent events instead.
 */

import type { ConsentField, ConsentValue } from './types.js';

function digitToValue(d: string | undefined): ConsentValue {
  if (d === '1') return 'granted';
  if (d === '0') return 'denied';
  return 'unknown';
}

export interface GcsDecoded {
  adStorage: ConsentValue;
  analyticsStorage: ConsentValue;
  raw?: string;
}

/**
 * Decode a gcs signal. Format: `G<lead><ad_storage><analytics_storage>`, e.g.
 * `G111` = ad+analytics granted, `G100` = both denied, `G101` = ad denied /
 * analytics granted. Only ad_storage and analytics_storage are represented by
 * gcs; ad_user_data / ad_personalization are carried by gcd.
 */
export function decodeGcs(gcs: string | undefined): GcsDecoded {
  if (!gcs || typeof gcs !== 'string') return { adStorage: 'unknown', analyticsStorage: 'unknown' };
  const digits = gcs.replace(/^[gG]/, '');
  if (!/^\d+$/.test(digits)) return { adStorage: 'unknown', analyticsStorage: 'unknown', raw: gcs };
  let ad: string | undefined;
  let analytics: string | undefined;
  if (digits.length >= 3) {
    // G<lead><ad><analytics> — skip the leading status digit.
    ad = digits[1];
    analytics = digits[2];
  } else if (digits.length === 2) {
    ad = digits[0];
    analytics = digits[1];
  }
  return { adStorage: digitToValue(ad), analyticsStorage: digitToValue(analytics), raw: gcs };
}

/** True when analytics_storage is confidently denied (a cookieless ping is acceptable pre-consent). */
export function analyticsStorageDenied(gcs: string | undefined): boolean {
  return decodeGcs(gcs).analyticsStorage === 'denied';
}

/** True when the gcs confidently shows analytics_storage granted (a real tracked hit). */
export function analyticsStorageGranted(gcs: string | undefined): boolean {
  return decodeGcs(gcs).analyticsStorage === 'granted';
}

// ── gcd (best-effort, evidence only) ─────────────────────────────────────────

// gcd encodes default+update for the four consent fields in order. The letter
// codes below are the community-reverse-engineered set; anything outside it is
// reported 'unknown'. `confident` is only true when all four segments mapped.
const GCD_LETTER: Record<string, ConsentValue> = {
  l: 'unknown', // consent type not set
  p: 'denied', // default denied, no update
  q: 'granted', // default granted, no update
  t: 'denied', // default denied
  u: 'granted', // default denied → update granted
  v: 'denied', // default granted → update denied
  m: 'denied',
  n: 'granted',
};

export interface GcdDecoded {
  fields: Partial<Record<ConsentField, ConsentValue>>;
  confident: boolean;
  raw?: string;
}

const GCD_FIELD_ORDER: ConsentField[] = [
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
];

/**
 * Best-effort gcd decode. Extracts the trailing letter of each of the four
 * ordered segments (e.g. `13l3l3l3l5` → segments `l`,`l`,`l`,`l`). Marked
 * `confident:false` unless every field mapped to a known granted/denied code.
 * Never used to drive a Fail — supplementary evidence only.
 */
export function decodeGcd(gcd: string | undefined): GcdDecoded {
  const fields: Partial<Record<ConsentField, ConsentValue>> = {};
  if (!gcd || typeof gcd !== 'string') return { fields, confident: false };
  // Pull every alphabetic segment marker in order.
  const letters = gcd.toLowerCase().match(/[a-z]/g) ?? [];
  let mapped = 0;
  for (let i = 0; i < GCD_FIELD_ORDER.length && i < letters.length; i += 1) {
    const value = GCD_LETTER[letters[i]];
    if (value !== undefined) {
      fields[GCD_FIELD_ORDER[i]] = value;
      if (value !== 'unknown') mapped += 1;
    }
  }
  return { fields, confident: mapped === GCD_FIELD_ORDER.length, raw: gcd };
}
