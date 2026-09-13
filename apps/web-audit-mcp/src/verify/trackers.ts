/**
 * Tracker domain classification for the verification engine.
 *
 * Wraps web-audit-mcp's classifyUrl (ga4/gtm/meta/google_ads/floodlight/tiktok/
 * linkedin) and adds the pieces the verify spec needs that the shared code
 * lacks: Microsoft Clarity (clarity.ms) detection, Meta Pixel eventID capture
 * (for future dedup work — NOT server dedup verification), and the `_gl`
 * cross-domain linker parameter.
 */

import { classifyUrl } from '../agent/browser.js';
import type { TrackerObservation } from './types.js';

interface VendorDef {
  id: string;
  /** Names an operator might use in expectedTrackers → this vendor. */
  aliases: string[];
  test: (url: string) => boolean;
}

const CLARITY_RE = /(?:^|\.)clarity\.ms\//i;

const VENDORS: VendorDef[] = [
  { id: 'ga4', aliases: ['ga4', 'google_analytics', 'gtag', 'analytics'], test: (u) => classifyUrl(u).groups.includes('ga4') },
  { id: 'gtm', aliases: ['gtm', 'google_tag_manager', 'tag_manager'], test: (u) => classifyUrl(u).groups.includes('gtm') },
  { id: 'meta_pixel', aliases: ['meta_pixel', 'meta', 'facebook', 'fb', 'facebook_pixel'], test: (u) => classifyUrl(u).groups.includes('meta') },
  { id: 'clarity', aliases: ['clarity', 'microsoft_clarity', 'ms_clarity'], test: (u) => CLARITY_RE.test(u) },
  { id: 'google_ads', aliases: ['google_ads', 'gads', 'adwords'], test: (u) => classifyUrl(u).groups.includes('google_ads') },
  { id: 'floodlight', aliases: ['floodlight', 'dv360', 'cm360'], test: (u) => classifyUrl(u).groups.includes('floodlight') },
  { id: 'tiktok', aliases: ['tiktok', 'tiktok_pixel', 'tt'], test: (u) => classifyUrl(u).groups.includes('tiktok') },
  { id: 'linkedin', aliases: ['linkedin', 'linkedin_insight', 'li'], test: (u) => classifyUrl(u).groups.includes('linkedin') },
];

/** Canonical vendor id for a request URL, or 'other'. */
export function classifyTrackerVendor(url: string): string {
  for (const v of VENDORS) {
    if (v.test(url)) return v.id;
  }
  return 'other';
}

/** Resolve an operator-supplied expectedTrackers name to a canonical vendor id (or the name itself). */
export function resolveTrackerName(name: string): string {
  const key = name.trim().toLowerCase();
  for (const v of VENDORS) {
    if (v.id === key || v.aliases.includes(key)) return v.id;
  }
  return key;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Meta Pixel eventID (`eid` on /tr, or `event_id`) — for future dedup work only. */
export function extractMetaEventId(url: string): string | undefined {
  try {
    const q = new URL(url).searchParams;
    return q.get('eid') ?? q.get('event_id') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The `_gl` cross-domain linker param value on a URL, or undefined. */
export function extractGlParam(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('_gl') ?? undefined;
  } catch {
    // Fall back to a raw scan (the URL may be a fragment/relative form).
    const m = /[?&#]_gl=([^&#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : undefined;
  }
}

/** True when a destination URL carries a non-empty `_gl` linker param. */
export function hasGlParam(url: string): boolean {
  const gl = extractGlParam(url);
  return typeof gl === 'string' && gl.length > 0;
}

/** Build a normalized tracker observation from a raw request. */
export function toTrackerObservation(url: string, method: string, tRelativeMs: number): TrackerObservation {
  const vendor = classifyTrackerVendor(url);
  const obs: TrackerObservation = { url: url.slice(0, 500), domain: hostOf(url), vendor, method, tRelativeMs };
  if (vendor === 'meta_pixel') {
    const eid = extractMetaEventId(url);
    if (eid) obs.eventId = eid;
  }
  return obs;
}

/** True when this request URL is any recognized tracker (for capture recording). */
export function isTrackerRequest(url: string): boolean {
  return classifyTrackerVendor(url) !== 'other';
}
