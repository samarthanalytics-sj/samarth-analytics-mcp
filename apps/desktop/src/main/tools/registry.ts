import type { GoogleDataService } from '../google/data-service';
import type { LlmToolDef, ToolExecutor } from '../llm/types';
import type { GoogleProduct, GtmContext } from '../../shared/ipc';
import type { AuditHistoryStore } from '../storage/audit-history';
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
  builtInVarsForTemplates,
  buildVariable,
  buildUrlQueryVariable,
  buildClickTextLookupVariable,
  findExistingTrigger,
  customEventNameOf,
  buildGa4ServerTag,
  buildAdsConversionServerTag,
  buildAdsConversionLinkerServerTag,
  buildAdsRemarketingServerTag,
  buildAllowParamsTransformation,
  buildServerAllEventsTrigger,
  buildMetaPixelTag,
  buildMetaCapiServerTag,
  metaStandardEvent,
  buildTikTokCapiServerTag,
  tikTokStandardEvent,
  auditServerContainer,
  detectMetaTags,
  findUnusedTriggers,
  findUnusedVariables,
  type TriggerInput,
  type VariableKind,
  type GtmTagResource,
} from '../google/gtm-builders';
import { withQuotaRetry } from '../google/quota-retry';
import { auditWorkspace, auditChanges } from '../google/audit-runner';
import { diffSnapshots } from '../google/gtm-monitor';
import { auditGa4 } from '../google/ga4-audit';
import { auditGa4DataQuality } from '../google/ga4-data-quality';
import { buildScorecard, type ScorecardSection } from '../google/scorecard';
import { buildReport } from '../google/report';
import { consentReportToSection } from '../google/consent-section';
import { extractConfiguredGa4Ids, crossCheckMeasurementIds } from '../google/gtm-ga4-check';

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

interface Tool extends LlmToolDef {
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
  return (
    g?.response?.data?.error?.message ??
    g?.errors?.[0]?.message ??
    g?.message ??
    String(e)
  );
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
]);

// Tool product is derived from its name (GA4 Analytics tools contain "ga4", GTM tools
// contain "gtm") — used to hard-scope the registry to one product — EXCEPT the GTM
// tag-edit tools above, which operate on GTM despite the "ga4" in their name.
const productOf = (name: string): GoogleProduct =>
  name.includes('ga4') && !GTM_GA4_TAG_TOOLS.has(name) ? 'ga4' : 'gtm';

export function buildToolRegistry(
  data: GoogleDataService,
  confirm?: ConfirmFn,
  product?: GoogleProduct,
  history?: AuditHistoryStore,
  ctxControl?: GtmContextControl
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
      description: 'List the workspaces in a GTM container. Requires accountId and containerId.',
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
        'List the folders in a GTM workspace (each folder\'s name + folderId). The GTM API DOES expose this (folders.list) — use it to find a folder\'s id before move_gtm_entities_to_folder / rename_gtm_folder / delete_gtm_folder, instead of asking the user to read ids from the GTM UI. Requires accountId, containerId, workspaceId.',
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
        "List the container's GTM environments (Test/Staging/etc.) — each one's environmentId, type, gtm_auth token (authorizationCode), and a ready-to-paste install snippet (head <script> + body <noscript>). The GTM API DOES manage environments, so use this (and create_gtm_environment) instead of telling the user to do it in the GTM UI. Requires accountId, containerId.",
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
        'List the tags in a GTM workspace. Requires accountId, containerId, workspaceId.',
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
      name: 'list_gtm_triggers',
      description: 'List the triggers in a GTM workspace. Requires accountId, containerId, workspaceId.',
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
        'List the UNUSED (orphaned) triggers in a GTM workspace — triggers referenced by NO tag (neither a firing nor a blocking/exception trigger) and not a member of a Trigger Group. These are safe-to-delete clutter. Read-only — call this to show the user exactly what delete_unused_gtm_triggers would remove (returns each trigger\'s triggerId, name, type). Requires accountId, containerId, workspaceId.',
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
        'List the UNUSED (orphaned) variables in a GTM workspace — variables whose {{name}} is referenced by NO tag, trigger, or other variable in the fields this audit can read. Read-only — call this to show the user what delete_unused_gtm_variables would remove (returns each variable\'s variableId, name, type). ADVISORY: this is a strong hint, not proof — a variable referenced only in a published version, or in a field the audit cannot inspect, may appear here even though it IS used. Requires accountId, containerId, workspaceId.',
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
      description: 'List the user-defined variables in a GTM workspace (name + type). Use it to check whether a variable already exists before creating one. Requires accountId, containerId, workspaceId.',
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
      description: 'List the CLIENTS in a SERVER container workspace (server-side GTM — e.g. the GA4 client "gaaw_client" that claims incoming requests). Requires accountId, containerId, workspaceId.',
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
        'List the CUSTOM (community-gallery) templates imported into a workspace, each with its tag TYPE code (cvt_… — for gallery templates this is cvt_<galleryTemplateId>, e.g. cvt_5RM3Q) — the value to put in a tag\'s `type` to build a tag from that template — plus the gallery owner/repository. Use to find an imported template (e.g. Meta Pixel) before creating tags from it. Requires accountId, containerId, workspaceId.',
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
      description: 'List the TRANSFORMATIONS in a SERVER container workspace (server-side GTM — they enrich/redact event data before tags run). Requires accountId, containerId, workspaceId.',
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
        'Audit a SERVER container workspace (server-side GTM). Checks that a client claims incoming requests, that server tags carry their destination id (GA4 Measurement ID / Ads Conversion ID+Label / remarketing id), have a firing trigger and are not paused, and that a tagging server URL is set. Returns the same findings/severity/boundary shape as audit_gtm_container — but for server resources. Requires accountId, containerId, workspaceId.',
      inputSchema: {
        type: 'object',
        properties: { accountId: { type: 'string' }, containerId: { type: 'string' }, workspaceId: { type: 'string' } },
        required: ['accountId', 'containerId', 'workspaceId'],
        additionalProperties: false,
      },
      handler: async (a) =>
        auditServerContainer(await data.getServerContainerSnapshot(s(a.accountId), s(a.containerId), s(a.workspaceId))),
    },
    {
      name: 'verify_server_endpoint',
      description:
        'Runtime check for a server-side GTM tagging server: GET <serverUrl>/healthy (sGTM servers answer "ok") to confirm the host is actually deployed and reachable. https-only, public hosts only. Use after bootstrapping a server container and deploying the host, or when an audit flags a missing/blank tagging server URL. Requires serverUrl (e.g. https://sgtm.example.com).',
      inputSchema: {
        type: 'object',
        properties: { serverUrl: { type: 'string' } },
        required: ['serverUrl'],
        additionalProperties: false,
      },
      handler: (a) => data.verifyServerEndpoint(s(a.serverUrl)),
    },
    {
      name: 'audit_gtm_container',
      description:
        'Audit a GTM workspace and return ACTIONABLE findings. Returns counts, a severity summary, and an array of findings — each with severity, category, the affected resource, a recommendation, and (for auto-fixable issues) a ready-to-run `fix` { tool, args } you can call directly to resolve it (the workspace ids are already filled in). ' +
        'Checks: tags with no firing trigger, paused tags, GA4 event tags missing a measurement ID or event name, multiple/inconsistent GA4 measurement IDs, Custom HTML (security + document.write), missing Consent Mode v2 settings on ad/analytics tags, unused triggers, unused variables, and duplicate names. ' +
        'Requires accountId, containerId, workspaceId.',
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
        'Re-audit the workspace AND report what CHANGED since the last audit of it: NEW issues (regressions) and RESOLVED issues, plus the full current report. Records this run so the next call can diff against it — the basis for continuous monitoring. New findings carry the same ready-to-run fixes (apply on approval). Use when the user asks "what changed", "any regressions", or to monitor over time. Requires accountId, containerId, workspaceId.',
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
        'Show CONFIG DRIFT between the draft workspace and the PUBLISHED (live) container version: which tags/triggers/variables were added, removed, or modified in the draft relative to what is live — i.e. exactly what publishing this workspace would change. Requires accountId, containerId, workspaceId.',
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
      name: 'list_gtm_versions',
      description:
        'List the container\'s published version history (newest first): version id, name, and tag/trigger/variable counts. Use to find versions to diff. Requires accountId, containerId.',
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
        'Diff two PUBLISHED container versions — which tags/triggers/variables were added, removed, or modified between version A (base) and version B. Use to answer "what changed between version N and M / when did this break". Requires accountId, containerId, versionA, versionB (version ids from list_gtm_versions).',
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
        'Cross-check the GA4 measurement ids configured in this GTM container against the GA4 properties the signed-in user can access — flags ids set on GTM tags that match NO accessible GA4 web stream (a typo, a wrong id, or a property on another GA4 account/login), and resolves matched ids to their property. Requires accountId, containerId, workspaceId; optional ga4Account (e.g. "accounts/123") to limit the GA4 scan.',
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
        'Scan a WEB container for Meta/Facebook pixel tags (Custom HTML with the fbq pixel, or a tag named/typed for Facebook/Meta) and report any standard ecommerce events they reference (Purchase, AddToCart, …). Use to decide whether Meta ECOMMERCE tracking is in use before setting up Meta CAPI server-side. Returns the matching tags + hasMetaPixel / hasEcommerce flags. Requires accountId, containerId, workspaceId.',
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
        'Run a GA4 report. dimensions/metrics are GA4 API names (e.g. ["date"], ["activeUsers","sessions"]). Dates accept "NdaysAgo", "today", "yesterday", or YYYY-MM-DD.',
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
        'Produce a unified analytics health SCORECARD: an overall 0–100 score + letter grade (A–F) with a per-section breakdown and a ranked top-issues list, combining the GTM container audit and (when a GA4 property is supplied) the GA4 property audit. Requires accountId, containerId, workspaceId; optional ga4Property like "properties/123456" to fold GA4 into the score.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          ga4Property: { type: 'string', description: 'Optional GA4 property (e.g. "properties/123") to include in the score.' },
          consentReport: { type: 'object', description: 'Optional web-audit consent_compliance_audit report (parsed JSON) to fold a Consent Mode v2 section into the score.' },
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
        'Generate a shareable, client-ready analytics health REPORT (Markdown): overall 0–100 score + letter grade, a per-section summary table, a ranked top-issues table, and full findings tables — from the GTM container audit and (when ga4Property is supplied) the GA4 property audit. Returns { report } as Markdown; present it to the user verbatim. Requires accountId, containerId, workspaceId; optional ga4Property like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          ga4Property: { type: 'string', description: 'Optional GA4 property to include in the report.' },
          consentReport: { type: 'object', description: 'Optional web-audit consent_compliance_audit report (parsed JSON) to add a Consent Mode v2 section to the report.' },
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
        'PREFERRED way to create a tag that fires on an event — builds a CORRECT GTM resource from simple fields (you do not write raw GTM JSON). One confirmed step: enables needed built-in variables, reuses an existing same-named trigger or creates it, and creates the tag linked to it. ' +
        'platform: "ga4_event" (needs measurementId G-XXXX, eventName, optional eventParameters [{name,value}]); "google_tag" (the Google tag / gtag base that configures GA4/Ads — needs tagId G-XXXX/AW-XXXX/GT-XXXX, optional configSettings [{name,value}]); "google_ads_conversion" (needs conversionId AW-XXXX, conversionLabel); "custom_html" (needs html — use for Facebook/LinkedIn/TikTok/other pixels); ' +
        '"conversion_linker" (Google Ads Conversion Linker; no fields required; optional enableCrossDomain plus comma-separated linkerDomains); "google_ads_call_conversion" (needs phoneNumber exactly as shown on the page, conversionId, conversionLabel); "google_ads_remarketing" (needs conversionId; an all-pages audience tag); "floodlight" (Campaign Manager / DV360 Floodlight counter; needs advertiserId, groupTag, activityTag; optional countingMethod standard|unique); "custom_image" (a beacon/pixel; needs url). ' +
        'trigger.kind: "link_click" or "all_clicks" (optional clickUrlValue and/or clickTextValue, each with a *Operator equals|contains|startsWith|matchRegex), "custom_event" (eventName = dataLayer event; optional ANDed scope conditions — formIdValue, pagePathValue/pagePathOperator, pageUrlValue — e.g. event form_submit AND {{Page Path}} contains /contact, the corpus-standard data-layer form pattern), "pageview", "form_submit" (optional formIdValue and/or formClassesValue, each with a *Operator — scopes the trigger to ONE form via {{Form ID}}/{{Form Classes}}; or pagePathValue/pagePathOperator to scope to a single page via {{Page Path}} when the form has no id/class; omit all and it fires on every form submit). ' +
        'eventParameters values may be GTM built-in variables (e.g. {{Click URL}}, {{Click Text}}, {{Form ID}}, {{Form URL}}) — the needed built-in variables are auto-enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          platform: { type: 'string', enum: ['ga4_event', 'google_tag', 'google_ads_conversion', 'custom_html', 'conversion_linker', 'google_ads_call_conversion', 'google_ads_remarketing', 'floodlight', 'custom_image'] },
          tagName: { type: 'string' },
          measurementId: { type: 'string' },
          eventName: { type: 'string' },
          eventParameters: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } },
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
              kind: { type: 'string', enum: ['link_click', 'all_clicks', 'custom_event', 'pageview', 'form_submit', 'youtube_video'] },
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
        };

        // Enable EXACTLY the built-in variables this tag needs: the trigger's,
        // plus any referenced by the event/config parameter VALUES (e.g. an
        // eventSettingsTable value of "{{Click Text}}" needs the Click Text
        // built-in variable enabled, or it resolves to nothing).
        const templateVals = [
          a.eventName != null ? s(a.eventName) : undefined, // e.g. "video_{{Video Status}}" → enable Video Status
          ...(Array.isArray(a.eventParameters) ? a.eventParameters.map((p) => s(obj(p).value)) : []),
          ...(Array.isArray(a.configSettings) ? a.configSettings.map((p) => s(obj(p).value)) : []),
        ];
        const vars = Array.from(
          new Set([
            ...triggerBuiltInVars(triggerInput),
            ...builtInVarsForTemplates(templateVals),
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
        const createdVariables: string[] = [];
        if (urlVarNames.size || triggerInput.lookupTable) {
          const existingVarNames = new Set(
            (await data.listGtmVariables(accountId, containerId, workspaceId)).map((v) => v.name.toLowerCase())
          );
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
        'Create a GTM variable with the correct structure (you do not write raw JSON). kind: "constant" (value), "data_layer" (dataLayerName), "javascript" (javascript — a Custom JavaScript variable, e.g. "function(){return document.title;}" for page title), or "event_data" (SERVER container only — reads keyPath from the incoming event, e.g. keyPath "items" or "x-ga-mp1-tt"; optional defaultValue). Requires accountId, containerId, workspaceId, kind, name.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          kind: { type: 'string', enum: ['constant', 'data_layer', 'javascript', 'event_data'] },
          name: { type: 'string' },
          value: { type: 'string' },
          dataLayerName: { type: 'string' },
          javascript: { type: 'string' },
          keyPath: { type: 'string' },
          defaultValue: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'kind', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create ${s(a.kind)} variable "${s(a.name)}"`,
      precheck: (a) => findExistingByName(data, a, s(a.name), 'variable'),
      handler: (a) =>
        data.createGtmVariable(
          s(a.accountId),
          s(a.containerId),
          s(a.workspaceId),
          buildVariable({
            name: s(a.name),
            kind: s(a.kind) as VariableKind,
            value: a.value != null ? s(a.value) : undefined,
            dataLayerName: a.dataLayerName != null ? s(a.dataLayerName) : undefined,
            javascript: a.javascript != null ? s(a.javascript) : undefined,
            keyPath: a.keyPath != null ? s(a.keyPath) : undefined,
            defaultValue: a.defaultValue != null ? s(a.defaultValue) : undefined,
          }) as unknown as Record<string, unknown>
        ),
    },
    {
      name: 'create_gtm_workspace',
      description: 'Create a new draft workspace in a GTM container to make changes in. Requires accountId, containerId, name.',
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
        'COPY all tags, triggers, and variables from one workspace into another in the SAME container. GTM has no atomic "move", so this RECREATES the resources in the destination (variables, then triggers incl. trigger groups, then tags — remapping firing/blocking trigger references, built-in trigger ids, and trigger-group members to the destination). Non-destructive: any resource whose NAME already exists in the destination is SKIPPED, never overwritten. Variable {{references}} carry over by name. NOT copied: folders, built-in variables (may need enabling), clients/transformations (server-only), and tags using legacy firing/blocking RULES — those are listed in `unsupported`. Quota/429 errors are auto-retried with backoff, so a large copy usually completes in ONE run; any create that still fails is recorded in `failed` and the copy CONTINUES; re-running is safe (skips what already exists) and resolves setup/teardown-tag ordering. Returns created/skipped per type plus unsupported + failed. Requires accountId, containerId, fromWorkspaceId, toWorkspaceId.',
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
        'Create a GTM ENVIRONMENT (e.g. a "Test" preview-and-debug environment) and return its environmentId, gtm_auth token (authorizationCode), and the ready-to-paste install snippet (head <script> + body <noscript>, with gtm_auth/gtm_preview/gtm_cookies_win filled in). This is a config write (not a publish) — it does not change the live container. Requires accountId, containerId, name; optional url and enableDebug (boolean). Use this instead of telling the user to create the environment in the GTM UI.',
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
        'Create a SERVER container (server-side GTM, usageContext "server") in an account. Note: this only creates the CONTAINER — the actual tagging-server HOST (Cloud Run / App Engine) must be provisioned separately (GTM UI "automatically provision tagging server", or gcloud); its URL then appears as the container\'s taggingServerUrls. Requires accountId, name.',
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
        'Create a CLIENT in a SERVER container workspace. `client` is a GTM API Client resource {name, type, parameter?}. The GA4 client is type "gaaw_client" (claims incoming GA4/gtag requests). Requires accountId, containerId, workspaceId, client.',
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
        'Delete a CLIENT from a SERVER container workspace (draft, not published). The GTM API DOES support this (workspaces.clients.delete) — do NOT tell the user clients can only be removed in the GTM UI. Useful for removing a duplicate/unused client. Requires accountId, containerId, workspaceId, clientId. Destructive — requires the user to confirm twice; make sure the client is not the only one claiming requests. Optional name is shown in the approval prompt.',
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
        'Create a TRANSFORMATION in a SERVER container workspace (reshape event data before tags run). EITHER pass name + allowParams (a structured "Allow parameters" transformation — keeps ONLY the listed event params, dropping the rest, e.g. to strip PII), OR a raw `transformation` GTM resource {name, type, parameter?} for any other type. Requires accountId, containerId, workspaceId.',
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
        "Set up server-side tagging FROM a web container in one step: creates a SERVER container, then adds a GA4 client + a GA4 server tag in its default workspace. Give it the GA4 Measurement ID to relay EITHER directly via `measurementId`, OR via `webContainerId` (the web container — it derives that container's GA4 Measurement ID automatically; pass the ACTIVE web container's id when the user says \"set up a server container for this web container\"). Returns the new container id + taggingServerUrls. Does NOT deploy the tagging-server host or change the web container — once the server is provisioned and you have its URL, call set_web_server_container_url to send to it. Requires accountId, name, and one of measurementId / webContainerId.",
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          measurementId: { type: 'string' },
          webContainerId: { type: 'string', description: 'Derive the GA4 Measurement ID from this web container (alternative to measurementId).' },
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
      name: 'set_web_server_container_url',
      description:
        "Wire a WEB container to a server container: set the web Google tag's server_container_url (the data then flows web→server). Requires accountId, containerId, workspaceId, tagId (the web Google tag — type googtag; find it with list_gtm_tags), and serverUrl (the https://… tagging-server URL, available only AFTER you provision the server host). Upserts the config setting, preserving the tag's other settings. After this, QA in GTM Preview.",
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
        'Set the SERVER container\'s own Tagging Server URL (its container-level taggingServerUrls field). The GTM API CAN write this (containers.update) — do NOT tell the user it can only be set in the GTM UI. Use when they have their tagging-server host URL (e.g. https://sgtm.example.com) and want it recorded on the container; this clears the audit\'s "No tagging server URL" finding. IMPORTANT: this only RECORDS the URL in config — it does NOT deploy the host. The server at that URL must still be live (confirm with verify_server_endpoint). This is DIFFERENT from set_web_server_container_url (which points a WEB tag at the server). Requires accountId, containerId (the SERVER container), serverUrl.',
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
      name: 'create_server_tag',
      description:
        'Create a tag in a SERVER container workspace (reads event data from the GA4 client). platform: "ga4" (forward events to GA4 — needs measurementId, optional eventName, defaults to forwarding the incoming event), "ads_conversion" (Google Ads conversion — needs conversionId + conversionLabel), "ads_conversion_linker" (Google Ads conversion linker), or "ads_remarketing" (Google Ads dynamic remarketing — needs conversionId). Optional firingTriggerId. Requires accountId, containerId, workspaceId, platform, name.',
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
            tag = buildAdsConversionServerTag(name, s(a.conversionId), s(a.conversionLabel), ftid);
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
        'Create the firing trigger for a SERVER container — a Custom Event trigger that fires on ALL events, optionally SCOPED to a client via "Client Name equals <clientName>". Use THIS (not create_gtm_trigger) for server triggers — it builds the exact customEvent shape GTM requires (a {{_event}} match-all custom-event filter plus the optional Client Name filter), which is easy to get wrong by hand. When clientName is given it also enables the Client Name built-in so the filter resolves. Requires accountId, containerId, workspaceId, name; optional clientName (e.g. "GA4").',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string' },
          clientName: { type: 'string', description: 'Scope the trigger to this client (Client Name equals …). Omit to fire on all events.' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) =>
        `Create server trigger "${s(a.name)}"${s(a.clientName) ? ` scoped to Client Name = ${s(a.clientName)}` : ' (all events)'} in workspace ${s(a.workspaceId)}`,
      precheck: (a) => findExistingByName(data, a, s(a.name), 'trigger'),
      handler: async (a) => {
        const clientName = a.clientName != null ? s(a.clientName) : '';
        if (clientName) {
          // Enable the Client Name built-in so {{Client Name}} resolves (best-effort).
          try {
            await data.enableGtmBuiltInVariables(s(a.accountId), s(a.containerId), s(a.workspaceId), ['clientName']);
          } catch {
            /* non-fatal */
          }
        }
        const trigger = buildServerAllEventsTrigger(s(a.name), clientName || undefined);
        return data.createGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), trigger as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_meta_emq_variables',
      description:
        'Create the standard Meta CAPI "Event Match Quality" Event Data variables (ed - fbp, fbc, event_id, value, currency, transaction_id, content_ids, email_address, phone_number, first_name, last_name, country, city, postal_code) in a SERVER container, so you can map them into the Meta Conversions API tag\'s Event Parameters / user_data. Idempotent — skips variables that already exist. NOTE: the Meta Conversions API TAG itself is a gallery template (cvt_…) you import + configure (Pixel ID + Access Token) in the GTM UI — the API cannot build it; this just creates the variables it reads. The CAPI tag hashes user_data itself, so these source the RAW values. Requires accountId, containerId (the SERVER container), workspaceId.',
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
        'Create a Meta (Facebook) Pixel tag from the official community template with the CORRECT event fields — use this instead of hand-building a cvt_ template tag (which gets the event wrong). Pass the Meta `event`: a STANDARD event (PageView, ViewContent, Search, AddToCart, AddToWishlist, InitiateCheckout, AddPaymentInfo, Purchase, Lead, CompleteRegistration, Contact, CustomizeProduct, Donate, FindLocation, Schedule, StartTrial, SubmitApplication, Subscribe) is set as eventName=standard + standardEventName; ANY other value becomes a CUSTOM event (eventName=custom + customEventName=<event>). Free text like "add to cart" resolves to AddToCart. `objectProperties` is an array of {name, value} → the Meta Object Properties (event params) — pass the ones recommended for the event (e.g. Purchase: value, currency, content_ids, content_type; ViewContent: content_ids, content_type, value, currency) with values referencing the container\'s ecommerce variables (e.g. {{Ecommerce Value}}); use list_gtm_variables to find them. `name` is OPTIONAL — defaults to "Meta - Event - <Event> Tag". Imports Facebook\'s OFFICIAL Meta Pixel template if needed (you do NOT pass the cvt_ type). Optional firingTriggerId (create/identify the trigger first — without it the tag will not fire). Requires accountId, containerId, workspaceId, pixelId, event.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional — defaults to "Meta - Event - <Event> Tag".' },
          pixelId: { type: 'string' },
          event: { type: 'string', description: 'Meta event, e.g. ViewContent / AddToCart / Purchase / Donate, or a custom name.' },
          objectProperties: {
            type: 'array',
            description: 'Meta Object Properties (event params): {name, value} rows, e.g. {name:"value", value:"{{Ecommerce Value}}"}.',
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
        const tag = buildMetaPixelTag(tmpl.type, metaPixelTagName(a), s(a.pixelId), event, ftid, objProps);
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_meta_capi_server_tag',
      description:
        'Create a Meta/Facebook Conversions API (CAPI) SERVER tag from the Stape "Facebook Conversion API" community template (stape-io / facebook-tag), tuned for high Event Match Quality: action source = website, Event Enhancement (gtmeec cookie) ON, generate _fbp ON. Pass pixelId + accessToken (typically {{Facebook Pixel ID}} / {{Facebook Api Token}} variables) and the Meta `event` — a STANDARD event (ViewContent, AddToCart, Purchase, Lead, …) sets eventNameStandard with Override; anything else inherits the incoming event_name. For EMQ, FIRST run create_meta_emq_variables (email/phone/fbp/fbc/etc.) and map them in the CAPI tag\'s user-data; the more PII you send (email + click-ID = high priority), the higher the score. Imports the Stape template if needed (you do NOT pass the cvt_ type). Optional firingTriggerId, eventEnhancement, generateFbp, actionSource, name (defaults to "Meta CAPI - <Event> Tag"). Requires accountId, containerId (SERVER), workspaceId, pixelId, accessToken, event.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional — defaults to "Meta CAPI - <Event> Tag".' },
          pixelId: { type: 'string' },
          accessToken: { type: 'string', description: 'Meta CAPI access token (usually a {{variable}}).' },
          event: { type: 'string', description: 'Meta event, e.g. AddToCart / Purchase / ViewContent.' },
          actionSource: { type: 'string', description: 'Default "website".' },
          eventEnhancement: { type: 'boolean', description: 'Event Enhancement (gtmeec) — default true.' },
          generateFbp: { type: 'boolean', description: 'Generate _fbp cookie — default true.' },
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
        const name = s(a.name).trim() || `Meta CAPI - ${metaStandardEvent(event) ?? event} Tag`;
        const tag = buildMetaCapiServerTag(tmpl.type, name, s(a.pixelId), s(a.accessToken), event, {
          actionSource: a.actionSource != null ? s(a.actionSource) : undefined,
          eventEnhancement: a.eventEnhancement != null ? Boolean(a.eventEnhancement) : undefined,
          generateFbp: a.generateFbp != null ? Boolean(a.generateFbp) : undefined,
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'create_tiktok_capi_server_tag',
      description:
        'Create a TikTok Events API SERVER tag from the Stape "TikTok Events API" community template (stape-io / tiktok-tag), tuned for match quality: Event Enhancement ON, generate _ttp ON. This is the SERVER-side Events API tag — DISTINCT from the TikTok WEB pixel (tiktok / gtm-template-pixel) and it uses DIFFERENT field keys (pixelId / accessToken / eventName, NOT the web pixel_code / event). Pass pixelId + accessToken (the TikTok Events Manager access token, usually {{variables}}) and the `event`. A TikTok STANDARD event sets eventName (Purchase, AddToCart, ViewContent, InitiateCheckout, CompleteRegistration, SubmitForm, Search, …); GA4 names are mapped (purchase→Purchase [NOT the legacy CompletePayment], add_to_cart→AddToCart, view_item→ViewContent, begin_checkout→InitiateCheckout, generate_lead→SubmitForm, sign_up→CompleteRegistration, file_download→Download); anything unrecognised becomes a custom event. For match quality, pass userData rows (name ∈ email/phone/external_id/ttclid/ttp/ip/user_agent/first_name/last_name/city/state/country/zip_code — values usually {{variables}}) and eventId for deduplication with the web pixel. ALWAYS pass eventProperties for the event: Purchase → contents, content_type, value, currency, order_id (from transaction_id), description; ViewContent → content_type, contents, value, currency, description; AddToCart/AddToWishlist/AddPaymentInfo → contents, content_type, value, currency; InitiateCheckout → contents, content_type, value, currency, num_items; Search → query, content_type; Subscribe → value, currency, subscription_type; CompleteRegistration → registration_method; SubmitForm → form_name, value (commerce keys land in the TikTok customDataList, the rest in additional properties — the tool routes them automatically). Imports the Stape template if needed (you do NOT pass the cvt_ type). The tag needs a SERVER trigger (create_server_trigger) scoped to the client that claims the events. Optional eventSource (web/app/offline/crm, default web), testEventCode, generateTtp, eventEnhancement, requireConsent, firingTriggerId, name (defaults to "TikTok CAPI - <Event> Tag"). Requires accountId, containerId (SERVER), workspaceId, pixelId, accessToken, event.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          name: { type: 'string', description: 'Optional — defaults to "TikTok CAPI - <Event> Tag".' },
          pixelId: { type: 'string', description: 'TikTok Pixel ID (usually a {{variable}}).' },
          accessToken: { type: 'string', description: 'TikTok Events API access token (usually a {{variable}}).' },
          event: { type: 'string', description: 'Event, e.g. purchase / AddToCart / ViewContent / a custom name.' },
          eventSource: { type: 'string', description: 'web | app | offline | crm — default web.' },
          eventId: { type: 'string', description: 'Event ID for dedup with the web pixel (usually a {{variable}}).' },
          userData: {
            type: 'array',
            description: 'Advanced-matching rows { name, value }; name ∈ email/phone/external_id/ttclid/ttp/ip/user_agent/first_name/last_name/city/state/country/zip_code.',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          eventProperties: {
            type: 'array',
            description: 'Event-data rows { name, value } (currency/value/contents/content_ids/content_type/num_items/order_id/…).',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false },
          },
          testEventCode: { type: 'string' },
          generateTtp: { type: 'boolean', description: 'Generate _ttp cookie — default true.' },
          eventEnhancement: { type: 'boolean', description: 'Event Enhancement — default true.' },
          requireConsent: { type: 'boolean', description: 'Gate on ad_storage consent — default false (optional).' },
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
        const tag = buildTikTokCapiServerTag(tmpl.type, name, s(a.pixelId), s(a.accessToken), event, {
          eventSource: a.eventSource != null ? s(a.eventSource) : undefined,
          eventId: a.eventId != null ? s(a.eventId) : undefined,
          userData: mapRows(a.userData),
          eventProperties: mapRows(a.eventProperties),
          testEventCode: a.testEventCode != null ? s(a.testEventCode) : undefined,
          generateTtp: a.generateTtp != null ? Boolean(a.generateTtp) : undefined,
          eventEnhancement: a.eventEnhancement != null ? Boolean(a.eventEnhancement) : undefined,
          requireConsent: a.requireConsent != null ? Boolean(a.requireConsent) : undefined,
          firingTriggerId: Array.isArray(a.firingTriggerId) && a.firingTriggerId.length ? a.firingTriggerId.map(String) : undefined,
        });
        return data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), tag as unknown as Record<string, unknown>);
      },
    },
    {
      name: 'import_gallery_template',
      description:
        'Import a Community Template Gallery template into a workspace by GitHub owner + repository — the GTM API DOES support this (templates.import_from_gallery); do NOT tell the user templates can only be imported in the GTM UI. Works for ANY gallery template. Common pixel templates (owner / repository): Meta Pixel = facebook / GoogleTagManager-WebTemplate-For-FacebookPixel; TikTok Pixel = tiktok / gtm-template-pixel; LinkedIn Insight Tag = linkedin / linkedin-gtm-community-template; Snap Pixel = Snapchat / snapchat-google-tag-manager; Pinterest Tag = pinterest / ws-gtm-template (Pinterest server CAPI = pinterest / ss-gtm-template); Meta CAPI (server) = stape-io / facebook-tag; TikTok Events API (server) = stape-io / tiktok-tag (official alt = tiktok / gtm-template-eapi). Idempotent (returns the existing one if already imported). Returns the template + its tag TYPE code (cvt_…). After importing, build a tag from it with create_gtm_tag using that returned `type` and the template\'s own field keys (e.g. Meta Pixel: pixelId, eventName, standardEventName) — those fields are template-specific, so check the template in GTM if a create is rejected. Requires accountId, containerId, workspaceId, owner, repository; optional sha (defaults to latest).',
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
        'Create a folder in a GTM workspace to organise tags/triggers/variables. Folders are PURELY organisational — they do not change what fires. Requires accountId, containerId, workspaceId, name. To then file items into it, call move_gtm_entities_to_folder with the returned folderId.',
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
        'Move tags, triggers, and/or variables into a GTM folder (organisational only — does NOT change firing). Requires accountId, containerId, workspaceId, folderId, and at least one of tagIds / triggerIds / variableIds (arrays of ids). To file all GA4 tags: list_gtm_tags, keep the gaawe/gaawc/googtag ids, create_gtm_folder, then call this with those tagIds.',
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
        'Rename a GTM folder. Organisational only — does not change what fires. Requires accountId, containerId, workspaceId, folderId, name (the new name).',
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
        'Delete a GTM folder (draft, not published). GTM does NOT delete the folder\'s contents — its tags/triggers/variables simply become unfiled. Requires accountId, containerId, workspaceId, folderId. Destructive — requires the user to confirm twice (and type "delete").',
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
        'GA4 EVENT tag — type "gaawe". PREFER create_gtm_tracking_tag, which builds this correctly. If ' +
        'using this raw tool, `parameter` MUST be exactly this shape — event parameters go in ' +
        'eventSettingsTable as a LIST of MAP entries keyed parameter/parameterValue (NOT an ' +
        '"eventParameters" list of name/value, which GTM silently ignores): ' +
        '[{"type":"tagReference","key":"measurementId","value":""},' +
        '{"type":"template","key":"measurementIdOverride","value":"G-XXXXXXX or {{GA4 Variable}}"},' +
        '{"type":"template","key":"eventName","value":"email_click"},' +
        '{"type":"list","key":"eventSettingsTable","list":[' +
        '{"type":"map","map":[{"type":"template","key":"parameter","value":"link_url"},{"type":"template","key":"parameterValue","value":"{{Click URL}}"}]},' +
        '{"type":"map","map":[{"type":"template","key":"parameter","value":"link_text"},{"type":"template","key":"parameterValue","value":"{{Click Text}}"}]}]}]. ' +
        'The Google tag — type "googtag" with [{"type":"template","key":"tagId","value":"G-XXXX/AW-XXXX/GT-XXXX"}]. ' +
        'Google Ads conversion — type "awct" with {"type":"template","key":"conversionId","value":"123456789"} ' +
        '(the NUMERIC id only — GTM rejects an "AW-" prefix) and ' +
        '{"type":"template","key":"conversionLabel","value":"…"}. Google Ads remarketing — type "sp". ' +
        'Facebook Pixel, LinkedIn Insight, TikTok, Pinterest, or any platform without a native GTM ' +
        'template — type "html" (Custom HTML) with a {"type":"template","key":"html","value":"<script>…</script>"} ' +
        'parameter containing that platform\'s snippet. Pick the right type for the platform the user names.',
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
        'Update an existing tag in a GTM workspace (read-modify-write — the current tag is fetched and only the fields you pass are overlaid; `parameter` is merged by key, so omitted fields like eventName/measurementId are preserved). Pass only the fields you want to change. To ADD GA4 event parameters (session_id, user_id, click_text, …) to GA4 event tags, use add_ga4_event_parameters instead — it appends to the eventSettingsTable without wiping the tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          tag: { type: 'object', description: 'Partial tag — only the fields to change. parameter[] is merged by key.' },
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
        'Add GA4 event parameters to an existing GA4 Event tag (type "gaawe"). Appends them to the tag\'s eventSettingsTable — the correct place for GA4 event parameters — and preserves eventName/measurementId, so it never triggers "measurementIdOverride/eventName must not be empty". A parameter whose name already exists has its value updated (not duplicated). Use this for requests like "add session_id and user_id to all GA4 event tags". Values may be GTM variables like {{Click Text}}. Call once per tag.',
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
      name: 'set_ga4_measurement_id',
      description:
        'Set/replace the Measurement ID on a GA4 tag. The value may be a literal id (G-XXXX, AW-XXXX, GT-XXXX) OR a GTM variable like {{GA4 Variable}}. For a GA4 Event tag (gaawe) it sets measurementIdOverride; for a Google tag (googtag) it sets the tag ID. Use this for requests like "replace {{GA4 Measurement ID}} with {{GA4 Variable}} on all GA4 tags" or "point all GA4 tags at G-1234567890" — it builds the parameter correctly and preserves the rest of the tag, so it never produces the "measurementIdOverride/template key" errors you get from hand-editing the tag. Call once per tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string', description: 'The GA4 Event (gaawe) or Google tag (googtag) tag ID.' },
          measurementId: {
            type: 'string',
            description: 'The Measurement ID (G-/AW-/GT-XXXX) or a GTM variable reference such as {{GA4 Variable}}.',
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
        'Set a tag\'s Consent Mode v2 settings — the fix for the "no Consent Mode v2 settings" audit finding. consentStatus "needed" + consentTypes (ad_storage, analytics_storage, ad_user_data, ad_personalization) makes GTM block the tag until those are granted; consentStatus "notNeeded" declares the tag needs no additional consent (it relies on Consent Mode at the Google-tag level). Read-modify-write; preserves the rest of the tag.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          consentStatus: { type: 'string', enum: ['needed', 'notNeeded'], description: 'needed = require the consentTypes; notNeeded = no additional consent required.' },
          consentTypes: {
            type: 'array',
            description: 'Required consent types when consentStatus is "needed" (e.g. ["analytics_storage"] for GA4, ["ad_storage","ad_user_data","ad_personalization"] for Ads).',
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
        'Set/replace the Measurement ID on ALL GA4 tags in the workspace in ONE approval (GA4 event tags + the Google tag). The value may be a literal id (G-/AW-/GT-XXXX) or a GTM variable like {{GA4 Variable}}. PREFER this whenever the user says "all GA4 tags" / "every GA4 tag" (e.g. "replace {{GA4 Measurement ID}} with {{GA4 Variable}} on all GA4 tags") — do NOT loop set_ga4_measurement_id tag-by-tag. It builds each parameter correctly, preserves the rest of every tag, continues past any single failure, and returns a summary of updated/failed tags.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          measurementId: {
            type: 'string',
            description: 'The Measurement ID (G-/AW-/GT-XXXX) or a GTM variable reference such as {{GA4 Variable}}.',
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
        'Add GA4 event parameters to ALL GA4 Event tags (gaawe) in the workspace in ONE approval. PREFER this whenever the user says "all GA4 tags" / "every GA4 event tag" (e.g. "add user_id and session_id to all GA4 event tags") — do NOT loop add_ga4_event_parameters tag-by-tag. It appends to each tag\'s eventSettingsTable, updates a value in place if the name already exists, preserves each tag, continues past any single failure, and returns a summary. Values may be GTM variables like {{User ID}}.',
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
        'Pause or unpause a tag in a GTM workspace, preserving all its other settings. Use this to apply the audit fix for a paused tag. Requires accountId, containerId, workspaceId, tagId, and paused (boolean — false to unpause/enable, true to pause). Optional name is shown in the approval prompt.',
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
        'Delete a tag from a GTM workspace (draft, not published). Requires accountId, containerId, workspaceId, tagId. Destructive — requires the user to confirm twice.',
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
        'Delete a trigger from a GTM workspace (draft, not published). Use this to apply the audit fix for an unused trigger. Requires accountId, containerId, workspaceId, triggerId. Destructive — requires the user to confirm twice. Optional name is shown in the approval prompt.',
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
        'Bulk-delete the UNUSED (orphaned) triggers in a GTM workspace — those referenced by no tag (firing or blocking) and not a Trigger Group member. By DEFAULT deletes ALL unused triggers; pass triggerIds (the filter/selection) to delete only specific ones — any id you pass that is actually in use, or not found, is skipped and reported, NEVER deleted. It lists tags + triggers itself (you do NOT pass them); prefer calling list_unused_gtm_triggers first so the user can see what will go. Destructive — confirms twice. Requires accountId, containerId, workspaceId; optional triggerIds (string[]).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          triggerIds: { type: 'array', items: { type: 'string' }, description: 'Optional selection filter — only delete these ids (and only if actually unused). Omit to delete ALL unused triggers.' },
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
        'Bulk-delete the UNUSED (orphaned) variables in a GTM workspace — variables whose {{name}} is referenced by no tag, trigger, or other variable in the readable fields. By DEFAULT deletes ALL unused variables; pass variableIds (the filter/selection) to delete only specific ones — any id you pass that is actually referenced (or not found) is skipped and reported. It lists the container itself (you do NOT pass it); prefer calling list_unused_gtm_variables first so the user can see what will go. CAUTION: unlike triggers, the GTM API does NOT refuse to delete a REFERENCED variable, and this detection is a strong hint (not proof) — a variable used only in a published version or a field the audit cannot read could be wrongly deleted, silently breaking that {{reference}}. Destructive — confirms twice. Requires accountId, containerId, workspaceId; optional variableIds (string[]).',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          variableIds: { type: 'array', items: { type: 'string' }, description: 'Optional selection filter — only delete these ids (and only if actually unused). Omit to delete ALL unused variables.' },
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
        'Delete a variable from a GTM workspace (draft, not published). Requires accountId, containerId, workspaceId, variableId. Destructive — requires the user to confirm twice; verify the variable is not used by a published version first. Optional name is shown in the approval prompt.',
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
        'Enable built-in variables in a GTM workspace. Requires accountId, containerId, workspaceId, ' +
        'and types (array of built-in variable TYPE KEYS). Valid keys include: clickUrl ({{Click URL}}), ' +
        'clickText ({{Click Text}}), clickClasses, clickId, clickElement, pageUrl ({{Page URL}}), ' +
        'pageHostname, pagePath, referrer. NOTE: there is NO built-in for "Page Title" — to use page ' +
        'title, create a Custom JavaScript variable returning document.title (GA4 also auto-collects ' +
        'page_title and page_location, so you usually do not need to send them as event parameters).',
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
        'PREFERRED one-shot tool: create a tag that fires on a trigger, in a single confirmed step. ' +
        'Enables any needed built-in variables, REUSES an existing trigger with the same name (no ' +
        'duplicates) or creates it, then creates the tag linked to that trigger. Requires accountId, ' +
        'containerId, workspaceId, `tag` (GTM Tag resource {name,type,parameter?}), `trigger` (GTM ' +
        'Trigger resource {name,type,filter?}), and optional `builtInVariables` (TYPE KEYS, e.g. ' +
        '["clickUrl","clickText","pageUrl"] — there is NO built-in for Page Title). For a GA4 event ' +
        '`tag`, use type "gaawe" with the eventSettingsTable (parameter/parameterValue) shape described in create_gtm_tag. ' +
        'Use this instead of separate create_gtm_trigger + create_gtm_tag calls so the user approves once.',
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
        'Click-on-links uses type "linkClick"; filter operator types are LOWERCASE ' +
        '(equals, contains, startsWith, endsWith, matchRegex) and conditions go in `filter` ' +
        'with arg0/arg1 template parameters. Example (Click URL contains mailto:): ' +
        '{"name":"Email link click","type":"linkClick","filter":[{"type":"contains",' +
        '"parameter":[{"type":"template","key":"arg0","value":"{{Click URL}}"},' +
        '{"type":"template","key":"arg1","value":"mailto:"}]}]}. ' +
        'The {{Click URL}} built-in variable must be enabled in the container. ' +
        'For a CUSTOM EVENT trigger (a dataLayer event like purchase / add_to_cart), use type ' +
        '"customEvent" and put the event name in customEventFilter as {{_event}} equals <name> — ' +
        'do NOT use a top-level "eventName" field (that is TIMER-only; the API rejects it on a ' +
        'customEvent trigger). Example: {"name":"Purchase","type":"customEvent","customEventFilter":' +
        '[{"type":"equals","parameter":[{"type":"template","key":"arg0","value":"{{_event}}"},' +
        '{"type":"template","key":"arg1","value":"purchase"}]}]}.',
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
        'Update an existing trigger IN PLACE (read-modify-write) — the GTM API DOES support this; do NOT delete + recreate a trigger to change it (and you can\'t delete one that tags reference). Set its display `name` and/or, for a Custom Event trigger, its `eventName` — the dataLayer Event name it matches, normalized to snake_case (so "CE - Purchase" → "purchase"). Tags keep firing on the same trigger id. Requires accountId, containerId, workspaceId, triggerId; pass name and/or eventName.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          triggerId: { type: 'string' },
          name: { type: 'string', description: 'New display name (optional).' },
          eventName: { type: 'string', description: 'New Custom Event "Event name" — the dataLayer event it matches, e.g. purchase (optional).' },
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
      description: 'Create a variable in a GTM workspace. Requires accountId, containerId, workspaceId, and a variable object {name, type, ...}.',
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
            'Switch the ACTIVE GTM workspace — the one shown in the app bar and used by the Container audit and new operations — within the current account and container. Accepts workspaceId OR workspaceName (e.g. "MCP-TEST", case-insensitive). Use when the user says "switch to / use / change to workspace X". Does NOT modify GTM; it only re-points the app.',
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
            'Switch the ACTIVE GTM container within the current account, by containerId OR containerName (case-insensitive). Optionally also set the workspace (workspaceId/workspaceName); otherwise the "Default Workspace" — or the first workspace — is selected. Use when the user says "switch to container X". Does NOT modify GTM; it only re-points the app.',
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

  const all = [...readTools, ...(confirm ? writeTools : []), ...contextTools];
  const tools = product ? all.filter((t) => productOf(t.name) === product) : all;

  return {
    list: (): LlmToolDef[] =>
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
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
        const summary = tool.summarize ? tool.summarize(effectiveArgs) : tool.name;
        const declined = JSON.stringify({ declined: true, message: 'The user declined this change.' });

        // The user may edit names/types/config in the approval card; the returned
        // args replace the model's proposal.
        const edited = await confirm({
          tool: tool.name,
          summary,
          details: effectiveArgs,
          destructive: tool.destructive,
        });
        if (!edited) {
          console.error(`[tool] ${name}: user DECLINED in approval card`);
          return declined;
        }
        if (JSON.stringify(edited) !== JSON.stringify(effectiveArgs)) {
          console.error(`[tool] ${name}: args EDITED in approval card → ${truncForLog(JSON.stringify(edited))}`);
        }
        effectiveArgs = edited;

        // Destructive tools (delete) require a SECOND, final confirmation.
        if (tool.destructive) {
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
