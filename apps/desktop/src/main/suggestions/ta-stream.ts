// TAG ASSISTANT DEBUG-STREAM PARSER — pure (no browser, no I/O).
//
// When Tag Assistant (tagassistant.google.com) connects to a site, the page streams its debug feed to
// the TA window as plain postMessage JSON frames. We capture those frames verbatim in the TA page (a
// simple window 'message' listener — no UI scraping) and this module turns them into per-event records:
// which dataLayer push happened (TA's "API Call" block), and which tags started/finished with what
// status (TA's "Tags Fired" panel). Schema learned from live captures against samarthanalytics.com
// (probes 2026-07-10): frame types CONTAINER_STARTING / CONTAINER_DETAILS / PAGE_SUMMARY / PING / MEMO,
// with MEMO.data.memo.sanitized carrying messageType EVENT_STARTED | DATA_LAYER | MACRO_RESOLVED |
// TAG_STARTED | TAG_STATUS keyed by {publicId, eventId, eventName, tagName?}.
//
// Tolerant BY DESIGN: the stream is undocumented, so unknown frames are skipped, statuses are matched
// by substring, and nothing here ever throws on a malformed frame (a debug frame must never be able to
// break verification).

/** One container observed on the debugged page. */
export interface TaContainer {
  id: string;
  /** The container actually entered debug mode (its frames carry per-tag data). */
  debug: boolean;
  /** GTM = web container, OGT = Google tag (gtag). */
  product?: string;
  /** TA resolved the container's details — for a GTM container this requires a signed-in session with
   *  access; false/undefined + debug:false means "not enabled for debugging" (sign in and retry). */
  detailsFound?: boolean;
}

export type TaTagStatus = 'fired' | 'failed' | 'running' | 'unknown';

export interface TaTagResult {
  name: string;
  status: TaTagStatus;
}

/** One dataLayer event as Tag Assistant sees it — the unit of the TA left-rail timeline. */
export interface TaEventRecord {
  /** The container that processed the event (publicId, e.g. GTM-NKZD4BVB). */
  container: string;
  eventId: number;
  eventName: string;
  /** The EXACT dataLayer push that raised the event — TA's "API Call" block. Absent for internal
   *  events (gtm.init etc.) that carry no message. */
  apiCall?: Record<string, unknown>;
  /** Resolved variable values at this event (name → value) — feeds DLV-based trigger suggestions for
   *  tags that did not fire. */
  variables?: Record<string, string>;
  /** Tags GTM ran on this event, with their final status. A container tag NOT in this list did not
   *  fire on this event (join against the container inventory at the verdict layer). */
  tags: TaTagResult[];
}

export interface TaCapture {
  containers: TaContainer[];
  events: TaEventRecord[];
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Map TA's execute strings ("execute_running", "execute_succeeded", "execute_failure", …) to a status.
 *  Substring-matched so wording drift in the undocumented stream degrades to 'unknown', never throws. */
export function mapExecuteStatus(execute: string | undefined): TaTagStatus {
  const s = (execute ?? '').toLowerCase();
  if (/succe|complete|finish|done/.test(s)) return 'fired';
  if (/fail|error|exception|abort/.test(s)) return 'failed';
  if (/running|start|progress/.test(s)) return 'running';
  return 'unknown';
}

const STATUS_RANK: Record<TaTagStatus, number> = { unknown: 0, running: 1, fired: 2, failed: 3 };

/**
 * Parse raw captured TA frames (strings or already-parsed objects, in arrival order) into containers +
 * per-event records. Junk/unknown frames are skipped. PURE.
 */
export function parseTaFrames(frames: unknown[]): TaCapture {
  const containers = new Map<string, TaContainer>();
  const events = new Map<string, TaEventRecord>();

  for (const raw of frames) {
    let frame: Record<string, unknown> | null = null;
    if (typeof raw === 'string') {
      try { frame = asObj(JSON.parse(raw)); } catch { frame = null; }
    } else {
      frame = asObj(raw);
    }
    if (!frame) continue;
    const type = String(frame.type ?? '');
    const data = asObj(frame.data);

    if (type === 'CONTAINER_STARTING' && data) {
      const id = String(data.id ?? '');
      if (!id) continue;
      const prev = containers.get(id);
      containers.set(id, {
        id,
        // debug:true wins across frames — gtm.js loads once plain, then RELOADS in debug mode.
        debug: Boolean(data.debug) || Boolean(prev?.debug),
        product: String(data.containerProduct ?? prev?.product ?? '') || undefined,
        ...(prev?.detailsFound !== undefined ? { detailsFound: prev.detailsFound } : {}),
      });
      continue;
    }
    if (type === 'CONTAINER_DETAILS' && data) {
      const id = String(data.id ?? '');
      if (!id) continue;
      const prev = containers.get(id) ?? { id, debug: false };
      containers.set(id, { ...prev, detailsFound: String(data.status ?? '') === 'DETAILS_FOUND' });
      continue;
    }
    if (type !== 'MEMO') continue;

    const san = asObj(asObj(asObj(frame.data)?.memo)?.sanitized);
    if (!san) continue;
    const key = asObj(san.key);
    if (!key) continue;
    const container = String(key.publicId ?? '');
    const eventId = Number(key.eventId);
    if (!container || !Number.isFinite(eventId)) continue;
    const mapKey = `${container}|${eventId}`;
    let rec = events.get(mapKey);
    if (!rec) {
      rec = { container, eventId, eventName: String(key.eventName ?? ''), tags: [] };
      events.set(mapKey, rec);
    }
    if (!rec.eventName && key.eventName) rec.eventName = String(key.eventName);

    const messageType = String(san.messageType ?? '');
    if (messageType === 'DATA_LAYER') {
      const msg = asObj(san.message);
      if (msg) {
        rec.apiCall = msg;
        // AUTHORITATIVE event name = the real dataLayer push's own `event`. The frame's key.eventName is
        // UNRELIABLE — observed mislabeled (e.g. a gtm.linkClick event keyed as "form_submission"), which
        // put the wrong event in the timeline header AND the verdict EVENT column. The push's event wins.
        const pushEvent = typeof msg.event === 'string' ? msg.event.trim() : '';
        if (pushEvent) rec.eventName = pushEvent;
      }
      collectVariables(san, rec);
    } else if (messageType === 'MACRO_RESOLVED') {
      collectVariables(san, rec);
    } else if (messageType === 'TAG_STARTED' || messageType === 'TAG_STATUS') {
      // TAG_STARTED carries key.tagName; TAG_STATUS carries tagInfo[{name, execute}] (and key.tagName).
      const infos = Array.isArray(san.tagInfo) ? san.tagInfo : [];
      const seen = new Set<string>();
      for (const t of infos) {
        const ti = asObj(t);
        const name = String(ti?.name ?? '');
        if (!name) continue;
        seen.add(name);
        upsertTag(rec, name, messageType === 'TAG_STARTED' ? 'running' : mapExecuteStatus(String(ti?.execute ?? '')));
      }
      const keyed = String(key.tagName ?? '');
      if (keyed && !seen.has(keyed)) upsertTag(rec, keyed, 'running');
    }
  }

  return {
    containers: [...containers.values()],
    // Chronological (eventId order per container, containers interleaved as captured).
    events: [...events.values()].sort((a, b) => (a.container === b.container ? a.eventId - b.eventId : 0)),
  };
}

/** Worst-status-wins upsert: a tag that FAILED must never be papered over by a later 'running' frame. */
function upsertTag(rec: TaEventRecord, name: string, status: TaTagStatus): void {
  const existing = rec.tags.find((t) => t.name === name);
  if (!existing) {
    rec.tags.push({ name, status });
    return;
  }
  // fired>running, failed>everything: keep the most informative terminal status.
  if (STATUS_RANK[status] > STATUS_RANK[existing.status]) existing.status = status;
}

/** Pull {name, resolvedValue} pairs out of a frame's macroInfo into the event's variables map. */
function collectVariables(san: Record<string, unknown>, rec: TaEventRecord): void {
  const macros = Array.isArray(san.macroInfo) ? san.macroInfo : [];
  for (const m of macros) {
    const mo = asObj(m);
    const name = String(mo?.name ?? '');
    if (!name || mo?.resolvedValue === undefined) continue;
    const v = mo.resolvedValue;
    const str = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    (rec.variables ??= {})[name] = str.slice(0, 200);
  }
}

/** The events of ONE container (the site's GTM web container), oldest first — what the UI renders. */
export function eventsForContainer(capture: TaCapture, publicId: string): TaEventRecord[] {
  return capture.events.filter((e) => e.container === publicId).sort((a, b) => a.eventId - b.eventId);
}

/** Convert one container's TA event records into the MonitorEvent shape the existing verdict pipeline
 *  (verdictsFromMonitor → monitorVerdicts) consumes — TA names are mapped to container tag IDs via the
 *  inventory (name → id). Tags TA reports that aren't in the inventory are dropped (another container's
 *  tags can never be miscredited).
 *
 *  CRITICAL: only tags that ACTUALLY FIRED are emitted per event. GTM's per-event debug also reports tags
 *  it EVALUATED but did NOT fire (that is how Tag Assistant shows "N tags did not fire" for an event);
 *  those map to `unknown`. Crediting them was the bug that mis-attributed click tags to the synthetic
 *  `form_submission` events we push on every page (a click tag was "seen" on form_submission with an
 *  unknown/not-fired status, so it was wrongly reported as firing there — and, being the earliest event,
 *  that is the event the UI showed). So: fired (execute_succeeded) + running (TAG_STARTED) → success;
 *  failed (execute_failure) → failure; unknown (evaluated-but-not-fired / unrecognized) → EXCLUDED. PURE. */
export function taEventsToMonitorEvents(
  events: TaEventRecord[],
  inventory: Array<{ id: string; tagName: string }>,
): Array<{ event: string; tags: Array<{ id: string; name?: string; status: 'success' | 'failure' | 'unknown' }> }> {
  const idByName = new Map(inventory.map((t) => [t.tagName, t.id] as const));
  return events.map((ev) => ({
    event: ev.eventName,
    tags: ev.tags
      .map((t) => {
        const id = idByName.get(t.name);
        if (!id) return null;
        if (t.status === 'unknown') return null; // evaluated-but-not-fired — don't credit it to this event
        const status = t.status === 'failed' ? 'failure' as const : 'success' as const; // fired + running = fired
        return { id, name: t.name, status };
      })
      .filter((t): t is { id: string; name: string; status: 'success' | 'failure' } => t !== null),
  }));
}

// ── Phase 3: the in-app "show it in detail" views ──────────────────────────────────────────────────

/** One dataLayer event for the in-app timeline (mirrors shared/ipc TaEventView). */
export interface TaEventView {
  eventId: number;
  eventName: string;
  apiCall?: Record<string, unknown>;
  variables?: Record<string, string>;
  tagsFired: Array<{ name: string; status: TaTagStatus }>;
}

/** A DLV trigger suggestion for a not-fired tag (mirrors shared/ipc TaTriggerSuggestion). */
export interface TaTriggerSuggestion {
  tagName: string;
  event: string;
  conditions: Array<{ key: string; value: string }>;
  how: string;
}

/** Map one container's parsed events into the timeline view the renderer shows (the API-Call push +
 *  resolved variables + the tags that fired on each event). PURE. */
export function toTaEventViews(events: TaEventRecord[]): TaEventView[] {
  return events.map((e) => ({
    eventId: e.eventId,
    eventName: e.eventName,
    ...(e.apiCall ? { apiCall: e.apiCall } : {}),
    ...(e.variables ? { variables: e.variables } : {}),
    tagsFired: e.tags.map((t) => ({ name: t.name, status: t.status })),
  }));
}

const INTERNAL_EVENT = /^(gtm\.|page_view$|user_engagement$|scroll$)/i;

/** Build DLV-based trigger suggestions for tags that did NOT fire, using the REAL pushes we captured.
 *  For each unfired tag we look for the event it was meant to fire on (expectedEvent) among the captured
 *  events; if found, we surface that event + up to 4 of its push params as Data Layer Variable conditions;
 *  if the event never occurred, we say so. When the tag has no expected event, we point at the best
 *  captured interaction event. PURE + unit-tested. */
export function buildTriggerSuggestions(
  unfired: Array<{ tagName: string; expectedEvent?: string }>,
  events: TaEventView[],
): TaTriggerSuggestion[] {
  const realInteraction = events.find((e) => !INTERNAL_EVENT.test(e.eventName));
  return unfired.map(({ tagName, expectedEvent }) => {
    const match = expectedEvent ? events.find((e) => e.eventName === expectedEvent) : undefined;
    const ev = match ?? (expectedEvent ? undefined : realInteraction);
    if (!ev) {
      const how = expectedEvent
        ? `No "${expectedEvent}" event was seen during the test, so this tag never had a chance to fire. Make sure the site pushes { event: "${expectedEvent}" } to the dataLayer at the right moment, then trigger this tag on it.`
        : `No custom dataLayer event was captured for this tag. Add a dataLayer.push({ event: "…" }) where it should fire and trigger this tag on that event.`;
      return { tagName, event: expectedEvent ?? '', conditions: [], how };
    }
    const conditions = Object.entries(ev.apiCall ?? {})
      .filter(([k]) => k !== 'event' && !/^gtm\./i.test(k))
      .slice(0, 4)
      .map(([key, value]) => ({ key, value: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 60) }));
    const cond = conditions.length
      ? ', scoped with ' + conditions.map((c) => `{{dlv - ${c.key}}} = "${c.value}"`).join(' and ')
      : '';
    return {
      tagName,
      event: ev.eventName,
      conditions,
      how: `Create a Custom Event trigger on "${ev.eventName}"${cond}, then set this tag to fire on it. (These values come from the real push captured during the test.)`,
    };
  });
}

/** Why a GTM container has no per-tag data, in operator terms — drives the "sign in and retry" UX. */
export function containerDebugProblem(capture: TaCapture, publicId: string): string | null {
  const c = capture.containers.find((x) => x.id === publicId);
  if (!c) return `Tag Assistant never saw container ${publicId} on the page — is it installed on this URL?`;
  if (c.debug) return null;
  if (c.detailsFound === false) {
    return `Tag Assistant could not enable debugging for ${publicId} — a GTM web container needs a signed-in Google session with access to it. Sign in (one-time) and retry.`;
  }
  return `${publicId} did not enter debug mode — reconnect Tag Assistant and retry.`;
}
