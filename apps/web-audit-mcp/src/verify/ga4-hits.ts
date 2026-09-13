/**
 * GA4 /g/collect parser — GET query strings AND batched POST bodies.
 *
 * Mirrors the POST-batch split approach of apps/desktop/src/shared/runtime-capture.ts
 * (query = first event, body = one &-joined group per line) but captures the
 * FULL param set the verification spec enumerates — v, tid, cid, sid, en, ep.*,
 * epn.*, up.*, upn.*, gcs, gcd, dl, dr, _et — and flags the legacy /collect
 * endpoint. Pure and dependency-free: robust to missing/garbled input.
 *
 * Request-level params (v/tid/cid/sid/gcs/gcd/dl/dr) live in the query string
 * and are copied onto every event derived from that request (a batched POST
 * carries the events in the body but the ids in the query).
 */

import type { Ga4Hit } from './types.js';

/** Collect endpoints we treat as GA4 (client-side). */
const GA4_COLLECT_RE = /\/g\/collect(?:[/?]|$)/i;
const LEGACY_COLLECT_RE = /google-analytics\.com\/(?:r\/)?collect(?:[/?]|$)/i;

/** True when a request URL is a GA4 (or legacy) collect endpoint. */
export function isGa4CollectRequest(url: string): boolean {
  return GA4_COLLECT_RE.test(url) || LEGACY_COLLECT_RE.test(url);
}

/** True for the legacy Universal-Analytics-style /collect endpoint (captured but flagged). */
export function isLegacyCollect(url: string): boolean {
  return !GA4_COLLECT_RE.test(url) && LEGACY_COLLECT_RE.test(url);
}

const COMMON_KEYS = ['v', 'tid', 'cid', 'sid', 'gcs', 'gcd', 'dl', 'dr'] as const;

interface EventGroup {
  en: string;
  params: Record<string, string>;
  etMs?: number;
  hasItems: boolean;
  /** The group carried something event-shaped (en / ep.* / epn.* / items). */
  hasEventData: boolean;
}

/** Decode an `&`-joined param string (a query string sans `?`, or one POST body line). */
function decodeParams(paramString: string): Record<string, string> {
  const out: Record<string, string> = {};
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(paramString);
  } catch {
    return out;
  }
  for (const [k, v] of sp.entries()) {
    if (k && out[k] === undefined) out[k] = v;
  }
  return out;
}

/** Pull the event-scoped fields (en, ep.*, epn.*, up.*, upn.*, _et, items) out of a param map. */
function parseEventGroup(map: Record<string, string>): EventGroup {
  let en = '';
  const params: Record<string, string> = {};
  let etMs: number | undefined;
  let hasItems = false;
  let hasEventData = false;

  for (const [key, val] of Object.entries(map)) {
    if (key === 'en') {
      en = val ?? '';
      hasEventData = true;
    } else if (key === '_et') {
      const n = Number(val);
      if (Number.isFinite(n)) etMs = n;
    } else if (
      key.startsWith('ep.') ||
      key.startsWith('epn.') ||
      key.startsWith('up.') ||
      key.startsWith('upn.')
    ) {
      // Keyed by full key so a spec's { "ep.page_type": "home" } matches directly.
      params[key] = val ?? '';
      hasEventData = true;
    } else if (/^pr\d+$/.test(key)) {
      hasItems = true;
      hasEventData = true;
    }
  }
  return { en, params, etMs, hasItems, hasEventData };
}

function buildHit(
  common: Record<string, string>,
  ev: EventGroup,
  transport: 'GET' | 'POST',
  legacy: boolean,
  tRelativeMs: number,
): Ga4Hit {
  const hit: Ga4Hit = {
    en: ev.en,
    params: ev.params,
    hasItems: ev.hasItems,
    transport,
    legacy,
    tRelativeMs,
  };
  if (common.v !== undefined) hit.v = common.v;
  if (common.tid !== undefined) hit.tid = common.tid;
  if (common.cid !== undefined) hit.cid = common.cid;
  if (common.sid !== undefined) hit.sid = common.sid;
  if (common.gcs !== undefined) hit.gcs = common.gcs;
  if (common.gcd !== undefined) hit.gcd = common.gcd;
  if (common.dl !== undefined) hit.dl = common.dl;
  if (common.dr !== undefined) hit.dr = common.dr;
  if (ev.etMs !== undefined) hit.etMs = ev.etMs;
  return hit;
}

export interface RawCollectRequest {
  url: string;
  method?: string;
  postData?: string | null;
  /** ms since navigation start. */
  tRelativeMs: number;
}

/**
 * Parse one GA4 collect request into a flat list of decoded events. Returns []
 * for a non-collect URL. A batched POST yields one hit per body line; a plain
 * GET yields one hit. When a collect request carries no event-shaped params at
 * all, a single param-only hit (en='') is still emitted so consent/tracker
 * checks can see it fired.
 */
export function parseCollectRequest(req: RawCollectRequest): Ga4Hit[] {
  if (!isGa4CollectRequest(req.url)) return [];

  const transport: 'GET' | 'POST' = (req.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const legacy = isLegacyCollect(req.url);

  // Query string → common (request-level) params + a possible first event.
  let queryMap: Record<string, string> = {};
  try {
    const u = new URL(req.url);
    for (const [k, v] of u.searchParams.entries()) {
      if (k && queryMap[k] === undefined) queryMap[k] = v;
    }
  } catch {
    queryMap = {};
  }
  const common: Record<string, string> = {};
  for (const k of COMMON_KEYS) {
    if (queryMap[k] !== undefined) common[k] = queryMap[k];
  }

  const hits: Ga4Hit[] = [];

  const queryEvent = parseEventGroup(queryMap);
  if (queryEvent.hasEventData) {
    hits.push(buildHit(common, queryEvent, transport, legacy, req.tRelativeMs));
  }

  if (req.postData && typeof req.postData === 'string') {
    for (const line of req.postData.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lineMap = decodeParams(trimmed);
      const ev = parseEventGroup(lineMap);
      if (!ev.hasEventData) continue;
      // A body line may override request-level params (rare); prefer the line's value.
      const merged: Record<string, string> = { ...common };
      for (const k of COMMON_KEYS) {
        if (lineMap[k] !== undefined) merged[k] = lineMap[k];
      }
      hits.push(buildHit(merged, ev, transport, legacy, req.tRelativeMs));
    }
  }

  if (hits.length === 0) {
    // Collect request with no decodable event — still record it fired.
    hits.push(buildHit(common, { en: '', params: {}, hasItems: false, hasEventData: false }, transport, legacy, req.tRelativeMs));
  }
  return hits;
}
