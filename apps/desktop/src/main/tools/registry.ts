import type { GoogleDataService } from '../google/data-service';
import type { LlmToolDef, ToolExecutor } from '../llm/types';
import type { GoogleProduct } from '../../shared/ipc';
import type { AuditHistoryStore } from '../storage/audit-history';
import {
  buildGa4EventTag,
  buildGoogleAdsConversionTag,
  buildCustomHtmlTag,
  buildTrigger,
  triggerBuiltInVars,
  buildVariable,
  type TriggerInput,
  type VariableKind,
} from '../google/gtm-builders';
import { auditWorkspace, auditChanges } from '../google/audit-runner';
import { diffSnapshots } from '../google/gtm-monitor';
import { auditGa4 } from '../google/ga4-audit';
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
}

/**
 * Asks the user to approve a write. Resolves with the (possibly user-edited)
 * args to apply, or null if the user declined. Lets the approval card edit
 * names/types/config before the change is made.
 */
export type ConfirmFn = (proposal: WriteProposal) => Promise<Record<string, unknown> | null>;

interface Tool extends LlmToolDef {
  /** Mutates GTM — only listed/executed when a confirm function is provided. */
  write?: boolean;
  /** Deletes data — requires a SECOND confirmation before applying. */
  destructive?: boolean;
  /** Human-readable one-liner shown in the approval prompt. */
  summarize?: (args: Record<string, unknown>) => string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const s = (v: unknown): string => String(v ?? '');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

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
// Tool product is derived from its name (every GA4 tool contains "ga4", every
// GTM tool contains "gtm") — used to hard-scope the registry to one product.
const productOf = (name: string): GoogleProduct => (name.includes('ga4') ? 'ga4' : 'gtm');

export function buildToolRegistry(
  data: GoogleDataService,
  confirm?: ConfirmFn,
  product?: GoogleProduct,
  history?: AuditHistoryStore
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
        return { report: buildReport(sections, { generatedAt: new Date().toISOString() }) };
      },
    },
  ];

  const writeTools: Tool[] = [
    {
      name: 'create_gtm_tracking_tag',
      description:
        'PREFERRED way to create a tag that fires on an event — builds a CORRECT GTM resource from simple fields (you do not write raw GTM JSON). One confirmed step: enables needed built-in variables, reuses an existing same-named trigger or creates it, and creates the tag linked to it. ' +
        'platform: "ga4_event" (needs measurementId G-XXXX, eventName, optional eventParameters [{name,value}]); "google_ads_conversion" (needs conversionId AW-XXXX, conversionLabel); "custom_html" (needs html — use for Facebook/LinkedIn/TikTok/other pixels). ' +
        'trigger.kind: "link_click" or "all_clicks" (optional clickUrlValue + clickUrlOperator equals|contains|startsWith|matchRegex), "custom_event" (eventName = dataLayer event), "pageview", "form_submit".',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          platform: { type: 'string', enum: ['ga4_event', 'google_ads_conversion', 'custom_html'] },
          tagName: { type: 'string' },
          measurementId: { type: 'string' },
          eventName: { type: 'string' },
          eventParameters: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } },
          },
          conversionId: { type: 'string' },
          conversionLabel: { type: 'string' },
          html: { type: 'string' },
          trigger: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['link_click', 'all_clicks', 'custom_event', 'pageview', 'form_submit'] },
              clickUrlValue: { type: 'string' },
              clickUrlOperator: { type: 'string' },
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
        } else if (platform === 'google_ads_conversion') {
          tag = buildGoogleAdsConversionTag({ name: s(a.tagName), conversionId: s(a.conversionId), conversionLabel: s(a.conversionLabel) });
        } else if (platform === 'custom_html') {
          tag = buildCustomHtmlTag({ name: s(a.tagName), html: s(a.html) });
        } else {
          throw new Error(`unknown platform: ${platform}`);
        }

        const ts = obj(a.trigger);
        const triggerInput: TriggerInput = {
          name: s(ts.name),
          kind: (s(ts.kind) || 'pageview') as TriggerInput['kind'],
          clickUrlValue: ts.clickUrlValue != null ? s(ts.clickUrlValue) : undefined,
          clickUrlOperator: ts.clickUrlOperator != null ? s(ts.clickUrlOperator) : undefined,
          eventName: ts.eventName != null ? s(ts.eventName) : undefined,
        };

        const vars = Array.from(
          new Set([...triggerBuiltInVars(triggerInput), ...(Array.isArray(a.builtInVariables) ? a.builtInVariables.map(String) : [])])
        );
        let enabledVariables: string[] = [];
        if (vars.length) {
          try {
            enabledVariables = await data.enableGtmBuiltInVariables(accountId, containerId, workspaceId, vars);
          } catch {
            enabledVariables = vars;
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

        return { tag: createdTag, trigger: { triggerId, name: triggerInput.name, reused: reusedTrigger }, enabledVariables };
      },
    },
    {
      name: 'create_gtm_variable_typed',
      description:
        'Create a GTM variable with the correct structure (you do not write raw JSON). kind: "constant" (value), "data_layer" (dataLayerName), "javascript" (javascript — a Custom JavaScript variable, e.g. "function(){return document.title;}" for page title). Requires accountId, containerId, workspaceId, kind, name.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          kind: { type: 'string', enum: ['constant', 'data_layer', 'javascript'] },
          name: { type: 'string' },
          value: { type: 'string' },
          dataLayerName: { type: 'string' },
          javascript: { type: 'string' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'kind', 'name'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Create ${s(a.kind)} variable "${s(a.name)}"`,
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
      name: 'create_gtm_tag',
      description:
        'Create a tag in a GTM workspace (draft). `tag` is a GTM API Tag resource ' +
        '{name, type, parameter?, firingTriggerId?}; link to a trigger via firingTriggerId:["<id>"]. ' +
        'GA4 EVENT tag — type "gaawe"; `parameter` MUST be exactly this shape (eventParameters is a ' +
        'LIST of MAP entries, each with name+value, NOT a flat object): ' +
        '[{"type":"template","key":"eventName","value":"email_click"},' +
        '{"type":"template","key":"measurementIdOverride","value":"G-XXXXXXX or {{GA4 Variable}}"},' +
        '{"type":"list","key":"eventParameters","list":[' +
        '{"type":"map","map":[{"type":"template","key":"name","value":"link_url"},{"type":"template","key":"value","value":"{{Click URL}}"}]},' +
        '{"type":"map","map":[{"type":"template","key":"name","value":"link_text"},{"type":"template","key":"value","value":"{{Click Text}}"}]}]}]. ' +
        'Google Ads conversion — type "awct" with {"type":"template","key":"conversionId","value":"AW-XXXX"} ' +
        'and {"type":"template","key":"conversionLabel","value":"…"}. Google Ads remarketing — type "sp". ' +
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
      handler: (a) => data.createGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.tag)),
    },
    {
      name: 'update_gtm_tag',
      description: 'Update an existing tag in a GTM workspace. Requires accountId, containerId, workspaceId, tagId, and the full tag object.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          containerId: { type: 'string' },
          workspaceId: { type: 'string' },
          tagId: { type: 'string' },
          tag: { type: 'object' },
        },
        required: ['accountId', 'containerId', 'workspaceId', 'tagId', 'tag'],
        additionalProperties: false,
      },
      write: true,
      summarize: (a) => `Update tag ${s(a.tagId)} ("${s(obj(a.tag).name)}") in workspace ${s(a.workspaceId)}`,
      handler: (a) => data.updateGtmTag(s(a.accountId), s(a.containerId), s(a.workspaceId), s(a.tagId), obj(a.tag)),
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
        '`tag`, use type "gaawe" with the eventParameters LIST-of-MAP shape described in create_gtm_tag. ' +
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
        'The {{Click URL}} built-in variable must be enabled in the container.',
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
      handler: (a) => data.createGtmTrigger(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.trigger)),
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
      handler: (a) => data.createGtmVariable(s(a.accountId), s(a.containerId), s(a.workspaceId), obj(a.variable)),
    },
  ];

  const all = confirm ? [...readTools, ...writeTools] : readTools;
  const tools = product ? all.filter((t) => productOf(t.name) === product) : all;

  return {
    list: (): LlmToolDef[] =>
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    execute: async (name, args): Promise<string> => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      let effectiveArgs = args ?? {};
      if (tool.write) {
        if (!confirm) {
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
        if (!edited) return declined;
        effectiveArgs = edited;

        // Destructive tools (delete) require a SECOND, final confirmation.
        if (tool.destructive) {
          const again = await confirm({
            tool: tool.name,
            summary: `FINAL CONFIRMATION — permanently ${tool.summarize ? tool.summarize(effectiveArgs) : summary}. This cannot be undone.`,
            details: effectiveArgs,
            destructive: true,
          });
          if (!again) return declined;
        }
      }
      try {
        return JSON.stringify(await tool.handler(effectiveArgs));
      } catch (e) {
        const msg = apiErrorMessage(e);
        console.error(`[samarth-desktop] tool "${name}" failed: ${msg}`);
        throw new Error(msg);
      }
    },
  };
}
