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

// Any request to this host is a monitor report — the verify driver captures + aborts it, so it never
// leaves the machine. A .invalid TLD guarantees it can never resolve to a real server.
export const MONITOR_SENTINEL_HOST = 'samarth-verify-monitor.invalid';
const SENTINEL_MARK = 'samarth-verify-monitor';

/** The sandboxed-JS body for the GTM Custom Template that reports per-tag firing. Runs in GTM's template
 *  sandbox (require()'d APIs only — no page globals). It registers addEventCallback and, after each
 *  event's tags run, sends the fired tags (id + status + executionTime) to the sentinel. PURE. */
export function buildMonitorTemplateJs(sentinel = `https://${MONITOR_SENTINEL_HOST}/m`): string {
  return [
    "const addEventCallback = require('addEventCallback');",
    "const sendPixel = require('sendPixel');",
    "const encodeUriComponent = require('encodeUriComponent');",
    "const JSON = require('JSON');",
    'addEventCallback((ctid, eventData) => {',
    '  const src = eventData.tags || [];',
    '  const tags = [];',
    '  for (let i = 0; i < src.length; i++) {',
    '    tags.push({ id: src[i].id, status: src[i].status, executionTime: src[i].executionTime });',
    '  }',
    "  const payload = { event: eventData.event, ueid: eventData['gtm.uniqueEventId'], tags: tags };",
    `  sendPixel('${sentinel}?e=' + encodeUriComponent(JSON.stringify(payload)), () => {}, () => {});`,
    '});',
    'data.gtmOnSuccess();',
  ].join('\n');
}

/** True when a captured request is one of our monitor reports (host match, tolerant of scheme/path). */
export function isMonitorHit(url: string): boolean {
  return url.includes(SENTINEL_MARK);
}

/** Parse a monitor sentinel pixel URL back into a MonitorEvent — null when it isn't ours or is malformed
 *  (a monitor report must never break verification). */
export function parseMonitorHit(url: string): MonitorEvent | null {
  if (!isMonitorHit(url)) return null;
  try {
    const raw = new URL(url).searchParams.get('e');
    if (!raw) return null;
    const obj = JSON.parse(raw) as { event?: unknown; ueid?: unknown; tags?: unknown };
    const rawTags = Array.isArray(obj.tags) ? obj.tags : [];
    const tags: MonitorTagResult[] = rawTags
      .map((t): MonitorTagResult => {
        const o = (t ?? {}) as { id?: unknown; status?: unknown; executionTime?: unknown };
        return {
          id: o.id === undefined || o.id === null ? '' : String(o.id),
          status: normStatus(typeof o.status === 'string' ? o.status : undefined),
          executionTime: typeof o.executionTime === 'number' ? o.executionTime : undefined,
        };
      })
      .filter((t) => t.id !== '');
    return {
      event: typeof obj.event === 'string' ? obj.event : '',
      uniqueEventId: typeof obj.ueid === 'number' ? obj.ueid : undefined,
      tags,
    };
  } catch {
    return null;
  }
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
