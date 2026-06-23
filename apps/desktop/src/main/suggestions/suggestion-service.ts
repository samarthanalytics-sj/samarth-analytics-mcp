// Paste-a-plan path: turn pasted JSON into SuggestedTag[] for the review panel.
// Accepts whatever a user is likely to have on hand from the web-audit feature:
//   • a full gtm_tag_suggestions report  ({ suggestions: [...] })
//   • a raw SuggestInput                  ({ siteHost, forms, elements })
//   • a SuggestInput's PageScan[] array   ([ { page, elements, forms, signals } ])
//   • a bare SuggestedTag[]               ([ { platform:'ga4_event', tagName, trigger } ])
// PURE (no Electron, no I/O) so it is unit-tested with the node:assert harness.

import { buildSuggestions } from '../../../../web-audit-mcp/src/agent/tag-suggest/suggest.js';
import { buildSuggestInput, type PageScan } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { SuggestInput, SuggestedTag } from '../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import type { CreateTagOutcome, SuggestedTagView } from '../../shared/ipc';

export interface ParsedSuggestions {
  suggestions: SuggestedTag[];
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function looksLikeSuggestedTag(v: unknown): boolean {
  return isObj(v) && v.platform === 'ga4_event' && typeof v.tagName === 'string' && isObj(v.trigger);
}
function looksLikePageScan(v: unknown): boolean {
  return isObj(v) && typeof v.page === 'string' && isObj(v.signals) && Array.isArray(v.elements);
}

/** Parse + normalize a pasted JSON string into ranked suggestions. Throws a
 *  user-facing message on malformed/unrecognized input. */
export function parseSuggestions(rawJson: string): ParsedSuggestions {
  const text = (rawJson ?? '').trim();
  if (!text) throw new Error('Paste the JSON output of the web-audit gtm_tag_suggestions tool.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON. Paste the gtm_tag_suggestions tool output (or a SuggestInput / suggestions array).');
  }
  return suggestionsFromData(data);
}

/** Normalize already-parsed data (split out so tests can call it directly). */
export function suggestionsFromData(data: unknown): ParsedSuggestions {
  const warnings: string[] = [];

  if (Array.isArray(data)) {
    if (data.length === 0) return { suggestions: [], warnings: ['The pasted array is empty.'] };
    if (looksLikeSuggestedTag(data[0])) return { suggestions: data as SuggestedTag[], warnings };
    if (looksLikePageScan(data[0])) {
      // siteHost only labels the input; element outbound-classification already
      // happened upstream, so '' is fine here.
      return { suggestions: buildSuggestions(buildSuggestInput(data as PageScan[], ''), { full: true }), warnings };
    }
    throw new Error('Unrecognized array — expected suggestions (SuggestedTag[]) or page scans (PageScan[]).');
  }

  if (isObj(data)) {
    if (Array.isArray(data.suggestions)) {
      // A full gtm_tag_suggestions report.
      const sugs = data.suggestions.filter(looksLikeSuggestedTag) as SuggestedTag[];
      if (sugs.length !== data.suggestions.length) {
        warnings.push(`Ignored ${data.suggestions.length - sugs.length} item(s) that were not GA4-event suggestions.`);
      }
      return { suggestions: sugs, warnings };
    }
    if (Array.isArray(data.forms) || Array.isArray(data.elements)) {
      // A raw SuggestInput.
      const input: SuggestInput = {
        siteHost: typeof data.siteHost === 'string' ? data.siteHost : '',
        forms: Array.isArray(data.forms) ? (data.forms as SuggestInput['forms']) : [],
        elements: Array.isArray(data.elements) ? (data.elements as SuggestInput['elements']) : [],
      };
      return { suggestions: buildSuggestions(input, { full: true }), warnings };
    }
  }

  throw new Error('Unrecognized JSON — expected a gtm_tag_suggestions report, a SuggestInput, or a suggestions array.');
}

/** A tool runner — buildToolRegistry's `execute`. Injected so the create loop is
 *  pure/testable (no Electron, no real GTM). */
export type ToolExecute = (name: string, args: Record<string, unknown>) => Promise<string>;

/** GTM API rate-limit / quota errors (per-minute-per-user etc.) — retryable. */
const QUOTA_RE = /quota exceeded|rate.?limit|rateLimitExceeded|userRateLimitExceeded|queries per (minute|second|day)|\b429\b|RESOURCE_EXHAUSTED/i;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CreateTagsOptions {
  /** Sleep impl — injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause between tags to stay under the GTM per-minute quota (default 700ms). */
  throttleMs?: number;
  /** Retries on a quota/rate-limit error, with exponential backoff (default 4). */
  maxRetries?: number;
}

/**
 * Create the user-approved suggestions as DRAFT tags via the existing
 * create_gtm_tracking_tag tool — the single create code path (same builders,
 * same draft-only/no-publish guarantee). SEQUENTIAL so one tag's failure is
 * isolated. Throttled + retried-with-backoff so a batch doesn't trip the GTM
 * "Queries per minute per user" quota (which otherwise fails tags mid-batch).
 * Pure: the executor and sleep are injected.
 */
export async function createSuggestedTags(
  execute: ToolExecute,
  ids: { accountId: string; containerId: string; workspaceId: string },
  tags: SuggestedTagView[],
  opts: CreateTagsOptions = {},
): Promise<CreateTagOutcome[]> {
  const sleep = opts.sleep ?? realSleep;
  const throttleMs = opts.throttleMs ?? 700;
  const maxRetries = opts.maxRetries ?? 4;
  const outcomes: CreateTagOutcome[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (i > 0 && throttleMs > 0) await sleep(throttleMs); // smooth the request rate
    let attempt = 0;
    for (;;) {
      try {
        const out = JSON.parse(
          await execute('create_gtm_tracking_tag', {
            accountId: ids.accountId,
            containerId: ids.containerId,
            workspaceId: ids.workspaceId,
            platform: t.platform,
            tagName: t.tagName,
            measurementId: t.measurementId,
            // google_tag (the GA4 Configuration base tag) uses tagId + configSettings;
            // ga4_event uses eventName + eventParameters. Send the right set per platform.
            ...(t.platform === 'google_tag'
              ? { tagId: t.tagId ?? t.measurementId, configSettings: Array.isArray(t.configSettings) ? t.configSettings : [] }
              : { eventName: t.eventName, eventParameters: Array.isArray(t.eventParameters) ? t.eventParameters : [] }),
            trigger: t.trigger,
          }),
        ) as { declined?: boolean; tag?: { name?: string }; trigger?: { reused?: boolean } };
        if (out?.declined) {
          outcomes.push({ id: t.id, ok: false, error: 'declined' });
        } else {
          outcomes.push({
            id: t.id,
            ok: true,
            tagName: out?.tag?.name ?? t.tagName,
            triggerReused: out?.trigger?.reused === true,
          });
        }
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Back off and retry on a transient quota error (trigger reuse-by-name
        // makes a retry idempotent — it won't duplicate the trigger).
        if (QUOTA_RE.test(msg) && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1))); // 2s, 4s, 8s, 16s
          continue;
        }
        outcomes.push({ id: t.id, ok: false, error: msg });
        break;
      }
    }
  }
  return outcomes;
}
