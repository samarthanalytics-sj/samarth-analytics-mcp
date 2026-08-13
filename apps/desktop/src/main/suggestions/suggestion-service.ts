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
import type { SuggestedTagView } from '../../shared/ipc';
import { adsIdentityIssue } from '../../shared/tag-template';
import { ga4VariablePlan, buildVariable, type ContainerSnapshot } from '../google/gtm-builders';
import { QUOTA_RE } from '../google/quota-retry';
import { DUPLICATE_RE, realSleep, type ToolExecute, type CreateTagsOptions } from './create-suggested-tags';

// The batch create loop moved to create-suggested-tags.ts so the chat orchestrator can import it
// without pulling ../google/gtm-builders (and through it the repo-root src/) into its compile root.
// Re-exported here because every existing caller imports it from this module.
export { createSuggestedTags, DUPLICATE_RE, realSleep } from './create-suggested-tags';
export type { ToolExecute, CreateTagsOptions } from './create-suggested-tags';

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

/** Which Google Ads rows to BLOCK because their Conversion ID / Label is not usable yet (still the
 *  engine's un-provisioned {{Google Ads Conversion ID}} / {{...Label}} placeholder, empty, or
 *  malformed). Unlike the google_tag case there is nothing to PROVISION here: an Ads tag must carry a
 *  LITERAL id, because normalizeAdsConversionId passes any {{variable}} through verbatim, so a Constant
 *  holding "AW-123456789" would reach the awct template with the prefix it rejects. Blocked rows are
 *  filtered out per-row (never the whole batch) exactly like planGoogleTagVars' errors. PURE. */
export function planAdsIdentity(list: SuggestedTagView[]): { errors: Map<string, string> } {
  const errors = new Map<string, string>();
  for (const t of list) {
    const issue = adsIdentityIssue(t);
    if (issue) errors.set(t.id, issue);
  }
  return { errors };
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
