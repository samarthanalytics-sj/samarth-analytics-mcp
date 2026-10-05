// The runtime leg, proven the only way configuration cannot: by sending ONE hit and reading it back.
//
// Every server check so far proves configuration. None of it can say whether a hit that leaves the
// browser is claimed by the tagging server, forwarded by the relay, and accepted by GA4. This module
// settles that by delivering one deliberately-labelled synthetic event through the tagging server
// and looking for it in the property's realtime report.
//
// That breaks the engine's standing rule that verification never delivers a hit, so the rule is
// broken narrowly and on purpose (user decision, 2026-09-22):
//   - one event, named samarth_probe_<8 hex>, so it can never be mistaken for traffic and each probe
//     is unique. The verdict keys on that exact name, so a stale probe can never pass a new one;
//   - a throwaway client id, so it creates no user or session anyone will recognise;
//   - debug_mode on, so it also appears in DebugView for a human to see;
//   - never called from the monitor, the verify engine or any scheduled path. It runs only when an
//     operator asks, through the confirm-gated chat tool.
//
// A hit that never shows up is reported as NOT VERIFIED, not as a failure: realtime has a short
// lag and a property can filter or sample. Only a hit that DOES show up proves anything. PURE.

import type { ServerContainerSnapshot } from './gtm-builders';
import { serverTagParam } from './gtm-builders';

const GA4_ID = /^G-[A-Z0-9]{4,}$/i;

/** Where this server's ACTIVE GA4 relays (unpaused sgtmgaaw tags with a firing trigger) send a hit,
 *  mirroring server-pair.ts so the probe and the pair findings agree on what the server forwards. */
export interface ProbeTargets {
  /** Literal Measurement IDs (a `{{Constant}}` resolved), upper-cased. A relay with a literal id
   *  overrides the hit's tid, so a probe for any OTHER id lands in one of these properties instead. */
  forwarded: Set<string>;
  /** A relay with a blank Measurement ID: it forwards whatever tid the incoming hit carries. */
  inherits: boolean;
  /** A relay whose id is a non-Constant variable (lookup table, event data, ...): decided at runtime,
   *  so the config can neither confirm nor rule out a given id. */
  dynamic: boolean;
}

/** The ids this server's active GA4 relays forward. PURE. */
export function probeTargets(server: Pick<ServerContainerSnapshot, 'tags' | 'variables'>): ProbeTargets {
  const constants = new Map<string, string>();
  for (const v of server.variables ?? []) {
    if ((v.type ?? '').toLowerCase() !== 'c') continue;
    const val = String(((v.parameter ?? []) as Array<{ key?: string; value?: unknown }>).find((p) => p.key === 'value')?.value ?? '').trim();
    if (val) constants.set(v.name.trim().toLowerCase(), val);
  }
  const forwarded = new Set<string>();
  let inherits = false;
  let dynamic = false;
  for (const t of server.tags) {
    if (t.type !== 'sgtmgaaw' || t.paused || (t.firingTriggerId ?? []).length === 0) continue;
    const raw = serverTagParam(t, 'measurementId').trim();
    if (!raw) { inherits = true; continue; }
    const ref = raw.match(/^\{\{([^}]+)\}\}$/);
    const val = ref ? constants.get(ref[1].trim().toLowerCase()) : raw;
    if (val === undefined) { dynamic = true; continue; }
    if (GA4_ID.test(val.trim())) forwarded.add(val.trim().toUpperCase());
  }
  return { forwarded, inherits, dynamic };
}

/**
 * Why a probe for `measurementId` must NOT be sent, or null when it may be. Decided BEFORE anything
 * is delivered, because a probe cannot be taken back out of a GA4 property:
 *   - an id a relay forwards literally is the server's own configured destination: allowed (if this
 *     account cannot read that property the probe is still sent, and reported as not read back);
 *   - an id only an inheriting/dynamic relay would carry is allowed only when this account can read
 *     a property with that stream, since nothing else corroborates it (a typo or another client's id
 *     would otherwise be delivered straight into a property no one here can see);
 *   - any other id is refused: a literal relay would re-route the hit into ITS property, so the probe
 *     would land in a different production property than the one named, and read back nothing. PURE.
 */
export function probeTargetRefusal(targets: ProbeTargets, measurementId: string, readable: boolean): string | null {
  const id = measurementId.trim().toUpperCase();
  if (targets.forwarded.has(id)) return null;
  if (targets.inherits || targets.dynamic) {
    if (readable) return null;
    return `No GA4 property this account can read has the stream ${id}, and no relay on this server names ${id} literally (it would only be carried by a relay that ${targets.inherits ? 'inherits the incoming id' : 'derives the id from a variable'}). Nothing corroborates that ${id} is the intended property and the arrival could not be read back, so no probe was sent. Check the id, or pass one the server forwards${targets.forwarded.size ? ` (${[...targets.forwarded].join(', ')})` : ''}.`;
  }
  const list = [...targets.forwarded].join(', ');
  return list
    ? `This server does not forward ${id}: its active GA4 relays forward ${list} and none inherits the id, so a probe for ${id} would be re-routed into ${list} instead. No probe was sent. Pass one of the forwarded ids.`
    : `This server has no active GA4 relay (an unpaused GA4 tag with a firing trigger), so a probe for ${id} has nowhere to go. No probe was sent.`;
}

export interface ProbeHit {
  /** Full URL the hit is sent to (GET; the GA4 client accepts GET with query params). */
  url: string;
  /** The unique event name the verdict will look for. */
  eventName: string;
  clientId: string;
  measurementId: string;
}

/** Random hex of the given length, from the caller's entropy so this stays pure. */
export function probeSuffix(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += Math.floor(random() * 16).toString(16);
  return s;
}

/**
 * The exact GA4 collect request the tagging server's GA4 client claims (`/g/collect`, protocol
 * v=2). Field names are the ones GA4's own gtag sends, which the repo's capture decoder already
 * reads: tid, cid, en, _dbg, ep.*. Throws on a malformed id or a non-https host rather than
 * sending something the server would reject with a 400 that looks like a real failure.
 */
export function buildProbeHit(input: { taggingUrl: string; measurementId: string; suffix: string; clientId?: string }): ProbeHit {
  const mid = input.measurementId.trim().toUpperCase();
  if (!GA4_ID.test(mid)) throw new Error(`Not a GA4 Measurement ID: ${input.measurementId}`);
  let base: URL;
  try { base = new URL(input.taggingUrl); } catch { throw new Error(`Not a valid tagging server URL: ${input.taggingUrl}`); }
  if (base.protocol !== 'https:') throw new Error('Tagging server URL must be https.');
  if (base.username || base.password) throw new Error('URL must not embed credentials.');
  const eventName = `samarth_probe_${input.suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
  // A throwaway client id in gtag's own "<random>.<epoch>" shape.
  const clientId = input.clientId ?? `${Math.floor(1e9 + Number.parseInt(input.suffix.slice(0, 6), 16) % 9e8)}.${Math.floor(Date.now() / 1000)}`;
  // Keep the configured path prefix: a same-origin setup (https://www.example.com/metrics) routes
  // only that path to the tagging server, and gtag sends to `${server_container_url}/g/collect`.
  // Query and hash are dropped.
  const prefix = base.pathname.replace(/\/+$/, '');
  const u = new URL(`${base.protocol}//${base.host}${prefix}/g/collect`);
  const q = u.searchParams;
  q.set('v', '2');
  q.set('tid', mid);
  q.set('cid', clientId);
  q.set('en', eventName);
  q.set('_dbg', '1');
  q.set('ep.debug_mode', '1');
  q.set('ep.probe_source', 'samarth_runtime_probe');
  q.set('dl', `https://${base.host}/samarth-runtime-probe`);
  q.set('dt', 'Samarth runtime probe');
  q.set('sid', String(Math.floor(Date.now() / 1000)));
  q.set('sct', '1');
  q.set('seg', '0');
  q.set('_p', String(Date.now()));
  return { url: u.toString(), eventName, clientId, measurementId: mid };
}

/** The realtime read-back for one probe: an EXACT filter on its unique event name, so the row comes
 *  back however many other event names the property saw in the window (an unfiltered report returns
 *  one capped page of rows and can cut a count-1 probe off a busy property). PURE. */
export function probeRealtimeQuery(property: string, eventName: string): {
  property: string;
  dimensions: string[];
  metrics: string[];
  dimensionFilter: Record<string, unknown>;
} {
  return {
    property,
    dimensions: ['eventName'],
    metrics: ['eventCount'],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } } },
  };
}

export interface RealtimeRow { dimensions: string[]; metrics: string[] }

export type ProbeVerdict =
  | { status: 'pass'; eventCount: number }
  | { status: 'not_verified' };

/** Did THIS probe's event reach the property? Keys on the exact unique event name. PURE. */
export function probeVerdict(rows: readonly RealtimeRow[], eventName: string): ProbeVerdict {
  const want = eventName.toLowerCase();
  let count = 0;
  for (const r of rows) {
    if ((r.dimensions[0] ?? '').toLowerCase() !== want) continue;
    count += Number.parseInt(r.metrics[0] ?? '0', 10) || 0;
  }
  return count > 0 ? { status: 'pass', eventCount: count } : { status: 'not_verified' };
}

export interface ProbeResult {
  status: 'pass' | 'not_verified' | 'send_failed';
  measurementId: string;
  property: string | null;
  propertyDisplayName: string | null;
  taggingHost: string;
  eventName: string;
  /** HTTP status the tagging server answered the hit with (204 = claimed and accepted). */
  sendStatus: number | null;
  sentAt: number;
  seenAt: number | null;
  latencyMs: number | null;
  polls: number;
  /** What this proves and what it does not, in the operator's terms. */
  boundary: string;
  note: string;
}

/** The human-facing summary for each outcome, so every caller says the same thing. PURE. */
export function describeProbe(r: Omit<ProbeResult, 'boundary' | 'note'>): Pick<ProbeResult, 'boundary' | 'note'> {
  const boundary =
    'This proves the round trip web -> tagging server -> GA4 relay -> GA4 property for ONE synthetic event. It does not prove ' +
    'that the site\'s real tags send to this server (see the pair findings), nor anything about non-GA4 destinations. ' +
    'Any other server tag whose trigger matches the event (another GA4 relay, a CAPI tag on an all-events trigger) receives it too.';
  if (r.status === 'send_failed') {
    return { boundary, note: `The tagging server did not accept the hit (HTTP ${r.sendStatus ?? 'no response'}). A 400 here means no client claimed /g/collect; check the GA4 client and its default paths.` };
  }
  if (r.status === 'pass') {
    return { boundary, note: `Event "${r.eventName}" reached ${r.propertyDisplayName ?? r.property} ${Math.round((r.latencyMs ?? 0) / 1000)}s after the server accepted it (HTTP ${r.sendStatus}). It is also visible in DebugView. The full path works.` };
  }
  return {
    boundary,
    note: `The server accepted the hit (HTTP ${r.sendStatus}) but "${r.eventName}" did not appear in ${r.propertyDisplayName ?? r.property ?? 'the property'} within the wait. NOT VERIFIED rather than failed: realtime can lag past the wait, and a property can filter traffic. Check DebugView for the event name, then the relay's trigger for ${r.measurementId}.`,
  };
}
