/**
 * Server state and the create path for the Tag suggestions page.
 *
 * The browser never sends a tool name or tool arguments. It sends a scan id and the ids of the rows
 * the user ticked, and the arguments are rebuilt HERE from this process's own copy of the scan. That
 * is the same rule /v1/audit/fix follows, and for the same reason: an endpoint that executed a tool
 * name and argument bag posted by a browser would be an open write endpoint against whatever Google
 * account the caller is signed in as.
 *
 * Creation itself reuses createSuggestedTags, the identical loop the desktop app runs, so the
 * throttling, the quota backoff and the "already exists" handling behave the same on both surfaces.
 */

import { randomUUID } from 'node:crypto';
import { createSuggestedTags } from '../../desktop/src/main/suggestions/create-suggested-tags.js';
import type { CreateTagOutcome, SuggestedTagView } from '../../desktop/src/shared/ipc';
import type { ScanResult } from './scan-client.js';

/** How long a scan stays available to create from. */
export const SCAN_TTL_MS = 30 * 60_000;
/** How many scans to keep in memory at once, oldest evicted first. */
export const MAX_SCANS = 200;

export interface StoredScan {
  id: string;
  userId: string;
  site: string;
  createdAt: number;
  suggestions: SuggestedTagView[];
  warnings: string[];
}

/**
 * Rows as the page shows them. Deliberately not the whole suggestion: the browser gets what it needs
 * to render and choose, and the payload the tool will receive stays on the server.
 */
export interface SuggestionRow {
  id: string;
  tagName: string;
  platform: string;
  eventName?: string;
  page?: string;
  trigger?: unknown;
  /** True when GA4 Enhanced Measurement already tracks this, so creating it would double-count. */
  enhancedMeasurementOverlap?: boolean;
}

/** Give every suggestion a stable id, since the browser refers to rows by id alone. */
function withIds(list: Record<string, unknown>[]): SuggestedTagView[] {
  return list.map((s, i) => ({ ...(s as object), id: typeof s.id === 'string' && s.id ? s.id : `s${i + 1}` }) as SuggestedTagView);
}

export function toRows(list: SuggestedTagView[]): SuggestionRow[] {
  return list.map((s) => {
    const raw = s as unknown as Record<string, unknown>;
    return {
      id: s.id,
      tagName: s.tagName,
      platform: String(s.platform),
      ...(s.eventName ? { eventName: s.eventName } : {}),
      ...(typeof raw.page === 'string' ? { page: raw.page } : {}),
      ...(s.trigger ? { trigger: s.trigger } : {}),
      ...(raw.enhancedMeasurementOverlap === true ? { enhancedMeasurementOverlap: true } : {}),
    };
  });
}

/**
 * In-memory, and that is a deliberate limit rather than a shortcut: a scan is a working set for the
 * next few minutes, not a record. A restart loses it, and the page's answer to that is to scan
 * again, which is cheap and always current. Persisting it would mean storing a crawl of a customer's
 * site in a database that exists to hold their chat history.
 */
export class ScanStore {
  private readonly scans = new Map<string, StoredScan>();

  put(userId: string, result: ScanResult): StoredScan {
    this.purge();
    const record: StoredScan = {
      id: randomUUID(),
      userId,
      site: result.site,
      createdAt: Date.now(),
      suggestions: withIds(result.suggestions),
      warnings: result.warnings,
    };
    this.scans.set(record.id, record);
    return record;
  }

  /**
   * A scan belongs to the user who ran it. The id is a random UUID, but ownership is checked anyway:
   * an unguessable id is not an authorisation model, and this one is handed to a browser.
   */
  get(userId: string, scanId: string): StoredScan | null {
    const found = this.scans.get(scanId);
    if (!found || found.userId !== userId) return null;
    if (Date.now() - found.createdAt > SCAN_TTL_MS) {
      this.scans.delete(scanId);
      return null;
    }
    return found;
  }

  private purge(): void {
    const cutoff = Date.now() - SCAN_TTL_MS;
    for (const [id, s] of this.scans) if (s.createdAt < cutoff) this.scans.delete(id);
    while (this.scans.size >= MAX_SCANS) {
      const oldest = this.scans.keys().next().value;
      if (oldest === undefined) break;
      this.scans.delete(oldest);
    }
  }

  get size(): number {
    return this.scans.size;
  }
}

/**
 * Pick the ticked rows out of a stored scan, in the order the scan produced them.
 *
 * Unknown ids are reported rather than skipped. Silently creating four tags when five were ticked is
 * the kind of wrong that only shows up later, in a container someone else has to debug.
 */
export function selectRows(
  scan: StoredScan,
  ids: readonly string[],
): { selected: SuggestedTagView[]; unknown: string[] } {
  const wanted = new Set(ids);
  const selected = scan.suggestions.filter((s) => wanted.has(s.id));
  const found = new Set(selected.map((s) => s.id));
  return { selected, unknown: [...wanted].filter((id) => !found.has(id)) };
}

/**
 * Apply the measurement id the user supplied, if any.
 *
 * When they supply none, the field is left alone and create_gtm_tracking_tag resolves it from the
 * container's own Google tag. Inventing one here, or defaulting to a placeholder, would produce a
 * tag that looks created and reports to nowhere.
 */
export function withMeasurementId(list: SuggestedTagView[], measurementId?: string): SuggestedTagView[] {
  const id = (measurementId ?? '').trim();
  if (!id) return list;
  return list.map((s) => ({ ...s, measurementId: id }));
}

export type ToolExecute = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface CreateResult {
  outcomes: CreateTagOutcome[];
  created: number;
  existing: number;
  failed: number;
}

/** Create the selected suggestions as DRAFT tags, then count the outcomes for the summary line. */
export async function createSelected(
  execute: ToolExecute,
  ids: { accountId: string; containerId: string; workspaceId: string },
  tags: SuggestedTagView[],
  onProgress?: (done: number, total: number) => void,
): Promise<CreateResult> {
  const outcomes = await createSuggestedTags(execute, ids, tags, onProgress ? { onProgress } : {});
  return {
    outcomes,
    created: outcomes.filter((o) => o.ok).length,
    existing: outcomes.filter((o) => !o.ok && o.existing).length,
    failed: outcomes.filter((o) => !o.ok && !o.existing).length,
  };
}
