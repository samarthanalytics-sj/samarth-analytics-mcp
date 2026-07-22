// Tag Watch - PURE core: apply a freshly fetched gtag snapshot to a watch target, producing the
// new target state (snapshot + capped timeline) and the change set to alert on. No I/O, no clock -
// the service passes `now` in - so every branch (first scan, no-change, real change, went-unparsed)
// is unit-testable. Builds on gtag-spy.ts (parse + diff).

import type { GtagSpySnapshot, GtagSpyChange } from './gtag-spy';
import { diffGtagSnapshots } from './gtag-spy';

/** One recorded scan on a target's timeline (newest first in the stored array). */
export interface TagWatchEvent {
  at: number;
  /** first_scan | changed | unparsed_now | reparsed | scan_error */
  kind: 'first_scan' | 'changed' | 'unparsed_now' | 'reparsed' | 'scan_error';
  /** The config changes for a `changed` event (empty otherwise). */
  changes: GtagSpyChange[];
  /** A one-line human summary for the timeline row + Slack. */
  summary: string;
  /** Present on scan_error. */
  error?: string;
}

export interface TagWatchTarget {
  measurementId: string;
  label?: string;
  /** The most recent PARSED snapshot (the diff baseline). null until the first parseable scan. */
  lastSnapshot: GtagSpySnapshot | null;
  /** Newest-first event log (capped). */
  timeline: TagWatchEvent[];
  lastScanAt: number | null;
  /** Whether the last scan failed to fetch/parse - drives the "unparsed_now"/"reparsed" transitions. */
  lastParsed: boolean;
}

export const TIMELINE_CAP = 50;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Summarize a change set for a timeline row / Slack line: lead with the field names, cap the list. */
export function summarizeChanges(changes: GtagSpyChange[]): string {
  const fields = changes.map((c) => c.field);
  const head = fields.slice(0, 3).join(', ');
  return `${plural(changes.length, 'change')}: ${head}${fields.length > 3 ? `, +${fields.length - 3} more` : ''}`;
}

export interface ScanOutcome {
  /** The fetched-and-parsed snapshot, or null when the fetch/parse failed entirely. */
  snapshot: GtagSpySnapshot | null;
  /** Set only when the fetch itself threw (network/HTTP) - distinct from a fetched-but-unparseable body. */
  error?: string;
}

/** Fold a scan outcome into a target: returns the updated target and the event to alert on (or null
 *  when nothing noteworthy happened - a clean no-change scan). Alerting policy lives with the caller;
 *  first_scan and scan_error return an event but the caller decides whether to Slack them. */
export function applyScan(target: TagWatchTarget, outcome: ScanOutcome, now: number): { target: TagWatchTarget; event: TagWatchEvent } {
  let event: TagWatchEvent;

  if (outcome.error || !outcome.snapshot) {
    event = { at: now, kind: 'scan_error', changes: [], summary: `Scan failed: ${outcome.error ?? 'could not fetch the tag'}`, error: outcome.error ?? 'fetch failed' };
    return { target: { ...target, lastScanAt: now, timeline: cap([event, ...target.timeline]) }, event };
  }

  const snap = outcome.snapshot;
  // The tag fetched but its config blob could not be parsed.
  if (!snap.parsed) {
    event = target.lastParsed
      ? { at: now, kind: 'unparsed_now', changes: [], summary: 'The gtag config could not be parsed this scan (Google may have changed the format). Not comparing until it parses again.' }
      : { at: now, kind: 'scan_error', changes: [], summary: 'The gtag config could not be parsed.', error: 'unparseable' };
    return { target: { ...target, lastScanAt: now, lastParsed: false, timeline: cap([event, ...target.timeline]) }, event };
  }

  // First ever parseable snapshot: baseline, no diff.
  if (!target.lastSnapshot) {
    event = { at: now, kind: 'first_scan', changes: [], summary: `Baseline captured for ${snap.measurementId}: ${snap.keyEvents.length} key event(s), ${snap.destinations.length} destination(s).` };
    return { target: { ...target, lastSnapshot: snap, lastScanAt: now, lastParsed: true, timeline: cap([event, ...target.timeline]) }, event };
  }

  const changes = diffGtagSnapshots(target.lastSnapshot, snap);
  if (changes.length === 0) {
    // Clean scan: advance the baseline + stamp the time, but add NO timeline row (avoid noise) and no alert.
    // Exception: if the PREVIOUS scan was unparsed, note the recovery.
    if (!target.lastParsed) {
      event = { at: now, kind: 'reparsed', changes: [], summary: 'The gtag config parses again; no config change vs the last good snapshot.' };
      return { target: { ...target, lastSnapshot: snap, lastScanAt: now, lastParsed: true, timeline: cap([event, ...target.timeline]) }, event };
    }
    // A clean no-change scan: an empty `changed` event (shouldAlert=false) and NO new timeline row.
    event = { at: now, kind: 'changed', changes: [], summary: 'No change.' };
    return { target: { ...target, lastSnapshot: snap, lastScanAt: now, lastParsed: true, timeline: target.timeline }, event };
  }

  event = { at: now, kind: 'changed', changes, summary: summarizeChanges(changes) };
  return { target: { ...target, lastSnapshot: snap, lastScanAt: now, lastParsed: true, timeline: cap([event, ...target.timeline]) }, event };
}

/** True when the caller should send a Slack alert for this event (real config changes + the
 *  format-broke transition; never a clean no-change scan, never first-scan noise). */
export function shouldAlert(event: TagWatchEvent): boolean {
  return (event.kind === 'changed' && event.changes.length > 0) || event.kind === 'unparsed_now';
}

function cap(timeline: TagWatchEvent[]): TagWatchEvent[] {
  return timeline.slice(0, TIMELINE_CAP);
}
