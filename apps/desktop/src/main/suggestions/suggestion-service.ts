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
import { ga4VariablePlan, buildVariable, type ContainerSnapshot } from '../google/gtm-builders';
import { QUOTA_RE } from '../google/quota-retry';

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

// A real id is G-/GT-/AW- + an alphanumeric suffix, and is NOT the all-X placeholder
// (G-XXXXXXXXXX). Only an all-X suffix is rejected — a real id that merely contains an
// X-run (e.g. G-1XXXAB2345) is fine.
const isRealMeasurementId = (v: string): boolean =>
  /^(G|GT|AW)-[A-Z0-9]{4,}$/i.test(v) && !/^(G|GT|AW)-X+$/i.test(v.trim());

/** Decide what a batch of suggestions needs before creation, for the base Google
 *  tag(s): which {{variable}} Constants to CREATE (so a google_tag whose tagId is a
 *  variable doesn't point at nothing), and which rows to BLOCK (placeholder id, or a
 *  same-named non-constant variable). PURE — snapshot in, plan out. Mirrors the
 *  tested ensureGa4Config logic (ga4VariablePlan), applied to the scan create flow. */
export function planGoogleTagVars(
  snap: ContainerSnapshot,
  list: SuggestedTagView[],
): { creates: Array<{ name: string; value: string }>; errors: Map<string, string> } {
  const errors = new Map<string, string>();
  const creates: Array<{ name: string; value: string }> = [];
  const planned = new Set<string>();
  for (const t of list) {
    if (t.platform !== 'google_tag') continue;
    const m = /^\s*\{\{(.+?)\}\}\s*$/.exec(t.tagId ?? '');
    if (!m) continue; // a literal G-XXXX tagId needs no variable
    const varName = m[1];
    const mid = String(t.measurementId ?? '').trim();
    if (!isRealMeasurementId(mid)) {
      errors.set(t.id, 'Enter your real GA4 Measurement ID (e.g. G-ABC1234567) on this row before creating.');
      continue;
    }
    const key = varName.toLowerCase();
    if (planned.has(key)) continue;
    const plan = ga4VariablePlan(snap, varName);
    if (plan.action === 'conflict') {
      errors.set(t.id, `A variable named "${varName}" already exists but is not a constant (type "${plan.existingType}") — rename it, or edit the Tag ID.`);
      continue;
    }
    if (plan.action === 'create') creates.push({ name: varName, value: mid });
    planned.add(key);
  }
  return { creates, errors };
}

/** A tool runner — buildToolRegistry's `execute`. Injected so the create loop is
 *  pure/testable (no Electron, no real GTM). */
export type ToolExecute = (name: string, args: Record<string, unknown>) => Promise<string>;

/** "Found entity with duplicate name" — a tag with this name already exists. Not an
 *  error to surface: it's already there, so it's SKIPPED (marked "already exists"). */
const DUPLICATE_RE = /duplicate name|already exists|entity with duplicate|duplicate entity/i;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CreateTagsOptions {
  /** Sleep impl — injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause between tags to stay under the GTM per-minute quota (default 900ms). */
  throttleMs?: number;
  /** Retries on a quota/rate-limit error, with exponential backoff (default 6). */
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
        // A tag with this name already exists → skip it, mark "already exists" (NOT
        // an error, and don't retry — the name won't free up).
        if (DUPLICATE_RE.test(msg)) {
          outcomes.push({ id: t.id, ok: false, existing: true, error: 'already exists' });
          break;
        }
        // Back off and retry on a transient quota error (trigger reuse-by-name
        // makes a retry idempotent — it won't duplicate the trigger). Also slow the
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
  }
  return outcomes;
}

/** Create the Constant variables a google_tag batch needs, with the SAME duplicate /
 *  quota resilience as the tag creates: a duplicate (a TOCTOU race where the variable
 *  was created since the snapshot) is tolerated, a quota error is retried with
 *  backoff, and any OTHER failure is recorded PER-VARIABLE — so only the dependent
 *  google_tag rows fail, never the whole batch. Returns variable-name (lowercased) →
 *  error message for the ones that genuinely failed. PURE (execute + sleep injected). */
export async function provisionVariables(
  execute: ToolExecute,
  ids: { accountId: string; containerId: string; workspaceId: string },
  creates: Array<{ name: string; value: string }>,
  opts: CreateTagsOptions = {},
): Promise<Map<string, string>> {
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? 6;
  const failed = new Map<string, string>();
  for (const c of creates) {
    let attempt = 0;
    for (;;) {
      try {
        await execute('create_gtm_variable', { ...ids, variable: buildVariable({ kind: 'constant', name: c.name, value: c.value }) });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (DUPLICATE_RE.test(msg)) break; // race: the constant already exists → fine
        if (QUOTA_RE.test(msg) && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
          continue;
        }
        failed.set(c.name.toLowerCase(), msg);
        break;
      }
    }
  }
  return failed;
}
