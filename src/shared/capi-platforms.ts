// ONE table describing every conversion-API destination the app can build server-side.
//
// It exists because the same four facts about a platform were previously written out in four
// places: the web-pixel regexes that detect it, the credential fields the plan says it needs, the
// credential inputs the UI renders, and the builder call that creates the tag. Keeping those in
// step by hand is why the one-click apply supported four platforms while seventeen typed builders
// existed: adding a builder did not add it to the flow, and nothing failed loudly when it did not.
//
// A platform is now added by appending ONE entry here.
//
// Credential fields are declared rather than positional, because the platforms genuinely disagree:
// Yelp needs a token alone, Nextdoor needs a pixel id plus a client id plus a token, LINE Yahoo
// adds a channel id. `build` adapts the declared fields onto each builder's own argument order, so
// the callers never need to know it.

import {
  buildMetaCapiServerTag, buildTikTokCapiServerTag, buildLinkedInCapiServerTag,
  buildPinterestCapiServerTag, buildStackAdaptServerTag, buildRedditCapiServerTag,
  buildSnapchatCapiServerTag, buildMicrosoftCapiServerTag, buildAmazonCapiServerTag,
  buildXCapiServerTag, buildQuoraCapiServerTag, buildAdRollCapiServerTag,
  buildNextdoorCapiServerTag, buildYelpCapiServerTag, buildSpotifyCapiServerTag,
  buildLineYahooCapiServerTag, buildRtbHouseServerTag,
} from './server-migration.js';
import type { GtmTagResource } from './gtm-builders.js';

/** The platforms with a TYPED server builder. Generic gallery-import destinations are not here:
 *  they have no builder to call, so the one-click flow cannot create them. */
export type CapiPlatformId =
  | 'meta' | 'tiktok' | 'linkedin' | 'pinterest' | 'snapchat' | 'microsoft' | 'reddit'
  | 'amazon' | 'stackadapt' | 'x' | 'quora' | 'adroll' | 'nextdoor' | 'yelp'
  | 'spotify' | 'lineyahoo' | 'rtbhouse';

export interface CapiCredentialField {
  /** Stored under `${platform}.${key}`; also the template's own field name where they agree. */
  key: string;
  /** What the input asks for, in the vendor's own words. */
  label: string;
  /** Rendered masked, and never echoed back in any output. */
  secret?: boolean;
  /** Optional fields do not block the apply when blank. */
  optional?: boolean;
}

export interface CapiPlatformSpec {
  platform: CapiPlatformId;
  label: string;
  /** Gallery coordinates. Templates the gallery never listed are installed from source instead;
   *  see gtm-template-sources.ts - the caller's import helper handles that transparently. */
  gallery: [owner: string, repository: string];
  /** Web-pixel detection: the tag NAME, or the body of a Custom HTML tag. */
  nameRe: RegExp;
  bodyRe: RegExp;
  /** A GTM-native web tag type that is authoritative for this platform (beats the regexes). */
  nativeWebType?: string;
  fields: CapiCredentialField[];
  /** Enrichment variables to provision once per container before the first tag. */
  emqVariables?: 'meta' | 'tiktok';
  /** Adapts the declared credentials onto this builder's own argument order. */
  build: (
    type: string,
    tagName: string,
    creds: Record<string, string>,
    ctx: { event: string; firingTriggerId: string[] },
  ) => GtmTagResource;
}

/** ORDER MATTERS for detection (first match wins): linkedin precedes snapchat because a LinkedIn
 *  snippet loads from snap.licdn.com, which a bare /snap/ would otherwise claim. */
export const CAPI_PLATFORMS: readonly CapiPlatformSpec[] = [
  {
    platform: 'meta', label: 'Meta CAPI', gallery: ['stape-io', 'facebook-tag'],
    nameRe: /\bmeta\b|facebook|fb[\s_-]?pixel/i, bodyRe: /fbq\(|connect\.facebook\.net/i,
    emqVariables: 'meta',
    fields: [{ key: 'pixelId', label: 'Meta Pixel ID' }, { key: 'accessToken', label: 'Meta CAPI access token', secret: true }],
    build: (t, n, c, x) => buildMetaCapiServerTag(t, n, c.pixelId, c.accessToken, x.event, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'tiktok', label: 'TikTok CAPI', gallery: ['stape-io', 'tiktok-tag'],
    nameRe: /tiktok/i, bodyRe: /ttq\.|analytics\.tiktok\.com/i,
    emqVariables: 'tiktok',
    fields: [{ key: 'pixelId', label: 'TikTok Pixel ID' }, { key: 'accessToken', label: 'TikTok access token', secret: true }],
    build: (t, n, c, x) => buildTikTokCapiServerTag(t, n, c.pixelId, c.accessToken, x.event, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'linkedin', label: 'LinkedIn CAPI', gallery: ['stape-io', 'linkedin-tag'],
    nameRe: /linkedin/i, bodyRe: /lintrk|snap\.licdn\.com/i, nativeWebType: 'bzi',
    // LinkedIn fires on a Conversion Rule URN, NOT the web Partner ID: a different identifier
    // entirely, and the most common thing to get wrong here.
    fields: [
      { key: 'conversionRuleUrn', label: 'LinkedIn conversion rule URN (urn:lla:llaPartnerConversion:...)' },
      { key: 'accessToken', label: 'LinkedIn access token', secret: true },
    ],
    build: (t, n, c, x) => buildLinkedInCapiServerTag(t, n, c.accessToken, c.conversionRuleUrn, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'pinterest', label: 'Pinterest CAPI', gallery: ['pinterest', 'ss-gtm-template'],
    nameRe: /pinterest/i, bodyRe: /pintrk/i,
    fields: [{ key: 'advertiserId', label: 'Pinterest Advertiser ID' }, { key: 'accessToken', label: 'Pinterest API access token', secret: true }],
    build: (t, n, c, x) => buildPinterestCapiServerTag(t, n, c.advertiserId, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'snapchat', label: 'Snapchat CAPI', gallery: ['Snapchat', 'capi-google-tag-manager-serverside-tag'],
    nameRe: /snap(chat)?\b/i, bodyRe: /snaptr\(|sc-static\.net/i,
    fields: [{ key: 'pixelId', label: 'Snapchat Pixel ID' }, { key: 'accessToken', label: 'Snapchat API access token', secret: true }],
    build: (t, n, c, x) => buildSnapchatCapiServerTag(t, n, c.pixelId, c.accessToken, x.event, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'microsoft', label: 'Microsoft Ads CAPI', gallery: ['stape-io', 'microsoft-capi-tag'],
    nameRe: /microsoft|bing|\buet\b/i, bodyRe: /bat\.bing\.com|uetq/i, nativeWebType: 'baut',
    fields: [{ key: 'uetTagId', label: 'Microsoft UET Tag ID' }, { key: 'authToken', label: 'Microsoft auth token', secret: true }],
    build: (t, n, c, x) => buildMicrosoftCapiServerTag(t, n, c.uetTagId, c.authToken, x.event, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'reddit', label: 'Reddit CAPI', gallery: ['stape-io', 'reddit-tag'],
    nameRe: /reddit/i, bodyRe: /rdt\(|redditstatic\.com/i,
    fields: [{ key: 'accountId', label: 'Reddit Ads account ID' }, { key: 'accessToken', label: 'Reddit conversion access token', secret: true }],
    build: (t, n, c, x) => buildRedditCapiServerTag(t, n, c.accountId, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'amazon', label: 'Amazon Ads CAPI', gallery: ['stape-io', 'amazon-tag'],
    nameRe: /amazon[\s_-]?(ads?|pixel|tag)/i, bodyRe: /amzn\(|amazon-adsystem/i,
    // Amazon takes a REGION, not a secret: the token lives in the template's own connection.
    fields: [{ key: 'tagId', label: 'Amazon Ads Tag ID' }, { key: 'region', label: 'Region (NA or EU)' }],
    build: (t, n, c, x) => buildAmazonCapiServerTag(t, n, [c.tagId], c.region, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'stackadapt', label: 'StackAdapt', gallery: ['StackAdapt', 'stackadapt-gtm-server-side-pixel'],
    nameRe: /stackadapt/i, bodyRe: /saq\(|srv\.stackadapt/i,
    fields: [{ key: 'pixelId', label: 'StackAdapt pixel ID' }, { key: 'pixelType', label: 'Pixel type (audience / conversion / universal)' }],
    build: (t, n, c, x) => buildStackAdaptServerTag(t, n, c.pixelId, c.pixelType, { action: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'x', label: 'X (Twitter) CAPI', gallery: ['stape-io', 'twitter-tag'],
    nameRe: /\btwitter\b|\bx[\s_-]?pixel\b/i, bodyRe: /twq\(|static\.ads-twitter/i,
    // eventId is the per-conversion X Event ID (tw-...), so one tag is one X conversion event.
    fields: [
      { key: 'pixelId', label: 'X Pixel ID' },
      { key: 'eventId', label: 'X Event ID (tw-...)' },
      { key: 'pixelAccessToken', label: 'X pixel access token', secret: true },
    ],
    build: (t, n, c, x) => buildXCapiServerTag(t, n, c.pixelId, c.eventId, { pixelAccessToken: c.pixelAccessToken }, { firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'quora', label: 'Quora CAPI', gallery: ['stape-io', 'quora-tag'],
    nameRe: /quora/i, bodyRe: /\bqp\(|a\.quora\.com/i,
    fields: [{ key: 'accountId', label: 'Quora account ID' }, { key: 'accessToken', label: 'Quora access token', secret: true }],
    build: (t, n, c, x) => buildQuoraCapiServerTag(t, n, c.accountId, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'adroll', label: 'AdRoll CAPI', gallery: ['stape-io', 'adroll-tag'],
    nameRe: /adroll/i, bodyRe: /__adroll|s\.adroll\.com|adroll_adv_id/i,
    fields: [
      { key: 'advertisableId', label: 'AdRoll advertisable ID' },
      { key: 'pixelId', label: 'AdRoll pixel ID' },
      { key: 'accessToken', label: 'AdRoll access token', secret: true },
    ],
    build: (t, n, c, x) => buildAdRollCapiServerTag(t, n, c.advertisableId, c.pixelId, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'nextdoor', label: 'Nextdoor CAPI', gallery: ['stape-io', 'nextdoor-tag'],
    nameRe: /nextdoor/i, bodyRe: /\bndp\(|ads\.nextdoor\.com/i,
    fields: [
      { key: 'pixelId', label: 'Nextdoor Pixel ID' },
      { key: 'clientId', label: 'Nextdoor client ID' },
      { key: 'accessToken', label: 'Nextdoor access token', secret: true },
    ],
    build: (t, n, c, x) => buildNextdoorCapiServerTag(t, n, c.pixelId, c.clientId, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'yelp', label: 'Yelp CAPI', gallery: ['stape-io', 'yelp-tag'],
    nameRe: /\byelp\b/i, bodyRe: /yelp\.com\/ads|yelpads/i,
    // Yelp has no public pixel id at all: the token is the whole credential.
    fields: [{ key: 'accessToken', label: 'Yelp access token', secret: true }],
    build: (t, n, c, x) => buildYelpCapiServerTag(t, n, c.accessToken, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'spotify', label: 'Spotify Ads CAPI', gallery: ['stape-io', 'spotify-tag'],
    nameRe: /spotify/i, bodyRe: /pixel\.spotify|ads\.spotify|spotify\.com\/pixel/i,
    fields: [{ key: 'authToken', label: 'Spotify auth token', secret: true }, { key: 'connectionId', label: 'Spotify connection ID' }],
    build: (t, n, c, x) => buildSpotifyCapiServerTag(t, n, c.authToken, c.connectionId, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'lineyahoo', label: 'LINE Yahoo CAPI', gallery: ['stape-io', 'line-yahoo-tag'],
    nameRe: /line[\s_-]?yahoo|yahoo[\s_-]?(ads|conversion)|\byjtag\b/i,
    bodyRe: /yjtag|s\.yimg\.jp\/wi\/ytag|yahoo_retargeting_id/i,
    fields: [
      { key: 'tagId', label: 'Yahoo tag ID' },
      { key: 'accessToken', label: 'LINE Yahoo access token', secret: true },
      { key: 'channelId', label: 'Channel ID' },
    ],
    build: (t, n, c, x) => buildLineYahooCapiServerTag(t, n, c.tagId, c.accessToken, c.channelId, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
  {
    platform: 'rtbhouse', label: 'RTB House', gallery: ['stape-io', 'rtb-house-tag'],
    nameRe: /rtb\s*house|rtbhouse/i, bodyRe: /creativecdn\.com/i,
    // No access token: the partner key is the credential. Events are PAGE TYPES, so the builder
    // requires one.
    fields: [{ key: 'taggingHash', label: 'RTB House tagging hash' }, { key: 'partnerKey', label: 'RTB House partner key', secret: true }],
    build: (t, n, c, x) => buildRtbHouseServerTag(t, n, c.taggingHash, c.partnerKey, { event: x.event, firingTriggerId: x.firingTriggerId }),
  },
];

const BY_ID = new Map<string, CapiPlatformSpec>(CAPI_PLATFORMS.map((p) => [p.platform, p]));

/** The spec for a platform id, or null when it has no typed builder. PURE. */
export function capiPlatform(id: string): CapiPlatformSpec | null {
  return BY_ID.get(id) ?? null;
}

/** Which platform a WEB tag belongs to, or null. A native GTM type is authoritative; otherwise the
 *  tag name, then the body of a Custom HTML tag. GA4 tags are never a CAPI destination. PURE. */
export function webPixelPlatform(
  tag: { type: string; name: string; parameter?: unknown },
): CapiPlatformId | null {
  if (tag.type === 'gaawe' || tag.type === 'gaawc' || tag.type === 'googtag') return null;
  for (const p of CAPI_PLATFORMS) if (p.nativeWebType && tag.type === p.nativeWebType) return p.platform;
  const body = tag.type === 'html' ? JSON.stringify(tag.parameter ?? []) : '';
  for (const p of CAPI_PLATFORMS) {
    if (p.nameRe.test(tag.name) || (body && p.bodyRe.test(body))) return p.platform;
  }
  return null;
}

/** The value keys this platform's credentials are stored under, e.g. "meta.accessToken". PURE. */
export function capiValueKeys(spec: CapiPlatformSpec): string[] {
  return spec.fields.map((f) => `${spec.platform}.${f.key}`);
}

/** Credentials for a platform, read from the flat `${platform}.${field}` map. PURE. */
export function capiCredentials(
  spec: CapiPlatformSpec,
  values: Record<string, string | undefined> | undefined,
): { creds: Record<string, string>; missing: string[] } {
  const creds: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of spec.fields) {
    const v = (values?.[`${spec.platform}.${f.key}`] ?? '').trim();
    creds[f.key] = v;
    if (!v && !f.optional) missing.push(f.label);
  }
  return { creds, missing };
}
