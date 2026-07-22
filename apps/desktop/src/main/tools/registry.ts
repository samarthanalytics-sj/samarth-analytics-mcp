import type { GoogleDataService } from '../google/data-service';
import { AdsError, type GoogleAdsService } from '../google/ads-service';
import { CONVERSION_CATEGORIES } from '../google/ads-rest';
import type { LlmToolDef, ToolExecutor } from '../llm/types';
import type { GoogleProduct, GtmContext } from '../../shared/ipc';
import type { AuditHistoryStore } from '../storage/audit-history';
import { ManifestStore } from '../storage/manifest-store';
import type { MemoryStore } from '../storage/memory-store';
import { toolAllowedForContainer, type ContainerKind } from '../../shared/tool-scope';
import { fuseRankings } from '../../shared/embeddings';
import {
  MEMORY_KINDS,
  findMemoriesMatching,
  searchMemories,
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type MemorySearchScope,
} from '../../shared/chat-memory';
import { lookupCorpusPatterns, LOOKUP_DEFAULT_LIMIT, LOOKUP_MAX_LIMIT, type CorpusLookupKind } from '../../shared/corpus-lookup';
import { getPatternLibrary } from '../corpus/pattern-library';
import { fingerprintResource, diffManifest, type ManifestResource } from '../../shared/install-manifest';
import { buildTrackingStatus } from '../../shared/tracking-status';
import {
  buildGa4EventTag,
  buildGoogleTag,
  buildGoogleAdsConversionTag,
  buildCustomHtmlTag,
  buildFloodlightCounterTag,
  buildGoogleAdsCallConversionTag,
  buildGoogleAdsRemarketingTag,
  buildConversionLinkerTag,
  buildCustomImageTag,
  buildTrigger,
  triggerBuiltInVars,
  triggerDataLayerVarKeys,
  builtInVarsForTemplates,
  buildVariable,
  buildUrlQueryVariable,
  buildClickTextLookupVariable,
  buildLookupTableVariable,
  buildRegexTableVariable,
  buildGoogleTagEventSettingsVariable,
  buildFormNameVariable,
  findExistingTrigger,
  customEventNameOf,
  buildGa4ServerTag,
  buildAdsConversionServerTag,
  buildAdsConversionLinkerServerTag,
  buildAdsRemarketingServerTag,
  buildAllowParamsTransformation,
  buildServerAllEventsTrigger,
  buildServerEventTrigger,
  buildConsentModeDefaultTag,
  GA4_ECOMMERCE_FUNNEL_EVENTS,
  buildMetaPixelTag,
  metaWebObjectProps,
  buildMetaCapiServerTag,
  metaStandardEvent,
  buildTikTokCapiServerTag,
  tikTokStandardEvent,
  buildLinkedInCapiServerTag,
  buildHotjarTag,
  buildPinterestTag,
  buildPinterestCapiServerTag,
  buildStackAdaptServerTag,
  buildRedditCapiServerTag,
  buildAmazonCapiServerTag,
  buildTikTokPixelTag,
  buildLinkedInInsightTag,
  buildRedditPixelTag,
  buildSnapPixelTag,
  detectMetaTags,
  findUnusedTriggers,
  findUnusedVariables,
  type TriggerInput,
  type VariableKind,
  type GtmTagResource,
} from '../google/gtm-builders';
import { buildGa4WriteTools } from './ga4-write-tools';
import { formTrackingRecipe, AJAX_FORM_PROVIDERS_LIST } from './form-recipes';
import { withQuotaRetry } from '../google/quota-retry';
import { auditWorkspace, auditServerWorkspace, auditChanges } from '../google/audit-runner';
import { diffSnapshots } from '../google/gtm-monitor';
import { auditGa4 } from '../google/ga4-audit';
import { auditGa4DataQuality } from '../google/ga4-data-quality';
import { rankGa4Campaigns } from '../google/ga4-campaigns';
import { monitorGa4 } from '../google/ga4-monitor';
import { gatherGa4MonitorInput } from '../services/ga4-monitoring-service';
import { buildScorecard, type ScorecardSection } from '../google/scorecard';
import { buildReport } from '../google/report';
import { consentReportToSection } from '../google/consent-section';
import { extractConfiguredGa4Ids, crossCheckMeasurementIds } from '../google/gtm-ga4-check';
import { runSyntheticTest } from '../suggestions/synthetic-driver';
import { evaluateRuntimeCapture } from '../../shared/runtime-capture';

// A change a write-tool wants to make, surfaced to the user for approval.
export interface WriteProposal {
  tool: string;
  summary: string;
  details: Record<string, unknown>;
  /** Destructive (delete) — the UI emphasizes this and it requires a 2nd confirm. */
  destructive?: boolean;
  /** When set, the approval card requires the user to TYPE this word (e.g. "delete") before
   *  the action can be approved — used for the final confirmation of a destructive action. */
  requireTextConfirm?: string;
}

/**
 * Asks the user to approve a write. Resolves with the (possibly user-edited)
 * args to apply, or null if the user declined. Lets the approval card edit
 * names/types/config before the change is made.
 */
export type ConfirmFn = (proposal: WriteProposal) => Promise<Record<string, unknown> | null>;

/** Lets a chat tool switch the app's ACTIVE GTM context (account/container/workspace).
 *  `current` returns the working context (for defaults); `set` persists it AND notifies the
 *  UI so the GTM bar dropdown updates. Provided only on the chat path. */
export interface GtmContextControl {
  current: () => GtmContext | undefined;
  set: (ctx: GtmContext) => Promise<void> | void;
}

/** Wiring for the chat MEMORY tools (remember / forget). Present only in the chat path — the model reads,
 *  saves and removes the ACTIVE account's local notes (the same store the chat injects each turn). */
export interface MemoryToolContext {
  store: MemoryStore;
  accountId: string;
  /** The client scope for a client-scoped memory: containerId in a GTM turn, property in a GA4 turn.
   *  A FUNCTION, not a value: the active container can change mid-turn (set_gtm_container), and a
   *  snapshot would file new notes under, and recall from, the container the user just left. */
  scope: () => MemoryScope;
  /** Provenance hook: memories the model pulled in MID-turn via `recall_memories`. The chat service
   *  folds these into the turn's "memories used" list, credits each one once, and owns the usage log. */
  onRecall?: (memories: Memory[]) => void;
}

export interface Tool extends LlmToolDef {
  /** Mutates GTM — only listed/executed when a confirm function is provided. */
  write?: boolean;
  /** Deletes data — requires a SECOND confirmation before applying. */
  destructive?: boolean;
  /** Human-readable one-liner shown in the approval prompt. */
  summarize?: (args: Record<string, unknown>) => string;
  /** Runs BEFORE the approval prompt. If it returns a value, that's an "already present"
   *  short-circuit — the create is skipped (no duplicate, no approval) and the value is
   *  returned to the model. Return null/undefined to proceed normally. */
  precheck?: (args: Record<string, unknown>) => Promise<unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const s = (v: unknown): string => String(v ?? '');

/** Human-readable one-line description of a suggested tag's trigger condition, for suggest_tags_from_url. */
function describeTriggerCondition(t: Record<string, unknown> | undefined): string {
  const g = (k: string): string | undefined => (t && typeof t[k] === 'string' ? (t[k] as string) : undefined);
  const kind = g('kind') ?? '';
  const op = (k: string): string => g(k) ?? 'equals';
  if (kind === 'form_submit') {
    if (g('formIdValue')) return `form submit where Form ID ${op('formIdOperator')} "${g('formIdValue')}"`;
    if (g('formClassesValue')) return `form submit where Form Classes ${op('formClassesOperator')} "${g('formClassesValue')}"`;
    if (g('pagePathValue')) return `form submit on Page Path ${op('pagePathOperator')} "${g('pagePathValue')}"`;
    return 'form submit (any form on the page)';
  }
  if (kind === 'link_click' || kind === 'all_clicks') {
    const parts: string[] = [];
    if (g('clickTextValue')) parts.push(`Click Text ${op('clickTextOperator')} "${g('clickTextValue')}"`);
    if (g('clickUrlValue')) parts.push(`Click URL ${op('clickUrlOperator')} "${g('clickUrlValue')}"`);
    if (g('clickElementValue')) parts.push(`Click Element matches "${g('clickElementValue')}"`);
    const base = kind === 'link_click' ? 'link click' : 'click';
    return parts.length ? `${base} where ${parts.join(' AND ')}` : `${base} (any)`;
  }
  if (kind === 'custom_event') return `custom event "${g('eventName') ?? ''}"`;
  if (kind === 'pageview') return g('pageUrlValue') ? `page view where Page URL ${op('pageUrlOperator')} "${g('pageUrlValue')}"` : 'page view (All Pages)';
  return kind || 'trigger';
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
/** Read an optional boolean arg (a real boolean, or the strings "true"/"false"); undefined otherwise
 *  so the builder's own default applies. */
const bln = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);

/** The Meta Pixel tag name: an explicit `name`, else the convention "Meta - Event - <Event> Tag"
 *  (canonical standard event, or the custom event as typed). */
const metaPixelTagName = (a: Record<string, unknown>): string => {
  const provided = a.name != null ? s(a.name).trim() : '';
  if (provided) return provided;
  const ev = s(a.event).trim();
  return `Meta - Event - ${metaStandardEvent(ev) ?? ev} Tag`;
};

/** One-line truncation for logging tool args/results without flooding the console. */
const truncForLog = (str: string, n = 600): string => (str.length > n ? `${str.slice(0, n)}…(+${str.length - n} chars)` : str);

/** Precheck helper: is a tag/variable with this name already in the workspace? Returns an
 *  "already present" payload (so the create is skipped, no approval) or null to proceed. */
async function findExistingByName(
  data: GoogleDataService,
  a: Record<string, unknown>,
  name: string,
  kind: 'tag' | 'variable' | 'trigger'
): Promise<unknown> {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const list =
    kind === 'tag'
      ? await data.listGtmTags(s(a.accountId), s(a.containerId), s(a.workspaceId))
      : kind === 'variable'
        ? await data.listGtmVariables(s(a.accountId), s(a.containerId), s(a.workspaceId))
        : await data.listGtmTriggers(s(a.accountId), s(a.containerId), s(a.workspaceId));
  const match = list.find((x) => x.name.trim().toLowerCase() === want);
  if (!match) return null;
  const id =
    kind === 'tag'
      ? (match as { tagId: string }).tagId
      : kind === 'variable'
        ? (match as { variableId: string }).variableId
        : (match as { triggerId: string }).triggerId;
  const label = kind === 'tag' ? 'Tag' : kind === 'variable' ? 'Variable' : 'Trigger';
  return { alreadyExists: true, [kind]: match, message: `${label} "${match.name}" already exists (ID ${id}) — not created.` };
}

/** Cheap similarity for "did you mean" on an unknown tool name: common-prefix length,
 *  heavily boosted when one name contains the other (catches near-miss/hallucinated
 *  names like set_ga4_measurement_id_for_all_tags → ..._on_all_tags). */
function toolNameSimilarity(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i + (a.includes(b) || b.includes(a) ? 100 : 0);
}
function closestToolNames(name: string, names: string[]): string[] {
  return names
    .map((n) => ({ n, score: toolNameSimilarity(name, n) }))
    .filter((x) => x.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.n);
}

// Pull the real Google API error out of a googleapis/Gaxios error so the model
// (and the dev console) sees the true reason — e.g. "Request had insufficient
// authentication scopes" (403) or a precise field validation message (400).
function apiErrorMessage(e: unknown): string {
  const g = e as {
    response?: { data?: { error?: { message?: string; status?: string } } };
    errors?: Array<{ message?: string }>;
    message?: string;
  };
  const raw =
    g?.response?.data?.error?.message ??
    g?.errors?.[0]?.message ??
    g?.message ??
    String(e);
  // GTM locks a workspace once a container VERSION has been created from it (a "submit") — e.g. by
  // "Auto: create preview & verify" / the Auto-verify & heal loop, or a Submit/Publish in GTM. A
  // submitted workspace is READ-ONLY, so every write (create tag/trigger/…) then fails. Make the fix
  // obvious instead of surfacing the bare "Workspace is already submitted".
  if (/already submitted|workspace .*submitted|workspace is submitted/i.test(raw)) {
    return `${raw} — this GTM workspace is read-only because a version was already created from it (a "submit", e.g. by "Auto: create preview & verify" or a Submit/Publish in GTM). Create a NEW workspace (create_gtm_workspace, or pick/add one in the GTM bar) and retry there.`;
  }
  return raw;
}

/**
 * Read-only tools are always available. Write tools (create/edit tags, triggers,
 * variables in a draft workspace) are included ONLY when `confirm` is supplied,
 * and each one calls `confirm` first — if the user declines, nothing is applied.
 * Writes never publish; changes stay in the workspace until published in GTM.
 */
// GTM WRITE tools that edit GA4 *tags inside GTM*. Their names contain "ga4" but they
// belong to the GTM product, NOT the read-only GA4 Analytics product. Without this
// exception the substring match below files them under 'ga4' → they get filtered OUT of
// the GTM chat (and GA4 is read-only, so unavailable there too), making them unreachable
// by the model — which is exactly why it fell back to set_gtm_tag_paused.
const GTM_GA4_TAG_TOOLS = new Set([
  'set_ga4_measurement_id',
  'set_ga4_measurement_id_on_all_tags',
  'add_ga4_event_parameters',
  'add_ga4_event_parameters_to_all_tags',
  // Edits a GTM server GA4 tag (sgtmgaaw) — belongs in the GTM chat, NOT the read-only GA4
  // Analytics product. Without this entry productOf() files it under 'ga4' (the substring match)
  // so it is filtered OUT of the GTM chat, where server-container work happens, and unreachable.
  'add_ga4_server_parameters',
]);

// Tool product is derived from its name (GA4 Analytics tools contain "ga4", GTM tools
// contain "gtm") — used to hard-scope the registry to one product — EXCEPT the GTM
// tag-edit tools above, which operate on GTM despite the "ga4" in their name.
const productOf = (name: string): GoogleProduct =>
  name.includes('ga4') && !GTM_GA4_TAG_TOOLS.has(name) ? 'ga4' : 'gtm';

/**
 * Record the resources a WEB setup tool created into the per-container install
 * manifest. The setup result carries only NAMES (created.variables/triggers/tags),
 * so we re-fetch the live snapshot to resolve each created name to its id +
 * config and fingerprint it. Best-effort by design; callers wrap in try/catch.
 */
async function recordSetupManifest(
  data: GoogleDataService,
  manifests: ManifestStore,
  ids: { accountId: string; containerId: string; workspaceId: string },
  created: { variables?: string[]; triggers?: string[]; tags?: string[] },
  tool: string
): Promise<void> {
  const createdVars = new Set((created.variables ?? []).map((n) => n.trim().toLowerCase()));
  const createdTrigs = new Set((created.triggers ?? []).map((n) => n.trim().toLowerCase()));
  const createdTags = new Set((created.tags ?? []).map((n) => n.trim().toLowerCase()));
  if (!createdVars.size && !createdTrigs.size && !createdTags.size) return;

  const snap = await data.getGtmContainerSnapshot(ids.accountId, ids.containerId, ids.workspaceId);
  const entries: ManifestResource[] = [];
  const push = (
    kind: ManifestResource['kind'],
    id: string,
    name: string,
    type: string,
    parameter: unknown
  ): void => {
    if (!id) return; // no id to track by → can't detect drift for it, skip.
    entries.push({ kind, id, name, fingerprint: fingerprintResource({ name, type, parameter }), tool });
  };
  for (const t of snap.tags) {
    if (createdTags.has((t.name ?? '').trim().toLowerCase())) push('tag', t.tagId, t.name, t.type, t.parameter);
  }
  for (const tr of snap.triggers) {
    if (createdTrigs.has((tr.name ?? '').trim().toLowerCase())) push('trigger', tr.triggerId, tr.name, tr.type, tr.parameter);
  }
  for (const v of snap.variables) {
    if (createdVars.has((v.name ?? '').trim().toLowerCase())) push('variable', v.variableId, v.name, v.type, v.parameter);
  }
  if (!entries.length) return;
  const key = ManifestStore.key(ids.accountId, ids.containerId, ids.workspaceId);
  manifests.record(key, { account: ids.accountId, container: ids.containerId, workspace: ids.workspaceId }, entries, new Date().toISOString());
}

/**
 * Shape a Google Ads failure into something that can safely reach the chat transcript.
 *
 * The rule that matters: never read `.response` or `.config` off the raw error. A gaxios failure
 * carries the request config it was made with, and that config carries the `developer-token` header,
 * so a "helpful" error dump would print the operator's token into the chat and into the console log.
 * That is why every Ads handler catches for itself instead of letting the generic apiErrorMessage()
 * path (which does read `.response.data.error.message`) see the error at all. AdsError already holds
 * a message and a remedy written for a human by ads-errors, and that is the only thing that travels.
 */
function adsFailure(e: unknown): Record<string, unknown> {
  if (e instanceof AdsError) {
    return {
      ok: false,
      error: e.info.message,
      ...(e.info.remedy ? { remedy: e.info.remedy } : {}),
      ...(e.info.code ? { code: e.info.code } : {}),
      ...(e.info.retryable ? { retryable: true } : {}),
    };
  }
  // A non-AdsError here is a local precondition (no active account, no signed-in token) or something
  // unexpected. Only an Error's own message travels; an unknown throw shape is reported generically
  // rather than serialized, because nothing guarantees what a stranger object is carrying.
  return { ok: false, error: e instanceof Error ? e.message : 'The Google Ads request failed.' };
}

/**
 * Ads preflight. Both ways a call can be dead on arrival (no developer token, or an account whose
 * Google token never granted the adwords scope) surface as a 403 at call time, and a 403 is NOT
 * invalid_grant, so it never reaches the auth-expired chokepoint that would explain it. Checking up
 * front is the difference between "add your developer token in Settings" and a bare permission error
 * the model will happily invent a cause for.
 */
async function adsNotReady(ads: GoogleAdsService): Promise<Record<string, unknown> | null> {
  try {
    const r = await ads.readiness();
    if (r.ready) return null;
    return {
      ok: false,
      ready: false,
      error: r.reason?.message ?? 'Google Ads is not available for this Google account.',
      ...(r.reason?.remedy ? { remedy: r.reason.remedy } : {}),
      ...(r.reason?.code ? { code: r.reason.code } : {}),
      note: 'Report this fix to the user verbatim. Do not retry, and do not guess a conversion id or label.',
    };
  } catch (e) {
    return adsFailure(e);
  }
}

/**
 * Google Ads chat tools. Part of the GTM toolset, not a product of their own: they exist so the model
 * can fetch a REAL Conversion ID and Label itself and feed them into create_gtm_tracking_tag
 * (platform google_ads_conversion), instead of asking the user to paste them out of the Ads UI or
 * emitting a {{placeholder}} variable that produces a tag which reports created and records nothing.
 *
 * Registered only when an Ads service is injected, so every existing caller (the audit/suggestion fix
 * appliers, the startup diagnostic, the test fakes) keeps working unchanged with no Ads surface.
 *
 * `writesEnabled` mirrors the GTM/GA4 rule: the create tool exists only when the registry was built
 * with a confirm fn, so a read-only registry cannot even name it.
 */
function buildGoogleAdsTools(ads: GoogleAdsService, writesEnabled: boolean): Tool[] {
  // Every handler runs behind the readiness gate and swallows its own errors, so an Ads failure is a
  // structured answer the model can read out, never a throw carrying a request config.
  const run = async (fn: () => Promise<unknown>): Promise<unknown> => {
    const blocked = await adsNotReady(ads);
    if (blocked) return blocked;
    try {
      return await fn();
    } catch (e) {
      return adsFailure(e);
    }
  };
  // An empty login-customer-id is not the same as an absent one (the API rejects a blank header), so a
  // model that sends "" must be read as "no manager", not as a manager named nothing.
  const login = (a: Record<string, unknown>): string | undefined => s(a.loginCustomerId).trim() || undefined;

  const readTools: Tool[] = [
    {
      name: 'list_google_ads_accounts',
      description:
        'List the Google Ads accounts the signed-in user can reach, manager (MCC) accounts included. Returns each ' +
        'account\'s customerId (bare digits, the only form the API accepts), name, manager flag, testAccount flag ' +
        '(holds no real conversion data), and the loginCustomerId to send back when the account is reached THROUGH a ' +
        'manager. Read-only. Call this to resolve a customerId instead of asking the user to copy a dashed id out of ' +
        'the Google Ads UI, then call list_google_ads_conversion_actions.',
      inputSchema: { ...EMPTY_SCHEMA },
      handler: () =>
        run(async () => {
          const accounts = await ads.listAccounts();
          return {
            ok: true,
            count: accounts.length,
            accounts: accounts.map((a) => ({
              customerId: a.id,
              name: a.name,
              manager: a.manager,
              testAccount: a.testAccount,
              status: a.status,
              hidden: a.hidden,
              ...(a.loginCustomerId ? { loginCustomerId: a.loginCustomerId } : {}),
              ...(a.currencyCode ? { currencyCode: a.currencyCode } : {}),
            })),
            note: 'Pass BOTH a row\'s customerId and its loginCustomerId to the other Google Ads tools: an account reached through a manager needs that manager id on every call, and omitting it reads as a permission error rather than a missing header.',
          };
        }),
    },
    {
      name: 'list_google_ads_conversion_actions',
      description:
        'List a Google Ads account\'s conversion actions WITH each one\'s Conversion ID (AW-xxxxxxxxx) and Conversion ' +
        'LABEL: exactly the pair a GTM Google Ads Conversion Tracking (awct) tag needs. Answers "what is the conversion ' +
        'id / label for X". Read-only. Requires customerId (bare digits, no dashes); also pass loginCustomerId when the ' +
        'account sits under a manager (list_google_ads_accounts returns it). ' +
        'ALWAYS CALL THIS BEFORE creating a Google Ads conversion tag in GTM: pick the action the user means, then call ' +
        'create_gtm_tracking_tag with platform "google_ads_conversion" and pass that action\'s conversionId and ' +
        'conversionLabel as LITERAL values (e.g. "AW-17667466396" and "g9RqCLD6kdQcEJzJwOhB"). NEVER a {{variable}} for ' +
        'either one, and never an invented placeholder: a braced value is handed to the awct template verbatim, keeping ' +
        'the "AW-" prefix the template rejects, so the tag is reported as created while recording nothing. Do not ask ' +
        'the user to paste values this tool can read. ' +
        'taggable=false means the action can NEVER fire from GTM (offline upload, app, store visit, Analytics-imported) ' +
        'and its `note` says why: report that note instead of inventing a label. A null conversionLabel means Google ' +
        'published no event snippet, so the label exists nowhere in the API: say so rather than fabricating one.',
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string', description: 'Google Ads account id, bare digits (strip the dashes).' },
          loginCustomerId: { type: 'string', description: 'Manager (MCC) id to act through, when reached via a manager.' },
        },
        required: ['customerId'],
        additionalProperties: false,
      },
      handler: (a) =>
        run(async () => {
          const { actions, conversionCustomer } = await ads.listConversionActions(s(a.customerId), login(a));
          return {
            ok: true,
            customerId: s(a.customerId),
            count: actions.length,
            // Where the actions actually LIVE. Under cross-account conversion tracking they belong to a
            // manager and are shared with its clients, which is normal and not an error.
            conversionCustomer: {
              customerId: conversionCustomer.conversionCustomerId,
              isCrossAccount: conversionCustomer.isCrossAccount,
              status: conversionCustomer.status,
            },
            actions: actions.map((x) => ({
              id: x.id,
              name: x.name,
              category: x.category,
              status: x.status,
              type: x.type,
              conversionId: x.conversionId,
              conversionLabel: x.conversionLabel,
              taggable: x.taggable,
              ...(x.primaryForGoal === undefined ? {} : { primaryForGoal: x.primaryForGoal }),
              ...(x.note ? { note: x.note } : {}),
            })),
            ...(conversionCustomer.isCrossAccount && conversionCustomer.conversionCustomerId
              ? { note: `Conversion tracking for this account is owned by manager ${conversionCustomer.conversionCustomerId}, so these actions are shared with its other client accounts. Editing one affects all of them.` }
              : {}),
          };
        }),
    },
  ];

  if (!writesEnabled) return readTools;

  return [
    ...readTools,
    {
      name: 'create_google_ads_conversion_action',
      description:
        'Create a new WEBSITE conversion action in a Google Ads account and return its Conversion ID and Label. ' +
        'READ THIS BEFORE CALLING: unlike every GTM write in this app, which only lands in a DRAFT workspace, this ' +
        'applies IMMEDIATELY to the advertiser\'s live Google Ads account. No draft stage, no undo, no tool here can ' +
        'remove it. So call list_google_ads_conversion_actions FIRST and reuse an existing action when one fits; only ' +
        'create when the user actually asked for a new one, and state the exact name and category you are about to ' +
        'create BEFORE calling. It is gated by the app\'s strongest confirmation: the same two-step card deletes use, ' +
        'which asks the user to type "delete" to approve. Warn them about that wording, it is confirmation strength, ' +
        'not a delete. Requires customerId, name and category; optional countingType and loginCustomerId.',
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string', description: 'Account that will OWN the action, bare digits.' },
          name: { type: 'string', description: 'Name exactly as it should appear in Google Ads.' },
          category: {
            type: 'string',
            enum: CONVERSION_CATEGORIES.map((c) => c.value),
            description: 'What the conversion represents. Lead-style categories count once per click; purchase-style ones can repeat.',
          },
          countingType: {
            type: 'string',
            enum: ['ONE_PER_CLICK', 'MANY_PER_CLICK'],
            description: 'Omit to take Google\'s guidance for the category (one per click for leads, many for purchases).',
          },
          loginCustomerId: { type: 'string', description: 'Manager (MCC) id to act through, when reached via a manager.' },
        },
        required: ['customerId', 'name', 'category'],
        additionalProperties: false,
      },
      write: true,
      // destructive:true is NOT a claim that this deletes something. It is the flag that buys the
      // two-step approval card (plain writes auto-apply, because a GTM write is only ever a reversible
      // draft edit), and this is the one write in the registry that lands on a LIVE advertising account
      // with no draft stage and nothing here able to undo it. It gets the strongest gate that exists.
      destructive: true,
      summarize: (a) =>
        `Create a LIVE Google Ads conversion action "${s(a.name)}" (${s(a.category)}) in account ${s(a.customerId)}. This is not a draft: it exists in Google Ads the moment it is created`,
      // Readiness is checked HERE, not only in the handler: precheck runs before the approval card, so
      // a missing developer token or scope never makes the user type "delete" to authorize a write that
      // could not have been attempted. adsNotReady swallows its own errors, which matters because a
      // precheck throw would escape execute()'s try/catch entirely.
      precheck: () => adsNotReady(ads),
      handler: (a) =>
        run(async () => {
          const input = {
            name: s(a.name).trim(),
            category: s(a.category).trim().toUpperCase(),
            ...(s(a.countingType).trim() ? { countingType: s(a.countingType).trim().toUpperCase() } : {}),
          };
          // Dry run first. validateOnly is the same mutate call with the write suppressed, so a duplicate
          // name or a category the API refuses is reported with nothing landing in the live account.
          const invalid = await ads.validateConversionAction(s(a.customerId), input, login(a));
          if (invalid) {
            return {
              ok: false,
              created: false,
              error: invalid.message,
              ...(invalid.remedy ? { remedy: invalid.remedy } : {}),
              note: 'Google Ads rejected the conversion action before it was created, so NOTHING was written. Fix the name or category and ask again.',
            };
          }
          const action = await ads.createConversionAction(s(a.customerId), input, login(a));
          return {
            ok: true,
            created: true,
            customerId: s(a.customerId),
            action: {
              id: action.id,
              name: action.name,
              category: action.category,
              status: action.status,
              type: action.type,
              conversionId: action.conversionId,
              conversionLabel: action.conversionLabel,
              taggable: action.taggable,
              ...(action.note ? { note: action.note } : {}),
            },
            note: 'This conversion action is LIVE in Google Ads now. Pass its conversionId and conversionLabel as LITERAL values to create_gtm_tracking_tag (platform google_ads_conversion), never as a {{variable}}. The label exists nowhere else in the API, so if it came back null, read the action in Google Ads rather than guessing.',
          };
        }),
    },
  ];
}

export function buildToolRegistry(
  data: GoogleDataService,
  confirm?: ConfirmFn,
  product?: GoogleProduct,
  history?: AuditHistoryStore,
  ctxControl?: GtmContextControl,
  manifests?: ManifestStore,
  memoryCtx?: MemoryToolContext,
  /** Google Ads. Optional so every non-chat caller (audit/suggestion fix appliers, the startup
   *  diagnostic, the test fakes) keeps compiling and simply gets no Ads tools. */
  ads?: GoogleAdsService,
  /** The ACTIVE container's kind. Tools that cannot act on that kind are left out of the list, which
   *  is the difference between a ~26k-token GTM request and one that fits a small TPM budget. Omit
   *  (or pass undefined) to send everything: unknown kind must never hide a tool. */
  containerKind?: ContainerKind,
  /** Opt-in semantic search over the corpus vocabulary: query -> related terms. Omitted when the
   *  feature is off, unsupported by the provider, or still building, in which case corpus lookup
   *  behaves exactly as it always has. */
  semantic?: (query: string) => Promise<string[] | null>
): ToolExecutor {
  const readTools: Tool[] = [
    {
      name: 'list_gtm_accounts',
      description: 'List the Google Tag Manager accounts the signed-in user can access.',
      inputSchema: { ...EMPTY_SCHEMA },
      handler: () => data.listGtmAccounts(),
    },
    {
      name: 'list_gtm_containers',
      description: 'List the GTM containers within a GTM account. Requires the numeric accountId.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string', description: 'GTM account id' } },
        required: ['accountId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmContainers(s(a.accountId)),
    },
    {
      name: 'list_gtm_workspaces',
      description: 'List the workspaces in a GTM container.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' } },
        required: ['accountId', 'containerId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmWorkspaces(s(a.accountId), s(a.containerId)),
    },
    {
      name: 'list_gtm_folders',
      description:
        'List the folders in a GTM workspace (name + folderId). The GTM API DOES expose this (folders.list): use it to find a folder id before move_gtm_entities_to_folder / rename_gtm_folder / delete_gtm_folder rather than asking the user.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmFolders(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'list_gtm_environments',
      description:
        "List the container's GTM environments (Test/Staging/etc.): environmentId, type, gtm_auth token (authorizationCode), and a ready-to-paste install snippet (head <script> + body <noscript>). The GTM API DOES manage environments, so use this and create_gtm_environment rather than sending the user to the GTM UI.",
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' } },
        required: ['accountId', 'containerId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmEnvironments(s(a.accountId), s(a.containerId)),
    },
    {
      name: 'list_gtm_tags',
      description:
        'List the tags in a GTM workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmTags(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      // The site-wide counterpart to suggest_tags_from_url, which only ever looks at ONE page. Without
      // this, "list the forms on this website" or "check for sitemaps" had no tool at all, so the model
      // silently answered for the homepage alone and dropped the sitemap half of the question.
      name: 'discover_site_urls',
      description:
        'List the pages of a website, from its sitemap.xml (found via robots.txt or the usual locations) and falling back to a link crawl when there is no sitemap. Read-only. Answers "does this site have a sitemap", "what pages does it have", and is the FIRST step for anything site-wide, because suggest_tags_from_url only ever looks at the ONE url you give it: call this, then call suggest_tags_from_url on the pages that matter. Also reports the GTM container and GA4 measurement ids already live on the homepage. UNLIKE the list_* tools this one IS capped: it returns `total` alongside `urls`, and when they differ say so rather than implying the list is complete. Read `sitemapStatus` before saying anything about sitemaps: `found` and `none` are facts, `unreachable` means the sitemap could not be READ (say that, never that the site has none), and `partial` means the page count is a FLOOR. Needs a full public http(s) URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Site or page URL, e.g. https://example.com' },
          limit: { type: 'number', description: 'Max urls to return (default 50, max 200). The true count is always reported as `total`.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const { discoverSite } = await import('../suggestions/discover');
        const res = await discoverSite(s(a.url));
        // discoverSite goes up to 800 urls. Dumping that into the chat would refill the very
        // per-minute token budget the tool gating exists to protect, so cap hard and report honestly.
        const asked = Number(a.limit);
        const cap = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 50, 1), 200);
        const urls = res.urls.slice(0, cap);
        return {
          url: s(a.url),
          sitemapFound: res.viaSitemap,
          // 'unreachable' is NOT 'none': the sitemap could not be READ, so absence is unproven and
          // saying "this site has no sitemap" would be a false positive claim.
          sitemapStatus: res.sitemapStatus,
          total: res.total,
          returned: urls.length,
          ...(res.total > urls.length
            ? { truncated: `showing ${urls.length} of ${res.total} pages; say so rather than implying this is the whole site, and raise \`limit\` (max 200) or narrow the url if more are needed` }
            : {}),
          urls,
          installed: res.installed,
          ...(res.note ? { note: res.note } : {}),
          next: 'Call suggest_tags_from_url on the specific pages worth tracking (it scans ONE page per call). Forms and CTAs differ per page, so a homepage scan does not describe the site.',
        };
      },
    },
    {
      name: 'suggest_tags_from_url',
      description:
        'Scan a LIVE web page with a headless browser and return the GA4 event tags worth creating for it, INCLUDING the exact TRIGGER CONDITION each needs: form submits scoped by Form ID/classes or page path, CTA/link clicks by Click Text or Click URL, mailto:/tel: clicks, file downloads, outbound links. Read-only, it only inventories the DOM. Answers "how should the trigger be configured to track X on <url>?"; pass a suggestion\'s `trigger` object straight to create_gtm_tracking_tag so the tag actually fires. Needs a full public http(s) URL. Slow, call it once per page.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page URL to scan, e.g. https://example.com/contact' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const { scanUrlForSuggestions } = await import('../suggestions/scan-url');
        const res = await scanUrlForSuggestions(s(a.url));
        const all = res.suggestions ?? [];
        // Cap the payload so a link-heavy page can't balloon the chat context (and the LLM's
        // per-minute token budget). The top suggestions are already ranked by relevance.
        const CAP = 40;
        const suggestions = all.slice(0, CAP).map((t) => ({
          tagName: t.tagName,
          event: t.eventName,
          platform: t.platform,
          page: t.page,
          // Human-readable condition + the raw trigger to hand to create_gtm_tracking_tag.
          triggerCondition: describeTriggerCondition(t.trigger),
          trigger: t.trigger,
          // Caveat when present — e.g. an AJAX form plugin (CF7/Gravity/Ninja/…) whose native Form
          // Submission trigger won't fire, with the listener + Custom Event to add.
          ...(t.note ? { note: t.note } : {}),
        }));
        return {
          url: s(a.url),
          pagesScanned: res.summary?.pagesScanned ?? 1,
          count: suggestions.length,
          ...(all.length > CAP ? { truncated: `showing the top ${CAP} of ${all.length} — scan a more specific page for the rest` } : {}),
          suggestions,
          next: "Pass a suggestion's `trigger` (and its event/tagName) to create_gtm_tracking_tag to create it as a draft. If a suggestion's note says it's an AJAX form plugin (Contact Form 7 / Gravity Forms / Ninja Forms / WPForms / Elementor), call get_form_tracking_recipe(provider) instead — it returns the listener + GA4 tag to create so the Custom Event trigger actually fires.",
        };
      },
    },
    {
      name: 'get_form_tracking_recipe',
      description:
        "Get the complete, ready-to-create GTM recipe for an AJAX WordPress form plugin (Contact Form 7, Gravity Forms, Ninja Forms, WPForms, Elementor). These submit via AJAX, so GTM's NATIVE Form Submission trigger never fires: you need a Custom HTML LISTENER that dataLayer.pushes a Custom Event, then a GA4 tag on that event. Returns a `guide`, a `listenerTag` (Custom HTML on All Pages with the exact script) and a `ga4Tag`; pass each to create_gtm_tracking_tag, listener FIRST. Use whenever suggest_tags_from_url or the user names one of these plugins.",
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['contactform7', 'gravityforms', 'ninjaforms', 'wpforms', 'elementor'] },
          eventName: { type: 'string', description: 'GA4 event name to send (default form_submission).' },
          measurementId: { type: 'string', description: 'GA4 Measurement ID G-XXXX (or a {{variable}}) for the GA4 tag.' },
        },
        required: ['provider'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const recipe = formTrackingRecipe(s(a.provider), {
          eventName: a.eventName != null ? s(a.eventName) : undefined,
          measurementId: a.measurementId != null ? s(a.measurementId) : undefined,
        });
        if (!recipe) throw new Error(`No AJAX form recipe for "${s(a.provider)}". Supported: ${AJAX_FORM_PROVIDERS_LIST.join(', ')}.`);
        return recipe;
      },
    },
    {
      name: 'list_gtm_triggers',
      description: 'List the triggers in a GTM workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmTriggers(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'list_unused_gtm_triggers',
      description:
        'List the UNUSED (orphaned) triggers in a GTM workspace: referenced by NO tag (firing or blocking) and not in a Trigger Group, so safe-to-delete clutter. Read-only; use it to show exactly what delete_unused_gtm_triggers would remove (triggerId, name, type).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const snap = await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId));
        return findUnusedTriggers(snap).map((t) => ({ triggerId: t.triggerId, name: t.name, type: t.type }));
      },
    },
    {
      name: 'list_unused_gtm_variables',
      description:
        'List the UNUSED (orphaned) variables in a GTM workspace: {{name}} referenced by NO tag, trigger or other variable in the fields this audit can read. Read-only; use it to show what delete_unused_gtm_variables would remove (variableId, name, type). ADVISORY, not proof: a variable referenced only in a published version, or in a field the audit cannot inspect, can appear here even though it IS used.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const snap = await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId));
        return findUnusedVariables(snap).map((v) => ({ variableId: v.variableId, name: v.name, type: v.type }));
      },
    },
    {
      name: 'list_gtm_variables',
      description: 'List the user-defined variables in a GTM workspace (name + type). Use it to check whether a variable already exists before creating one.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmVariables(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'list_gtm_clients',
      description: 'List the CLIENTS in a SERVER container workspace, e.g. the GA4 client "gaaw_client" that claims incoming requests.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmClients(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'list_gtm_templates',
      description:
        'List the CUSTOM (community-gallery) templates imported into a workspace with each one\'s tag TYPE code (cvt_<galleryTemplateId>, e.g. cvt_5RM3Q), which is the value to put in a tag\'s `type`, plus the gallery owner/repository. Use to find an imported template before creating tags from it.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmTemplates(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'list_gtm_transformations',
      description: 'List the TRANSFORMATIONS in a SERVER container workspace; they enrich or redact event data before tags run.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmTransformations(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'audit_server_container',
      description:
        'Audit a SERVER container workspace. Checks that a client claims incoming requests; that server tags carry their destination id, have a firing trigger and are not paused; and that a tagging server URL is set. Flags duplicate GA4 relays (double-counting), URL-encoded trigger filter values (e.g. "Sign+Petition+Click") that never match a decoded event name, Meta CAPI tags with a swapped Pixel ID / Access Token, and Meta CAPI tags left with a Test Event Code. Same findings shape as audit_gtm_container.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) =>
        auditServerWorkspace(data, { accountId: s(a.accountId), containerId: s(a.containerId), workspaceId: s(a.workspaceId) }),
    },
    {
      name: 'verify_server_endpoint',
      description:
        'Runtime check for a server-side GTM tagging server: GET <serverUrl>/healthy to confirm the host is deployed and reachable. https-only, public hosts only. Use after deploying a tagging server, or when an audit flags a missing tagging server URL.',
      inputSchema: {
        type: 'object',
        properties: { serverUrl: { type: 'string' } },
        required: ['serverUrl'],
        additionalProperties: false,
      },
      handler: (a) => data.verifyServerEndpoint(s(a.serverUrl)),
    },
    {
      name: 'verify_tracking_setup',
      description:
        'READ-ONLY post-install QA on the WEB container: verify a tracking setup against the funnel checklist, pass/warn/fail per check. Web: Google tag present, per-event GA4 tag coverage (exists, not paused, has a trigger, forwards the ecommerce object), consent defaults on Consent Initialization, web-to-server link. Per-event contract checks: TAXONOMY (reserved google_/ga_/firebase_ or malformed names GA4 rejects) and SCHEMA (required GA4 params per recommended event; for a tag forwarding the whole ecommerce object it names the params the site must push, since that is a runtime check). Given the server ids it also checks the GA4 client, the recorded tagging server URL, per-event relay coverage (a base all-events relay counts) and a LIVE /healthy probe. Run after the setup_ tools, and before telling the user tracking is complete.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string', description: 'The WEB container id.' },
          workspaceId: { type: 'string' },
          events: { type: 'array', items: { type: 'string' }, description: 'Events to check. Omit for the standard ecommerce funnel.' },
          serverAccountId: { type: 'string', description: 'Set all three server ids to cover the SERVER container too.' },
          serverContainerId: { type: 'string' },
          serverWorkspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) => {
        const events = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : undefined;
        const server =
          s(a.serverAccountId).trim() && s(a.serverContainerId).trim() && s(a.serverWorkspaceId).trim()
            ? { accountId: s(a.serverAccountId).trim(), containerId: s(a.serverContainerId).trim(), workspaceId: s(a.serverWorkspaceId).trim() }
            : undefined;
        return data.verifyTrackingSetup(s(a.accountId), s(a.containerId), s(a.workspaceId), { events, server });
      },
    },
    {
      name: 'runtime_synthetic_test',
      description:
        'RUNTIME synthetic test (READ-ONLY, SAFE): load a live URL in headless Chromium, push SYNTHETIC dataLayer funnel events with obviously-fake values, and capture the analytics /collect hits each tag would send, proving per-event that GA4 (and Meta/TikTok/your server) fire at RUNTIME with the right params. ' +
        'SAFETY: during the synthetic-firing window EVERY analytics beacon is ABORTED before it leaves the browser, both known collectors and same-site FIRST-PARTY collector proxies (Stape, Cloudflare Zaraz, a self-hosted sGTM on a custom path), so no fake purchase or conversion ever reaches a destination or the tagging server. A normal page_view may still fire on navigation, as on any real visit. ' +
        'Needs a LOCAL Playwright install (`npm i playwright && npx playwright install chromium` in apps/desktop); without it the tool returns a clear error instead of running. Returns, per expected event, whether a GA4 hit fired, any missing required params, and which destinations fired.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Live page URL to load; the GTM container must be installed on it.' },
          events: { type: 'array', items: { type: 'string' }, description: 'Events to fire and verify. Omit for the standard funnel.' },
          serverUrl: { type: 'string', description: 'First-party tagging server URL; its host is aborted as a collector too.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const events = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
        const serverUrl = s(a.serverUrl).trim() || undefined;
        let run: Awaited<ReturnType<typeof runSyntheticTest>>;
        try {
          run = await runSyntheticTest(s(a.url), { events, serverUrl });
        } catch (e) {
          // Playwright not installed (or another launch-time failure) → clean JSON, never throw.
          const msg = e instanceof Error ? e.message : String(e);
          return {
            error: /Playwright is not installed/i.test(msg)
              ? 'Playwright not installed. Run `npm i playwright && npx playwright install chromium` in apps/desktop to use the runtime synthetic test.'
              : msg,
            safety: 'No hits were sent. All analytics collector requests are aborted before delivery.',
          };
        }
        const report = evaluateRuntimeCapture(run.capturedHits, events);
        return {
          url: s(a.url),
          pagesOk: run.pagesOk,
          ...(run.error ? { error: run.error } : {}),
          report,
          capturedHitCount: run.capturedHits.length,
          collectorsAborted: run.capturedHits.map((h) => ({ collector: h.collector, url: h.url })),
          safety:
            'SAFE: fired SYNTHETIC events only and ABORTED every analytics beacon they triggered before it left the browser — including same-site first-party collector proxies — so NO synthetic conversion was delivered to GA4/Meta/TikTok/Ads or your tagging server.',
        };
      },
    },
    {
      name: 'audit_gtm_container',
      description:
        'Audit a GTM workspace and return ACTIONABLE findings: counts, a severity summary, and findings carrying severity, category, the affected resource, a recommendation, and for auto-fixable issues a ready-to-run `fix` { tool, args } with the ids already filled in. ' +
        'Checks: tags with no firing trigger, paused tags, GA4 event tags missing a measurement ID or event name, inconsistent GA4 measurement IDs, Custom HTML (security + document.write), missing Consent Mode v2 settings on ad/analytics tags, unused triggers, unused variables, duplicate names.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: (a) =>
        auditWorkspace(data, {
          accountId: s(a.accountId),
          containerId: s(a.containerId),
          workspaceId: s(a.workspaceId),
        }),
    },
    {
      name: 'audit_gtm_container_changes',
      description:
        'Re-audit the workspace AND report what CHANGED since its last audit: NEW issues (regressions), RESOLVED issues, plus the full current report. Records this run so the next call can diff against it. New findings carry the same ready-to-run fixes. Use when the user asks "what changed" or "any regressions".',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        if (!history) {
          return { error: 'Monitoring history is unavailable in this context — use audit_gtm_container instead.' };
        }
        return auditChanges(
          data,
          history,
          { accountId: s(a.accountId), containerId: s(a.containerId), workspaceId: s(a.workspaceId) },
          Date.now()
        );
      },
    },
    {
      name: 'diff_gtm_workspace_vs_live',
      description:
        'Show CONFIG DRIFT between the draft workspace and the PUBLISHED (live) container version: which tags/triggers/variables the draft adds, removes or modifies, i.e. what publishing it would change.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        const [live, workspace] = await Promise.all([
          data.getGtmLiveVersionSnapshot(accountId, containerId),
          data.getGtmContainerSnapshot(accountId, containerId, workspaceId),
        ]);
        if (!live) {
          return {
            publishedVersion: null,
            note: 'No published version yet — everything in this workspace is pending its first publish.',
            workspaceCounts: {
              tags: workspace.tags.length,
              triggers: workspace.triggers.length,
              variables: workspace.variables.length,
            },
          };
        }
        // base = live, target = workspace → added/removed/modified are framed as
        // "what a publish of this workspace would change in the live container".
        return { publishedVersion: 'live', drift: diffSnapshots(live, workspace) };
      },
    },
    {
      name: 'audit_install_drift',
      description:
        'Report DRIFT against the install manifest, the record of resources our setup tools (e.g. setup_ecommerce_funnel) created here. Compares each managed tag/trigger/variable to the LIVE container: INTACT, MODIFIED (renamed or reconfigured since setup), DELETED; and lists UNMANAGED resources added outside our setup. Read-only. Returns hasManifest:false when no setup has been recorded yet.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        if (!manifests) {
          return { hasManifest: false, note: 'Install-manifest tracking is unavailable in this context.' };
        }
        const manifest = manifests.get(ManifestStore.key(accountId, containerId, workspaceId));
        if (!manifest) {
          return {
            hasManifest: false,
            note: 'No install manifest for this workspace yet — run a setup tool (e.g. setup_ecommerce_funnel) first, then re-run this to detect drift.',
          };
        }
        const snap = await data.getGtmContainerSnapshot(accountId, containerId, workspaceId);
        const report = diffManifest(manifest, snap);
        return {
          hasManifest: true,
          updatedAt: manifest.updatedAt,
          summary: report.summary,
          managed: report.managed,
          unmanaged: report.unmanaged,
        };
      },
    },
    {
      name: 'audit_tracking_status',
      description:
        'UNIFIED tracking status for the WEB container: ONE card of six DIMENSIONS (setup, consent, schema, dedup, runtime, manifest), each with a verdict (pass / partial / fail / not_run) plus its worst issues, and an overall roll-up. It does NOT re-audit; it AGGREGATES verify_tracking_setup, the SERVER container audit and install-drift, answering "is my tracking healthy?" at a glance. Each sub-audit is best-effort: one that errors reports not_run rather than failing the call. Set the three server ids to cover the server side too.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string', description: 'The WEB container id.' },
          workspaceId: { type: 'string' },
          events: { type: 'array', items: { type: 'string' }, description: 'Events to check. Omit for the standard ecommerce funnel.' },
          serverAccountId: { type: 'string', description: 'Set all three server ids to cover the SERVER container too.' },
          serverContainerId: { type: 'string' },
          serverWorkspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        const events = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : undefined;
        const server =
          s(a.serverAccountId).trim() && s(a.serverContainerId).trim() && s(a.serverWorkspaceId).trim()
            ? { accountId: s(a.serverAccountId).trim(), containerId: s(a.serverContainerId).trim(), workspaceId: s(a.serverWorkspaceId).trim() }
            : undefined;

        // Each sub-audit is best-effort: a failure leaves that input undefined so
        // buildTrackingStatus reports the dimension not_run — never throw the whole tool.
        let setup: Awaited<ReturnType<GoogleDataService['verifyTrackingSetup']>> | undefined;
        try {
          setup = await data.verifyTrackingSetup(accountId, containerId, workspaceId, { events, server });
        } catch {
          setup = undefined;
        }

        let serverFindings: Awaited<ReturnType<typeof auditServerWorkspace>>['findings'] | undefined;
        if (server) {
          try {
            const report = await auditServerWorkspace(data, {
              accountId: server.accountId,
              containerId: server.containerId,
              workspaceId: server.workspaceId,
            });
            serverFindings = report.findings;
          } catch {
            serverFindings = undefined;
          }
        }

        let drift: { summary: { intact: number; modified: number; deleted: number; unmanaged: number } } | null = null;
        if (manifests) {
          const manifest = manifests.get(ManifestStore.key(accountId, containerId, workspaceId));
          if (manifest) {
            try {
              const snap = await data.getGtmContainerSnapshot(accountId, containerId, workspaceId);
              drift = { summary: diffManifest(manifest, snap).summary };
            } catch {
              drift = null;
            }
          }
        }

        return buildTrackingStatus({
          setup: setup ? { checks: setup.checks } : null,
          serverFindings,
          drift,
          // Only "audited a server container" when the server audit actually SUCCEEDED —
          // serverFindings is set only inside `if (server)` and only on success. If server ids were
          // given but the audit threw, this stays false so dedup reports not_run (unknown), never a
          // false 'pass'.
          hasServerContainer: serverFindings !== undefined,
        });
      },
    },
    {
      name: 'list_gtm_versions',
      description:
        'List the container\'s published version history (newest first): version id, name, and tag/trigger/variable counts. Use to find versions to diff.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' } },
        required: ['accountId', 'containerId'],
        additionalProperties: false,
      },
      handler: (a) => data.listGtmVersions(s(a.accountId), s(a.containerId)),
    },
    {
      name: 'diff_gtm_versions',
      description:
        'Diff two PUBLISHED container versions: tags/triggers/variables added, removed or modified between version A (base) and version B. Answers "what changed between version N and M" or "when did this break". versionA and versionB are ids from list_gtm_versions.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          versionA: { type: 'string', description: 'Base version id (the older one).' },
          versionB: { type: 'string', description: 'Target version id (the newer one).' },
        },
        required: ['accountId', 'containerId', 'versionA', 'versionB'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const [base, target] = await Promise.all([
          data.getGtmVersionSnapshot(accountId, containerId, s(a.versionA)),
          data.getGtmVersionSnapshot(accountId, containerId, s(a.versionB)),
        ]);
        return { versionA: s(a.versionA), versionB: s(a.versionB), drift: diffSnapshots(base, target) };
      },
    },
    {
      name: 'check_gtm_measurement_ids',
      description:
        'Cross-check the GA4 measurement ids configured in this GTM container against the GA4 properties the signed-in user can access: flags ids matching NO accessible GA4 web stream (a typo, a wrong id, or a property on another login) and resolves matched ids to their property. Optional ga4Account ("accounts/123") bounds the scan.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          ga4Account: { type: 'string', description: 'Optional GA4 account (accounts/123) to bound the scan.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const snapshot = await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId));
        const configured = extractConfiguredGa4Ids(snapshot);
        const accessible = await data.listGa4MeasurementIds(a.ga4Account != null && s(a.ga4Account) ? s(a.ga4Account) : undefined);
        return crossCheckMeasurementIds(
          configured,
          accessible.map((x) => ({ measurementId: x.measurementId, property: x.property, propertyDisplayName: x.propertyDisplayName }))
        );
      },
    },
    {
      name: 'detect_meta_web_tags',
      description:
        'Scan a WEB container for Meta/Facebook pixel tags (Custom HTML with fbq, or a tag named/typed for Facebook/Meta) and report the standard ecommerce events they reference. Use to decide whether Meta ecommerce tracking is in use before setting up Meta CAPI server-side. Returns matching tags plus hasMetaPixel / hasEcommerce.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => detectMetaTags(await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId))),
    },
    {
      name: 'list_ga4_accounts',
      description: 'List the Google Analytics 4 account summaries the signed-in user can access.',
      inputSchema: { ...EMPTY_SCHEMA },
      handler: () => data.listGa4Accounts(),
    },
    {
      name: 'list_ga4_properties',
      description: 'List GA4 properties under an account. Requires account like "accounts/123456".',
      inputSchema: {
        type: 'object',
        properties: { account: { type: 'string' } },
        required: ['account'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4Properties(s(a.account)),
    },
    {
      name: 'list_ga4_data_streams',
      description: 'List the data streams of a GA4 property. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4DataStreams(s(a.property)),
    },
    {
      name: 'run_ga4_report',
      description:
        'Run a GA4 report. dimensions/metrics are GA4 API names (e.g. ["date"], ["activeUsers","sessions"]). Dates accept "NdaysAgo", "today", "yesterday", or YYYY-MM-DD. If unsure a dimension/metric combination is valid, call check_ga4_compatibility FIRST instead of guessing.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          dimensions: { type: 'array', items: { type: 'string' } },
          metrics: { type: 'array', items: { type: 'string' } },
        },
        required: ['property', 'startDate', 'endDate', 'metrics'],
        additionalProperties: false,
      },
      handler: (a) =>
        data.runGa4Report({
          property: s(a.property),
          startDate: s(a.startDate) || '28daysAgo',
          endDate: s(a.endDate) || 'today',
          dimensions: Array.isArray(a.dimensions) ? a.dimensions.map(String) : [],
          metrics: Array.isArray(a.metrics) ? a.metrics.map(String) : [],
        }),
    },
    {
      name: 'check_ga4_compatibility',
      description:
        'Check which of the given GA4 dimensions/metrics can be combined in ONE report on this property (the Data API rejects incompatible pairs). Call this BEFORE run_ga4_report when combining unusual dimensions/metrics; drop or replace anything reported incompatible instead of retrying blind.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          dimensions: { type: 'array', items: { type: 'string' } },
          metrics: { type: 'array', items: { type: 'string' } },
        },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) =>
        data.ga4CheckCompatibility(
          s(a.property),
          Array.isArray(a.dimensions) ? a.dimensions.map(String) : [],
          Array.isArray(a.metrics) ? a.metrics.map(String) : []
        ),
    },
    {
      name: 'audit_ga4_property',
      description:
        'Audit a GA4 property configuration and return findings with a severity summary: no data streams, 2-month (default) data retention, no key events/conversions, enhanced measurement off on a web stream, custom dimensions that may capture PII, no Google Ads links, and missing industry category. GA4 is READ-ONLY — findings are advisory (recommend changes for the user to make in the GA4 UI). Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => auditGa4(await data.getGa4PropertySnapshot(s(a.property))),
    },
    {
      name: 'audit_ga4_data_quality',
      description:
        'Audit the actual GA4 reporting DATA over the last N days (default 28) and flag data-quality problems that silently corrupt analytics: a high share of "Unassigned" channel sessions, a high share of "(not set)" source/medium, or no data at all. Returns severity-tagged findings with the change to make. Complements audit_ga4_property (which checks config). Requires property like "properties/123456"; optional days.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          days: { type: 'number', description: 'Lookback window in days (default 28).' },
        },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => {
        // Coerce defensively: a non-numeric days would otherwise become
        // "NaNdaysAgo" and 400 at the Data API. Clamp to [1, 365].
        const n = Math.floor(Number(a.days));
        const days = a.days != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
        return auditGa4DataQuality(await data.getGa4DataQuality(s(a.property), days));
      },
    },
    {
      name: 'rank_ga4_campaigns',
      description:
        "Rank a GA4 property's marketing campaigns by conversions and revenue over a window — answers 'which campaign performed best' and flags untagged-campaign traffic. Read-only (GA4 Data API). Requires property like \"properties/123456\"; optional days (default 28).",
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          days: { type: 'number', description: 'Lookback window in days (default 28).' },
        },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => {
        // Coerce defensively (mirrors audit_ga4_data_quality): non-numeric → 28, clamp to [1, 365].
        const n = Math.floor(Number(a.days));
        const days = a.days != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
        return rankGa4Campaigns(await data.getGa4CampaignPerformance(s(a.property), days));
      },
    },
    {
      name: 'monitor_ga4_property',
      description:
        'Run a live HEALTH MONITOR on a GA4 property and return an alert list: is data still being received (realtime active users + last complete day), did a key event stop firing, a sudden traffic spike or drop, conversions not moving with traffic, attribution decay ("Unassigned"/"(not set)"), or duplicate/unlabelled ecommerce transactions. Read-only. Each alert has a stable id, severity, and a fix; overall health is healthy/warning/critical. Use this to catch live data issues (the desktop app can also run it on a schedule and Slack new issues). Requires property like "properties/123456"; optional days (trend window, default 28, max 365).',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          days: { type: 'number', description: 'Lookback window in days for trend/regression detection (default 28, max 365).' },
          minSeverity: { type: 'string', enum: ['critical', 'high', 'medium'], description: 'Only return alerts at this severity and worse (default medium).' },
        },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const n = Math.floor(Number(a.days));
        const days = a.days != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
        const minSeverity = a.minSeverity === 'critical' || a.minSeverity === 'high' ? a.minSeverity : 'medium';
        const input = await gatherGa4MonitorInput(data, s(a.property), days);
        return monitorGa4(input, { minSeverity });
      },
    },
    {
      name: 'list_ga4_key_events',
      description:
        'List the key events (conversions) configured on a GA4 property — by event NAME, with counting method and whether it is a custom event. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4KeyEvents(s(a.property)),
    },
    {
      name: 'list_ga4_audiences',
      description:
        'List the audiences (remarketing / segmentation) configured on a GA4 property — by display name, with description, membership window in days, whether ads personalization is enabled, and the number of filter clauses. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4Audiences(s(a.property)),
    },
    {
      name: 'get_ga4_attribution_settings',
      description:
        'Get a GA4 property\'s attribution settings: the reporting attribution model and the acquisition/other conversion lookback windows, plus the Ads web conversion export scope. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.getGa4AttributionSettings(s(a.property)),
    },
    {
      name: 'get_ga4_google_signals',
      description:
        'Get a GA4 property\'s Google Signals state (enabled/disabled) and consent setting — controls cross-device reporting, demographics, and remarketing from signed-in Google users. Read-only. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.getGa4GoogleSignals(s(a.property)),
    },
    {
      name: 'list_ga4_measurement_protocol_secrets',
      description:
        'List Measurement Protocol secrets on a GA4 property, grouped by data stream — by DISPLAY NAME only (the secret value is never returned). Use to see which server-side / MP integrations exist. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4MeasurementProtocolSecrets(s(a.property)),
    },
    {
      name: 'list_ga4_bigquery_links',
      description:
        'List a GA4 property\'s BigQuery export links: the linked Google Cloud project and whether daily and/or streaming export is enabled. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4BigQueryLinks(s(a.property)),
    },
    {
      name: 'list_ga4_firebase_links',
      description:
        'List a GA4 property\'s Firebase project links. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4FirebaseLinks(s(a.property)),
    },
    {
      name: 'generate_ga4_report',
      description:
        'Generate a shareable, client-ready Markdown health report for a GA4 property: an overall score + grade combining the property CONFIG audit and the DATA-quality audit (last N days, default 28), with per-section grades and full findings tables. Present the returned Markdown verbatim. Requires property like "properties/123456"; optional days.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          days: { type: 'number', description: 'Data-quality lookback window in days (default 28).' },
        },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const n = Math.floor(Number(a.days));
        const days = a.days != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
        const property = s(a.property);
        const [snap, dq] = await Promise.all([
          data.getGa4PropertySnapshot(property),
          data.getGa4DataQuality(property, days),
        ]);
        const ga4 = auditGa4(snap);
        const dqResult = auditGa4DataQuality(dq);
        const sections: ScorecardSection[] = [
          {
            key: 'ga4',
            label: 'GA4 property',
            findings: ga4.findings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              recommendation: f.recommendation,
            })),
          },
          {
            key: 'data_quality',
            label: dqResult.dateRange ? `GA4 data quality (${dqResult.dateRange})` : 'GA4 data quality',
            findings: dqResult.findings,
          },
        ];
        return { report: buildReport(sections, { title: 'GA4 Health Report', generatedAt: new Date().toISOString() }) };
      },
    },
    {
      name: 'list_ga4_custom_dimensions',
      description:
        'List a GA4 property\'s custom dimensions: parameter name, display name, scope (EVENT/USER/ITEM), and description. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4CustomDimensions(s(a.property)),
    },
    {
      name: 'list_ga4_custom_metrics',
      description:
        'List a GA4 property\'s custom metrics: parameter name, display name, measurement unit, scope, and description. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4CustomMetrics(s(a.property)),
    },
    {
      name: 'list_ga4_google_ads_links',
      description:
        'List the Google Ads accounts linked to a GA4 property (customerId, ads-personalization flag). Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.listGa4GoogleAdsLinks(s(a.property)),
    },
    {
      name: 'get_ga4_property_details',
      description:
        'Get a GA4 property\'s details: display name, time zone, currency, industry category, service level, parent account, create time. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.getGa4PropertyDetails(s(a.property)),
    },
    {
      name: 'get_ga4_data_retention',
      description:
        'Get a GA4 property\'s data-retention settings: event data retention (e.g. TWO_MONTHS / FOURTEEN_MONTHS) and whether user data resets on new activity. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (a) => data.getGa4DataRetention(s(a.property)),
    },
    {
      name: 'get_ga4_enhanced_measurement',
      description:
        'Get the enhanced-measurement settings of ONE GA4 WEB data stream (page views, scrolls, outbound clicks, site search, video, file downloads, etc.). Requires dataStream — the full stream resource name like "properties/123/dataStreams/456" (from list_ga4_data_streams).',
      inputSchema: {
        type: 'object',
        properties: { dataStream: { type: 'string' } },
        required: ['dataStream'],
        additionalProperties: false,
      },
      handler: (a) => data.getGa4EnhancedMeasurement(s(a.dataStream)),
    },
    {
      name: 'run_ga4_realtime_report',
      description:
        'Run a GA4 REAL-TIME report (events in the last 30 minutes). dimensions/metrics are GA4 realtime API names (e.g. dimensions ["unifiedScreenName","country"], metrics ["activeUsers"]). Requires property like "properties/123456" and metrics.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          dimensions: { type: 'array', items: { type: 'string' } },
          metrics: { type: 'array', items: { type: 'string' } },
        },
        required: ['property', 'metrics'],
        additionalProperties: false,
      },
      handler: (a) =>
        data.runGa4RealtimeReport({
          property: s(a.property),
          dimensions: Array.isArray(a.dimensions) ? a.dimensions.map(String) : [],
          metrics: Array.isArray(a.metrics) ? a.metrics.map(String) : [],
        }),
    },
    {
      name: 'score_ga4_property',
      description:
        'Produce a GA4 property health SCORECARD: an overall 0–100 score + letter grade (A–F) and a severity-ranked top-issues list, from the GA4 property audit. The GA4-mode counterpart to analytics_scorecard. Requires property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const ga4 = auditGa4(await data.getGa4PropertySnapshot(s(a.property)));
        return buildScorecard([
          {
            key: 'ga4',
            label: 'GA4 property',
            findings: ga4.findings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              recommendation: f.recommendation,
            })),
          },
        ]);
      },
    },
    {
      name: 'analytics_scorecard',
      description:
        'Unified analytics health SCORECARD: a 0-100 score and letter grade with a per-section breakdown and ranked top issues, combining the GTM container audit and, when ga4Property ("properties/123456") is given, the GA4 property audit.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          ga4Property: { type: 'string', description: 'GA4 property ("properties/123") to include in the score.' },
          consentReport: { type: 'object', description: 'Parsed consent_compliance_audit report, adds a Consent Mode v2 section.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const sections: ScorecardSection[] = [];
        const gtm = await auditWorkspace(data, {
          accountId: s(a.accountId),
          containerId: s(a.containerId),
          workspaceId: s(a.workspaceId),
        });
        sections.push({
          key: 'gtm',
          label: 'GTM container',
          findings: gtm.findings.map((f) => ({
            severity: f.severity,
            category: f.category,
            message: f.message,
            recommendation: f.recommendation,
            confidence: f.confidence,
          })),
        });
        if (a.ga4Property != null && s(a.ga4Property)) {
          const ga4 = auditGa4(await data.getGa4PropertySnapshot(s(a.ga4Property)));
          sections.push({
            key: 'ga4',
            label: 'GA4 property',
            findings: ga4.findings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              recommendation: f.recommendation,
            })),
          });
        }
        if (a.consentReport != null) {
          const consent = consentReportToSection(a.consentReport);
          if (consent) sections.push(consent);
        }
        return buildScorecard(sections);
      },
    },
    {
      name: 'generate_analytics_report',
      description:
        'Generate a shareable, client-ready analytics health REPORT in Markdown: 0-100 score and grade, a per-section summary table, a ranked top-issues table and full findings tables, from the GTM container audit and, when ga4Property is given, the GA4 property audit. Returns { report }; present it to the user verbatim.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          ga4Property: { type: 'string', description: 'GA4 property to include in the report.' },
          consentReport: { type: 'object', description: 'Parsed consent_compliance_audit report, adds a Consent Mode v2 section.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const sections: ScorecardSection[] = [];
        const gtm = await auditWorkspace(data, {
          accountId: s(a.accountId),
          containerId: s(a.containerId),
          workspaceId: s(a.workspaceId),
        });
        sections.push({
          key: 'gtm',
          label: 'GTM container',
          findings: gtm.findings.map((f) => ({
            severity: f.severity,
            category: f.category,
            message: f.message,
            recommendation: f.recommendation,
            confidence: f.confidence,
          })),
        });
        if (a.ga4Property != null && s(a.ga4Property)) {
          const ga4 = auditGa4(await data.getGa4PropertySnapshot(s(a.ga4Property)));
          sections.push({
            key: 'ga4',
            label: 'GA4 property',
            findings: ga4.findings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              recommendation: f.recommendation,
            })),
          });
        }
        if (a.consentReport != null) {
          const consent = consentReportToSection(a.consentReport);
          if (consent) sections.push(consent);
        }
        return {
          report: buildReport(sections, {
            generatedAt: new Date().toISOString(),
            boundary: gtm.boundary,
            runtimeRequired: gtm.runtimeRequired,
          }),
        };
      },
    },
  ];

  const writeTools: Tool[] = [
    {
      name: 'create_gtm_tracking_tag',
      description:
        'PREFERRED way to create a tag that fires on an event: builds a CORRECT GTM resource from simple fields (no raw GTM JSON). One call enables needed built-in variables, reuses or creates the named trigger, and creates the tag linked to it, in the draft workspace. ' +
        'Fields per platform: ga4_event (measurementId, eventName, optional eventParameters [{name,value}]); google_tag (tagId G-/AW-/GT-XXXX, optional configSettings); meta_pixel (pixelId, or measurementId as the pixel id, plus eventName = the Meta event e.g. PageView/Lead/AddToCart/Purchase/ViewContent; eventParameters become Meta Object Properties); tiktok_pixel (pixelId + eventName Pageview/ViewContent/AddToCart/CompletePayment); linkedin_insight (pixelId = LinkedIn Partner ID); reddit_pixel (pixelId + eventName PageVisit/ViewContent/AddToCart/Purchase/Lead/SignUp/Search; empty or PageVisit emits the full init snippet); pinterest_tag (pixelId + eventName pagevisit/viewcontent/addtocart/checkout/lead); google_ads_conversion (conversionId, conversionLabel); custom_html (html); conversion_linker (none; optional enableCrossDomain + comma-separated linkerDomains); google_ads_call_conversion (phoneNumber exactly as shown on the page, conversionId, conversionLabel); google_ads_remarketing (conversionId); floodlight (advertiserId, groupTag, activityTag; optional countingMethod); custom_image (url). Templated platforms are imported automatically. ' +
        'trigger.kind: link_click / all_clicks (optional clickUrlValue, clickTextValue, each with a *Operator equals|contains|startsWith|matchRegex); custom_event (eventName = the dataLayer event; ANDed scope via formIdValue, pagePathValue/pagePathOperator, pageUrlValue, or dataLayerConditions [{key,value,operator}], which scopes by a pushed dataLayer key through an auto-created {{dlv - <key>}} variable: the only way to scope an AJAX/embed form to ONE form, since {{Form ID}} does NOT work on a pushed event); pageview; timer (REQUIRES trigger.intervalMs in ms, optional trigger.limit); form_submit (formIdValue/formClassesValue with a *Operator scope to ONE form, or pagePathValue/pagePathOperator when the form has no id/class; omit all and it fires on every form submit). ' +
        'eventParameters values may be built-in variables ({{Click URL}}, {{Click Text}}, {{Form ID}}, {{Form URL}}), which are auto-enabled. ' +
        'WHERE THE ADS VALUES COME FROM: for google_ads_conversion, google_ads_call_conversion and google_ads_remarketing, call list_google_ads_conversion_actions first and take conversionId + conversionLabel straight off the chosen action rather than asking the user to paste them. Both MUST be LITERAL values (e.g. "AW-17667466396" and "g9RqCLD6kdQcEJzJwOhB"), NEVER a {{variable}} or a placeholder: a braced value is passed to the awct template verbatim, so it keeps the "AW-" prefix the template rejects and you get a tag that looks created but records nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          platform: { type: 'string', enum: ['ga4_event', 'google_tag', 'meta_pixel', 'tiktok_pixel', 'linkedin_insight', 'reddit_pixel', 'pinterest_tag', 'google_ads_conversion', 'custom_html', 'conversion_linker', 'google_ads_call_conversion', 'google_ads_remarketing', 'floodlight', 'custom_image'] },
          tagName: { type: 'string' },
          measurementId: { type: 'string' },
          pixelId: { type: 'string' },
          eventName: { type: 'string' },
          eventParameters: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } },
          },
          eventParamLookups: {
            type: 'array',
            description: 'Lookup Table variables an event parameter references by {{variableName}} (e.g. form_name = {{Lookup - X Form Name}} keyed on {{Page Path}}). Auto-created (type smm) when missing.',
            items: {
              type: 'object',
              properties: {
                variableName: { type: 'string' },
                input: { type: 'string' },
                rows: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
                defaultValue: { type: 'string' },
              },
              required: ['variableName', 'input', 'rows'],
            },
          },
          tagId: { type: 'string' },
          configSettings: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } },
          },
          conversionId: { type: 'string' },
          conversionLabel: { type: 'string' },
          html: { type: 'string' },
          advertiserId: { type: 'string' },
          groupTag: { type: 'string' },
          activityTag: { type: 'string' },
          countingMethod: { type: 'string', enum: ['standard', 'unique'] },
          phoneNumber: { type: 'string' },
          enableConversionLinker: { type: 'boolean' },
          enableCrossDomain: { type: 'boolean' },
          linkerDomains: { type: 'string' },
          url: { type: 'string' },
          useCacheBuster: { type: 'boolean' },
          cacheBusterQueryParam: { type: 'string' },
          trigger: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['link_click', 'all_clicks', 'custom_event', 'pageview', 'form_submit', 'youtube_video', 'timer'] },
              clickUrlValue: { type: 'string' },
              clickUrlOperator: { type: 'string' },
              clickUrlIgnoreCase: { type: 'boolean' },
              clickTextValue: { type: 'string' },
              clickTextOperator: { type: 'string' },
              clickTextIgnoreCase: { type: 'boolean' },
              clickElementValue: { type: 'string' },
              clickElementOperator: { type: 'string' },
              lookupTable: {
                type: 'object',
                properties: { name: { type: 'string' }, texts: { type: 'array', items: { type: 'string' } } },
                required: ['name', 'texts'],
              },
              formIdValue: { type: 'string' },
              formIdOperator: { type: 'string' },
              formClassesValue: { type: 'string' },
              formClassesOperator: { type: 'string' },
              pagePathValue: { type: 'string' },
              pagePathOperator: { type: 'string' },
              pageUrlValue: { type: 'string' },
              pageUrlOperator: { type: 'string' },
              eventName: { type: 'string' },
              dataLayerConditions: {
                type: 'array',
                description: 'custom_event only: ANDed scope conditions on a pushed dataLayer key, each read via an auto-created {{dlv - <key>}} variable. Scopes an AJAX/embed form to ONE form by its pushed form_id ({{Form ID}} does NOT resolve on a pushed event).',
                items: {
                  type: 'object',
                  properties: { key: { type: 'string' }, value: { type: 'string' }, operator: { type: 'string' } },
                  required: ['key', 'value'],
                },
              },
              intervalMs: { type: 'string', description: 'timer only, REQUIRED: firing interval in ms (e.g. "30000").' },
              limit: { type: 'string', description: 'timer only: max fires (omit = unlimited).' },
            },
            required: ['name', 'kind'],
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'platform', 'tagName', 'trigger'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create ${s(a.platform)} tag "${s(a.tagName)}" firing on "${s(obj(a.trigger).name)}" trigger`,
      precheck: (a) => findExistingByName(data, a, s(a.tagName), 'tag'),
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        const platform = s(a.platform);

        let tag;
        // Set by the meta_pixel branch when the tag's Object Properties reference {{dlv - ecommerce.*}} —
        // triggers best-effort provisioning of those ecommerce dataLayer variables below.
        let needsEcommerceDlv = false;
        if (platform === 'ga4_event') {
          tag = buildGa4EventTag({
            name: s(a.tagName),
            measurementId: s(a.measurementId),
            eventName: s(a.eventName),
            eventParameters: Array.isArray(a.eventParameters)
              ? a.eventParameters.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) }))
              : [],
          });
        } else if (platform === 'google_tag') {
          tag = buildGoogleTag({
            name: s(a.tagName),
            tagId: s(a.tagId),
            configSettings: Array.isArray(a.configSettings)
              ? a.configSettings.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) }))
              : [],
          });
        } else if (platform === 'google_ads_conversion') {
          tag = buildGoogleAdsConversionTag({ name: s(a.tagName), conversionId: s(a.conversionId), conversionLabel: s(a.conversionLabel) });
        } else if (platform === 'custom_html') {
          tag = buildCustomHtmlTag({ name: s(a.tagName), html: s(a.html) });
        } else if (platform === 'conversion_linker') {
          tag = buildConversionLinkerTag({ name: s(a.tagName), enableCrossDomain: bln(a.enableCrossDomain), linkerDomains: a.linkerDomains != null ? s(a.linkerDomains) : undefined });
        } else if (platform === 'google_ads_call_conversion') {
          tag = buildGoogleAdsCallConversionTag({ name: s(a.tagName), phoneNumber: s(a.phoneNumber), conversionId: s(a.conversionId), conversionLabel: s(a.conversionLabel) });
        } else if (platform === 'google_ads_remarketing') {
          tag = buildGoogleAdsRemarketingTag({ name: s(a.tagName), conversionId: s(a.conversionId), enableConversionLinker: bln(a.enableConversionLinker) });
        } else if (platform === 'floodlight') {
          const cm = s(a.countingMethod);
          tag = buildFloodlightCounterTag({
            name: s(a.tagName),
            advertiserId: s(a.advertiserId),
            groupTag: s(a.groupTag),
            activityTag: s(a.activityTag),
            countingMethod: cm === 'unique' ? 'unique' : cm === 'standard' ? 'standard' : undefined,
            enableConversionLinker: bln(a.enableConversionLinker),
          });
        } else if (platform === 'custom_image') {
          tag = buildCustomImageTag({ name: s(a.tagName), url: s(a.url), useCacheBuster: bln(a.useCacheBuster), cacheBusterQueryParam: a.cacheBusterQueryParam != null ? s(a.cacheBusterQueryParam) : undefined });
        } else if (platform === 'meta_pixel') {
          // Meta (Facebook) Pixel via the OFFICIAL gallery template (not Custom HTML). The pixel id is
          // pixelId (or measurementId, e.g. a {{Meta Pixel ID}} variable); eventName is the Meta event.
          const tmpl = await data.importGalleryTemplate(accountId, containerId, workspaceId, 'facebook', 'GoogleTagManager-WebTemplate-For-FacebookPixel');
          if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
            throw new Error(`Could not resolve the Meta Pixel template's tag type (got "${tmpl.type}").`);
          }
          const pixelId = s(a.pixelId).trim() || s(a.measurementId).trim();
          const event = s(a.eventName).trim() || 'PageView';
          const objProps = Array.isArray(a.eventParameters)
            ? a.eventParameters.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name)
            : [];
          // An ecommerce Meta tag's Object Properties reference the `{{dlv - ecommerce.*}}` variables —
          // flag it so the variable-provisioning block below best-effort creates those dlv variables
          // (so the tag's Object Properties resolve instead of reading nothing).
          needsEcommerceDlv = objProps.some((p) => p.value.includes('{{dlv - ecommerce.'));
          // The shared trigger logic below attaches firingTriggerId — do NOT pass it here.
          tag = buildMetaPixelTag(tmpl.type, s(a.tagName), pixelId, event, undefined, objProps);
        } else if (platform === 'pinterest_tag') {
          // Pinterest web tag via the OFFICIAL gallery template. The tag id is pixelId (or
          // measurementId, e.g. a {{Pinterest Tag ID}} variable); eventName is the Pinterest event.
          const tmpl = await data.importGalleryTemplate(accountId, containerId, workspaceId, 'pinterest', 'ws-gtm-template');
          if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
            throw new Error(`Could not resolve the Pinterest template's tag type (got "${tmpl.type}").`);
          }
          const tagId = s(a.pixelId).trim() || s(a.measurementId).trim();
          const event = s(a.eventName).trim() || 'pagevisit';
          // The shared trigger logic below attaches firingTriggerId — do NOT pass it here.
          tag = buildPinterestTag(tmpl.type, s(a.tagName), tagId, event);
        } else if (platform === 'tiktok_pixel') {
          // TikTok web Pixel via the OFFICIAL gallery template. The pixel code is pixelId (or
          // measurementId, e.g. a {{TikTok Pixel ID}} variable); eventName is the TikTok event.
          const tmpl = await data.importGalleryTemplate(accountId, containerId, workspaceId, 'tiktok', 'gtm-template-pixel');
          if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
            throw new Error(`Could not resolve the TikTok Pixel template's tag type (got "${tmpl.type}").`);
          }
          const pixelCode = s(a.pixelId).trim() || s(a.measurementId).trim();
          const event = s(a.eventName).trim() || 'Pageview';
          tag = buildTikTokPixelTag(tmpl.type, s(a.tagName), pixelCode, event);
        } else if (platform === 'linkedin_insight') {
          // LinkedIn Insight (base) tag via the OFFICIAL community gallery template. The partner id is
          // pixelId (or measurementId, e.g. a {{LinkedIn Partner ID}} variable).
          const tmpl = await data.importGalleryTemplate(accountId, containerId, workspaceId, 'linkedin', 'linkedin-gtm-community-template');
          if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
            throw new Error(`Could not resolve the LinkedIn Insight template's tag type (got "${tmpl.type}").`);
          }
          const partnerId = s(a.pixelId).trim() || s(a.measurementId).trim();
          tag = buildLinkedInInsightTag(tmpl.type, s(a.tagName), partnerId);
        } else if (platform === 'reddit_pixel') {
          // Reddit Pixel as a Custom HTML tag (there is NO gallery template). The pixel id is pixelId
          // (or measurementId, e.g. a {{Reddit Pixel ID}} variable). An empty or "PageVisit" event
          // emits the full rdt() init snippet (the base tag); any other event emits a track-only call.
          const pixelId = s(a.pixelId).trim() || s(a.measurementId).trim();
          const event = s(a.eventName).trim();
          const isBase = event === '' || event.toLowerCase() === 'pagevisit';
          tag = buildRedditPixelTag(s(a.tagName), pixelId, event, { base: isBase });
        } else {
          throw new Error(`unknown platform: ${platform}`);
        }

        const ts = obj(a.trigger);
        const triggerInput: TriggerInput = {
          name: s(ts.name),
          kind: (s(ts.kind) || 'pageview') as TriggerInput['kind'],
          clickUrlValue: ts.clickUrlValue != null ? s(ts.clickUrlValue) : undefined,
          clickUrlOperator: ts.clickUrlOperator != null ? s(ts.clickUrlOperator) : undefined,
          clickUrlIgnoreCase: bln(ts.clickUrlIgnoreCase),
          clickTextValue: ts.clickTextValue != null ? s(ts.clickTextValue) : undefined,
          clickTextOperator: ts.clickTextOperator != null ? s(ts.clickTextOperator) : undefined,
          clickTextIgnoreCase: bln(ts.clickTextIgnoreCase),
          lookupTable: (() => {
            const lt = obj(ts.lookupTable);
            const name = s(lt.name).trim();
            const texts = Array.isArray(lt.texts) ? lt.texts.map((t) => s(t)).filter(Boolean) : [];
            return name && texts.length ? { name, texts } : undefined;
          })(),
          clickElementValue: ts.clickElementValue != null ? s(ts.clickElementValue) : undefined,
          clickElementOperator: ts.clickElementOperator != null ? s(ts.clickElementOperator) : undefined,
          formIdValue: ts.formIdValue != null ? s(ts.formIdValue) : undefined,
          formIdOperator: ts.formIdOperator != null ? s(ts.formIdOperator) : undefined,
          formClassesValue: ts.formClassesValue != null ? s(ts.formClassesValue) : undefined,
          formClassesOperator: ts.formClassesOperator != null ? s(ts.formClassesOperator) : undefined,
          pagePathValue: ts.pagePathValue != null ? s(ts.pagePathValue) : undefined,
          pagePathOperator: ts.pagePathOperator != null ? s(ts.pagePathOperator) : undefined,
          pageUrlValue: ts.pageUrlValue != null ? s(ts.pageUrlValue) : undefined,
          pageUrlOperator: ts.pageUrlOperator != null ? s(ts.pageUrlOperator) : undefined,
          eventName: ts.eventName != null ? s(ts.eventName) : undefined,
          // Optional ANDed custom_event scope conditions on a pushed dataLayer key, read via an
          // auto-created {{dlv - <key>}} variable (scopes an AJAX/embed form's custom_event to ONE form
          // by the form_id its listener pushes). Coerce defensively — the model can pass any shape.
          dataLayerConditions: Array.isArray(ts.dataLayerConditions)
            ? ts.dataLayerConditions
                .map((c) => {
                  const o = obj(c);
                  return { key: s(o.key).trim(), value: s(o.value), operator: o.operator != null ? s(o.operator) : undefined };
                })
                .filter((c) => c.key !== '' && c.value !== '')
            : undefined,
          intervalMs: ts.intervalMs != null ? s(ts.intervalMs) : undefined,
          limit: ts.limit != null ? s(ts.limit) : undefined,
        };
        // A Timer with no interval NEVER fires (blank Interval in the GTM UI) — fail loudly instead of
        // silently creating a broken trigger (enums are advisory; the model can pass any kind string).
        if (triggerInput.kind === 'timer' && !s(triggerInput.intervalMs ?? '').trim()) {
          throw new Error('trigger.kind "timer" requires trigger.intervalMs (the firing interval in milliseconds, e.g. "30000").');
        }

        // Companion Lookup Table variables an event parameter references (e.g. a per-page form_name):
        // normalize now so their INPUT built-in ({{Page Path}}) is enabled and the smm var provisioned.
        const paramLookups = (Array.isArray(a.eventParamLookups) ? a.eventParamLookups : [])
          .map((l) => {
            const o = obj(l);
            const variableName = s(o.variableName).trim();
            const input = s(o.input).trim();
            const rows = Array.isArray(o.rows)
              ? o.rows.map((r) => ({ key: s(obj(r).key), value: s(obj(r).value) })).filter((r) => r.key !== '' && r.value !== '')
              : [];
            const defaultValue = o.defaultValue != null ? s(o.defaultValue) : undefined;
            return { variableName, input, rows, defaultValue };
          })
          .filter((l) => l.variableName && l.input && l.rows.length);

        // Enable EXACTLY the built-in variables this tag needs: the trigger's,
        // plus any referenced by the event/config parameter VALUES (e.g. an
        // eventSettingsTable value of "{{Click Text}}" needs the Click Text
        // built-in variable enabled, or it resolves to nothing).
        const templateVals = [
          a.eventName != null ? s(a.eventName) : undefined, // e.g. "video_{{Video Status}}" → enable Video Status
          ...(Array.isArray(a.eventParameters) ? a.eventParameters.map((p) => s(obj(p).value)) : []),
          ...(Array.isArray(a.configSettings) ? a.configSettings.map((p) => s(obj(p).value)) : []),
          ...paramLookups.map((l) => l.input), // {{Page Path}} on the lookup's input → enable that built-in
        ];
        // A param that references the shared {{Form Name}} Custom JS variable (e.g. form tags' form_name)
        // needs the Form Element built-in — the variable's code reads {{Form Element}}.
        const needsFormName = templateVals.some((v) => String(v ?? '').includes('{{Form Name}}'));
        const vars = Array.from(
          new Set([
            ...triggerBuiltInVars(triggerInput),
            ...builtInVarsForTemplates(templateVals),
            ...(needsFormName ? ['formElement'] : []),
            ...(Array.isArray(a.builtInVariables) ? a.builtInVariables.map(String) : []),
          ])
        );
        let enabledVariables: string[] = [];
        if (vars.length) {
          try {
            enabledVariables = await data.enableGtmBuiltInVariables(accountId, containerId, workspaceId, vars);
          } catch {
            enabledVariables = vars;
          }
        }

        // Auto-provision USER variables the tag references by the {{URL - <key>}} convention (e.g.
        // search_term = {{URL - search}} for site search): a URL variable reading ?<key>=. Built-in
        // enabling does not create these, so a referenced-but-missing one would resolve to nothing.
        // Create only the missing ones — never overwrite a user's existing variable of the same name.
        const urlVarNames = new Set<string>();
        for (const val of templateVals) {
          for (const m of String(val ?? '').matchAll(/\{\{(URL - [^}]+)\}\}/g)) urlVarNames.add(m[1]);
        }
        // GA4 ecommerce event tags reference {{Ecommerce X}} Data Layer variables (items/value/currency/
        // item_list_id/…) — collect the referenced ones so the block below best-effort creates each as a
        // Data Layer variable reading ecommerce.<param> (the reverse of the engine's ecommerceParamVar).
        const ecommerceVarNames = new Set<string>();
        for (const val of templateVals) {
          for (const m of String(val ?? '').matchAll(/\{\{(Ecommerce [^}]+)\}\}/g)) ecommerceVarNames.add(m[1]);
        }
        // A custom_event trigger scoped by pushed dataLayer keys (e.g. form_id) needs a {{dlv - <key>}}
        // Data Layer Variable per key so the trigger condition resolves — auto-create the missing ones.
        const dlvKeys = triggerDataLayerVarKeys(triggerInput);
        const createdVariables: string[] = [];
        // An ecommerce Meta tag references {{dlv - ecommerce.*}} in its Object Properties — best-effort
        // create those dataLayer variables so they resolve (idempotent; never fails the tag create).
        // GA4 ecommerce tags use "Send Ecommerce data" (the whole dataLayer object), so they need NO dlv
        // vars — only this Meta path does.
        if (needsEcommerceDlv) {
          try {
            createdVariables.push(...(await data.createEcommerceDlvVariables(accountId, containerId, workspaceId)).created);
          } catch { /* best-effort: existing containers may already have them; the user can create them in GTM */ }
        }
        if (urlVarNames.size || ecommerceVarNames.size || triggerInput.lookupTable || paramLookups.length || needsFormName || dlvKeys.length) {
          const existingVarNames = new Set(
            (await data.listGtmVariables(accountId, containerId, workspaceId)).map((v) => v.name.toLowerCase())
          );
          // GA4 ecommerce parameter variables: {{Ecommerce Item List ID}} → a Data Layer variable reading
          // ecommerce.item_list_id (drop "Ecommerce ", lowercase each word, join with "_"). Created only
          // when missing — never overwrites an existing same-named variable.
          for (const name of ecommerceVarNames) {
            if (existingVarNames.has(name.toLowerCase())) continue;
            const key = name.replace(/^Ecommerce /, '').trim().split(/\s+/).map((w) => w.toLowerCase()).join('_');
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildVariable({ name, kind: 'data_layer', dataLayerName: `ecommerce.${key}` }) as unknown as Record<string, unknown>);
              createdVariables.push(name);
              existingVarNames.add(name.toLowerCase());
            } catch { /* best-effort: the tag still references it; the user can create it in GTM */ }
          }
          // The shared "Form Name" Custom JS variable (GTM has no built-in {{Form Name}}) — derives the
          // form name from the submitted {{Form Element}} at fire time. Created once, referenced by every
          // form tag; never overwrites an existing same-named variable.
          if (needsFormName && !existingVarNames.has('form name')) {
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildFormNameVariable() as unknown as Record<string, unknown>);
              createdVariables.push('Form Name');
              existingVarNames.add('form name');
            } catch { /* best-effort: the tag still references it; the user can create it in GTM */ }
          }
          for (const name of urlVarNames) {
            if (existingVarNames.has(name.toLowerCase())) continue;
            const queryKey = name.replace(/^URL - /, '').trim();
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildUrlQueryVariable(name, queryKey) as unknown as Record<string, unknown>);
              createdVariables.push(name);
            } catch { /* best-effort: the tag still references it; the user can create it in GTM */ }
          }
          // The lookup-table trigger's companion smm variable ({{Click Text}} → "true" per text).
          // Created only when missing — an existing same-named variable is never overwritten.
          const lt = triggerInput.lookupTable;
          if (lt && !existingVarNames.has(lt.name.toLowerCase())) {
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildClickTextLookupVariable(lt.name, lt.texts) as unknown as Record<string, unknown>);
              createdVariables.push(lt.name);
            } catch { /* best-effort: the trigger still references it; the user can create it in GTM */ }
          }
          // Companion Lookup Table variables an event parameter references (e.g. a per-page form_name:
          // {{Page Path}} → name). Created only when missing; never overwrites an existing variable.
          for (const l of paramLookups) {
            if (existingVarNames.has(l.variableName.toLowerCase())) continue;
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildLookupTableVariable(l.variableName, l.input, l.rows, l.defaultValue) as unknown as Record<string, unknown>);
              createdVariables.push(l.variableName);
              existingVarNames.add(l.variableName.toLowerCase()); // de-dupe if two params share one lookup
            } catch { /* best-effort: the tag still references it; the user can create it in GTM */ }
          }
          // {{dlv - <key>}} Data Layer variables a custom_event trigger scopes on (e.g. dlv - form_id),
          // reading the pushed key the install listener emits. Created only when missing — never
          // overwrites an existing same-named variable.
          for (const key of dlvKeys) {
            const name = `dlv - ${key}`;
            if (existingVarNames.has(name.toLowerCase())) continue;
            try {
              await data.createGtmVariable(accountId, containerId, workspaceId, buildVariable({ name, kind: 'data_layer', dataLayerName: key }) as unknown as Record<string, unknown>);
              createdVariables.push(name);
              existingVarNames.add(name.toLowerCase());
            } catch { /* best-effort: the trigger still references it; the user can create it in GTM */ }
          }
        }

        const existing = (await data.listGtmTriggers(accountId, containerId, workspaceId)).find(
          (t) => t.name.toLowerCase() === triggerInput.name.toLowerCase()
        );
        let triggerId: string;
        let reusedTrigger = false;
        if (existing) {
          triggerId = existing.triggerId;
          reusedTrigger = true;
        } else {
          triggerId = (
            await data.createGtmTrigger(accountId, containerId, workspaceId, buildTrigger(triggerInput) as unknown as Record<string, unknown>)
          ).triggerId;
        }

        const createdTag = await data.createGtmTag(accountId, containerId, workspaceId, {
          ...tag,
          firingTriggerId: [triggerId],
        } as unknown as Record<string, unknown>);

        return { tag: createdTag, trigger: { triggerId, name: triggerInput.name, reused: reusedTrigger }, enabledVariables, createdVariables };
      },
    },
    {
      name: 'create_gtm_variable_typed',
      description:
        'Create a GTM variable with the correct structure (no raw JSON). Fields per kind: constant (value); data_layer (dataLayerName); javascript (a Custom JavaScript variable, e.g. "function(){return document.title;}"); event_data (SERVER only, reads keyPath from the incoming event; optional defaultValue); request_header (SERVER only, reads one header via headerName); lookup_table (input = the {{variable}} to match EXACTLY, rows = [{key,value}], optional defaultValue); regex_table (same, but each row key is a REGEX matched against input, for when many inputs map to one value); google_tag_event_settings (a REUSABLE "Google Tag: Event Settings" table, type gtes, rows = event parameters like click_text = {{Click Text}}, referenced by GA4 tags in their Event Settings field: ALWAYS use this kind for a shared event-parameter variable, never a Custom JavaScript object).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          kind: { type: 'string', enum: ['constant', 'data_layer', 'javascript', 'event_data', 'request_header', 'lookup_table', 'regex_table', 'google_tag_event_settings'] },
          name: { type: 'string' },
          value: { type: 'string' },
          dataLayerName: { type: 'string' },
          javascript: { type: 'string' },
          keyPath: { type: 'string' },
          defaultValue: { type: 'string' },
          headerName: { type: 'string', description: 'request_header only: the HTTP header to read, e.g. "X-Geo-Country".' },
          input: { type: 'string', description: 'lookup_table / regex_table only: the input {{variable}}.' },
          rows: {
            type: 'array',
            description: 'Rows for lookup_table / regex_table / google_tag_event_settings (regex_table keys are regexes; gtes keys are event-parameter names).',
            items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'kind', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create ${s(a.kind)} variable "${s(a.name)}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name), 'variable'),
      handler: (a) => {
        const kind = s(a.kind);
        let resource: Record<string, unknown>;
        if (kind === 'google_tag_event_settings') {
          const rows = Array.isArray(a.rows) ? a.rows.map((r) => ({ key: s(obj(r).key), value: s(obj(r).value) })).filter((r) => r.key) : [];
          if (!rows.length) throw new Error('kind "google_tag_event_settings" requires rows ([{key,value}, …] - the event parameters, e.g. {key:"click_text", value:"{{Click Text}}"}).');
          resource = buildGoogleTagEventSettingsVariable(s(a.name), rows) as unknown as Record<string, unknown>;
        } else if (kind === 'lookup_table' || kind === 'regex_table') {
          const input = s(a.input).trim();
          const rows = Array.isArray(a.rows) ? a.rows.map((r) => ({ key: s(obj(r).key), value: s(obj(r).value) })).filter((r) => r.key) : [];
          if (!input || !rows.length) throw new Error(`kind "${kind}" requires input (the {{variable}} to match) and rows ([{key,value}, …]).`);
          const dv = a.defaultValue != null ? s(a.defaultValue) : undefined;
          resource = (kind === 'lookup_table'
            ? buildLookupTableVariable(s(a.name), input, rows, dv)
            : buildRegexTableVariable(s(a.name), input, rows, dv)) as unknown as Record<string, unknown>;
        } else {
          resource = buildVariable({
            name: s(a.name),
            kind: kind as VariableKind,
            value: a.value != null ? s(a.value) : undefined,
            dataLayerName: a.dataLayerName != null ? s(a.dataLayerName) : undefined,
            javascript: a.javascript != null ? s(a.javascript) : undefined,
            keyPath: a.keyPath != null ? s(a.keyPath) : undefined,
            defaultValue: a.defaultValue != null ? s(a.defaultValue) : undefined,
            headerName: a.headerName != null ? s(a.headerName) : undefined,
          }) as unknown as Record<string, unknown>;
        }
        return data.createGtmVariable(s(a.accountId), s(a.containerId), s(a.workspaceId), resource);
      },
    },
    {
      name: 'create_gtm_workspace',
      description: 'Create a new draft workspace in a GTM container to make changes in.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, name: { type: 'string' } },
        required: ['accountId', 'containerId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create GTM workspace "${s(a.name)}" in container ${s(a.containerId)}`,
      handler: (a) => data.createGtmWorkspace(s(a.accountId), s(a.containerId), s(a.name)),
    },
    {
      name: 'copy_workspace_resources',
      description:
        'COPY all tags, triggers and variables from one workspace into another in the SAME container. GTM has no atomic move, so this RECREATES them, remapping firing/blocking trigger references, built-in trigger ids and trigger-group members. Non-destructive: a resource whose NAME already exists in the destination is SKIPPED, never overwritten. Variable {{references}} carry over by name. NOT copied: folders, built-in variables, clients/transformations, and tags using legacy firing/blocking RULES, all listed in `unsupported`. Quota errors are auto-retried; a create that still fails is recorded in `failed` and the copy continues. Re-running is safe.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          fromWorkspaceId: { type: 'string' },
          toWorkspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'fromWorkspaceId', 'toWorkspaceId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Copy all tags/triggers/variables from workspace ${s(a.fromWorkspaceId)} → ${s(a.toWorkspaceId)} in container ${s(a.containerId)}`,
      handler: (a) => data.copyWorkspaceResources(s(a.accountId), s(a.containerId), s(a.fromWorkspaceId), s(a.toWorkspaceId)),
    },
    {
      name: 'create_gtm_environment',
      description:
        'Create a GTM ENVIRONMENT (e.g. a "Test" preview-and-debug environment) and return its environmentId, gtm_auth token (authorizationCode) and the ready-to-paste install snippet (head <script> + body <noscript> with gtm_auth/gtm_preview/gtm_cookies_win filled in). A config write, not a publish: it does not change the live container. Use this instead of sending the user to the GTM UI.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
          enableDebug: { type: 'boolean' },
          description: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create GTM environment "${s(a.name)}" in container ${s(a.containerId)}`,
      handler: (a) =>
        data.createGtmEnvironment(s(a.accountId), s(a.containerId), s(a.name), {
          url: a.url != null ? s(a.url) : undefined,
          enableDebug: typeof a.enableDebug === 'boolean' ? a.enableDebug : a.enableDebug != null ? s(a.enableDebug) === 'true' : undefined,
          description: a.description != null ? s(a.description) : undefined,
        }),
    },
    {
      name: 'create_server_container',
      description:
        'Create a SERVER container (server-side GTM, usageContext "server"). This creates the CONTAINER only: the tagging-server HOST (Cloud Run / App Engine) must be provisioned separately (GTM UI "automatically provision tagging server", or gcloud), after which its URL appears as taggingServerUrls.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, name: { type: 'string' } },
        required: ['accountId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create SERVER container "${s(a.name)}" in account ${s(a.accountId)}`,
      handler: (a) => data.createServerContainer(s(a.accountId), s(a.name)),
    },
    {
      name: 'create_gtm_client',
      description:
        'Create a CLIENT in a SERVER container workspace. `client` is a GTM API Client resource {name, type, parameter?}. The GA4 client is type "gaaw_client", which claims incoming GA4/gtag requests.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          client: { type: 'object', description: 'GTM Client resource {name, type, parameter?}' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'client'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create client "${s(obj(a.client).name)}" (type ${s(obj(a.client).type)}) in server workspace ${s(a.workspaceId)}`,
      handler: (a) => data.createGtmClient(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.client)),
    },
    {
      name: 'delete_gtm_client',
      description:
        'Delete a CLIENT from a SERVER container workspace (draft, not published). The GTM API DOES support this (workspaces.clients.delete); do NOT tell the user clients can only be removed in the GTM UI. Destructive, requires two confirmations: check the client is not the only one claiming requests.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          clientId: { type: 'string' },
          name: { type: 'string', description: 'Client name, for display only.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'clientId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) =>
        `Delete client ${a.name ? `"${s(a.name)}" (${s(a.clientId)})` : s(a.clientId)} from server workspace ${s(a.workspaceId)}`,
      handler: (a) => data.deleteGtmClient(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.clientId)),
    },
    {
      name: 'create_gtm_transformation',
      description:
        'Create a TRANSFORMATION in a SERVER container workspace (reshape event data before tags run). EITHER pass name + allowParams (an "Allow parameters" transformation keeping ONLY the listed event params, e.g. to strip PII), OR a raw `transformation` GTM resource {name, type, parameter?} for any other type.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string' },
          allowParams: { type: 'array', items: { type: 'string' }, description: 'Event-param names to KEEP (builds an allow-list transformation)' },
          transformation: { type: 'object', description: 'Raw GTM Transformation resource {name, type, parameter?} (alternative to allowParams)' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create transformation "${s(a.name) || s(obj(a.transformation).name) || 'allow-params'}" in server workspace ${s(a.workspaceId)}`,
      handler: (a) => {
        const allow = Array.isArray(a.allowParams) ? a.allowParams.map(String) : [];
        const t = allow.length > 0 ? buildAllowParamsTransformation(s(a.name) || 'Allow parameters', allow) : obj(a.transformation);
        if (!t || Object.keys(t).length === 0) throw new Error('Provide allowParams (an event-param allow-list) or a raw transformation object.');
        return data.createGtmTransformation(s(a.accountId), s(a.containerId), s(a.workspaceId), t);
      },
    },
    {
      name: 'bootstrap_server_side_tagging',
      description:
        'Set up server-side tagging in one step: creates a SERVER container, then a GA4 client and GA4 server tag in its default workspace. Give the Measurement ID to relay either as `measurementId` or as `webContainerId` (derived from that web container; use the ACTIVE web container id when the user says "set up a server container for this web container"). Returns the new container id and taggingServerUrls. Does NOT deploy the tagging-server host or change the web container: once the server is provisioned, call set_web_server_container_url.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          measurementId: { type: 'string' },
          webContainerId: { type: 'string', description: 'Derive the Measurement ID from this web container instead.' },
        },
        required: ['accountId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Bootstrap SERVER container "${s(a.name)}" with a GA4 client + GA4 server tag (→ ${s(a.measurementId) || `GA4 id from web container ${s(a.webContainerId)}`})`,
      handler: async (a) => {
        // Trim so a whitespace-only id doesn't read as "present" and skip both the derive
        // fallback and the empty-id guard (relaying a blank Measurement ID).
        let measurementId = a.measurementId != null ? s(a.measurementId).trim() : '';
        if (!measurementId && a.webContainerId != null && s(a.webContainerId)) {
          measurementId = await data.deriveWebContainerMeasurementId(s(a.accountId), s(a.webContainerId));
        }
        if (!measurementId) throw new Error("Provide measurementId, or webContainerId to derive it from that web container's GA4 tags.");
        return data.bootstrapServerSideTagging(s(a.accountId), s(a.name), measurementId);
      },
    },
    {
      name: 'create_server_container_from_web',
      description:
        "ONE STEP: create a complete, production-shaped server-side container FROM a web container. Derives its GA4 Measurement ID and builds the SERVER container, a GA4 client with server-managed first-party FPID cookies, an all-events firing trigger, a GA4 relay tag, a GTM client that first-party-serves the web container, and the standard Event Data variables (ed - event_id for browser/server dedup, ed - page_location for page-scoped triggers). With `serverUrl` it also records the URL, points the web Google tag at it, and wires web-side dedup (Unique Event ID sent as event_id on every GA4 hit). Returns the NON-GA4 conversion tags still in the web container that need a server tag built by hand. Does NOT deploy the host and does NOT publish.",
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          webContainerId: { type: 'string', description: 'The WEB container to base it on.' },
          name: { type: 'string', description: 'Name for the new server container.' },
          serverUrl: { type: 'string', description: 'Tagging-server URL. Omit to wire it later.' },
        },
        required: ['accountId', 'webContainerId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create SERVER container "${s(a.name).trim() || '<web container name> - Server'}" from web container ${s(a.webContainerId)}${s(a.serverUrl) ? ` and point it at ${s(a.serverUrl)}` : ''}`,
      handler: async (a) => {
        // Empty name passes through — the data-service derives "<web container name> - Server".
        return data.createServerContainerFromWeb(s(a.accountId), s(a.webContainerId), s(a.name).trim(), s(a.serverUrl).trim() || undefined);
      },
    },
    {
      name: 'set_web_server_container_url',
      description:
        "Wire a WEB container to a server container by setting the web Google tag's server_container_url. tagId is the web Google tag (type googtag; find it with list_gtm_tags); serverUrl exists only AFTER the server host is provisioned. Upserts the config setting, preserving the tag's other settings. QA in GTM Preview afterwards.",
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          serverUrl: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'serverUrl'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Point web Google tag ${s(a.tagId)} at server ${s(a.serverUrl)} (server_container_url)`,
      handler: (a) => data.setWebServerContainerUrl(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId), s(a.serverUrl)),
    },
    {
      name: 'set_server_container_tagging_url',
      description:
        'Set the SERVER container\'s own Tagging Server URL (container-level taggingServerUrls). The GTM API CAN write this (containers.update); do NOT tell the user it is UI-only. Clears the audit\'s "No tagging server URL" finding. It only RECORDS the URL, it does NOT deploy the host: confirm the server is live with verify_server_endpoint. DIFFERENT from set_web_server_container_url, which points a WEB tag at the server. containerId must be the SERVER container.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          serverUrl: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'serverUrl'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Set tagging server URL ${s(a.serverUrl)} on server container ${s(a.containerId)}`,
      handler: (a) => data.setServerContainerTaggingUrl(s(a.accountId), s(a.containerId), [s(a.serverUrl)]),
    },
    {
      name: 'setup_ecommerce_funnel',
      description:
        "ONE STEP: install the FULL GA4 ecommerce funnel in a WEB container. Per funnel event (default view_item, add_to_cart, view_cart, begin_checkout, add_shipping_info, add_payment_info, purchase) it creates a Custom Event trigger plus a GA4 event tag with 'Send Ecommerce data' ON, so the tag forwards the WHOLE dataLayer ecommerce object and no per-parameter mapping is needed. Also creates the dlv - ecommerce.* variables downstream Ads/Meta tags read. Idempotent: same-named resources are skipped, so re-running completes a partial install. Derive measurementId from the existing Google tag or ask.",
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          measurementId: { type: 'string', description: 'GA4 Measurement ID the event tags send to.' },
          events: { type: 'array', items: { type: 'string' }, description: 'Funnel events to install. Omit for the standard 7.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'measurementId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => {
        const evs = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
        return `Install the GA4 ecommerce funnel (${evs.length} events: ${evs.join(', ')} → ${s(a.measurementId)}) with triggers + ecommerce variables in workspace ${s(a.workspaceId)}`;
      },
      handler: async (a) => {
        const measurementId = s(a.measurementId).trim();
        if (!measurementId) throw new Error('measurementId (G-XXXXXXX) is required — derive it from the web Google tag or ask the user.');
        const events = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        const result = await data.setupEcommerceFunnel(accountId, containerId, workspaceId, measurementId, events);
        // Record what we created into the per-container install manifest so re-runs
        // are safe and later user edits/deletions are detectable as drift. Best-effort:
        // a manifest failure must never fail the setup, and it's a no-op when no
        // ManifestStore is injected (e.g. the diagnostic registry / most tests).
        if (manifests) {
          try {
            await recordSetupManifest(
              data,
              manifests,
              { accountId, containerId, workspaceId },
              result.created,
              'setup_ecommerce_funnel'
            );
          } catch (e) {
            console.error('[install-manifest] recording setup_ecommerce_funnel failed (non-fatal):', e);
          }
        }
        return result;
      },
    },
    {
      name: 'setup_server_ecommerce_funnel',
      description:
        'ONE STEP: install the server-side ecommerce funnel in a SERVER container (containerId must be the SERVER one). Per funnel event (default the standard 7) it creates a trigger ({{_event}} equals the event, scoped to the GA4 client) plus a GA4 server tag relaying it, and with adsConversionId plus a per-event conversionLabel, a Google Ads conversion server tag for that event (typically purchase). Enables the Client Name built-in. Idempotent by name. Run AFTER create_server_container_from_web.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string', description: 'The SERVER container id.' },
          workspaceId: { type: 'string' },
          measurementId: { type: 'string', description: 'GA4 Measurement ID the server relays to.' },
          events: { type: 'array', items: { type: 'string' }, description: 'Funnel events. Omit for the standard 7.' },
          adsConversionId: { type: 'string', description: 'AW-XXXXXXXX, only for server Ads conversion tags.' },
          adsConversionLabels: {
            type: 'array',
            items: {
              type: 'object',
              properties: { event: { type: 'string' }, conversionLabel: { type: 'string' } },
              required: ['event', 'conversionLabel'],
              additionalProperties: false,
            },
            description: 'Per-event Ads conversion labels. Only listed events get an Ads tag.',
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'measurementId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => {
        const evs = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
        return `Install the SERVER ecommerce funnel (${evs.length} events → ${s(a.measurementId)}${s(a.adsConversionId).trim() ? ` + Ads conversions for ${s(a.adsConversionId).trim()}` : ''}) in server workspace ${s(a.workspaceId)}`;
      },
      handler: (a) => {
        const measurementId = s(a.measurementId).trim();
        if (!measurementId) throw new Error('measurementId (G-XXXXXXX) is required.');
        const events = Array.isArray(a.events) && a.events.length > 0 ? a.events.map(String) : [...GA4_ECOMMERCE_FUNNEL_EVENTS];
        const conversionId = s(a.adsConversionId).trim();
        const labels = Array.isArray(a.adsConversionLabels)
          ? a.adsConversionLabels
              .map((l) => ({ event: s(obj(l).event).trim(), conversionLabel: s(obj(l).conversionLabel).trim() }))
              .filter((l) => l.event && l.conversionLabel)
          : [];
        const ads = conversionId && labels.length > 0 ? { conversionId, labels } : undefined;
        return data.setupServerEcommerceFunnel(s(a.accountId), s(a.containerId), s(a.workspaceId), measurementId, events, ads);
      },
    },
    {
      name: 'setup_consent_mode_defaults',
      description:
        "Install the Consent Mode v2 DEFAULT-consent tag in a WEB container: a Custom HTML gtag('consent','default',...) covering ALL v2 signals (ad_storage, analytics_storage, ad_user_data, ad_personalization, functionality_storage, security_storage) with wait_for_update, firing on the built-in 'Consent Initialization - All Pages' trigger, BEFORE any other tag. Ad/analytics signals default to DENIED (GDPR-safe); the CMP then upgrades via gtag('consent','update'). DEFAULTS only: the user still needs a CMP for the update call. Skipped if a same-named tag exists.",
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: "Tag name (default 'Consent Mode - Defaults')." },
          adStorage: { type: 'string', enum: ['granted', 'denied'] },
          analyticsStorage: { type: 'string', enum: ['granted', 'denied'] },
          adUserData: { type: 'string', enum: ['granted', 'denied'] },
          adPersonalization: { type: 'string', enum: ['granted', 'denied'] },
          functionalityStorage: { type: 'string', enum: ['granted', 'denied'] },
          securityStorage: { type: 'string', enum: ['granted', 'denied'] },
          waitForUpdate: { type: 'number', description: 'ms to wait for the CMP update before tags fire. Default 500.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create consent-default tag "${s(a.name).trim() || 'Consent Mode - Defaults'}" (ads/analytics ${s(a.adStorage) === 'granted' ? 'granted' : 'denied'} by default, fires on Consent Initialization) in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'Consent Mode - Defaults', 'tag'),
      handler: (a) => {
        const grantedOrDenied = (v: unknown): 'granted' | 'denied' | undefined => (v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : undefined);
        const tag = buildConsentModeDefaultTag(s(a.name).trim() || 'Consent Mode - Defaults', {
          ad_storage: grantedOrDenied(a.adStorage),
          analytics_storage: grantedOrDenied(a.analyticsStorage),
          ad_user_data: grantedOrDenied(a.adUserData),
          ad_personalization: grantedOrDenied(a.adPersonalization),
          functionality_storage: grantedOrDenied(a.functionalityStorage),
          security_storage: grantedOrDenied(a.securityStorage),
          waitForUpdate: typeof a.waitForUpdate === 'number' ? a.waitForUpdate : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_server_tag',
      description:
        'Create a tag in a SERVER container workspace (it reads event data from the GA4 client). Fields per platform: ga4 (measurementId, optional eventName, defaults to forwarding the incoming event); ads_conversion (conversionId + conversionLabel; set productReporting=true ONLY for an ecommerce/purchase conversion); ads_conversion_linker (none); ads_remarketing (conversionId).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          platform: { type: 'string', enum: ['ga4', 'ads_conversion', 'ads_conversion_linker', 'ads_remarketing'] },
          name: { type: 'string' },
          measurementId: { type: 'string' },
          conversionId: { type: 'string' },
          conversionLabel: { type: 'string' },
          eventName: { type: 'string' },
          productReporting: { type: 'boolean', description: 'ads_conversion only: forward product/cart data (Shopping reporting). Default false.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'platform', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create ${s(a.platform)} server tag "${s(a.name)}" in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(a.name), 'tag'),
      handler: (a) => {
        const name = s(a.name);
        const ftid = Array.isArray(a.firingTriggerId) ? a.firingTriggerId.map(String) : undefined;
        let tag: GtmTagResource;
        switch (s(a.platform)) {
          case 'ga4':
            if (!s(a.measurementId)) throw new Error('platform "ga4" requires measurementId.');
            tag = buildGa4ServerTag(name, s(a.measurementId), a.eventName != null ? s(a.eventName) : undefined, ftid);
            break;
          case 'ads_conversion':
            if (!s(a.conversionId) || !s(a.conversionLabel)) throw new Error('platform "ads_conversion" requires conversionId and conversionLabel.');
            tag = buildAdsConversionServerTag(name, s(a.conversionId), s(a.conversionLabel), ftid, bln(a.productReporting));
            break;
          case 'ads_conversion_linker':
            tag = buildAdsConversionLinkerServerTag(name, ftid);
            break;
          case 'ads_remarketing':
            if (!s(a.conversionId)) throw new Error('platform "ads_remarketing" requires conversionId.');
            tag = buildAdsRemarketingServerTag(name, s(a.conversionId), ftid);
            break;
          default:
            throw new Error(`Unknown server-tag platform "${s(a.platform)}" — use ga4 / ads_conversion / ads_conversion_linker / ads_remarketing.`);
        }
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_server_trigger',
      description:
        'Create the firing trigger for a SERVER container: a Custom Event trigger, optionally SCOPED to a client via "Client Name equals <clientName>". `eventName` fires on ONE event ({{_event}} equals it, the dominant server pattern); omit it to fire on ALL events (a base/relay trigger). Use THIS, not create_gtm_trigger, for server triggers: it builds the exact customEvent shape GTM requires, and enables the Client Name built-in when clientName is given. `pageUrlContains` further scopes to pages whose URL contains that substring, reading {{ed - page_location}}, auto-created if missing. IMPORTANT: type event names EXACTLY as they arrive, with spaces, NEVER URL-encoded ("Sign Petition Click", not "Sign+Petition+Click"): an encoded value silently never matches.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string' },
          eventName: { type: 'string', description: 'Fire only on this event. Omit to fire on all. Use the name EXACTLY as sent (spaces, not "+").' },
          clientName: { type: 'string', description: 'Scope to this client (Client Name equals). Omit for any client.' },
          pageUrlContains: { type: 'string', description: 'Also require the event page URL to CONTAIN this substring.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create server trigger "${s(a.name)}"${s(a.eventName) ? ` on event "${s(a.eventName)}"` : ' (all events)'}${s(a.clientName) ? ` scoped to Client Name = ${s(a.clientName)}` : ''}${s(a.pageUrlContains).trim() ? ` on pages containing "${s(a.pageUrlContains).trim()}"` : ''} in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(a.name), 'trigger'),
      handler: async (a) => {
        const clientName = a.clientName != null ? s(a.clientName) : '';
        const eventName = a.eventName != null ? s(a.eventName).trim() : '';
        const pageUrlContains = a.pageUrlContains != null ? s(a.pageUrlContains).trim() : '';
        if (clientName) {
          // Enable the Client Name built-in so {{Client Name}} resolves (best-effort).
          try {
            await data.enableGtmBuiltInVariables(s(a.accountId), s(a.containerId), s(a.workspaceId), ['clientName']);
          } catch {
            /* non-fatal */
          }
        }
        if (pageUrlContains) {
          // The page filter reads {{ed - page_location}} — ensure it exists (idempotent, best-effort).
          try {
            const have = (await data.listGtmVariables(s(a.accountId), s(a.containerId), s(a.workspaceId))).some(
              (v) => v.name.trim().toLowerCase() === 'ed - page_location'
            );
            if (!have) {
              await data.createGtmVariable(
                s(a.accountId), s(a.containerId), s(a.workspaceId),
                buildVariable({ name: 'ed - page_location', kind: 'event_data', keyPath: 'page_location' }) as unknown as Record<string, unknown>
              );
            }
          } catch {
            /* non-fatal — the trigger still saves; the variable can be added after */
          }
        }
        const trigger = eventName
          ? buildServerEventTrigger(s(a.name), eventName, clientName || undefined, pageUrlContains ? { pageUrlContains } : undefined)
          : buildServerAllEventsTrigger(s(a.name), clientName || undefined);
        return data.createGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), trigger as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_meta_emq_variables',
      description:
        'Create the standard Meta CAPI "Event Match Quality" Event Data variables (ed - fbp, fbc, event_id, value, currency, transaction_id, content_ids, email_address, phone_number, first_name, last_name, country, city, postal_code, ip_override, user_agent) in a SERVER container, with nested user_data.* fallbacks for email/phone and request-header fallbacks for ip/user_agent. Idempotent. create_meta_capi_server_tag auto-runs this, so call it directly only to pre-provision. Values are RAW (the CAPI tag hashes user_data itself). containerId must be the SERVER container.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      write: true,
      summarize: () => `Create the Meta CAPI EMQ Event Data variables in the server container`,
      handler: (a) => data.createMetaEmqVariables(s(a.accountId), s(a.containerId), s(a.workspaceId)),
    },
    {
      name: 'create_meta_pixel_tag',
      description:
        'Create a Meta (Facebook) Pixel WEB tag from the official community template (imported automatically) with the CORRECT event fields. Use this instead of hand-building a cvt_ template tag, which gets the event wrong. `event`: a Meta standard event (PageView, ViewContent, Search, AddToCart, InitiateCheckout, AddPaymentInfo, Purchase, Lead, CompleteRegistration, Contact, Donate, Subscribe) sets eventName=standard + standardEventName; anything else becomes a CUSTOM event, and free text like "add to cart" resolves to AddToCart. `objectProperties` are the Meta Object Properties; OMIT it and the tool auto-fills the event\'s recommended properties from {{dlv - ecommerce.*}} variables, creating them; pass [] for none. `advancedMatching` rows are the Pixel\'s user-identity params (em/fn/ln/ph/ct/st/zp/cn/external_id/ge/db; country auto-maps to cn). Without firingTriggerId the tag will not fire.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Meta - Event - <Event> Tag".' },
          pixelId: { type: 'string' },
          event: { type: 'string', description: 'e.g. ViewContent / AddToCart / Purchase, or a custom name.' },
          objectProperties: {
            type: 'array',
            description: 'Meta Object Properties (event params): {name,value} rows.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          advancedMatching: {
            type: 'array',
            description: 'Advanced Matching rows {name,value}. Any rows turn it ON.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelId', 'event'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Meta Pixel tag "${metaPixelTagName(a)}" (event ${s(a.event)})`,
      precheck: (a) => findExistingByName(data, a, metaPixelTagName(a), 'tag'),
      handler: async (a) => {
        const event = s(a.event).trim();
        if (!event) throw new Error('event is required (a Meta standard event like ViewContent/AddToCart/Purchase, or a custom name).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'facebook', 'GoogleTagManager-WebTemplate-For-FacebookPixel');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Meta Pixel template's tag type (got "${tmpl.type}"). Try import_gallery_template + list_gtm_templates to confirm it imported, then create_gtm_tag with its type.`);
        }
        const ftid = Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined;
        const objProps = Array.isArray(a.objectProperties)
          ? a.objectProperties.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name)
          : undefined;
        const advancedMatching = Array.isArray(a.advancedMatching)
          ? a.advancedMatching.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name)
          : undefined;
        // Auto-fill path (no objectProperties passed): the builder fills the event's recommended props
        // from {{dlv - ecommerce.*}} variables — create those first (idempotent) so they resolve.
        let createdVariables: string[] = [];
        if (objProps === undefined && metaWebObjectProps(metaStandardEvent(event)).length) {
          try {
            createdVariables = (await data.createEcommerceDlvVariables(s(a.accountId), s(a.containerId), s(a.workspaceId))).created;
          } catch { /* best-effort: existing containers may already have them */ }
        }
        const tag = buildMetaPixelTag(tmpl.type, metaPixelTagName(a), s(a.pixelId), event, ftid, objProps, advancedMatching);
        const created = await data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
        return { ...created, createdVariables };
      },
    },
    {
      name: 'create_meta_capi_server_tag',
      description:
        'Create a Meta/Facebook Conversions API (CAPI) SERVER tag from the Stape template (stape-io / facebook-tag), imported automatically. containerId must be the SERVER container. Tuned for high Event Match Quality: action source website, Event Enhancement (gtmeec) ON, generate _fbp ON, and the EMQ user_data (em/ph/external_id plus client_ip_address/client_user_agent), ecommerce custom_data and event_id AUTO-MAPPED from {{ed - }} variables that are created if missing, so ONE call yields a working tag; mapEmqVariables=false skips that mapping and the template still auto-extracts user data from the event. pixelId and accessToken are usually {{variables}}. `event`: a Meta standard event (ViewContent, AddToCart, Purchase, Lead) sets eventNameStandard with Override; anything else inherits the incoming event_name. `userData` ADDS advanced-matching rows on top of the auto-map (em/ph/fn/ln/ct/st/zp/country/external_id/fbc/fbp/client_ip_address/client_user_agent/subscription_id/lead_id/fb_login_id/ge/db); a caller row wins a collision, and these rows ship even with mapEmqVariables=false.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Meta CAPI - <Event> Tag".' },
          pixelId: { type: 'string' },
          accessToken: { type: 'string' },
          event: { type: 'string', description: 'e.g. AddToCart / Purchase / ViewContent.' },
          actionSource: { type: 'string', description: 'Default "website".' },
          eventEnhancement: { type: 'boolean', description: 'gtmeec, default true.' },
          generateFbp: { type: 'boolean', description: 'Generate _fbp cookie, default true.' },
          mapEmqVariables: { type: 'boolean', description: 'Map the ed-variable EMQ/ecommerce rows in (default true).' },
          userData: {
            type: 'array',
            description: 'Advanced-matching rows {name,value} added to the auto-map (caller wins collisions).',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          userDataObject: { type: 'string', description: 'Variable whose object is merged into user_data.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelId', 'accessToken', 'event'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Meta CAPI server tag for ${s(a.event)} (pixel ${s(a.pixelId)})`,
      precheck: (a) => findExistingByName(data, a, s(a.name) || `Meta CAPI - ${s(metaStandardEvent(s(a.event).trim()) ?? s(a.event).trim())} Tag`, 'tag'),
      handler: async (a) => {
        const event = s(a.event).trim();
        if (!event) throw new Error('event is required (a Meta event like AddToCart/Purchase, or a custom name).');
        if (!s(a.accessToken).trim()) throw new Error('accessToken is required (the Meta CAPI access token, usually a {{variable}}).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'stape-io', 'facebook-tag');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Stape Facebook CAPI template's tag type (got "${tmpl.type}"). Import stape-io/facebook-tag and check list_gtm_templates.`);
        }
        const mapEmq = bln(a.mapEmqVariables) !== false; // default true; only an explicit false skips
        // The mapped rows reference {{ed - …}} variables — ensure they EXIST first (idempotent; skips
        // ones already present) or the tag create hard-fails on the dangling references.
        let createdVariables: string[] = [];
        if (mapEmq) {
          try {
            createdVariables = (await data.createMetaEmqVariables(s(a.accountId), s(a.containerId), s(a.workspaceId))).created;
          } catch { /* best-effort: existing containers may already have them */ }
        }
        const name = s(a.name).trim() || `Meta CAPI - ${metaStandardEvent(event) ?? event} Tag`;
        const userData = Array.isArray(a.userData)
          ? a.userData.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name)
          : undefined;
        const tag = buildMetaCapiServerTag(tmpl.type, name, s(a.pixelId), s(a.accessToken), event, {
          actionSource: a.actionSource != null ? s(a.actionSource) : undefined,
          eventEnhancement: bln(a.eventEnhancement),
          generateFbp: bln(a.generateFbp),
          mapEmqVariables: mapEmq,
          userData,
          userDataObject: a.userDataObject != null && s(a.userDataObject).trim() ? s(a.userDataObject) : undefined,
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        const created = await data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
        return { ...created, createdVariables };
      },
    },
    {
      name: 'create_tiktok_capi_server_tag',
      description:
        'Create a TikTok Events API SERVER tag from the Stape template (stape-io / tiktok-tag), imported automatically. containerId must be the SERVER container. DISTINCT from the TikTok WEB pixel and using DIFFERENT field keys (pixelId / accessToken / eventName, NOT the web pixel_code / event). `event`: a TikTok standard event (Purchase, AddToCart, ViewContent, InitiateCheckout, CompleteRegistration, SubmitForm, Search); GA4 names are mapped (purchase becomes Purchase, NOT the legacy CompletePayment); anything else becomes a custom event. By default mapEventData auto-fills user_data (email/phone/external_id plus client ip/user_agent), the recommended eventProperties and event_id from ed- variables that are created if missing, so ONE call yields a sending tag; set it false to keep only the rows you pass. matchAddress=true also maps first_name/last_name/city/state/country/zip_code from user_data.address.*, best for Purchase and registration. Explicit userData / eventProperties / eventId override the auto-map; commerce eventProperties keys land in customDataList and the rest in additional properties, routed automatically. Needs a SERVER trigger (create_server_trigger) scoped to the client claiming the events.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "TikTok CAPI - <Event> Tag".' },
          pixelId: { type: 'string' },
          accessToken: { type: 'string' },
          event: { type: 'string', description: 'e.g. purchase / AddToCart / ViewContent / a custom name.' },
          eventSource: { type: 'string', description: 'web | app | offline | crm, default web.' },
          eventId: { type: 'string', description: 'Dedup id shared with the web pixel.' },
          userData: {
            type: 'array',
            description: 'Advanced-matching rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          eventProperties: {
            type: 'array',
            description: 'Event-data rows {name,value} (currency/value/contents/content_type/order_id).',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          testEventCode: { type: 'string' },
          generateTtp: { type: 'boolean', description: 'Default true.' },
          eventEnhancement: { type: 'boolean', description: 'Default true.' },
          requireConsent: { type: 'boolean', description: 'Gate on ad_storage consent, default false.' },
          mapEventData: { type: 'boolean', description: 'Default true. See the tool description.' },
          matchAddress: { type: 'boolean', description: 'Default false. Only applies while auto-filling; blank rows are dropped.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelId', 'accessToken', 'event'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create TikTok Events API server tag for ${s(a.event)} (pixel ${s(a.pixelId)})`,
      precheck: (a) => findExistingByName(data, a, s(a.name) || `TikTok CAPI - ${s(tikTokStandardEvent(s(a.event).trim()) ?? s(a.event).trim())} Tag`, 'tag'),
      handler: async (a) => {
        const event = s(a.event).trim();
        if (!event) throw new Error('event is required (a TikTok event like AddToCart/CompletePayment/ViewContent, or a custom name).');
        if (!s(a.accessToken).trim()) throw new Error('accessToken is required (the TikTok Events API access token, usually a {{variable}}).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'stape-io', 'tiktok-tag');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Stape TikTok Events API template's tag type (got "${tmpl.type}"). Import stape-io/tiktok-tag and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || `TikTok CAPI - ${tikTokStandardEvent(event) ?? event} Tag`;
        const mapRows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const userData = mapRows(a.userData);
        const eventProperties = mapRows(a.eventProperties);
        const mapEd = bln(a.mapEventData) !== false; // default true; only an explicit false skips
        // When auto-filling, the builder fills user_data, event properties, AND event_id INDEPENDENTLY
        // (each gated only on its own emptiness) — so even a partial call (only userData, or both lists
        // but no eventId) still emits {{ed - …}} references. Create the variables whenever mapEd is on
        // (idempotent) so none dangle; gating on "both lists empty" under-creates and the tag create fails.
        let createdVariables: string[] = [];
        if (mapEd) {
          try {
            createdVariables = (await data.createTikTokEmqVariables(s(a.accountId), s(a.containerId), s(a.workspaceId))).created;
          } catch { /* best-effort: existing containers may already have them */ }
        }
        const tag = buildTikTokCapiServerTag(tmpl.type, name, s(a.pixelId), s(a.accessToken), event, {
          eventSource: a.eventSource != null ? s(a.eventSource) : undefined,
          eventId: a.eventId != null ? s(a.eventId) : undefined,
          userData,
          eventProperties,
          testEventCode: a.testEventCode != null ? s(a.testEventCode) : undefined,
          generateTtp: bln(a.generateTtp),
          eventEnhancement: bln(a.eventEnhancement),
          requireConsent: bln(a.requireConsent),
          mapEventData: mapEd,
          matchAddress: bln(a.matchAddress),
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        const created = await data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
        return { ...created, createdVariables };
      },
    },
    {
      name: 'create_linkedin_capi_server_tag',
      description:
        'Create a LinkedIn Conversions API SERVER tag from the Stape template (stape-io / linkedin-tag), imported automatically. containerId must be the SERVER container. LinkedIn conversions are keyed by a pre-defined Conversion Rule, NOT an event name, so accessToken + conversionRuleUrn (usually {{variables}}) come from LinkedIn Campaign Manager under Measurement > Conversions. autoMap is ON by default, deriving event data, match IDs (hashed email, li_fat_id) and user info from the incoming GA4 event with no explicit rows. eventId dedups against the LinkedIn Insight Tag. Optional override rows: userIds (email/linkedinFirstPartyId/acxiomID/moatID/ipAddress/googleAid), userInfo (firstName/lastName/jobTitle/companyName/countryCode), eventData (conversionHappenedAt/currency/amount/eventId). Needs a SERVER trigger (create_server_trigger).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "LinkedIn CAPI Tag".' },
          accessToken: { type: 'string' },
          conversionRuleUrn: { type: 'string', description: 'Conversion Rule ID / URN from Campaign Manager.' },
          eventId: { type: 'string', description: 'Dedup id shared with the LinkedIn Insight Tag.' },
          userIds: {
            type: 'array',
            description: 'Match-ID rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          userInfo: {
            type: 'array',
            description: 'User-info rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          eventData: {
            type: 'array',
            description: 'Event-data rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          autoMap: { type: 'boolean', description: 'Default true.' },
          optimistic: { type: 'boolean', description: 'gtmOnSuccess without waiting for LinkedIn, default false.' },
          requireConsent: { type: 'boolean', description: 'Gate on ad_storage consent, default false.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'accessToken', 'conversionRuleUrn'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create LinkedIn CAPI server tag "${s(a.name).trim() || 'LinkedIn CAPI Tag'}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'LinkedIn CAPI Tag', 'tag'),
      handler: async (a) => {
        if (!s(a.accessToken).trim()) throw new Error('accessToken is required (the LinkedIn Conversions API access token, usually a {{variable}}).');
        if (!s(a.conversionRuleUrn).trim()) throw new Error('conversionRuleUrn is required (the LinkedIn Conversion Rule ID/URN from Campaign Manager, usually a {{variable}}).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'stape-io', 'linkedin-tag');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Stape LinkedIn template's tag type (got "${tmpl.type}"). Import stape-io/linkedin-tag and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || 'LinkedIn CAPI Tag';
        const mapRows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const tag = buildLinkedInCapiServerTag(tmpl.type, name, s(a.accessToken), s(a.conversionRuleUrn), {
          eventId: a.eventId != null ? s(a.eventId) : undefined,
          userIds: mapRows(a.userIds),
          userInfo: mapRows(a.userInfo),
          eventData: mapRows(a.eventData),
          autoMap: bln(a.autoMap),
          optimistic: bln(a.optimistic),
          requireConsent: bln(a.requireConsent),
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_pinterest_capi_server_tag',
      description:
        'Create a Pinterest Conversions API SERVER tag from the official Pinterest server template (pinterest / ss-gtm-template), imported automatically: the server counterpart of create_pinterest_tag. containerId must be the SERVER container. advertiserId and apiAccessToken come from Pinterest Ads Manager, "Generate conversion access token". By default the tag INHERITS the event name from the incoming GA4 event and reads all event/user/custom data from it (getAllEventData), so no rows are needed; pass `event` to force a Pinterest standard event (checkout = purchase, add_to_cart, view_content, page_visit, lead, search, signup, initiate_checkout, or a custom name), and serverEventData / userData / customData rows only to add or override fields. Needs a SERVER trigger (create_server_trigger).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Pinterest CAPI Tag".' },
          advertiserId: { type: 'string', description: 'Ad Account ID, starts "549".' },
          apiAccessToken: { type: 'string' },
          event: { type: 'string', description: 'Force an event; omit to inherit from the incoming one.' },
          testMode: { type: 'boolean', description: 'Test request, not recorded. Default false.' },
          log: { type: 'boolean', description: 'logMode, default false.' },
          serverEventData: {
            type: 'array', description: 'Override rows {name,value} for event data (sets overrideMode on).',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          userData: {
            type: 'array', description: 'Override rows {name,value} for user data (match keys).',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          customData: {
            type: 'array', description: 'Override rows {name,value} for custom data.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'advertiserId', 'apiAccessToken'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Pinterest CAPI server tag "${s(a.name).trim() || 'Pinterest CAPI Tag'}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'Pinterest CAPI Tag', 'tag'),
      handler: async (a) => {
        if (!s(a.advertiserId).trim()) throw new Error('advertiserId is required (the Pinterest Advertiser / Ad Account ID, starts "549…", usually a {{variable}}).');
        if (!s(a.apiAccessToken).trim()) throw new Error('apiAccessToken is required (the Pinterest Conversions API access token, usually a {{variable}}).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'pinterest', 'ss-gtm-template');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Pinterest server template's tag type (got "${tmpl.type}"). Import pinterest/ss-gtm-template and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || 'Pinterest CAPI Tag';
        const rows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const tag = buildPinterestCapiServerTag(tmpl.type, name, s(a.advertiserId), s(a.apiAccessToken), {
          event: a.event != null ? s(a.event) : undefined,
          testMode: bln(a.testMode),
          log: bln(a.log),
          override: { serverEventData: rows(a.serverEventData), userData: rows(a.userData), customData: rows(a.customData) },
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_stackadapt_server_tag',
      description:
        'Create a StackAdapt SERVER pixel tag from the official StackAdapt server template, imported automatically. containerId must be the SERVER container. UNLIKE the CAPI tags, StackAdapt is ID-ONLY: pixelID plus pixelType conv (sent as cid=), rt or lal (sid=) or universal (uid=). There is NO access token and NO event_id dedup field: identity is first-party-cookie based and handled by the template. For a conversion, `action` names the event. commonProperties accepts email/first_name/last_name/phone/order_id/revenue/product_id/product_name/product_price/product_category/action; anything else goes in customProperties. Needs a SERVER trigger (create_server_trigger).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "StackAdapt Pixel".' },
          pixelID: { type: 'string', description: 'Pixel / audience / conversion id.' },
          pixelType: { type: 'string', enum: ['conv', 'rt', 'lal', 'universal'], description: 'conv=Conversion, rt=Retargeting, lal=Lookalike, universal=Universal Event.' },
          action: { type: 'string', description: 'Event name for a conversion (a commonProperties "action" row).' },
          commonProperties: {
            type: 'array', description: 'Standard property rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          customProperties: {
            type: 'array', description: 'Arbitrary property rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelID', 'pixelType'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create StackAdapt server pixel "${s(a.name).trim() || 'StackAdapt Pixel'}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'StackAdapt Pixel', 'tag'),
      handler: async (a) => {
        if (!s(a.pixelID).trim()) throw new Error('pixelID is required (the StackAdapt pixel/audience/conversion id, usually a {{variable}}).');
        if (!s(a.pixelType).trim()) throw new Error('pixelType is required (conv | rt | lal | universal).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'StackAdapt', 'stackadapt-gtm-server-side-pixel');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the StackAdapt server template's tag type (got "${tmpl.type}"). Import StackAdapt/stackadapt-gtm-server-side-pixel and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || 'StackAdapt Pixel';
        const rows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const tag = buildStackAdaptServerTag(tmpl.type, name, s(a.pixelID), s(a.pixelType), {
          action: a.action != null ? s(a.action) : undefined,
          commonProperties: rows(a.commonProperties),
          customProperties: rows(a.customProperties),
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_reddit_capi_server_tag',
      description:
        'Create a Reddit Conversions API SERVER tag from the Stape template (stape-io / reddit-tag), imported automatically: the server counterpart of the Reddit WEB pixel. containerId must be the SERVER container. accessToken is the Conversion Access Token from Reddit Ads, Events Manager > Conversions API. The event name is INHERITED from the incoming event by default; pass `event` to force a Reddit standard event (PAGE_VISIT/VIEW_CONTENT/SEARCH/ADD_TO_CART/PURCHASE/LEAD/SIGN_UP, a GA4 name, or a custom name). autoMap (default true) derives conversion_id (from the incoming event_id or transaction_id), value, currency and user match keys with no explicit rows. Override rows: serverEventData (conversion_id/currency/item_count/products/value), userData (email/phone_number/external_id/idfa/aaid/ip_address/user_agent/uuid). Needs a SERVER trigger (create_server_trigger).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Reddit CAPI Tag".' },
          pixelId: { type: 'string', description: 'Pixel / Advertiser ID (t2_/a2_).' },
          accessToken: { type: 'string' },
          event: { type: 'string', description: 'Force an event; omit to inherit from the incoming one.' },
          eventId: { type: 'string', description: 'Dedup id, sent as the conversion_id override row.' },
          testId: { type: 'string', description: 'Event Testing tool Test ID.' },
          clickId: { type: 'string', description: 'rdt_cid override.' },
          eventSourceUrl: { type: 'string' },
          serverEventData: {
            type: 'array', description: 'Override rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          userData: {
            type: 'array', description: 'User-match rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          autoMap: { type: 'boolean', description: 'Default true.' },
          optimistic: { type: 'boolean', description: 'gtmOnSuccess without waiting for Reddit, default false.' },
          requireConsent: { type: 'boolean', description: 'Gate on ad_storage consent, default false.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelId', 'accessToken'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Reddit CAPI server tag "${s(a.name).trim() || 'Reddit CAPI Tag'}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'Reddit CAPI Tag', 'tag'),
      handler: async (a) => {
        if (!s(a.pixelId).trim()) throw new Error('pixelId is required (the Reddit Pixel/Advertiser ID, t2_/a2_, usually a {{variable}}).');
        if (!s(a.accessToken).trim()) throw new Error('accessToken is required (the Reddit Conversions API access token, usually a {{variable}}).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'stape-io', 'reddit-tag');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Stape Reddit template's tag type (got "${tmpl.type}"). Import stape-io/reddit-tag and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || 'Reddit CAPI Tag';
        const rows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const tag = buildRedditCapiServerTag(tmpl.type, name, s(a.pixelId), s(a.accessToken), {
          event: a.event != null ? s(a.event) : undefined,
          eventId: a.eventId != null ? s(a.eventId) : undefined,
          testId: a.testId != null ? s(a.testId) : undefined,
          clickId: a.clickId != null ? s(a.clickId) : undefined,
          eventSourceUrl: a.eventSourceUrl != null ? s(a.eventSourceUrl) : undefined,
          serverEventData: rows(a.serverEventData),
          userData: rows(a.userData),
          autoMap: bln(a.autoMap),
          optimistic: bln(a.optimistic),
          requireConsent: bln(a.requireConsent),
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_amazon_capi_server_tag',
      description:
        'Create an Amazon Ads Conversions API SERVER tag from the Stape template (stape-io / amazon-tag), imported automatically. containerId must be the SERVER container. Amazon has NO api key or OAuth here: the only credential is tagIds, one or more Amazon Ads Tag ID UUIDs from Amazon DSP > Events Manager > View Tag Code. The event name is INHERITED from the incoming event by default; pass `event` to force an Amazon standard event (PageView/AddToShoppingCart/Checkout/Search/Signup/Lead/Off-AmazonPurchases = purchase, a GA4 name, or a custom name). eventId lands as the clientDedupeId row, otherwise auto-derived from the incoming event_id or transaction_id. Override tables: defaultAttributes (clientDedupeId/value/brand/category/productId/attr1 to attr10), purchaseAttributes (currencyCode/unitsSold), customAttributes. Needs a SERVER trigger (create_server_trigger).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Amazon CAPI Tag".' },
          tagIds: { type: 'array', description: 'Tag ID UUID(s); the event is sent to every id.', items: { type: 'string' } },
          tagRegion: { type: 'string', enum: ['NA', 'EU'], description: 'NA (Americas/Japan/Australia) or EU. Default NA.' },
          event: { type: 'string', description: 'Force an event; omit to inherit from the incoming one.' },
          eventId: { type: 'string', description: 'Dedup id, sent as clientDedupeId.' },
          matchId: { type: 'string', description: 'Defaults to eventData.user_id.' },
          ipAddress: { type: 'string', description: 'Defaults to eventData.ip_override.' },
          countryCode: { type: 'string', description: 'ISO alpha-2; required when consent fields are set.' },
          enableAdvancedMatching: { type: 'boolean', description: 'Send hashed email/phone, default false.' },
          userData: {
            type: 'array', description: 'Rows {name,value}: email/phonenumber. Only sent when enableAdvancedMatching.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          defaultAttributes: {
            type: 'array', description: 'Standard attribute rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          purchaseAttributes: {
            type: 'array', description: 'Off-AmazonPurchases rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          customAttributes: {
            type: 'array', description: 'Arbitrary attribute rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagIds', 'tagRegion'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Amazon CAPI server tag "${s(a.name).trim() || 'Amazon CAPI Tag'}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'Amazon CAPI Tag', 'tag'),
      handler: async (a) => {
        const tagIds = Array.isArray(a.tagIds) ? a.tagIds.map((v) => s(v).trim()).filter((v) => v !== '') : [];
        if (!tagIds.length) throw new Error('tagIds is required (at least one Amazon Ads Tag ID UUID from Events Manager → View Tag Code).');
        const region = s(a.tagRegion).trim().toUpperCase() === 'EU' ? 'EU' : 'NA';
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'stape-io', 'amazon-tag');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Stape Amazon template's tag type (got "${tmpl.type}"). Import stape-io/amazon-tag and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || 'Amazon CAPI Tag';
        const rows = (v: unknown): Array<{ name: string; value: string }> | undefined =>
          Array.isArray(v) ? v.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name) : undefined;
        const tag = buildAmazonCapiServerTag(tmpl.type, name, tagIds, region, {
          event: a.event != null ? s(a.event) : undefined,
          eventId: a.eventId != null ? s(a.eventId) : undefined,
          matchId: a.matchId != null ? s(a.matchId) : undefined,
          ipAddress: a.ipAddress != null ? s(a.ipAddress) : undefined,
          countryCode: a.countryCode != null ? s(a.countryCode) : undefined,
          enableAdvancedMatching: bln(a.enableAdvancedMatching),
          userData: rows(a.userData),
          defaultAttributes: rows(a.defaultAttributes),
          purchaseAttributes: rows(a.purchaseAttributes),
          customAttributes: rows(a.customAttributes),
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_hotjar_tag',
      description:
        'Create a Hotjar tracking tag (Custom HTML installing the hj() queue and loading static.hotjar.com). `siteId` is the Hotjar Site ID (hjid). Pass `userId` and/or `userAttributes` to also emit hj(\'identify\', userId, {...}), Hotjar\'s user-identity mechanism (email, plan, signup_date). Hotjar has no gallery template carrying identify, so Custom HTML is intentional. AFTER creating, call set_gtm_tag_consent with consentStatus "needed" and consentTypes ["analytics_storage"] (NOT the ad_* set). firingTriggerId is usually All Pages or Consent Initialization.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Hotjar - Tracking Code".' },
          siteId: { type: 'string', description: 'Hotjar Site ID (hjid).' },
          userId: { type: 'string', description: 'Stable user id for hj(\'identify\').' },
          userAttributes: {
            type: 'array',
            description: 'Identity attributes {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'siteId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Hotjar tag "${s(a.name).trim() || 'Hotjar - Tracking Code'}" (site ${s(a.siteId)})`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || 'Hotjar - Tracking Code', 'tag'),
      handler: async (a) => {
        if (!s(a.siteId).trim()) throw new Error('siteId is required (the Hotjar Site ID / hjid, a number or a {{variable}}).');
        const name = s(a.name).trim() || 'Hotjar - Tracking Code';
        const userAttributes = Array.isArray(a.userAttributes)
          ? a.userAttributes.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })).filter((p) => p.name)
          : undefined;
        const tag = buildHotjarTag(name, s(a.siteId), {
          userId: a.userId != null ? s(a.userId) : undefined,
          userAttributes,
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_pinterest_tag',
      description:
        'Create a Pinterest WEB tag from the Pinterest community template, imported automatically. `event`: a standard Pinterest event (pagevisit, viewcategory, viewcontent, addtocart, checkout = purchase, search, signup, lead, watchvideo); GA4 names are mapped; anything else becomes a CUSTOM event (eventName "ADE" + adeEventName). `enhancedMatchEmail` is a SHA-256-hashed email feeding the tag\'s Enhanced Match `em` field. AFTER creating, call set_gtm_tag_consent with consentStatus "needed" and consentTypes ["ad_storage","ad_user_data","ad_personalization"] (no built-in Consent Mode).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Pinterest - <Event> Tag".' },
          tagId: { type: 'string' },
          event: { type: 'string', description: 'e.g. checkout / addtocart / viewcontent, a GA4 name, or a custom name.' },
          enhancedMatchEmail: { type: 'string', description: 'SHA-256-hashed email for the tag\'s em field.' },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'event'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Pinterest tag for ${s(a.event)} (tag ${s(a.tagId)})`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || `Pinterest - ${s(a.event).trim()} Tag`, 'tag'),
      handler: async (a) => {
        const event = s(a.event).trim();
        if (!event) throw new Error('event is required (a Pinterest event like checkout/addtocart/viewcontent, a GA4 name, or a custom name).');
        if (!s(a.tagId).trim()) throw new Error('tagId is required (the Pinterest Tag ID).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'pinterest', 'ws-gtm-template');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Pinterest template's tag type (got "${tmpl.type}"). Import pinterest/ws-gtm-template and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || `Pinterest - ${event} Tag`;
        const em = a.enhancedMatchEmail != null && s(a.enhancedMatchEmail).trim() ? s(a.enhancedMatchEmail).trim() : undefined;
        const tag = buildPinterestTag(
          tmpl.type,
          name,
          s(a.tagId),
          event,
          Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
          em ? { em } : undefined,
        );
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_snap_pixel_tag',
      description:
        'Create a Snap Pixel WEB tag from the Snapchat community template, imported automatically. `event` sets event_type: a Snap event (PAGE_VIEW, ADD_CART, PURCHASE, START_CHECKOUT, SIGN_UP, SEARCH, VIEW_CONTENT, SUBSCRIBE, ADD_TO_WISHLIST, LOGIN, START_TRIAL, ADD_BILLING); GA4 names are mapped; unrecognised values fall back to PAGE_VIEW. `advancedMatching` rows carry user identity: names user_email / user_hashed_email / user_phone_number / user_hashed_phone_number / user_mobile_ad_id / user_hashed_mobile_ad_id (raw values are hashed by Snap on ingest; pre-hashed values go in the user_hashed_* fields). AFTER creating, call set_gtm_tag_consent with consentStatus "needed" and consentTypes ["ad_storage","ad_user_data","ad_personalization"] (no built-in Consent Mode).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional, defaults to "Snap - <Event> Tag".' },
          pixelId: { type: 'string', description: 'Snap Pixel ID (a UUID).' },
          event: { type: 'string', description: 'e.g. PURCHASE / ADD_CART / VIEW_CONTENT, a GA4 name, or a custom name.' },
          advancedMatching: {
            type: 'array',
            description: 'Advanced-matching rows {name,value}.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          firingTriggerId: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'pixelId', 'event'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create Snap Pixel tag for ${s(a.event)} (pixel ${s(a.pixelId)})`,
      precheck: (a) => findExistingByName(data, a, s(a.name).trim() || `Snap - ${s(a.event).trim()} Tag`, 'tag'),
      handler: async (a) => {
        const event = s(a.event).trim();
        if (!event) throw new Error('event is required (a Snap event like PURCHASE/ADD_CART/VIEW_CONTENT, a GA4 name, or a custom name).');
        if (!s(a.pixelId).trim()) throw new Error('pixelId is required (the Snap Pixel ID).');
        const tmpl = await data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), 'Snapchat', 'snapchat-google-tag-manager');
        if (!tmpl.type || !tmpl.type.startsWith('cvt_')) {
          throw new Error(`Could not resolve the Snap template's tag type (got "${tmpl.type}"). Import Snapchat/snapchat-google-tag-manager and check list_gtm_templates.`);
        }
        const name = s(a.name).trim() || `Snap - ${event} Tag`;
        const advancedMatching: Record<string, string> = {};
        if (Array.isArray(a.advancedMatching)) {
          for (const p of a.advancedMatching) {
            const nm = s(obj(p).name).trim();
            const v = s(obj(p).value);
            if (nm) advancedMatching[nm] = v;
          }
        }
        const tag = buildSnapPixelTag(
          tmpl.type,
          name,
          s(a.pixelId),
          event,
          Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
          Object.keys(advancedMatching).length ? advancedMatching : undefined,
        );
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'import_gallery_template',
      description:
        'Import a Community Template Gallery template into a workspace by GitHub owner + repository. The GTM API DOES support this (templates.import_from_gallery); do NOT tell the user it is UI-only. Works for ANY gallery template. Common owner/repository pairs: facebook / GoogleTagManager-WebTemplate-For-FacebookPixel; tiktok / gtm-template-pixel; linkedin / linkedin-gtm-community-template; Snapchat / snapchat-google-tag-manager; pinterest / ws-gtm-template (server: ss-gtm-template); stape-io / facebook-tag; stape-io / tiktok-tag. Idempotent. Returns the template and its tag TYPE code (cvt_), which you pass as `type` to create_gtm_tag along with the template\'s own field keys (template-specific, e.g. Meta Pixel uses pixelId, eventName, standardEventName).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          owner: { type: 'string' },
          repository: { type: 'string' },
          sha: { type: 'string', description: 'Optional gallery SHA/version; defaults to latest.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'owner', 'repository'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Import gallery template ${s(a.owner)}/${s(a.repository)} into workspace ${s(a.workspaceId)}`,
      handler: (a) => data.importGalleryTemplate(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.owner), s(a.repository), a.sha != null && s(a.sha) ? s(a.sha) : undefined),
    },
    {
      name: 'create_gtm_folder',
      description:
        'Create a folder in a GTM workspace to organise tags/triggers/variables. Folders are PURELY organisational, they do not change what fires. File items into it with move_gtm_entities_to_folder using the returned folderId.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create GTM folder "${s(a.name)}" in workspace ${s(a.workspaceId)}`,
      handler: (a) => data.createGtmFolder(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.name)),
    },
    {
      name: 'move_gtm_entities_to_folder',
      description:
        'Move tags, triggers and/or variables into a GTM folder (organisational only, does NOT change firing). Pass at least one of tagIds / triggerIds / variableIds. To file all GA4 tags: list_gtm_tags, keep the gaawe/gaawc/googtag ids, create_gtm_folder, then call this with those tagIds.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          folderId: { type: 'string' },
          tagIds: { type: 'array', items: { type: 'string' } },
          triggerIds: { type: 'array', items: { type: 'string' } },
          variableIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'folderId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => {
        const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
        return `Move ${n(a.tagIds)} tag(s), ${n(a.triggerIds)} trigger(s), ${n(a.variableIds)} variable(s) into folder ${s(a.folderId)}`;
      },
      handler: (a) =>
        data.moveEntitiesToFolder(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.folderId), {
          tagIds: Array.isArray(a.tagIds) ? a.tagIds.map(String) : [],
          triggerIds: Array.isArray(a.triggerIds) ? a.triggerIds.map(String) : [],
          variableIds: Array.isArray(a.variableIds) ? a.variableIds.map(String) : [],
        }),
    },
    {
      name: 'rename_gtm_folder',
      description:
        'Rename a GTM folder (organisational only). `name` is the new name.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          folderId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'folderId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Rename GTM folder ${s(a.folderId)} to "${s(a.name)}" in workspace ${s(a.workspaceId)}`,
      handler: (a) => data.renameGtmFolder(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.folderId), s(a.name)),
    },
    {
      name: 'delete_gtm_folder',
      description:
        'Delete a GTM folder (draft, not published). GTM does NOT delete its contents: the tags/triggers/variables become unfiled. Destructive, requires two confirmations.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          folderId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'folderId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) => `Delete GTM folder ${s(a.name) || s(a.folderId)} from workspace ${s(a.workspaceId)} (its items become unfiled, not deleted)`,
      handler: (a) => data.deleteGtmFolder(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.folderId)),
    },
    {
      name: 'create_gtm_tag',
      description:
        'Create a tag in a GTM workspace (draft). `tag` is a GTM API Tag resource ' +
        '{name, type, parameter?, firingTriggerId?}; link to a trigger via firingTriggerId:["<id>"]. ' +
        'PREFER create_gtm_tracking_tag, which builds these correctly. Using this raw tool, ' +
        '`parameter` must be exactly the GTM shape. GA4 EVENT tag, type "gaawe": event parameters go in ' +
        'eventSettingsTable as a LIST of MAP entries keyed parameter/parameterValue, NOT an ' +
        '"eventParameters" list of name/value, which GTM silently ignores: ' +
        '[{"type":"tagReference","key":"measurementId","value":""},' +
        '{"type":"template","key":"measurementIdOverride","value":"G-XXXXXXX or {{GA4 Variable}}"},' +
        '{"type":"template","key":"eventName","value":"email_click"},' +
        '{"type":"list","key":"eventSettingsTable","list":[' +
        '{"type":"map","map":[{"type":"template","key":"parameter","value":"link_url"},{"type":"template","key":"parameterValue","value":"{{Click URL}}"}]}]}]. ' +
        'Google tag, type "googtag" with [{"type":"template","key":"tagId","value":"G-XXXX/AW-XXXX/GT-XXXX"}]. ' +
        'Google Ads conversion, type "awct" with conversionId as the NUMERIC id only (GTM rejects an "AW-" prefix) ' +
        'plus conversionLabel. Google Ads remarketing, type "sp". Any platform with no native GTM template ' +
        '(Facebook Pixel, LinkedIn Insight, TikTok, Pinterest) uses type "html" (Custom HTML) with an ' +
        'html parameter carrying that platform\'s snippet. Pick the type matching the platform the user names.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tag: { type: 'object', description: 'GTM Tag resource: { name, type, parameter? }' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tag'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create tag "${s(obj(a.tag).name)}" (type ${s(obj(a.tag).type)}) in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(obj(a.tag).name), 'tag'),
      handler: (a) => data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.tag)),
    },
    {
      name: 'update_gtm_tag',
      description:
        'Update an existing tag in a GTM workspace. Read-modify-write: the current tag is fetched and only the fields you pass are overlaid, with `parameter` merged by key, so omitted fields like eventName/measurementId are preserved. To ADD GA4 event parameters use add_ga4_event_parameters instead: it appends to the eventSettingsTable without wiping the tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          tag: { type: 'object', description: 'Partial tag: only the fields to change. parameter[] is merged by key.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'tag'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Update tag ${s(a.tagId)} in workspace ${s(a.workspaceId)}`,
      handler: (a) => data.updateGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId), obj(a.tag)),
    },
    {
      name: 'add_ga4_event_parameters',
      description:
        'Add GA4 event parameters to an existing GA4 Event tag (type "gaawe"). Appends to the tag\'s eventSettingsTable, the correct place for them, and preserves eventName/measurementId so it never triggers "measurementIdOverride/eventName must not be empty". A name that already exists has its value updated, not duplicated. Values may be GTM variables like {{Click Text}}. Call once per tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string', description: 'The GA4 Event (gaawe) tag ID.' },
          parameters: {
            type: 'array',
            description: 'Event parameters to add.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'parameters'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Add ${(Array.isArray(a.parameters) ? a.parameters.length : 0)} GA4 event parameter(s) to tag ${s(a.tagId)} in workspace ${s(a.workspaceId)}`,
      handler: (a) =>
        data.addGa4EventParameters(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          s(a.tagId),
          (Array.isArray(a.parameters) ? a.parameters : []) as Array<{ name: string; value: string }>
        ),
    },
    {
      name: 'add_ga4_server_parameters',
      description:
        'Add event parameters and/or user properties to a GA4 SERVER tag (type "sgtmgaaw"): the server-side counterpart of add_ga4_event_parameters. Read-modify-write, preserving measurementId, eventName, "Include: All", excludes and triggers; a repeated name updates its value instead of duplicating. NOTE: a straight GA4 server relay already forwards every parameter of the incoming event, including client_id, user_id and the ecommerce fields, so use this only for ENRICHMENT (a country from a {{rh - ...}} header variable, a hashed id, a corrected page_location) or to override a value. Pass at least one of eventParameters / userProperties.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string', description: 'The GA4 SERVER (sgtmgaaw) tag ID.' },
          eventParameters: {
            type: 'array',
            description: 'Rows {name,value} for the sgtmgaaw "eventParameters" table.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          userProperties: {
            type: 'array',
            description: 'Rows {name,value} for the sgtmgaaw "userProperties" table.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Add ${(Array.isArray(a.eventParameters) ? a.eventParameters.length : 0)} event parameter(s) + ${(Array.isArray(a.userProperties) ? a.userProperties.length : 0)} user propert(y/ies) to GA4 server tag ${s(a.tagId)}`,
      handler: (a) =>
        data.addGa4ServerParameters(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId), {
          eventParameters: (Array.isArray(a.eventParameters) ? a.eventParameters.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })) : []),
          userProperties: (Array.isArray(a.userProperties) ? a.userProperties.map((p) => ({ name: s(obj(p).name), value: s(obj(p).value) })) : []),
        }),
    },
    {
      name: 'set_ga4_measurement_id',
      description:
        'Set/replace the Measurement ID on ONE GA4 tag. The value may be a literal id (G-/AW-/GT-XXXX) or a GTM variable like {{GA4 Variable}}. For a GA4 Event tag (gaawe) it sets measurementIdOverride; for a Google tag (googtag) it sets the tag ID. It builds the parameter correctly and preserves the rest of the tag, avoiding the "measurementIdOverride/template key" errors hand-editing produces. Call once per tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string', description: 'The GA4 Event (gaawe) or Google tag (googtag) tag ID.' },
          measurementId: {
            type: 'string',
            description: 'Measurement ID (G-/AW-/GT-XXXX) or a GTM variable like {{GA4 Variable}}.',
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'measurementId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Set Measurement ID to ${s(a.measurementId)} on tag ${s(a.tagId)} in workspace ${s(a.workspaceId)}`,
      handler: (a) =>
        data.setGa4MeasurementId(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId), s(a.measurementId)),
    },
    {
      name: 'set_gtm_tag_consent',
      description:
        'Set a tag\'s Consent Mode v2 settings: the fix for the "no Consent Mode v2 settings" audit finding. consentStatus "needed" plus consentTypes (ad_storage, analytics_storage, ad_user_data, ad_personalization) makes GTM block the tag until those are granted; "notNeeded" declares no additional consent is required (relying on Consent Mode at the Google-tag level). Read-modify-write, preserves the rest of the tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          consentStatus: { type: 'string', enum: ['needed', 'notNeeded'], description: 'needed = require the consentTypes; notNeeded = none required.' },
          consentTypes: {
            type: 'array',
            description: 'Required when consentStatus is "needed": ["analytics_storage"] for GA4, the three ad_* types for Ads.',
            items: { type: 'string' },
          },
          name: { type: 'string', description: 'Tag name, for display only.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'consentStatus'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => {
        const who = a.name ? `"${s(a.name)}" (${s(a.tagId)})` : `tag ${s(a.tagId)}`;
        const types = Array.isArray(a.consentTypes) && a.consentTypes.length ? ` — require ${a.consentTypes.join(', ')}` : '';
        const what = s(a.consentStatus) === 'notNeeded' ? 'No additional consent required' : `Require consent${types}`;
        return `Set consent on ${who}: ${what}`;
      },
      handler: (a) =>
        data.setGtmTagConsent(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          s(a.tagId),
          s(a.consentStatus),
          (Array.isArray(a.consentTypes) ? a.consentTypes : []) as string[]
        ),
    },
    {
      name: 'set_ga4_measurement_id_on_all_tags',
      description:
        'Set/replace the Measurement ID on ALL GA4 tags in the workspace in ONE call (GA4 event tags plus the Google tag). The value may be a literal id (G-/AW-/GT-XXXX) or a GTM variable like {{GA4 Variable}}. PREFER this whenever the user says "all GA4 tags" or "every GA4 tag"; do NOT loop set_ga4_measurement_id tag-by-tag. Preserves the rest of every tag, continues past a single failure, and returns an updated/failed summary.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          measurementId: {
            type: 'string',
            description: 'Measurement ID (G-/AW-/GT-XXXX) or a GTM variable like {{GA4 Variable}}.',
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'measurementId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Set Measurement ID to ${s(a.measurementId)} on ALL GA4 tags in workspace ${s(a.workspaceId)}`,
      handler: (a) =>
        data.setGa4MeasurementIdOnAllTags(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.measurementId)),
    },
    {
      name: 'add_ga4_event_parameters_to_all_tags',
      description:
        'Add GA4 event parameters to ALL GA4 Event tags (gaawe) in the workspace in ONE call. PREFER this whenever the user says "all GA4 tags" or "every GA4 event tag"; do NOT loop add_ga4_event_parameters tag-by-tag. Appends to each eventSettingsTable, updates in place if the name exists, preserves each tag, continues past a single failure, returns a summary. Values may be GTM variables like {{User ID}}.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          parameters: {
            type: 'array',
            description: 'Event parameters to add to every GA4 event tag.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'parameters'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Add ${(Array.isArray(a.parameters) ? a.parameters.length : 0)} GA4 event parameter(s) to ALL GA4 event tags in workspace ${s(a.workspaceId)}`,
      handler: (a) =>
        data.addGa4EventParametersToAllTags(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          (Array.isArray(a.parameters) ? a.parameters : []) as Array<{ name: string; value: string }>
        ),
    },
    {
      name: 'set_gtm_tag_paused',
      description:
        'Pause or unpause a tag in a GTM workspace, preserving its other settings. Applies the audit fix for a paused tag. paused=true pauses, false enables.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          paused: { type: 'boolean' },
          name: { type: 'string', description: 'Tag name, for display only.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'paused'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => {
        const verb = a.paused === true || s(a.paused) === 'true' ? 'Pause' : 'Unpause';
        const who = a.name ? `"${s(a.name)}" (${s(a.tagId)})` : `tag ${s(a.tagId)}`;
        return `${verb} ${who} in workspace ${s(a.workspaceId)}`;
      },
      handler: (a) =>
        data.setGtmTagPaused(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          s(a.tagId),
          a.paused === true || s(a.paused) === 'true'
        ),
    },
    {
      name: 'delete_gtm_tag',
      description:
        'Delete a tag from a GTM workspace (draft, not published). Destructive, requires two confirmations.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) => `Delete tag ${s(a.tagId)} from workspace ${s(a.workspaceId)}`,
      handler: (a) => data.deleteGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId)),
    },
    {
      name: 'delete_gtm_trigger',
      description:
        'Delete a trigger from a GTM workspace (draft, not published). Applies the audit fix for an unused trigger. Destructive, requires two confirmations.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          triggerId: { type: 'string' },
          name: { type: 'string', description: 'Trigger name, for display only.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'triggerId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) =>
        `Delete trigger ${a.name ? `"${s(a.name)}" (${s(a.triggerId)})` : s(a.triggerId)} from workspace ${s(a.workspaceId)}`,
      handler: (a) => data.deleteGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.triggerId)),
    },
    {
      name: 'delete_unused_gtm_triggers',
      description:
        'Bulk-delete the UNUSED (orphaned) triggers in a GTM workspace: referenced by no tag (firing or blocking) and not a Trigger Group member. By DEFAULT deletes ALL unused ones; pass triggerIds to delete only those, and any id actually in use or not found is skipped and reported, NEVER deleted. Prefer list_unused_gtm_triggers first so the user sees what will go. Destructive, confirms twice.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          triggerIds: { type: 'array', items: { type: 'string' }, description: 'Only these ids, and only if actually unused. Omit to delete ALL unused ones.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) => {
        const n = Array.isArray(a.triggerIds) && a.triggerIds.length ? `${a.triggerIds.length} selected` : 'all unlinked';
        return `Delete unused triggers (${n}) in workspace ${s(a.workspaceId)}`;
      },
      handler: async (a) => {
        const snap = await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId));
        const unused = findUnusedTriggers(snap);
        const byId = new Map(unused.map((t) => [t.triggerId, t]));
        const sel = Array.isArray(a.triggerIds) && a.triggerIds.length ? a.triggerIds.map(String) : null;
        const skipped: Array<{ triggerId: string; name: string; reason: string }> = [];
        let targets = unused;
        if (sel) {
          targets = [];
          for (const id of sel) {
            const u = byId.get(id);
            if (u) targets.push(u);
            else {
              const tr = snap.triggers.find((t) => t.triggerId === id);
              skipped.push({
                triggerId: id,
                name: tr?.name ?? '(unknown)',
                reason: tr ? 'in use (referenced by a tag or Trigger Group) — not deleted' : 'not found in this workspace',
              });
            }
          }
        }
        const deleted: Array<{ triggerId: string; name: string }> = [];
        const failed: Array<{ triggerId: string; name: string; error: string }> = [];
        for (const t of targets) {
          try {
            await withQuotaRetry(() => data.deleteGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), t.triggerId));
            deleted.push({ triggerId: t.triggerId, name: t.name });
          } catch (e) {
            failed.push({ triggerId: t.triggerId, name: t.name, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return { deletedCount: deleted.length, deleted, skipped, failed };
      },
    },
    {
      name: 'delete_unused_gtm_variables',
      description:
        'Bulk-delete the UNUSED (orphaned) variables in a GTM workspace: {{name}} referenced by no tag, trigger or other variable in the readable fields. By DEFAULT deletes ALL unused ones; pass variableIds to delete only those, and any id actually referenced or not found is skipped and reported. Prefer list_unused_gtm_variables first. CAUTION: unlike triggers, the GTM API does NOT refuse to delete a REFERENCED variable, and this detection is a hint, not proof: a variable used only in a published version, or in a field the audit cannot read, could be wrongly deleted, silently breaking that {{reference}}. Destructive, confirms twice.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          variableIds: { type: 'array', items: { type: 'string' }, description: 'Only these ids, and only if actually unused. Omit to delete ALL unused ones.' },
        },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) => {
        const n = Array.isArray(a.variableIds) && a.variableIds.length ? `${a.variableIds.length} selected` : 'all unreferenced';
        return `Delete unused variables (${n}) in workspace ${s(a.workspaceId)}`;
      },
      handler: async (a) => {
        const snap = await data.getGtmContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId));
        const unused = findUnusedVariables(snap);
        const byId = new Map(unused.map((v) => [v.variableId, v]));
        const sel = Array.isArray(a.variableIds) && a.variableIds.length ? a.variableIds.map(String) : null;
        const skipped: Array<{ variableId: string; name: string; reason: string }> = [];
        let targets = unused;
        if (sel) {
          targets = [];
          for (const id of sel) {
            const u = byId.get(id);
            if (u) targets.push(u);
            else {
              const v = snap.variables.find((x) => x.variableId === id);
              skipped.push({
                variableId: id,
                name: v?.name ?? '(unknown)',
                reason: v ? 'referenced (in use) — not deleted' : 'not found in this workspace',
              });
            }
          }
        }
        const deleted: Array<{ variableId: string; name: string }> = [];
        const failed: Array<{ variableId: string; name: string; error: string }> = [];
        for (const v of targets) {
          try {
            await withQuotaRetry(() => data.deleteGtmVariable(s(a.accountId), s(a.containerId), s(a.workspaceId), v.variableId));
            deleted.push({ variableId: v.variableId, name: v.name });
          } catch (e) {
            failed.push({ variableId: v.variableId, name: v.name, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return { deletedCount: deleted.length, deleted, skipped, failed };
      },
    },
    {
      name: 'delete_gtm_variable',
      description:
        'Delete a variable from a GTM workspace (draft, not published). Destructive, requires two confirmations; verify it is not used by a published version first.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          variableId: { type: 'string' },
          name: { type: 'string', description: 'Variable name, for display only.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'variableId'],
        additionalProperties: false,
      },
      write: true,
      destructive: true,
      summarize: (a) =>
        `Delete variable ${a.name ? `"${s(a.name)}" (${s(a.variableId)})` : s(a.variableId)} from workspace ${s(a.workspaceId)}`,
      handler: (a) => data.deleteGtmVariable(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.variableId)),
    },
    {
      name: 'enable_gtm_builtin_variables',
      description:
        'Enable built-in variables in a GTM workspace. `types` are built-in TYPE KEYS: clickUrl ' +
        '({{Click URL}}), clickText ({{Click Text}}), clickClasses, clickId, clickElement, pageUrl, ' +
        'pageHostname, pagePath, referrer. There is NO built-in for "Page Title": create a Custom ' +
        'JavaScript variable returning document.title (GA4 auto-collects page_title and page_location, ' +
        'so usually you do not need them as event parameters).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          types: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'types'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Enable built-in variables: ${(Array.isArray(a.types) ? a.types : []).join(', ')}`,
      handler: (a) =>
        data.enableGtmBuiltInVariables(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          Array.isArray(a.types) ? a.types.map(String) : []
        ),
    },
    {
      name: 'create_gtm_tag_with_trigger',
      description:
        'One-shot: create a tag that fires on a trigger in a single call. Enables needed built-in ' +
        'variables, REUSES a same-named trigger or creates it, then creates the tag linked to it. Use ' +
        'this rather than separate create_gtm_trigger + create_gtm_tag calls. `tag` is a GTM Tag ' +
        'resource {name,type,parameter?} and `trigger` a GTM Trigger resource {name,type,filter?}; ' +
        '`builtInVariables` are TYPE KEYS like ["clickUrl","clickText","pageUrl"] (there is NO built-in ' +
        'for Page Title). For a GA4 event tag use type "gaawe" with the eventSettingsTable shape ' +
        'described in create_gtm_tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tag: { type: 'object', description: 'GTM Tag resource {name, type, parameter?}' },
          trigger: { type: 'object', description: 'GTM Trigger resource {name, type, filter?}' },
          builtInVariables: { type: 'array', items: { type: 'string' } },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tag', 'trigger'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create tag "${s(obj(a.tag).name)}" firing on trigger "${s(obj(a.trigger).name)}" in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(obj(a.tag).name), 'tag'),
      handler: async (a) => {
        const accountId = s(a.accountId);
        const containerId = s(a.containerId);
        const workspaceId = s(a.workspaceId);
        const tag = obj(a.tag);
        const trigger = obj(a.trigger);
        const builtIns = Array.isArray(a.builtInVariables) ? a.builtInVariables.map(String) : [];

        // 1. Enable needed built-in variables (best-effort: already-enabled is fine).
        let enabledVariables: string[] = [];
        if (builtIns.length) {
          try {
            enabledVariables = await data.enableGtmBuiltInVariables(accountId, containerId, workspaceId, builtIns);
          } catch {
            enabledVariables = builtIns; // likely already enabled
          }
        }

        // 2. Reuse an existing trigger with the same name, else create it.
        const triggerName = s(trigger.name);
        const existing = (await data.listGtmTriggers(accountId, containerId, workspaceId)).find(
          (t) => t.name.toLowerCase() === triggerName.toLowerCase()
        );
        let triggerId: string;
        let reusedTrigger = false;
        if (existing) {
          triggerId = existing.triggerId;
          reusedTrigger = true;
        } else {
          triggerId = (await data.createGtmTrigger(accountId, containerId, workspaceId, trigger)).triggerId;
        }

        // 3. Create the tag linked to that trigger.
        const createdTag = await data.createGtmTag(accountId, containerId, workspaceId, {
          ...tag,
          firingTriggerId: [triggerId],
        });

        return {
          tag: createdTag,
          trigger: { triggerId, name: triggerName, reused: reusedTrigger },
          enabledVariables,
        };
      },
    },
    {
      name: 'create_gtm_trigger',
      description:
        'Create a trigger in a GTM workspace. `trigger` is a GTM API Trigger resource. ' +
        'All-elements click uses type "click"; click-on-links uses "linkClick" (NOT "all_clicks" / ' +
        '"allElements" / "form_submit"; common aliases are auto-corrected but prefer the exact value). ' +
        'Filter operator types are LOWERCASE (equals, contains, startsWith, endsWith, matchRegex) and ' +
        'conditions go in `filter` with arg0/arg1 template parameters, e.g. Click URL contains mailto: ' +
        '{"name":"Email link click","type":"linkClick","filter":[{"type":"contains",' +
        '"parameter":[{"type":"template","key":"arg0","value":"{{Click URL}}"},' +
        '{"type":"template","key":"arg1","value":"mailto:"}]}]} ' +
        '(the {{Click URL}} built-in must be enabled). ' +
        'A CUSTOM EVENT trigger uses type "customEvent" with the event name in customEventFilter as ' +
        '{{_event}} equals <name>. Do NOT use a top-level "eventName" field: that is TIMER-only and the ' +
        'API rejects it here. customEventFilter must hold ONLY that single {{_event}} match; any ' +
        'ADDITIONAL scope conditions ({{Page Path}} contains /checkout, {{Form ID}} equals x) go in ' +
        '`filter` (the API rejects more than one custom-event filter; misplaced extras are moved for you).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          trigger: { type: 'object', description: 'GTM Trigger resource' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'trigger'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create trigger "${s(obj(a.trigger).name)}" (type ${s(obj(a.trigger).type)}) in workspace ${s(a.workspaceId)}`,
      precheck: async (a) => {
        const t = obj(a.trigger);
        const existing = await data.listGtmTriggers(s(a.accountId), s(a.containerId), s(a.workspaceId));
        const match = findExistingTrigger(existing, { name: s(t.name), type: s(t.type), customEventName: customEventNameOf(t) });
        return match
          ? { alreadyExists: true, reused: true, trigger: match, message: `Trigger "${match.name}" already exists (ID ${match.triggerId}) — reused, not created.` }
          : null;
      },
      handler: (a) => data.createGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.trigger)),
    },
    {
      name: 'update_gtm_trigger',
      description:
        'Update an existing trigger IN PLACE (read-modify-write). The GTM API DOES support this: do NOT delete and recreate a trigger to change it (and you cannot delete one that tags reference). Sets its display `name` and/or, for a Custom Event trigger, its `eventName`, the dataLayer event it matches, normalized to snake_case. Tags keep firing on the same trigger id. Pass name and/or eventName.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          triggerId: { type: 'string' },
          name: { type: 'string', description: 'New display name (optional).' },
          eventName: { type: 'string', description: 'New Custom Event name: the dataLayer event it matches, e.g. purchase.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'triggerId'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Update trigger ${s(a.triggerId)}${a.eventName != null ? ` — Event name → ${s(a.eventName)}` : ''}${a.name != null ? ` — name → ${s(a.name)}` : ''}`,
      handler: (a) => {
        if (a.name == null && a.eventName == null) throw new Error('Pass name and/or eventName to update.');
        return data.updateGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.triggerId), {
          name: a.name != null ? s(a.name) : undefined,
          eventName: a.eventName != null ? s(a.eventName) : undefined,
        });
      },
    },
    {
      name: 'create_gtm_variable',
      description: 'Create a variable in a GTM workspace from a raw GTM Variable resource {name, type, ...}. Prefer create_gtm_variable_typed.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          variable: { type: 'object', description: 'GTM Variable resource' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'variable'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create variable "${s(obj(a.variable).name)}" (type ${s(obj(a.variable).type)}) in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(obj(a.variable).name), 'variable'),
      handler: (a) => data.createGtmVariable(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.variable)),
    },
  ];

  // Context tools switch the app's ACTIVE workspace/container (no GTM mutation), so they
  // need no confirm — they exist only when a context controller is wired (the chat path).
  const contextTools: Tool[] = ctxControl
    ? [
        {
          name: 'set_gtm_workspace',
          description:
            'Switch the ACTIVE GTM workspace (the one in the app bar, used by the audit and new operations) within the current account and container. Accepts workspaceId OR workspaceName (case-insensitive). Use when the user says "switch to workspace X". Does NOT modify GTM, it only re-points the app.',
          inputSchema: {
            type: 'object',
            properties: { workspaceId: { type: 'string' }, workspaceName: { type: 'string' } },
            additionalProperties: false,
          },
          handler: async (a) => {
            const cur = ctxControl.current();
            if (!cur?.accountId || !cur?.containerId)
              throw new Error('No active GTM account/container — pick one in the GTM bar first, then switch workspace.');
            const wantId = s(a.workspaceId);
            const wantName = s(a.workspaceName);
            if (!wantId && !wantName) throw new Error('Provide workspaceId or workspaceName.');
            const wss = await data.listGtmWorkspaces(cur.accountId, cur.containerId);
            const match = wss.find(
              (w) => (wantId && w.workspaceId === wantId) || (wantName && w.name.toLowerCase() === wantName.toLowerCase()),
            );
            if (!match)
              throw new Error(
                `Workspace "${wantName || wantId}" not found in ${cur.containerName ?? cur.containerId}. Available: ${wss.map((w) => w.name).join(', ') || '(none)'}.`,
              );
            const ctx: GtmContext = { ...cur, workspaceId: match.workspaceId, workspaceName: match.name };
            await ctxControl.set(ctx);
            return { switched: true, accountName: ctx.accountName, containerName: ctx.containerName, workspaceId: match.workspaceId, workspaceName: match.name };
          },
        },
        {
          name: 'set_gtm_container',
          description:
            'Switch the ACTIVE GTM container within the current account, by containerId OR containerName (case-insensitive). Optionally set the workspace too; otherwise "Default Workspace", or the first workspace, is selected. Use when the user says "switch to container X". Does NOT modify GTM, it only re-points the app.',
          inputSchema: {
            type: 'object',
            properties: {
              containerId: { type: 'string' },
              containerName: { type: 'string' },
              workspaceId: { type: 'string' },
              workspaceName: { type: 'string' },
            },
            additionalProperties: false,
          },
          handler: async (a) => {
            const cur = ctxControl.current();
            if (!cur?.accountId) throw new Error('No active GTM account — pick one in the GTM bar first.');
            const wantId = s(a.containerId);
            const wantName = s(a.containerName);
            if (!wantId && !wantName) throw new Error('Provide containerId or containerName.');
            const containers = await data.listGtmContainers(cur.accountId);
            const c = containers.find(
              (x) => (wantId && x.containerId === wantId) || (wantName && x.name.toLowerCase() === wantName.toLowerCase()),
            );
            if (!c)
              throw new Error(
                `Container "${wantName || wantId}" not found in ${cur.accountName ?? cur.accountId}. Available: ${containers.map((x) => x.name).join(', ') || '(none)'}.`,
              );
            const wss = await data.listGtmWorkspaces(cur.accountId, c.containerId);
            const wsWantId = s(a.workspaceId);
            const wsWantName = s(a.workspaceName);
            const ws =
              wss.find((w) => (wsWantId && w.workspaceId === wsWantId) || (wsWantName && w.name.toLowerCase() === wsWantName.toLowerCase())) ??
              wss.find((w) => w.name.toLowerCase() === 'default workspace') ??
              wss[0];
            if (!ws) throw new Error(`Container "${c.name}" has no workspaces.`);
            const ctx: GtmContext = {
              accountId: cur.accountId,
              accountName: cur.accountName,
              containerId: c.containerId,
              containerName: c.name,
              workspaceId: ws.workspaceId,
              workspaceName: ws.name,
            };
            await ctxControl.set(ctx);
            return { switched: true, containerId: c.containerId, containerName: c.name, workspaceId: ws.workspaceId, workspaceName: ws.name };
          },
        },
      ]
    : [];

  // Chat MEMORY tools (remember / forget). Present only when a memory context is wired (the chat path).
  // They write to the LOCAL memory store (not GTM), so they are NOT gated by `confirm` and are NOT GTM/GA4
  // writes — the user telling the assistant to remember/forget is explicit consent. Product-agnostic:
  // appended AFTER the product filter so they work in both GTM and GA4 chats.
  const memoryTools: Tool[] = memoryCtx
    ? [
        {
          name: 'remember_memory',
          description:
            'Save a durable NOTE to the assistant\'s memory for this account/client so it is recalled in FUTURE chats. ' +
            'Call this when the user tells you to remember something, states a lasting preference, correction or ' +
            'decision ("we use order_completed for purchase", "don\'t suggest scroll tracking again"), or after a ' +
            'NOTABLE persistent change they would want on record. Be CONSERVATIVE: never save transient values, ' +
            'one-off numbers, secrets, API keys or personal data. Confirm briefly what you saved.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The note, a short standalone statement (not "the user said..."). Under 200 chars.' },
              kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'rule = an instruction to follow; glossary = a client term/event mapping. Default fact.' },
              scope: { type: 'string', enum: ['account', 'client'], description: 'client = current container/property only; account = all of it. Default client when one is active.' },
            },
            required: ['text'],
            additionalProperties: false,
          },
          handler: async (a): Promise<unknown> => {
            const text = s(a.text).trim();
            if (!text) return { saved: false, message: 'No text to remember.' };
            const kind = (MEMORY_KINDS.includes(a.kind as MemoryKind) ? a.kind : 'fact') as MemoryKind;
            const active = memoryCtx.scope(); // resolved NOW: the container may have changed this turn
            const wantClient = a.scope === 'client' || (a.scope == null && (active.containerId || active.property));
            const scope: MemoryScope = wantClient ? { ...active } : {};
            const res = memoryCtx.store.add(memoryCtx.accountId, { kind, text, scope, source: 'chat' });
            return { saved: true, deduped: res.deduped, secretRemoved: res.redacted, kind: res.memory.kind, text: res.memory.text, scope: res.memory.scope.containerId || res.memory.scope.property ? 'client' : 'account' };
          },
        },
        {
          name: 'recall_memories',
          description:
            'SEARCH the saved memories for this Google account and read back what matches. A few of the most relevant ' +
            'notes are injected automatically each turn; call this when that is not enough: the user asks what you ' +
            'remember, refers to something agreed earlier that is not in front of you, or you are about to build or ' +
            'change something and want the client\'s saved rules first. scope="all" (default) looks across OTHER ' +
            'clients of this account too; "context" is the active client plus account-wide notes. Returns only what ' +
            'is saved: if nothing matches, say you have no note on it rather than guessing.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to look for, in the user\'s words. Empty lists the most relevant notes.' },
              scope: { type: 'string', enum: ['all', 'context', 'account'], description: 'all = every note under this account (default); context = active client plus account-wide; account = account-wide only.' },
              limit: { type: 'number', description: 'Max notes to return (default 10, max 25).' },
            },
            required: [],
            additionalProperties: false,
          },
          handler: async (a): Promise<unknown> => {
            const query = s(a.query).trim();
            const scope = (['all', 'context', 'account'].includes(s(a.scope)) ? s(a.scope) : 'all') as MemorySearchScope;
            const limit = Math.min(25, Math.max(1, Math.floor(Number(a.limit) || 10)));
            const active = memoryCtx.scope();
            const all = memoryCtx.store.list(memoryCtx.accountId);
            // Search UNLIMITED, then slice here, so the model is told how much it is NOT seeing instead
            // of being handed a silently truncated list it would present as everything saved.
            const matched = searchMemories(all, query, {
              scope,
              ctx: { containerId: active.containerId, property: active.property },
              limit: Number.MAX_SAFE_INTEGER,
            });
            const hits = matched.slice(0, limit);
            // Recalled notes shape the answer, so they belong in this turn's provenance. The chat
            // service credits each id once and owns the usage log (counting here too would double-count
            // a note that was also injected). Best-effort: provenance must never fail the answer.
            if (hits.length) {
              try {
                memoryCtx.onRecall?.(hits.map((h) => h.memory));
              } catch (e) {
                console.error('[tool] recall_memories provenance failed (continuing):', e instanceof Error ? e.message : e);
              }
            }
            return {
              // Only enabled notes are searchable at all, so report that as the pool rather than a
              // total that includes muted ones.
              searched: all.filter((m) => m.enabled).length,
              matched: matched.length,
              found: hits.length,
              scope,
              memories: hits.map((h) => ({
                kind: h.memory.kind,
                text: h.memory.text,
                scope: h.memory.scope.containerId || h.memory.scope.property
                  ? { client: h.memory.scope.label || h.memory.scope.containerId || h.memory.scope.property }
                  : 'account',
                pinned: h.memory.pinned,
                savedBy: h.memory.source,
                updatedAt: new Date(h.memory.updatedAt).toISOString().slice(0, 10),
              })),
              ...(hits.length === 0
                ? { note: 'Nothing saved matches. Tell the user you have no note on this rather than guessing.' }
                : matched.length > hits.length
                  ? { note: `${matched.length} notes matched; the ${hits.length} most relevant are returned. Say the list is partial, or call again with a narrower query or a higher limit.` }
                  : {}),
            };
          },
        },
        {
          name: 'forget_memory',
          description:
            'Remove saved memories matching a description. Call this when the user says to forget or stop applying ' +
            'something ("forget that", "stop suggesting Y"). Pass a distinctive query: every memory whose text ' +
            'matches is removed and reported. If nothing matches, say so.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'What to forget, matched against saved memory text.' } },
            required: ['query'],
            additionalProperties: false,
          },
          handler: async (a): Promise<unknown> => {
            const query = s(a.query).trim();
            const matches = findMemoriesMatching(memoryCtx.store.list(memoryCtx.accountId), query);
            for (const m of matches) memoryCtx.store.remove(memoryCtx.accountId, m.id);
            return { removed: matches.length, texts: matches.map((m) => m.text) };
          },
        },
      ]
    : [];

  // CORPUS retrieval. Reads the anonymized pattern library that ships inside the app (mined from the
  // operator's own historical GTM containers), so the assistant can answer "how do WE usually build
  // this?" with real counts on ANY machine — no local corpus, no network, no account data involved.
  // Read-only and product-agnostic (event-name conventions matter in GA4 chats too), so like the memory
  // tools it is appended AFTER the product filter.
  const corpusTools: Tool[] = [
    {
      name: 'lookup_corpus_patterns',
      description:
        'Look up how tags, triggers and variables were ACTUALLY built across the operator\'s own past GTM containers ' +
        '(an anonymized pattern library shipped with the app). Call this before proposing a naming convention, an ' +
        'event name, a trigger shape or a vendor setup, and whenever the user asks what is typical or "how do we ' +
        'usually do this". Search by intent ("form submit", "purchase ecommerce", "meta pixel"). Each result carries ' +
        'the number of distinct containers it appeared in, so cite the real count instead of saying "commonly". ' +
        'IMPORTANT: these are FREQUENCY counts from past work, not industry benchmarks and not proof a pattern is ' +
        'correct; never present them as a reading of the CURRENT container (use the GTM read tools for that).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for, in plain words or an event name. Empty lists the most common patterns.' },
          kind: { type: 'string', enum: ['all', 'tag', 'trigger', 'variable', 'vendor'], description: 'Restrict to one kind. vendor = platform adoption counts. Default all.' },
          brand: {
            type: 'string',
            enum: ['ga4', 'googtag', 'gads', 'meta', 'tiktok', 'linkedin', 'msads', 'snap', 'pinterest', 'hotjar', 'clarity', 'floodlight', 'consent', 'amplitude', 'x', 'html', 'img'],
            description: 'Restrict TAG results to one vendor. Common names work too (facebook = meta, bing = msads).',
          },
          limit: { type: 'number', description: `Max patterns to return (default ${LOOKUP_DEFAULT_LIMIT}, max ${LOOKUP_MAX_LIMIT}).` },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (a): Promise<unknown> => {
        const lib = getPatternLibrary();
        if (!lib) {
          return {
            available: false,
            note: 'No pattern library is bundled with this build. Answer from the live container and general knowledge, and do not cite any frequency.',
          };
        }
        const base = lookupCorpusPatterns(lib, {
          query: s(a.query),
          kind: (['all', 'tag', 'trigger', 'variable', 'vendor'].includes(s(a.kind)) ? s(a.kind) : 'all') as CorpusLookupKind,
          brand: s(a.brand),
          ...(a.limit != null ? { limit: Number(a.limit) } : {}),
        });
        // SEMANTIC PASS (opt-in). Keyword search cannot connect "asking for a demo" to
        // schedule_a_consultation_click, because the words genuinely differ. When enabled, terms that
        // are semantically near the query run a SECOND keyword lookup, and the two orderings are
        // fused, so an exact hit can never be displaced by something that merely feels similar.
        // Anything unavailable (off, no key, still building, provider error) returns `base` unchanged.
        if (!semantic || !s(a.query).trim()) return base;
        try {
          const terms = await semantic(s(a.query));
          if (!terms?.length) return base;
          const extra = terms
            .flatMap((t) => lookupCorpusPatterns(lib, { query: t, kind: 'all', limit: 4 }).hits)
            .filter((h) => !base.hits.some((b) => b.pattern === h.pattern));
          if (!extra.length) return base;
          const order = fuseRankings(base.hits.map((h) => h.pattern), extra.map((h) => h.pattern));
          const byPattern = new Map([...base.hits, ...extra].map((h) => [h.pattern, h]));
          const hits = order.map((k) => byPattern.get(k)).filter((h): h is NonNullable<typeof h> => !!h).slice(0, base.hits.length);
          return {
            ...base,
            hits,
            semantic: { used: true, relatedTerms: terms.slice(0, 8) },
            note: `${base.note ? base.note + ' ' : ''}Semantic search also matched terms that share no words with the query (${terms.slice(0, 4).join(', ')}), so results include patterns keyword search alone would miss.`,
          };
        } catch {
          return base; // semantic search is an enhancement, never a failure mode
        }
      },
    },
  ];

  // GOOGLE ADS belongs to the GTM toolset, NOT to a product of its own and NOT to the GA4 chat: its
  // entire job here is to hand the GTM half a real Conversion ID + Label so a google_ads_conversion tag
  // can be built without asking the user to paste them. So these go through the SAME product filter as
  // everything else (productOf files them under 'gtm', since no Ads tool name contains "ga4"), and the
  // create tool rides in the confirm-gated half exactly like every other write.
  const adsTools: Tool[] = ads ? buildGoogleAdsTools(ads, Boolean(confirm)) : [];

  // GA4 Admin write tools (product 'ga4') live in a separate catalog; included
  // only when a confirm function is provided, exactly like the GTM write tools.
  const all = [...readTools, ...(confirm ? [...writeTools, ...buildGa4WriteTools(data)] : []), ...contextTools, ...adsTools];
  const tools = [...(product ? all.filter((t) => productOf(t.name) === product) : all), ...memoryTools, ...corpusTools];

  return {
    // SENT list only. Tools that cannot act on the active container's kind are withheld to keep the
    // request small, but they stay EXECUTABLE below: the system prompt names several of them
    // outright, so a model that switched container mid-turn and calls one by name must still get the
    // real behaviour rather than "Unknown tool".
    list: (): LlmToolDef[] =>
      tools
        .filter((t) => toolAllowedForContainer(t.name, containerKind))
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    execute: async (name, args): Promise<string> => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        const near = closestToolNames(name, tools.map((t) => t.name));
        console.error(`[tool] ✗ model called UNKNOWN tool "${name}"${near.length ? ` — closest: ${near.join(', ')}` : ''}`);
        throw new Error(
          `Unknown tool: ${name}.${near.length ? ` Did you mean: ${near.join(', ')}? Call one of those EXACT names.` : ''}`
        );
      }
      console.error(`[tool] → ${name}${tool.write ? ' [write]' : ''} args=${truncForLog(JSON.stringify(args ?? {}))}`);

      // Guard against the model calling a plausible-looking tool with ANOTHER tool's
      // arguments (observed: set_gtm_tag_paused called with measurementId and no tagId →
      // a cryptic GTM 404). Validate the schema's required fields up front; if they are
      // missing AND the supplied args fully satisfy a different tool, redirect the model
      // there instead of firing a doomed request or showing a bad approval card.
      const provided = Object.keys(args ?? {}).filter((k) => (args as Record<string, unknown>)[k] !== undefined);
      const requiredOf = (t: { inputSchema: Record<string, unknown> }): string[] =>
        Array.isArray((t.inputSchema as { required?: unknown }).required) ? ((t.inputSchema as { required: string[] }).required) : [];
      const missing = requiredOf(tool).filter((r) => !provided.includes(r));
      if (missing.length) {
        const better = tools
          .filter((t) => t.name !== name && t.write === tool.write && requiredOf(t).length > 0 && requiredOf(t).every((r) => provided.includes(r)))
          // Most SPECIFIC match first (uses the most of the supplied args) — otherwise any
          // tool requiring just the workspace triple crowds out the tool the args really fit.
          .sort((a, b) => requiredOf(b).length - requiredOf(a).length)
          .map((t) => t.name)
          .slice(0, 3);
        const msg =
          `Tool "${name}" requires [${requiredOf(tool).join(', ')}] but is missing [${missing.join(', ')}] (you sent [${provided.join(', ')}]).` +
          (better.length ? ` Those arguments match a different tool — call one of these instead: ${better.join(', ')}.` : '');
        console.error(`[tool] ✗ ${name} BAD ARGS → ${msg}`);
        throw new Error(msg);
      }

      let effectiveArgs = args ?? {};
      // Idempotency: if a create tool's target already exists, report it and SKIP — no
      // duplicate, and (importantly) no approval prompt for a no-op.
      if (tool.precheck) {
        const pc = await tool.precheck(effectiveArgs);
        if (pc) {
          console.error(`[tool] ${name}: already present → skipped (no create, no approval)`);
          return JSON.stringify(pc);
        }
      }
      if (tool.write) {
        if (!confirm) {
          console.error(`[tool] ${name}: writes disabled (no confirm fn)`);
          return JSON.stringify({ declined: true, message: 'Write tools are disabled.' });
        }
        // Approval is DELETE-ONLY (user decision 2026-07-03): non-destructive writes (create/edit
        // tags, triggers, variables, folders, …) apply directly — they land in a DRAFT workspace,
        // are never published by us, and are reversible there. Destructive tools keep the full
        // two-step approval below. The confirm fn still gates write-tool AVAILABILITY above.
        if (tool.destructive) {
          const summary = tool.summarize ? tool.summarize(effectiveArgs) : tool.name;
          const declined = JSON.stringify({ declined: true, message: 'The user declined this change.' });

          // The user may edit names/types/config in the approval card; the returned
          // args replace the model's proposal.
          const edited = await confirm({
            tool: tool.name,
            summary,
            details: effectiveArgs,
            destructive: true,
          });
          if (!edited) {
            console.error(`[tool] ${name}: user DECLINED in approval card`);
            return declined;
          }
          if (JSON.stringify(edited) !== JSON.stringify(effectiveArgs)) {
            console.error(`[tool] ${name}: args EDITED in approval card → ${truncForLog(JSON.stringify(edited))}`);
          }
          effectiveArgs = edited;

          // Deletes require a SECOND, final confirmation.
          const again = await confirm({
            tool: tool.name,
            summary: `FINAL CONFIRMATION — permanently ${tool.summarize ? tool.summarize(effectiveArgs) : summary}. This cannot be undone.`,
            details: effectiveArgs,
            destructive: true,
            requireTextConfirm: 'delete', // type "delete" to confirm
          });
          if (!again) {
            console.error(`[tool] ${name}: user DECLINED final confirmation`);
            return declined;
          }
        } else {
          console.error(`[tool] ${name}: write auto-applied (approval is delete-only)`);
        }
      }
      try {
        const result = await tool.handler(effectiveArgs);
        console.error(`[tool] ✓ ${name} → ${truncForLog(JSON.stringify(result))}`);
        return JSON.stringify(result);
      } catch (e) {
        const msg = apiErrorMessage(e);
        console.error(`[tool] ✗ ${name} FAILED: ${msg}`);
        throw new Error(msg);
      }
    },
  };
}
