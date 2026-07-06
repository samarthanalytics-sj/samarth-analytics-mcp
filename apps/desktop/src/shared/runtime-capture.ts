// RUNTIME-CAPTURE — the pure, framework-free brain behind the "runtime synthetic test".
//
// It never talks to a browser, the network, or Google. Its whole job is to take the raw
// analytics /collect requests the driver ABORTED (url + optional POST body) and turn them into a
// structured, contract-checked report: which expected events actually fired at runtime, which GA4
// required params their hit carried, and which destinations (GA4/Meta/TikTok/server) each hit went
// to. The driver reuses `classifyCollector` here as the EXACT matcher it aborts on, and
// `syntheticDataLayerEvent` here to build the deterministic, contract-driven dataLayer payloads it
// pushes — so "what we fire" and "what we grade" share one source of truth.
//
// PURE: no I/O, no playwright, no googleapis. Robust to missing/garbled pieces.

import { EVENT_CONTRACT, validateEventParams } from './tracking-contract';

/** One decoded GA4 event out of a /g/collect request (a single request may carry several). */
export interface Ga4CollectEvent {
  /** The GA4 event name (`en=`), lower-cased; '' when the group carries no en. */
  event: string;
  /** Event params: `ep.<key>` (string) and `epn.<key>` (number) flattened to string values. */
  params: Record<string, string>;
  /** True when the hit carried item params (`pr1=`, `pr2=`, …) → the GA4 `items` array. */
  hasItems: boolean;
}

// 'ad' is the catch-all for other ad-tech beacon endpoints (Google Ads/DoubleClick, Pinterest, Snap,
// LinkedIn, Reddit, Bing, X) — captured + ABORTED like any collector so a synthetic event never
// delivers a real conversion to them, but not attributed to a GA4 funnel destination.
export type Collector = 'ga4' | 'meta' | 'tiktok' | 'server' | 'ad';

/** Per-expected-event runtime result. */
export interface RuntimeEventResult {
  event: string;
  /** A GA4 /collect hit for this event was captured. */
  ga4Fired: boolean;
  /** GA4 required params (per the tracking contract) that the captured hit did NOT carry. */
  missingRequired: string[];
  /** Which collectors fired an event with this name (deduped, stable order). */
  destinations: Collector[];
}

export interface RuntimeReport {
  events: RuntimeEventResult[];
  summary: { fired: number; notFired: number; missingParams: number };
  /** Distinct collectors observed across all captured hits (for the "nothing was delivered" note). */
  collectorsSeen: string[];
}

/** A captured (aborted) hit: the request URL and, for batched GA4 hits, the POST body. */
export interface CapturedHit {
  url: string;
  body?: string | null;
}

// ── collector classification ──────────────────────────────────────────────────
// This is the SINGLE matcher the driver aborts on AND the report classifies with. A request is a
// collector iff this returns non-null; the driver never route.continue()s such a request.

/** Classify a request URL as an analytics collector, or null for a normal (non-collector) request.
 *  - ga4:    google-analytics.com / *.google-analytics.com / region1.google-analytics.com,
 *            path /g/collect or /collect (also analytics.google.com/g/collect).
 *  - meta:   facebook.com/tr (the Meta pixel/CAPI browser endpoint).
 *  - tiktok: analytics.tiktok.com/api (the TikTok pixel/Events API endpoint).
 *  - server: any other host, ONLY when it matches the optional serverUrl host (a first-party sGTM
 *            collector) — passed in so the driver aborts the user's own tagging server too.
 *  PURE. */
export function classifyCollector(url: string, serverHost?: string | null): Collector | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();

  // GA4 web + Measurement Protocol: any google-analytics.com subdomain (region1., www., etc.) plus
  // analytics.google.com, on a /collect or /g/collect path.
  const isGaHost =
    host === 'google-analytics.com' ||
    host.endsWith('.google-analytics.com') ||
    host === 'analytics.google.com';
  if (isGaHost && (path === '/g/collect' || path === '/collect' || path.endsWith('/g/collect') || path.endsWith('/collect'))) {
    return 'ga4';
  }

  // Meta pixel / CAPI browser endpoint: facebook.com/tr (with or without a trailing marker).
  if ((host === 'facebook.com' || host.endsWith('.facebook.com')) && (path === '/tr' || path.startsWith('/tr'))) {
    return 'meta';
  }

  // TikTok pixel / Events API: analytics.tiktok.com/api/…
  if ((host === 'analytics.tiktok.com' || host.endsWith('.tiktok.com')) && path.startsWith('/api')) {
    return 'tiktok';
  }

  // The user's own first-party tagging server (sGTM). Match on host so a /g/collect proxied through
  // the server URL is aborted like any other collector.
  if (serverHost) {
    const sh = serverHost.toLowerCase();
    if (host === sh || host.endsWith(`.${sh}`)) return 'server';
  }

  // PATH-BASED server-side / first-party GA4 collect: the GA4/MP collect paths on ANY host (a
  // self-hosted sGTM or a proxied first-party collect) — caught even when no serverHost was given.
  if (path === '/g/collect' || path.endsWith('/g/collect') || path.endsWith('/mp/collect') || path.endsWith('/j/collect')) {
    return 'server';
  }

  // Other ad-tech conversion beacons fire on the SAME synthetic events, so they must be aborted too —
  // a synthetic 'purchase' must never deliver a real conversion to any of them. Not attributed to a
  // GA4 funnel destination; captured as 'ad' so the caller can see they fired.
  const AD_HOSTS = [
    'doubleclick.net', 'googleadservices.com', 'ct.pinterest.com', 'tr.snapchat.com',
    'px.ads.linkedin.com', 'dc.ads.linkedin.com', 'alb.reddit.com', 'bat.bing.com',
    'analytics.twitter.com', 'ads-api.twitter.com',
  ];
  if (AD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'ad';
  // Google Ads conversion / remarketing pixels served off google.<tld>.
  if ((host === 'google.com' || /(^|\.)google\.[a-z.]+$/.test(host)) && (path.startsWith('/pagead') || path.startsWith('/ccm/collect') || path.startsWith('/ads'))) {
    return 'ad';
  }
  return null;
}

/** The bare hostname of a captured URL — shows WHERE a tag beaconed. */
export function beaconHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A RICHER platform label than classifyCollector's abort-family: it NAMES the specific destination
 *  (linkedin / pinterest / reddit / snapchat / bing / twitter / google_ads / hotjar / clarity) instead
 *  of lumping them all into 'ad'. Lets a verify verdict attribute a beacon to the RIGHT tag (so two ad
 *  tags on one interaction aren't both marked fired) and show exactly what fired — Phase A of "verify
 *  all tag types". Returns 'other:<host>' for an unrecognised beacon so it stays visible. */
export function beaconPlatform(url: string): string {
  const c = classifyCollector(url);
  if (c && c !== 'ad') return c; // ga4 | meta | tiktok | server
  const host = beaconHost(url);
  if (!host) return 'other';
  const named: Array<[RegExp, string]> = [
    [/(^|\.)linkedin\.com$/, 'linkedin'],
    [/(^|\.)pinterest\.com$/, 'pinterest'],
    [/(^|\.)reddit\.com$/, 'reddit'],
    [/(^|\.)snapchat\.com$/, 'snapchat'],
    [/(^|\.)bing\.com$/, 'bing'],
    [/(^|\.)(twitter|x)\.com$/, 'twitter'],
    [/(^|\.)hotjar\.com$/, 'hotjar'],
    [/(^|\.)clarity\.ms$/, 'clarity'],
    [/(^|\.)(doubleclick\.net|googleadservices\.com)$/, 'google_ads'],
  ];
  for (const [re, name] of named) if (re.test(host)) return name;
  if (c === 'ad') return 'google_ads'; // the remaining google.<tld>/pagead conversion pixels
  return `other:${host}`;
}

/** The ad/pixel platform families (everything except GA4 + the first-party server collect). */
const KNOWN_AD_PLATFORMS = new Set(['meta', 'tiktok', 'linkedin', 'pinterest', 'reddit', 'snapchat', 'bing', 'twitter', 'google_ads', 'hotjar', 'clarity']);
export function isKnownAdPlatform(p: string): boolean {
  return KNOWN_AD_PLATFORMS.has(p);
}

// ── GA4 /g/collect parsing ─────────────────────────────────────────────────────

/** Parse one flat parameter group (query string OR one body line) into a GA4 event.
 *  `en=` → event, `ep.<k>=` / `epn.<k>=` → params, `pr1=`/`pr2=`… → hasItems. Returns null when the
 *  group has nothing GA4-shaped in it. */
function parseGroup(search: URLSearchParams): Ga4CollectEvent | null {
  let event = '';
  const params: Record<string, string> = {};
  let hasItems = false;
  let sawAnything = false;
  for (const [rawKey, rawVal] of search.entries()) {
    const key = rawKey;
    if (key === 'en') {
      event = (rawVal ?? '').trim().toLowerCase();
      sawAnything = true;
    } else if (key.startsWith('ep.')) {
      const name = key.slice(3);
      if (name) { params[name] = rawVal ?? ''; sawAnything = true; }
    } else if (key.startsWith('epn.')) {
      const name = key.slice(4);
      if (name) { params[name] = rawVal ?? ''; sawAnything = true; }
    } else if (/^pr\d+$/.test(key)) {
      // GA4 encodes ecommerce items as pr1=, pr2=, … one per item.
      hasItems = true;
      sawAnything = true;
    }
  }
  if (!sawAnything) return null;
  return { event, params, hasItems };
}

/** Parse a GA4 web/MP2 `/g/collect` request into a FLAT list of events.
 *  The query string carries the FIRST event (`en=…&ep.…&epn.…&pr1=…`). When a single request BATCHES
 *  multiple events, the extra events live in the POST body as additional `&`-joined groups, one per
 *  newline. Parses both the URL query and every body line into one list. Robust to a missing url,
 *  missing body, blank lines, and non-GA4 requests (→ []). PURE. */
export function parseGa4CollectHit(input: { url: string; body?: string | null }): Ga4CollectEvent[] {
  const out: Ga4CollectEvent[] = [];

  // 1) The query string is the first event.
  try {
    const u = new URL(input.url);
    const first = parseGroup(u.searchParams);
    if (first) out.push(first);
  } catch {
    // Not a URL — fall through and still try the body.
  }

  // 2) The POST body carries any additional batched events, one group per line.
  const body = input.body;
  if (body && typeof body === 'string') {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A body line is itself an &-joined param group (no leading '?').
      const parsed = parseGroup(new URLSearchParams(trimmed));
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

// ── synthetic dataLayer payloads (deterministic, contract-driven) ───────────────

/** A single synthetic ecommerce item — valid but obviously fake so a stray real hit is spottable. */
const SYNTHETIC_ITEM = {
  item_id: 'SYNTHETIC_SKU',
  item_name: 'Synthetic Test Item',
  price: 1,
  quantity: 1,
} as const;

/** Build a SYNTHETIC-but-valid dataLayer payload object for an event, driven by the tracking
 *  contract's required params. Values are deterministic (so tests can assert them) and clearly fake
 *  (SYNTHETIC_* / value:1) so that if abort-first interception ever failed, the bogus hit is
 *  instantly recognisable and harmless. Shape: `{ event, ecommerce?, ...topLevelParams }`.
 *  PURE. */
export function syntheticDataLayerEvent(event: string): Record<string, unknown> {
  const name = (event ?? '').trim().toLowerCase();
  const schema = EVENT_CONTRACT[name];
  const payload: Record<string, unknown> = { event: name };

  // Unknown/custom event: nothing to synthesize beyond the name.
  if (!schema) return payload;

  const required = new Set(schema.requiredParams);
  const ecommerce: Record<string, unknown> = {};
  let usedEcommerce = false;

  // items → a one-item ecommerce array.
  if (required.has('items')) {
    ecommerce.items = [{ ...SYNTHETIC_ITEM }];
    usedEcommerce = true;
  }
  // transaction_id → a stable, obviously-synthetic order id.
  if (required.has('transaction_id')) {
    ecommerce.transaction_id = 'SYNTHETIC_TEST_TXN';
    usedEcommerce = true;
  }
  // value + currency travel together (GA4 ignores value without currency).
  if (required.has('value') || required.has('currency')) {
    ecommerce.value = 1;
    ecommerce.currency = 'USD';
    usedEcommerce = true;
  }
  // search_term (non-ecommerce) rides at the top level.
  if (required.has('search_term')) {
    payload.search_term = 'synthetic test query';
  }

  if (usedEcommerce) payload.ecommerce = ecommerce;
  return payload;
}

// ── evaluation ──────────────────────────────────────────────────────────────────

/** Evaluate the captured (aborted) hits against the list of expected events. For EACH expected
 *  event it reports whether a GA4 /collect hit fired, which GA4 required params that hit was missing
 *  (via the tracking contract; ep./epn. keys plus hasItems→'items'), and every collector that fired
 *  an event of that name. PURE — takes raw captured hits, returns the report. */
export function evaluateRuntimeCapture(
  capturedHits: CapturedHit[],
  expectedEvents: string[],
): RuntimeReport {
  // Index every decoded GA4 event by name → the params of its (first) captured hit.
  const ga4ByEvent = new Map<string, { params: Record<string, string>; hasItems: boolean }>();
  // Map event name → the set of collectors that fired it.
  const destByEvent = new Map<string, Set<Collector>>();
  const collectorsSeen = new Set<Collector>();

  for (const hit of capturedHits ?? []) {
    const collector = classifyCollector(hit.url);
    if (collector) collectorsSeen.add(collector);

    if (collector === 'ga4') {
      // GA4 hits are fully decodable → attribute params + destination per event.
      for (const ev of parseGa4CollectHit(hit)) {
        if (!ev.event) continue;
        if (!ga4ByEvent.has(ev.event)) ga4ByEvent.set(ev.event, { params: ev.params, hasItems: ev.hasItems });
        (destByEvent.get(ev.event) ?? destByEvent.set(ev.event, new Set()).get(ev.event)!).add('ga4');
      }
    } else if (collector === 'meta' || collector === 'tiktok' || collector === 'server') {
      // Non-GA4 collectors: we can't reliably decode a GA4 event name from their payloads, so we
      // attribute them to EVERY expected event (they were fired during that event's settle window).
      // This is a coarse "this destination received traffic" signal, not per-event proof.
      for (const raw of expectedEvents ?? []) {
        const ev = (raw ?? '').trim().toLowerCase();
        if (!ev) continue;
        (destByEvent.get(ev) ?? destByEvent.set(ev, new Set()).get(ev)!).add(collector);
      }
    }
  }

  const order: Collector[] = ['ga4', 'meta', 'tiktok', 'server'];
  const events: RuntimeEventResult[] = [];
  let fired = 0;
  let notFired = 0;
  let missingParams = 0;

  for (const raw of expectedEvents ?? []) {
    const event = (raw ?? '').trim().toLowerCase();
    if (!event) continue;
    const ga4 = ga4ByEvent.get(event);
    const ga4Fired = ga4 !== undefined;

    // Compute missing GA4 required params from the captured hit's params (+ hasItems → 'items').
    let missingRequired: string[] = [];
    if (ga4Fired) {
      const present = new Set(Object.keys(ga4.params));
      if (ga4.hasItems) present.add('items');
      missingRequired = validateEventParams(event, present).missingRequired;
    }

    const dests = destByEvent.get(event);
    const destinations = order.filter((c) => dests?.has(c));

    if (ga4Fired) fired += 1;
    else notFired += 1;
    if (missingRequired.length > 0) missingParams += 1;

    events.push({ event, ga4Fired, missingRequired, destinations });
  }

  return {
    events,
    summary: { fired, notFired, missingParams },
    collectorsSeen: order.filter((c) => collectorsSeen.has(c)),
  };
}
