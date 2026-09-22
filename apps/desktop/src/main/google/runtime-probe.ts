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

const GA4_ID = /^G-[A-Z0-9]{4,}$/i;

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
  const u = new URL('/g/collect', `${base.protocol}//${base.host}`);
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
    'that the site\'s real tags send to this server (see the pair findings), nor anything about non-GA4 destinations.';
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
