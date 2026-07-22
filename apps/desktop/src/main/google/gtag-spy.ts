// GTAG SPY - parse the PUBLIC gtag.js loader (www.googletagmanager.com/gtag/js?id=G-XXXX) into a
// normalized, diffable snapshot of the tag-side configuration. No login, no permissions - this is
// exactly what every visitor's browser downloads, so it works on ANY measurement id (competitors
// included). PURE parsing over the fetched JS text; the caller does the fetch.
//
// Honesty rules: only fields the blob actually carries are reported; unknown/unparsed content
// degrades to `parsed: false` (never a guess); request-time values (serving geo, per-request
// consent resolution) are EXCLUDED so a scan from a different network can never fake a change.

export interface GtagSpySnapshot {
  measurementId: string;
  /** False when the config blob could not be located/parsed - every other field is then empty. */
  parsed: boolean;
  /** All ids the Google tag loads (GT-/AW-/extra G-), from the destination blob. */
  destinations: string[];
  /** Enhanced-measurement auto events compiled into the tag (from __ogt_auto_events). */
  autoEvents: { outboundClick: boolean; scroll: boolean; download: boolean; historyEvents: boolean; form: boolean; video: boolean; pageView: boolean } | null;
  /** Site-search query params (from __ccd_em_site_search). */
  siteSearchParams: string | null;
  /** Events marked as key events at tag level (from __ccd_conversion_marking). */
  keyEvents: string[];
  /** User-provided data collection (from __ogt_1p_data_v2). */
  userData: { enabled: boolean; auto: boolean; email: boolean; phone: boolean; address: boolean } | null;
  /** Email redaction (from __ccd_auto_redact). */
  redactEmail: boolean | null;
  /** Google Signals disabled everywhere at the tag (from __ccd_ga_regscope GOOGLE_SIGNALS row). */
  googleSignalsDisallowedEverywhere: boolean | null;
  /** First-party sGTM endpoint (from __gct server_container_url / transport_url), when set. */
  serverContainerUrl: string | null;
  /** Session timeout override in seconds (from __gct vtp_sessionDuration; 0 = default). */
  sessionDurationSec: number | null;
  /** Cross-domain linker domains (from __gct/linker config), when present. */
  linkerDomains: string[];
  /** The tag functions present, for change detection on anything we don't model yet. */
  tagFunctions: string[];
}

type TagEntry = Record<string, unknown> & { function?: string };

const val = (t: TagEntry, k: string): unknown => t[`vtp_${k}`];
const boolOf = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** Extract the embedded `var data = {...};` JSON. Returns null when the shape is unrecognized. */
export function extractGtagData(js: string): { resource?: { tags?: TagEntry[] }; blob?: Record<string, string> } | null {
  const marker = 'var data = ';
  const start = js.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  const end = js.indexOf('};\n', from);
  if (end < 0) return null;
  try {
    return JSON.parse(js.slice(from, end + 1)) as { resource?: { tags?: TagEntry[] }; blob?: Record<string, string> };
  } catch {
    return null;
  }
}

export function parseGtagSnapshot(measurementId: string, js: string): GtagSpySnapshot {
  const empty: GtagSpySnapshot = {
    measurementId, parsed: false, destinations: [], autoEvents: null, siteSearchParams: null,
    keyEvents: [], userData: null, redactEmail: null, googleSignalsDisallowedEverywhere: null,
    serverContainerUrl: null, sessionDurationSec: null, linkerDomains: [], tagFunctions: [],
  };
  const data = extractGtagData(js);
  const tags = data?.resource?.tags;
  if (!data || !Array.isArray(tags)) return empty;
  const byFn = (fn: string): TagEntry | undefined => tags.find((t) => t.function === fn);

  // Destinations: blob entry like "G-XXXX|GT-YYYY" (position varies; match by shape, not key).
  const destinations = Object.values(data.blob ?? {})
    .filter((v): v is string => typeof v === 'string' && /^(G|GT|AW|DC)-[A-Z0-9]+(\|(G|GT|AW|DC)-[A-Z0-9]+)*$/.test(v))
    .flatMap((v) => v.split('|'));

  const auto = byFn('__ogt_auto_events');
  const oneP = byFn('__ogt_1p_data_v2');
  const conv = byFn('__ccd_conversion_marking');
  const redact = byFn('__ccd_auto_redact');
  const regscope = byFn('__ccd_ga_regscope');
  const search = byFn('__ccd_em_site_search');
  const gct = byFn('__gct');

  // Key events: conversionRules entries carry a JSON matchingRules string with a stringValue arg.
  const keyEvents: string[] = [];
  if (conv) {
    for (const m of JSON.stringify(val(conv, 'conversionRules') ?? []).matchAll(/stringValue[\\":]+([a-zA-Z0-9_]+)/g)) {
      if (!keyEvents.includes(m[1])) keyEvents.push(m[1]);
    }
  }

  // Google Signals region scope: a settings row for GOOGLE_SIGNALS with disallowAllRegions true.
  let signalsOff: boolean | null = null;
  if (regscope) {
    const rows = JSON.stringify(val(regscope, 'settingsTable') ?? '');
    if (rows.includes('GOOGLE_SIGNALS')) signalsOff = /GOOGLE_SIGNALS","disallowAllRegions",true/.test(rows);
  }

  const serverUrl = (gct && (val(gct, 'serverContainerUrl') ?? val(gct, 'transportUrl'))) as string | undefined;
  const linker = gct ? JSON.stringify(val(gct, 'linker') ?? val(gct, 'linkerDomains') ?? '') : '';
  const linkerDomains = [...linker.matchAll(/"([a-z0-9.-]+\.[a-z]{2,})"/gi)].map((m) => m[1]);

  return {
    measurementId,
    parsed: true,
    destinations: destinations.length ? [...new Set(destinations)] : [measurementId],
    autoEvents: auto
      ? {
          outboundClick: boolOf(val(auto, 'enableOutboundClick')), scroll: boolOf(val(auto, 'enableScroll')),
          download: boolOf(val(auto, 'enableDownload')), historyEvents: boolOf(val(auto, 'enableHistoryEvents')),
          form: boolOf(val(auto, 'enableForm')), video: boolOf(val(auto, 'enableVideo')), pageView: boolOf(val(auto, 'enablePageView')),
        }
      : null,
    siteSearchParams: search ? String(val(search, 'searchQueryParams') ?? '') || null : null,
    keyEvents,
    userData: oneP
      ? {
          enabled: boolOf(val(oneP, 'isEnabled')), auto: boolOf(val(oneP, 'isAutoEnabled')),
          email: boolOf(val(oneP, 'autoEmailEnabled')), phone: boolOf(val(oneP, 'autoPhoneEnabled')), address: boolOf(val(oneP, 'autoAddressEnabled')),
        }
      : null,
    redactEmail: redact ? boolOf(val(redact, 'redactEmail')) : null,
    googleSignalsDisallowedEverywhere: signalsOff,
    serverContainerUrl: serverUrl ? String(serverUrl) : null,
    sessionDurationSec: gct && val(gct, 'sessionDuration') !== undefined ? Number(val(gct, 'sessionDuration')) || 0 : null,
    linkerDomains: [...new Set(linkerDomains)],
    tagFunctions: [...new Set(tags.map((t) => String(t.function ?? '')))].filter(Boolean).sort(),
  };
}

/** One human-readable change between two snapshots of the SAME measurement id. */
export interface GtagSpyChange { field: string; before: string; after: string }

const show = (v: unknown): string => (v === null ? '(not set)' : Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Diff STABLE config fields only - request-time values never enter the snapshot, so every change
 *  reported here is a real configuration change someone made. */
export function diffGtagSnapshots(before: GtagSpySnapshot, after: GtagSpySnapshot): GtagSpyChange[] {
  if (!before.parsed || !after.parsed) return [];
  const out: GtagSpyChange[] = [];
  const cmp = (field: string, a: unknown, b: unknown): void => {
    const sa = show(a);
    const sb = show(b);
    if (sa !== sb) out.push({ field, before: sa, after: sb });
  };
  cmp('destinations', before.destinations, after.destinations);
  cmp('enhanced measurement', before.autoEvents, after.autoEvents);
  cmp('site-search params', before.siteSearchParams, after.siteSearchParams);
  cmp('key events', before.keyEvents, after.keyEvents);
  cmp('user-provided data collection', before.userData, after.userData);
  cmp('email redaction', before.redactEmail, after.redactEmail);
  cmp('Google Signals disabled everywhere', before.googleSignalsDisallowedEverywhere, after.googleSignalsDisallowedEverywhere);
  cmp('server container URL', before.serverContainerUrl, after.serverContainerUrl);
  cmp('session timeout (sec)', before.sessionDurationSec, after.sessionDurationSec);
  cmp('cross-domain linker domains', before.linkerDomains, after.linkerDomains);
  cmp('tag functions', before.tagFunctions, after.tagFunctions);
  return out;
}
