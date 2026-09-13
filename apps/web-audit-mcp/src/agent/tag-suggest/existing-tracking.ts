// Phase 2 (safe slice): detect what analytics/advertising tracking a site ALREADY
// ships, from the signals the collector harvested in-page (script srcs, provider
// selectors, the site's own dataLayer events, and the JS framework). PURE — no
// browser, no I/O — so it unit-tests without a headless run and drops straight
// into the scan report. The intent is descriptive, not prescriptive: surface
// "GA4 + Meta Pixel are already installed; the site already pushes these
// dataLayer events" so the install-plan step can mark an already-pushed custom
// event as "nothing to install".

import type { PageSignals } from './types.js';

/** What tracking a site already has installed, unioned across the scanned pages. */
export interface ExistingTracking {
  /** A GTM container loader (gtm.js) is present. */
  gtm: boolean;
  /** GA4 is loaded (a gtag/analytics script or a G-XXXX Measurement ID was seen). */
  ga4: boolean;
  /** Distinct GA4 Measurement IDs (G-XXXXXXX) extracted from the gtag script URLs. */
  ga4MeasurementIds: string[];
  /** Google Ads (gtag AW-… / googleadservices / aw/collect). */
  googleAds: boolean;
  /** Meta (Facebook) Pixel (connect.facebook.net / facebook.com/tr). */
  metaPixel: boolean;
  /** TikTok Pixel (analytics.tiktok.com). */
  tiktok: boolean;
  /** LinkedIn Insight Tag (snap.licdn.com). */
  linkedin: boolean;
  /** Distinct dataLayer `event` values the site already pushes (union across pages). */
  dataLayerEvents: string[];
  /** First detected JS framework across the pages (next/react/vue/angular/gatsby), if any. */
  framework?: string;
}

// ── Vendor script-URL signatures ──────────────────────────────────────────────
// Matched against the unioned <script src> list. Kept here (this module has no
// pixel-signatures.ts sibling to reuse) and deliberately conservative.
const GTM_RE = /googletagmanager\.com\/gtm\.js/i;
// A gtag/analytics script OR a /g/collect beacon means GA4 is actually loading.
const GA4_SCRIPT_RE = /googletagmanager\.com\/gtag\/js|google-analytics\.com|\/g\/collect/i;
// A GA4 Measurement ID as it appears in the gtag loader URL (?id=G-XXXX). Global so all ids are pulled.
const GA4_ID_RE = /[?&]id=(G-[A-Z0-9]{4,})/gi;
// Google Ads: the gtag loader with an AW- id, the classic conversion/remarketing host, or aw/collect.
const GOOGLE_ADS_RE = /googleadservices\.com|gtag\/js\?id=AW-|[?&]id=AW-|\/aw\/collect/i;
const META_PIXEL_RE = /connect\.facebook\.net|facebook\.com\/tr/i;
const TIKTOK_RE = /analytics\.tiktok\.com/i;
const LINKEDIN_RE = /snap\.licdn\.com/i;

/** Union of `signals.scriptSrcs` + `signals.selectorsPresent` across pages — the surface every
 *  script/selector-based signature is matched against (a selector like a gtag id could appear either
 *  place). Framework and dataLayer are unioned separately below. */
function unionStrings(pages: Array<{ signals: PageSignals }>): string[] {
  const out: string[] = [];
  for (const p of pages) {
    const s = p.signals;
    if (Array.isArray(s.scriptSrcs)) out.push(...s.scriptSrcs);
    if (Array.isArray(s.selectorsPresent)) out.push(...s.selectorsPresent);
  }
  return out;
}

/** Detect the tracking a site already has, unioned across the scanned pages. PURE. */
export function detectExistingTracking(pages: Array<{ signals: PageSignals }>): ExistingTracking {
  const strings = unionStrings(pages);
  const anyMatch = (re: RegExp): boolean => strings.some((s) => re.test(s));

  const gtm = anyMatch(GTM_RE);

  // Extract every GA4 Measurement ID (G-XXXX) from the matched script URLs, deduped + sorted.
  const idSet = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(GA4_ID_RE)) idSet.add(m[1].toUpperCase());
  }
  const ga4MeasurementIds = [...idSet].sort();

  // Be conservative on ga4: a gtag/analytics/collect script OR a G-XXXX id. GTM alone is NOT enough —
  // a container can exist without GA4 wired into it — so gtm does not by itself imply ga4.
  const ga4 = anyMatch(GA4_SCRIPT_RE) || ga4MeasurementIds.length > 0;

  const googleAds = anyMatch(GOOGLE_ADS_RE);
  const metaPixel = anyMatch(META_PIXEL_RE);
  const tiktok = anyMatch(TIKTOK_RE);
  const linkedin = anyMatch(LINKEDIN_RE);

  // dataLayer events: deduped union across pages, order-stable (first-seen wins).
  const evSet = new Set<string>();
  for (const p of pages) {
    for (const ev of p.signals.dataLayerEvents ?? []) {
      if (typeof ev === 'string' && ev) evSet.add(ev);
    }
  }
  const dataLayerEvents = [...evSet];

  // framework: the first non-empty framework marker across the pages.
  const framework = pages.map((p) => p.signals.framework).find((f): f is string => !!f);

  return { gtm, ga4, ga4MeasurementIds, googleAds, metaPixel, tiktok, linkedin, dataLayerEvents, ...(framework ? { framework } : {}) };
}
