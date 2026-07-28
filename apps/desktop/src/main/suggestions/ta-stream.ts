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
  /** Which page load this event belongs to. `gtm.uniqueEventId` (the frame's `eventId`) RESTARTS at 0 on
   *  every full page navigation, but we drive one debug session across many pages into a single stream —
   *  so `container|eventId` alone collides page-to-page (page B's event 5 overwriting page A's event 5).
   *  Epoch increments each time a container's DATA_LAYER eventId goes backwards (a fresh document), which
   *  keeps each page's events distinct and gives a correct chronological order (epoch, then eventId). */
  epoch: number;
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
  // Per-container page epoch. gtm.uniqueEventId (the frame's eventId) resets to 0 on every full page load,
  // but we stream a whole multi-page drive into ONE capture, so `container|eventId` collides across pages.
  // Bump the epoch whenever a container's DATA_LAYER eventId goes strictly backwards (a new document has
  // restarted the counter), and key events by container|epoch|eventId so each page stays separate. Only
  // DATA_LAYER frames advance the boundary (they arrive in push order, strictly increasing within a page);
  // straggling TAG frames for a prior event reuse the current epoch, which is the page they fired on.
  const epochOf = new Map<string, { epoch: number; maxDl: number }>();

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
    const messageType = String(san.messageType ?? '');

    // Advance the page epoch on a DATA_LAYER push whose eventId dropped below this epoch's high-water mark
    // (a fresh page reset the counter). A page always starts with gtm.init(0)+gtm.js(1), so maxDl is >=1
    // before real events, and the new page's eventId 0 is a strict decrease — reliably detected. Equal
    // eventIds (duplicate frames) do NOT bump, so a re-emitted push can't split one page in two.
    let ep = epochOf.get(container);
    if (!ep) { ep = { epoch: 0, maxDl: -1 }; epochOf.set(container, ep); }
    if (messageType === 'DATA_LAYER') {
      if (eventId < ep.maxDl) ep.epoch += 1;
      ep.maxDl = eventId;
    }
    const epoch = ep.epoch;

    const mapKey = `${container}|${epoch}|${eventId}`;
    let rec = events.get(mapKey);
    if (!rec) {
      rec = { container, epoch, eventId, eventName: String(key.eventName ?? ''), tags: [] };
      events.set(mapKey, rec);
    }
    if (!rec.eventName && key.eventName) rec.eventName = String(key.eventName);
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
    // Chronological within a container: page epoch first, then eventId. Containers interleave as captured.
    events: [...events.values()].sort((a, b) =>
      a.container === b.container ? (a.epoch - b.epoch) || (a.eventId - b.eventId) : 0),
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

/** The events of ONE container (the site's GTM web container), oldest first — what the UI renders. Ordered
 *  by page epoch then eventId, so a multi-page drive reads top-to-bottom in the true firing order. */
export function eventsForContainer(capture: TaCapture, publicId: string): TaEventRecord[] {
  return capture.events
    .filter((e) => e.container === publicId)
    .sort((a, b) => (a.epoch - b.epoch) || (a.eventId - b.eventId));
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
  /** Stable, unique, 1-based chronological index across the whole capture. `eventId` alone is NOT unique
   *  once a drive spans pages (it resets per page), so `seq` is the timeline's identity — React key,
   *  expand/collapse state, and the Phase-3 screenshot alignment all key on it. */
  seq: number;
  eventId: number;
  eventName: string;
  apiCall?: Record<string, unknown>;
  variables?: Record<string, string>;
  tagsFired: Array<{ name: string; status: TaTagStatus }>;
  /** Phase 3: JPEG data-URI screenshot of the Tag Assistant panel for this event (attached by the IPC). */
  screenshot?: string;
}

/** A DLV trigger suggestion for a not-fired tag (mirrors shared/ipc TaTriggerSuggestion). */
export interface TaTriggerSuggestion {
  tagName: string;
  event: string;
  /** `key` is the FULL GTM variable reference (e.g. "dlv - form_name", "Page Path"); rendered {{key}}. */
  conditions: Array<{ key: string; value: string }>;
  how: string;
}

/** Map one container's parsed events into the timeline view the renderer shows (the API-Call push +
 *  resolved variables + the tags that fired on each event). PURE. */
export function toTaEventViews(events: TaEventRecord[]): TaEventView[] {
  // `events` arrives in chronological (epoch, eventId) order from eventsForContainer, so the array index
  // is a stable global sequence — the identity the UI keys on (eventId repeats across page loads).
  return events.map((e, i) => ({
    seq: i + 1,
    eventId: e.eventId,
    eventName: e.eventName,
    ...(e.apiCall ? { apiCall: e.apiCall } : {}),
    ...(e.variables ? { variables: e.variables } : {}),
    tagsFired: e.tags.map((t) => ({ name: t.name, status: t.status })),
  }));
}

const INTERNAL_EVENT = /^(gtm\.|page_view$|user_engagement$|scroll$)/i;

// Variables/keys that can NEVER be a stable trigger condition: they change on every submit / session / page
// load, so a trigger scoped on them matches once and never again (the timestamp the user hit). Matched on
// the variable NAME or a value that LOOKS volatile. The name boundary is any non-alphanumeric so it catches
// both raw keys ("timestamp") and resolved-variable names ("dlv - Timestamp").
const VOLATILE_KEY = /(^|[^a-z0-9])(timestamp|time|datetime|date|ts|nonce|event_?id|session_?id|client_?id|user_?id|request_?id|transaction_?id|order_?id|uuid|guid|hash|token|rand(om)?)([^a-z0-9]|$)/i;
// epoch-ms, ISO datetime, date-only, locale date, UUID, long hex — anything unique-per-submit / per-day.
const VOLATILE_VALUE = /^\d{10,}$|^\d{4}-\d{2}-\d{2}([T ]\d|$)|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i;
// GTM internals that surface in the resolved-variables map but aren't real conditions. Anchored to the
// exact name so a legit variable like "Event Category" survives (a prefix match would wrongly drop it).
const NONCONDITION_VAR = /^(_?event|_triggers)$/i;
// Lead a trigger with the most identifying variables — form identity first, then the CTA / page ones.
const RANK_HINT = /(form_?name|form_?type|form_?id|cta[ _-]?text|cta[ _-]?location|page[ _-]?path|page[ _-]?url)/i;
// A form-identity variable (form_name / form_type / form_id): the fields a form trigger should key off, and
// what we check for SHARED-vs-distinctive. form_id is included — it often differs per form even when the
// name/type don't, so it can be the real discriminator.
const FORM_IDENTITY = /(^|[^a-z0-9])(form_?name|form_?type|form_?id)([^a-z0-9]|$)/i;
// A page-scope signal variable (Page Path / Page URL / *Location) — used to page-match + de-dupe.
const PAGE_VAR = /page[ _-]?(path|url)|(^|[^a-z0-9])location([^a-z0-9]|$)/i;
// A value we must never emit as a literal condition (PII), and the shape a non-form/CTA value must have to
// be a usable equals-condition (a single-token slug / path / enum — NO spaces, so multi-word free text and
// names like "John Smith" are rejected; money, email and phone are rejected too).
const PII_VALUE = /@|^\+?\d[\d\s().-]{6,}$/;
const STABLE_LOOKING = /^[/#]?[\w/-]{1,80}$/;

/** The tag's resolved trigger scope → a clean Page Path for a {{Page Path}} trigger condition, or null when
 *  it's site-wide / unknown (no meaningful path filter to add). Handles a path, a full URL, or a bare
 *  host/path. PURE. */
export function pageScopeToPath(page?: string): string | null {
  if (!page) return null;
  let p = page.trim();
  if (!p || /^(site-?wide|all\s*pages?|any|\*)$/i.test(p)) return null;
  const m = /^(?:https?:)?\/\/[^/]+(\/.*)?$/i.exec(p);                 // full or protocol-relative URL
  if (m) p = m[1] ?? '/';
  else if (/^[^/\s]+\.[^/\s]+\//.test(p)) p = p.slice(p.indexOf('/')); // bare host.tld/path
  p = p.replace(/[?#].*$/, '');                                        // drop query / hash
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, 120) || '/';
}

/** Is a resolved value usable as a literal trigger condition? Drops empty / undefined / blob / volatile. */
function usableCondValue(v: string): boolean {
  const s = v.trim();
  if (!s || s === 'undefined' || s === 'null' || s === '[]' || s === '{}') return false;
  if (s.length > 80) return false;                 // giant element-path blobs etc. — not a trigger value
  return !VOLATILE_VALUE.test(s);
}

/** Candidate trigger conditions for ONE event, keyed by the FULL GTM variable name (rendered {{name}}).
 *  Primary source = the resolved Variables map (the debug "Variables" tab: form_name, CTA Location, CTA
 *  Text, Form Classes, ... — everything the container actually resolved), which is far richer than the raw
 *  dataLayer push. Falls back to the raw push (as {{dlv - key}}) only when no variables were resolved. */
function eventConditions(ev: TaEventView): Array<{ key: string; value: string }> {
  const fromVars = Object.entries(ev.variables ?? {}).map(([name, value]) => ({ key: name.trim(), value: String(value) }));
  const src = fromVars.length
    ? fromVars
    : Object.entries(ev.apiCall ?? {})
        .filter(([k]) => k !== 'event' && !/^gtm\./i.test(k))
        .map(([k, v]) => ({ key: `dlv - ${k}`, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  return src
    .filter((c) => !NONCONDITION_VAR.test(c.key) && !/^gtm\./i.test(c.key) && !VOLATILE_KEY.test(c.key) && usableCondValue(c.value))
    // Keep the FULL value (usableCondValue already caps at 80): a GTM equals-condition must be the exact
    // value, and page-matching compares on it — a re-truncation here would make the condition un-matchable.
    .map((c) => ({ key: c.key, value: c.value.trim() }));
}

/** Per eventName: how many events fired, and the set of distinct VALUES each candidate key took across all
 *  of them. A key with ONE value across ≥2 same-name events can't distinguish them (form_name / form_type
 *  were identical on every form here) → a WEAK condition; a key whose value VARIED is distinctive. */
function conditionDistinctness(events: TaEventView[]): Map<string, { count: number; keys: Map<string, Set<string>> }> {
  const m = new Map<string, { count: number; keys: Map<string, Set<string>> }>();
  for (const e of events) {
    let slot = m.get(e.eventName);
    if (!slot) { slot = { count: 0, keys: new Map() }; m.set(e.eventName, slot); }
    slot.count += 1;
    for (const c of eventConditions(e)) {
      const set = slot.keys.get(c.key) ?? new Set<string>();
      set.add(c.value);
      slot.keys.set(c.key, set);
    }
  }
  return m;
}

// Rank a condition: form identity (name / id / type) first, then other RANK_HINT (CTA / page), then the rest
// — so a distinctive form_id / form_name leads the surfaced conditions.
const condRank = (key: string): number => (FORM_IDENTITY.test(key) ? 0 : RANK_HINT.test(key) ? 1 : 2);
const rankConds = (cs: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> =>
  [...cs].sort((a, b) => condRank(a.key) - condRank(b.key));

/** A condition's page path if it IS a page-scope variable (Page Path / Page URL / *Location), else null —
 *  normalized so a full URL and a bare path compare equal. Used to page-match a tag to its own form's event. */
const condPath = (c: { key: string; value: string }): string | null => (PAGE_VAR.test(c.key) ? pageScopeToPath(c.value) : null);

/** May this condition be emitted as a literal GTM equals-condition? Never PII (email/phone); form/CTA/page
 *  identity is always fine; any other variable only if its value looks like a stable slug/path/enum. */
function emittableCond(c: { key: string; value: string }): boolean {
  if (PII_VALUE.test(c.value)) return false;
  if (RANK_HINT.test(c.key)) return true;
  return STABLE_LOOKING.test(c.value);
}

/** Build trigger suggestions for tags that did NOT fire, using the REAL pushes + resolved VARIABLES we
 *  captured. For each unfired tag we find the event it was meant to fire on (page-matched to the tag's own
 *  page when several same-name events exist — the site pushes identical form_name/type on every form, so
 *  the page is the real discriminator), then scope the suggested Custom Event trigger with the DISTINCTIVE
 *  variables: {{Page Path}} for the page the tag lives on, plus any variable whose value VARIED across the
 *  captured forms. Volatile params (timestamp/nonce/uuid) are dropped, and when form_name/form_type are
 *  identical across every form we say so instead of proposing them (they can't tell the forms apart). If the
 *  event never occurred, we explain that. PURE + unit-tested. */
export function buildTriggerSuggestions(
  unfired: Array<{ tagName: string; expectedEvent?: string; page?: string }>,
  events: TaEventView[],
): TaTriggerSuggestion[] {
  const realInteraction = events.find((e) => !INTERNAL_EVENT.test(e.eventName));
  const distinct = conditionDistinctness(events);
  return unfired.map(({ tagName, expectedEvent, page }) => {
    const pagePath = pageScopeToPath(page);
    // Which captured event should this tag fire on? Among same-name events, UNIQUELY page-match the one
    // whose page-scope variable resolves to THIS tag's page (so a form tag maps to its OWN form's push, not
    // the first form's). Ambiguous (≥2 events on the same page) or no match → we can't attribute ev's vars.
    const sameName = expectedEvent ? events.filter((e) => e.eventName === expectedEvent) : realInteraction ? [realInteraction] : [];
    const pageMatches = pagePath ? sameName.filter((e) => eventConditions(e).some((c) => condPath(c) === pagePath)) : [];
    const pageMatch = pageMatches.length === 1 ? pageMatches[0] : undefined;
    const ev = pageMatch ?? sameName[0] ?? (expectedEvent ? undefined : realInteraction);
    if (!ev) {
      const how = expectedEvent
        ? `No "${expectedEvent}" event was seen during the test, so this tag never had a chance to fire. Make sure the site pushes { event: "${expectedEvent}" } to the dataLayer at the right moment, then trigger this tag on it.`
        : `No custom dataLayer event was captured for this tag. Add a dataLayer.push({ event: "…" }) where it should fire and trigger this tag on that event.`;
      return { tagName, event: expectedEvent ?? '', conditions: [], how };
    }
    const slot = distinct.get(ev.eventName);
    const many = (slot?.count ?? 0) >= 2;
    const evConds = eventConditions(ev);
    const distinctiveVars = evConds.filter((c) => (slot?.keys.get(c.key)?.size ?? 0) > 1);
    // Can we attribute ev's captured vars to THIS tag? Only when we uniquely page-matched it, or there's a
    // single same-name event (nothing to confuse it with). Otherwise ev is arbitrary → trust only Page Path.
    // When we CAN trust it: with ≥2 events use only the vars that VARIED (distinctive); with <2, offer the
    // best stable vars (form identity first) since distinctiveness is unknowable.
    const trust = !!pageMatch || !many;
    const usable = !trust ? [] : many ? distinctiveVars : rankConds(evConds);
    // Lead with {{Page Path}} (the reliable per-tag discriminator), then distinctive vars, capped at 3. Skip
    // page-scope vars (the leading Page Path already covers the page) and anything not safely emittable.
    const conditions: TaTriggerSuggestion['conditions'] = [];
    if (pagePath) conditions.push({ key: 'Page Path', value: pagePath });
    for (const c of rankConds(usable)) {
      if (conditions.length >= 3) break;
      if (pagePath && PAGE_VAR.test(c.key)) continue;
      if (!emittableCond(c)) continue;
      if (!conditions.some((x) => x.key === c.key)) conditions.push(c);
    }
    // Nothing usable AND no page → fall back to the best vars we can trust, but with ≥2 forms NEVER the
    // proven-shared ones (they'd over-fire on every form). Empty is fine — the note tells the operator why.
    if (conditions.length === 0 && trust) {
      const pool = (many ? distinctiveVars : rankConds(evConds)).filter(emittableCond);
      for (const c of pool.slice(0, 2)) if (!conditions.some((x) => x.key === c.key)) conditions.push(c);
    }
    // A form-identity field is SHARED when it's constant across every captured form. Only call the forms
    // indistinguishable (and only name the actually-shared fields) when NO form-identity field varied — a
    // varying one IS a good condition and is proposed above, so the note must not contradict it.
    const formFieldShared = (field: string): boolean => {
      if (!many || !slot) return false;
      // Match camelCase too (formName / formType), consistent with FORM_IDENTITY — else the note silently
      // vanishes on a camelCase site, leaving an empty, unexplained suggestion.
      const re = new RegExp(`(^|[^a-z0-9])${field.replace('_', '_?')}([^a-z0-9]|$)`, 'i');
      const sets = [...slot.keys].filter(([k]) => re.test(k)).map(([, s]) => s);
      return sets.length > 0 && sets.every((s) => s.size === 1);
    };
    const anyFormVaries = !!slot && [...slot.keys].some(([k, s]) => FORM_IDENTITY.test(k) && s.size > 1);
    const sharedFields = anyFormVaries ? [] : ['form_name', 'form_type', 'form_id'].filter(formFieldShared);
    const cond = conditions.length ? ', scoped with ' + conditions.map((c) => `{{${c.key}}} = "${c.value}"`).join(' and ') : '';
    const fields = sharedFields.join(' and ');
    const wasWere = sharedFields.length > 1 ? 'were' : 'was';
    const itThey = sharedFields.length > 1 ? 'they' : 'it';
    const note = sharedFields.length === 0
      ? ''
      : pagePath
        ? ` Note: ${fields} ${wasWere} identical on every form submitted here, so ${itThey} can’t tell these forms apart — Page Path is what distinguishes this one.`
        : ` Note: ${fields} ${wasWere} identical on every form here and this tag isn’t page-scoped, so nothing captured distinguishes these forms — add a form-specific field (e.g. a hidden input carrying the form’s name) to the dataLayer push and key the trigger on it.`;
    return {
      tagName,
      event: ev.eventName,
      conditions,
      how: `Create a Custom Event trigger on "${ev.eventName}"${cond}, then set this tag to fire on it. (These values come from the real push captured during the test.)${note}`,
    };
  });
}

/** Why a GTM container has no per-tag data, in operator terms — drives the "sign in and retry" UX.
 *  When the SELECTED container isn't on the page at all, it names the containers Tag Assistant DID
 *  see (the #1 confusion: "it's using a different container id") and steers to the right fix. */
export function containerDebugProblem(capture: TaCapture, publicId: string): string | null {
  const c = capture.containers.find((x) => x.id === publicId);
  if (!c) {
    // List the GTM containers TA actually observed, so the operator can see it connected to a
    // DIFFERENT container than the one they selected — the exact mismatch they hit.
    const seen = capture.containers.map((x) => x.id).filter((id) => /^GTM-/i.test(id));
    const seenTxt = seen.length
      ? `Tag Assistant connected to a DIFFERENT container on this page: ${seen.join(', ')} — not your selected ${publicId}.`
      : `Tag Assistant saw no GTM container on this page.`;
    return (
      `${seenTxt} Your container ${publicId} is not the one live on this URL — either it is not published/installed here, ` +
      `or it loads indirectly (via dataLayer, a consent-management or CDP app, or server-side GTM) that Tag Assistant cannot attach to. ` +
      `To verify ${publicId} — including unpublished workspace changes — open GTM, click Preview, copy the Preview snippet, and paste it into the "GTM Preview snippet" box, then run again. (Quick Preview creates no version or environment.)`
    );
  }
  if (c.debug) return null;
  if (c.detailsFound === false) {
    return `Tag Assistant could not enable debugging for ${publicId} — a GTM web container needs a signed-in Google session with access to it. Sign in (one-time) and retry.`;
  }
  return `${publicId} did not enter debug mode — reconnect Tag Assistant and retry.`;
}

/** The GTM container ids Tag Assistant actually observed on the debugged page (for the UI's
 *  "containers on this page" line, so a selected-vs-live mismatch is visible at a glance). PURE. */
export function containersSeenOnPage(capture: TaCapture): string[] {
  return capture.containers.map((x) => x.id).filter((id) => /^GTM-/i.test(id));
}
