// The batch create loop behind "create the selected tags", split out of suggestion-service.ts so it
// can be shared.
//
// Why the split: the chat orchestrator compiles with rootDir "apps", and suggestion-service.ts
// imports ../google/gtm-builders, which re-exports the repo-root src/shared/gtm-builders.ts. That
// one import puts a file outside the orchestrator's compile root into its graph. Nothing in the
// create loop itself needs it - only planGoogleTagVars and provisionVariables do, and those stay
// where they are. suggestion-service.ts re-exports everything here, so the desktop imports are
// unchanged.
//
// PURE: the tool runner and sleep are injected, so this is unit-tested with no Electron, no HTTP and
// no real GTM.

import type { CreateTagOutcome, SuggestedTagView } from '../../shared/ipc';
// Written with the .js extension, unlike its neighbours: this module is also compiled by the chat
// orchestrator, which emits plain Node ESM, and Node requires the extension on a relative import at
// runtime. The desktop bundler resolves .js -> .ts happily, which is why the web-audit imports
// across this package already look like this.
import { QUOTA_RE } from '../google/quota-retry.js';

/** A tool runner - buildToolRegistry's `execute` on the desktop, an MCP callTool on the server.
 *  Injected so the create loop is pure/testable (no Electron, no real GTM). */
export type ToolExecute = (name: string, args: Record<string, unknown>) => Promise<string>;

/** "Found entity with duplicate name" - a tag with this name already exists. Not an
 *  error to surface: it's already there, so it's SKIPPED (marked "already exists"). */
export const DUPLICATE_RE = /duplicate name|already exists|entity with duplicate|duplicate entity/i;

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CreateToolResult {
  declined?: boolean;
  alreadyExists?: boolean;
  tag?: { name?: string; tagId?: string };
  trigger?: { reused?: boolean };
}

/**
 * Read the create tool's reply, which is not always JSON.
 *
 * create_gtm_tracking_tag REFUSES some requests in plain English rather than failing: a placeholder
 * Measurement ID it cannot resolve from the container, a platform it does not build, a Custom HTML
 * tag with no body. Those replies are the most useful thing the tool produces, because each one
 * says exactly what to change.
 *
 * JSON.parse threw on them, so the sentence was replaced by:
 *
 *   Unexpected token 'N', "Not creati"... is not valid JSON
 *
 * which is a parser complaining about the shape of an explanation nobody got to read. Throwing the
 * TEXT means the loop's existing error handling reports the refusal itself.
 */
export function parseCreateResult(raw: string): CreateToolResult {
  try {
    return JSON.parse(raw) as CreateToolResult;
  } catch {
    const text = String(raw ?? '').trim();
    throw new Error(text || 'The create tool returned an empty response.');
  }
}

export interface CreateTagsOptions {
  /** Sleep impl - injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause between tags to stay under the GTM per-minute quota (default 900ms). */
  throttleMs?: number;
  /** Retries on a quota/rate-limit error, with exponential backoff (default 6). */
  maxRetries?: number;
  /** Called after each tag is attempted (done, total) - drives the live "7/40" progress in the UI. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Create the user-approved suggestions as DRAFT tags via the existing
 * create_gtm_tracking_tag tool - the single create code path (same builders,
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
  const baseThrottle = opts.throttleMs ?? 900;
  const maxRetries = opts.maxRetries ?? 6;
  // Each create does several API calls (enable vars + list/create trigger + create
  // tag), so a big batch can trip the GTM "Queries per minute" quota. After a quota
  // error we PERMANENTLY slow the rest of the batch (adaptive throttle) so the run
  // self-tunes under the limit instead of repeatedly retrying into it.
  let throttleMs = baseThrottle;
  const MAX_THROTTLE = 8_000;
  const outcomes: CreateTagOutcome[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (i > 0 && throttleMs > 0) await sleep(throttleMs); // smooth the request rate
    let attempt = 0;
    for (;;) {
      try {
        // Per-platform arg set. Pixel platforms (meta/tiktok/reddit/pinterest/linkedin) + ga4_event go
        // through the eventName/eventParameters path with measurementId as the id. google_tag uses
        // tagId + configSettings. The Google Ads platforms read different id fields: a conversion tag
        // needs conversionId + conversionLabel, remarketing needs conversionId, and the conversion
        // linker needs neither - so send exactly those (measurementId holds the Conversion ID).
        const platformArgs: Record<string, unknown> =
          t.platform === 'google_tag'
            ? { measurementId: t.measurementId, tagId: t.tagId ?? t.measurementId, configSettings: Array.isArray(t.configSettings) ? t.configSettings : [] }
            : t.platform === 'google_ads_conversion'
              ? { conversionId: t.measurementId, conversionLabel: t.conversionLabel ?? '' }
              : t.platform === 'google_ads_remarketing'
                ? { conversionId: t.measurementId }
                : t.platform === 'conversion_linker'
                  ? {}
                  : {
                      measurementId: t.measurementId,
                      eventName: t.eventName,
                      eventParameters: Array.isArray(t.eventParameters) ? t.eventParameters : [],
                      // Companion Lookup Table variables an event param references (e.g. a per-page form_name).
                      ...(Array.isArray(t.eventParamLookups) && t.eventParamLookups.length ? { eventParamLookups: t.eventParamLookups } : {}),
                    };
        const out = parseCreateResult(
          await execute('create_gtm_tracking_tag', {
            accountId: ids.accountId,
            containerId: ids.containerId,
            workspaceId: ids.workspaceId,
            platform: t.platform,
            tagName: t.tagName,
            ...platformArgs,
            trigger: t.trigger,
          }),
        );
        if (out?.declined) {
          outcomes.push({ id: t.id, ok: false, error: 'declined' });
        } else if (out?.alreadyExists) {
          // The tool's precheck short-circuited: a tag with this name is ALREADY in the container, so
          // nothing was created. This must NOT count as "created" (it inflated the created total - the
          // reported count read higher than GTM actually had).
          outcomes.push({ id: t.id, ok: false, existing: true, error: 'already exists' });
        } else {
          outcomes.push({
            id: t.id,
            ok: true,
            tagName: out?.tag?.name ?? t.tagName,
            ...(out?.tag?.tagId ? { tagId: String(out.tag.tagId) } : {}),
            triggerReused: out?.trigger?.reused === true,
          });
        }
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A tag with this name already exists → skip it, mark "already exists" (NOT
        // an error, and don't retry - the name won't free up).
        if (DUPLICATE_RE.test(msg)) {
          outcomes.push({ id: t.id, ok: false, existing: true, error: 'already exists' });
          break;
        }
        // Back off and retry on a transient quota error (trigger reuse-by-name
        // makes a retry idempotent - it won't duplicate the trigger). Also slow the
        // REST of the batch so we stop hammering the per-minute quota.
        if (QUOTA_RE.test(msg) && attempt < maxRetries) {
          attempt += 1;
          throttleMs = Math.min(MAX_THROTTLE, throttleMs + 1_500);
          await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1))); // 2s,4s,8s,16s,30s,30s
          continue;
        }
        outcomes.push({ id: t.id, ok: false, error: msg });
        break;
      }
    }
    opts.onProgress?.(i + 1, tags.length);
  }
  return outcomes;
}
