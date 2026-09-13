// Which container variable each selected platform's tags read for their destination id.
//
// The "Create into" card shows one of these per SELECTED platform, because the id a row carries is
// platform-specific: a Meta row's id is a Pixel ID, a Google Ads row's is a Conversion ID, a GA4
// row's is a Measurement ID. They share one `measurementId` field on the row, which is exactly why
// the wrong hint is so misleading - it told a Google Ads user to "edit a row to a real G-XXXX id"
// when that field holds their Conversion ID.
//
// Data-driven and exhaustive over SuggestPlatform, so a new platform cannot be added without either
// giving it a hint or consciously deciding it needs none. The renderer only formats these.
import type { SuggestPlatform } from './ipc';

export interface PlatformIdHint {
  platform: SuggestPlatform;
  /** Human label for the platform, as the chip shows it. */
  label: string;
  /** The container variable(s) the tags default to, in the order they should read. */
  variables: string[];
  /** What the user does about it, phrased for the end of the sentence. */
  action: string;
}

/** Every platform's id variables. Exhaustive: SuggestPlatform is the key type, so a new member
 *  fails the build here rather than silently shipping without a hint. */
export const PLATFORM_ID_HINTS: Record<SuggestPlatform, PlatformIdHint> = {
  ga4: {
    platform: 'ga4',
    label: 'GA4',
    variables: ['{{GA4 Measurement ID}}'],
    action: 'make sure it exists in this container, or edit a row to a real G-XXXX id.',
  },
  meta: {
    platform: 'meta',
    label: 'Meta (Facebook)',
    variables: ['{{Meta Pixel ID}}'],
    action: 'set it in the container (or edit the Pixel ID per row).',
  },
  google_ads: {
    platform: 'google_ads',
    label: 'Google Ads',
    variables: ['{{Google Ads Conversion ID}}', '{{Google Ads Conversion Label}}'],
    action: 'set them in the container (or edit each row).',
  },
  tiktok: {
    platform: 'tiktok',
    label: 'TikTok',
    variables: ['{{TikTok Pixel ID}}'],
    action: 'set it in the container (or edit the Pixel ID per row).',
  },
  linkedin: {
    platform: 'linkedin',
    label: 'LinkedIn',
    variables: ['{{LinkedIn Partner ID}}'],
    action: 'set it in the container (or edit the Partner ID per row).',
  },
  reddit: {
    platform: 'reddit',
    label: 'Reddit',
    variables: ['{{Reddit Pixel ID}}'],
    action: 'set it in the container (or edit the Pixel ID per row).',
  },
  pinterest: {
    platform: 'pinterest',
    label: 'Pinterest',
    variables: ['{{Pinterest Tag ID}}'],
    action: 'set it in the container (or edit the Tag ID per row).',
  },
};

/** The chip order, so two selections always render in the same order regardless of click order. */
const DISPLAY_ORDER: SuggestPlatform[] = ['ga4', 'meta', 'google_ads', 'tiktok', 'linkedin', 'reddit', 'pinterest'];

/**
 * The hints to show for the current selection: one per SELECTED platform, in chip order.
 *
 * Selecting only Google Ads must NOT surface the GA4 Measurement ID line, because the scan generates
 * no GA4 rows for that selection (scan-core gates row generation on the same list) and the advice
 * would be about an id the user is not setting.
 */
export function platformIdHints(platforms: readonly SuggestPlatform[] | undefined): PlatformIdHint[] {
  const selected = new Set(platforms ?? []);
  return DISPLAY_ORDER.filter((p) => selected.has(p)).map((p) => PLATFORM_ID_HINTS[p]);
}
