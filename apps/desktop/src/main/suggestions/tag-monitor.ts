// AUTHORITATIVE per-tag firing via GTM's own Monitoring API (addEventCallback) — the signal Tag
// Assistant itself uses, but read in the browser WE control, with no Tag Assistant UI and no publish.
//
// Why a template: GTM exposes "which tags fired on event N" ONLY inside a sandboxed Custom Template via
// addEventCallback(containerId, eventData). A page-level Custom HTML tag can't see it. So verification
// (opt-in) adds a monitor template + a tag that runs it on every event; on each event the callback
// sendPixel()s the fired tags (id + status + executionTime) to a sentinel host we intercept + abort in
// the verify driver. We resolve each reported tag id -> name/expected from the container inventory we
// already read (container-verify.ts), so the template needs NO per-tag metadata.
//
// This module is PURE (no browser, no GTM API) — the template SOURCE string, the sentinel parser, and
// the verdict mapping. The gated container write (inject/remove the template) and the driver
// interception live elsewhere. Documented + stable, unlike the undocumented postMessage debug stream.

export type MonitorStatus = 'success' | 'failure' | 'exception' | 'timeout' | 'unknown';

export interface MonitorTagResult {
  /** The container tag id (matches AuditTag.tagId from the snapshot → resolvable to a name). */
  id: string;
  /** The tag's display name (Simo's monitor sends it when "Include tag name" is on); we also resolve
   *  id → name from the inventory, so this is a convenience/cross-check. */
  name?: string;
  status: MonitorStatus;
  /** Tag execution time in ms, when the monitor reports it. */
  executionTime?: number;
}
export interface MonitorEvent {
  /** The dataLayer event name this batch of tags fired on (gtm.js / gtm.load / a custom event). */
  event: string;
  uniqueEventId?: number;
  tags: MonitorTagResult[];
}

// The endpoint the imported GTM Monitor tag GET-pixels each event to. It MUST be
// https://placeholder.com/collect*: Simo's template restricts its send_pixel permission to exactly that
// pattern (verified in its template.tpl), and a gallery-imported template's permissions can't be edited —
// any other URL makes the sandbox BLOCK sendPixel and the monitor tag FAILS (the "0 fired" first run).
// The request is captured + ABORTED by the verify driver's route, so nothing ever reaches placeholder.com.
export const MONITOR_ENDPOINT = 'https://placeholder.com/collect';
const SENTINEL_MARK = 'placeholder.com/collect';
/** Simo Ahava's published "GTM Monitor" community template — imported via import_from_gallery so its
 *  sandbox permissions come vetted (we never hand-roll a template). It fires addEventCallback and GET-
 *  pixels each event's fired tags to `endPoint`. Source: github.com/gtm-templates-simo-ahava. */
export const MONITOR_GALLERY = { owner: 'gtm-templates-simo-ahava', repository: 'google-tag-manager-monitor' } as const;

/** True when a captured request is one of our monitor reports (host match, tolerant of scheme/path). */
export function isMonitorHit(url: string): boolean {
  return url.includes(SENTINEL_MARK);
}

/** Parse a GTM Monitor pixel URL back into a MonitorEvent. The imported template GET-pixels
 *  `<endPoint>?eventName=<e>&eventTimestamp=<ts>&tag1id=<id>&tag1nm=<name>&tag1st=<status>&tag1et=<ms>&
 *  tag2id=…` — one indexed group (1-based) per FIRED tag. Returns null when it isn't ours; never throws
 *  (a monitor report must not be able to break verification). */
export function parseMonitorHit(url: string): MonitorEvent | null {
  if (!isMonitorHit(url)) return null;
  try {
    const q = new URL(url).searchParams;
    const event = q.get('eventName') ?? '';
    const tags: MonitorTagResult[] = [];
    for (let n = 1; ; n += 1) {
      const id = q.get(`tag${n}id`);
      if (id === null) break; // groups are contiguous from 1; the first gap ends the list
      if (id === '') continue;
      tags.push({
        id: String(id),
        name: q.get(`tag${n}nm`) || undefined,
        status: normStatus(q.get(`tag${n}st`) ?? undefined),
        executionTime: numOrUndef(q.get(`tag${n}et`)),
      });
    }
    if (event === '' && tags.length === 0) return null;
    return { event, tags };
  } catch {
    return null;
  }
}
function numOrUndef(s: string | null): number | undefined {
  if (s === null || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function normStatus(s: string | undefined): MonitorStatus {
  const v = (s ?? '').toLowerCase();
  return v === 'success' || v === 'failure' || v === 'exception' || v === 'timeout' ? v : 'unknown';
}
// Worst status wins across events: a tag that failed once is worth surfacing over a success elsewhere.
const STATUS_RANK: Record<MonitorStatus, number> = { unknown: 0, success: 1, timeout: 2, failure: 3, exception: 4 };

export interface MonitorVerdict {
  tagId: string;
  /** The tag appeared in at least one event's fired list. */
  fired: boolean;
  /** Worst status observed across the events it fired on. */
  status: MonitorStatus;
  /** The dataLayer events it fired on. */
  onEvents: string[];
  maxExecutionMs?: number;
}

/** AUTHORITATIVE per-tag verdict from the monitor stream: a tag in ANY event's fired list fired (status
 *  success = clean; failure/exception/timeout = fired-but-errored); a tag never reported did NOT fire.
 *  Keyed by container tag id (resolve id -> name/expected from the inventory at the call site). Only tag
 *  ids in `tagIds` are tracked, so the site's OWN live container tags can never be mis-credited. PURE. */
export function monitorVerdicts(tagIds: string[], events: MonitorEvent[]): Map<string, MonitorVerdict> {
  const byId = new Map<string, MonitorVerdict>();
  for (const id of tagIds) byId.set(id, { tagId: id, fired: false, status: 'unknown', onEvents: [] });
  for (const ev of events) {
    for (const t of ev.tags) {
      const v = byId.get(t.id);
      if (!v) continue; // a fired tag not in our inventory (e.g. the monitor tag itself) — ignore
      v.fired = true;
      if (STATUS_RANK[t.status] > STATUS_RANK[v.status]) v.status = t.status;
      if (ev.event && !v.onEvents.includes(ev.event)) v.onEvents.push(ev.event);
      if (typeof t.executionTime === 'number') v.maxExecutionMs = Math.max(v.maxExecutionMs ?? 0, t.executionTime);
    }
  }
  // A fired tag still 'unknown' (the report carried no status) is treated as a clean success.
  for (const v of byId.values()) if (v.fired && v.status === 'unknown') v.status = 'success';
  return byId;
}
