/**
 * Google Analytics Admin API (GA4) — WRITE MCP tools (create / update / delete / archive).
 *
 * The read-only surface lives in ga4Admin.ts; this module is the mutating
 * counterpart. EVERYTHING here is doubly gated:
 *   1. env: GA4_MCP_ENABLE_WRITES (create/update) and GA4_MCP_ENABLE_DELETES
 *      (delete AND archive) — both default false, mirroring the GTM guardrails.
 *   2. per-call: confirm=true is required on every tool.
 * Writes also need the `analytics.edit` scope (and `analytics.manage.users` for
 * access-binding tools). See auth/googleAuth GA4_SCOPES.
 *
 * DESIGN: GA4 Admin collections are uniform (`create({parent, requestBody})`,
 * `patch({name, updateMask, requestBody})`, `delete({name})`,
 * `archive({name, requestBody})`), so a small factory registers the verb tools
 * from a data-driven catalog. High-frequency resources expose TYPED fields;
 * complex/rare resources take a raw `body` object (JSON passthrough) so the full
 * API shape stays reachable without modelling every nested clause. A raw `body`
 * is merged over any typed fields on both create and update.
 *
 * COVERAGE NOTES (documented, not stubbed):
 *   - Search Console links: NOT in the Admin API (UI-only) — no tool.
 *   - Event EDIT rules: the installed googleapis client exposes only event
 *     CREATE rules as a resource — only those are wired.
 *   - Account creation: only provisionAccountTicket (interactive ToS) — omitted.
 *   - Some resources (expanded data sets, subproperty filters, rollup links) are
 *     GA4 360-only and return 400 on standard properties.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ga4AdminClient, Ga4AdminAlphaClient } from '../utils/ga4Client.js';
import { getGuardrailConfig, checkGa4Guardrails } from '../utils/guardrails.js';
import { jsonResult, textResult, errorText } from '../utils/toolResponse.js';
import { formatGa4Error, toPropertyName } from '../utils/ga4Errors.js';

/** The four uniform mutating methods on a GA4 Admin collection. Cast the real
 *  googleapis sub-resource to this at the factory boundary (its param unions are
 *  huge; we only ever call these shapes). */
interface Ga4SubResource {
  create?: (p: { parent: string; requestBody: object } & Record<string, unknown>) => Promise<{ data: unknown }>;
  patch?: (p: { name: string; updateMask?: string; requestBody: object }) => Promise<{ data: unknown }>;
  delete?: (p: { name: string }) => Promise<{ data: unknown }>;
  archive?: (p: { name: string; requestBody: object }) => Promise<{ data: unknown }>;
}

type AnyGa4Client = Ga4AdminClient | Ga4AdminAlphaClient;

/** Normalize an account id into `accounts/{id}`. */
function toAccountName(account: string): string {
  const t = account.trim();
  return t.startsWith('accounts/') ? t : `accounts/${t}`;
}

/** Build a `properties/{id}/dataStreams/{streamId}` parent. */
function toDataStreamName(property: string, dataStreamId: string): string {
  const s = dataStreamId.trim();
  const suffix = s.startsWith('dataStreams/') ? s : `dataStreams/${s}`;
  return `${toPropertyName(property)}/${suffix}`;
}

/** Compute an updateMask from the top-level keys actually supplied (excluding
 *  the raw `body` escape hatch and an explicit updateMask). GA4 patch requires
 *  it; callers can override with an explicit `updateMask`. */
function deriveUpdateMask(body: Record<string, unknown>): string {
  return Object.keys(body).join(',');
}

/** The supplied args, keeping only the listed keys that are actually present. */
function pickDefined(a: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

type ParentKind = 'property' | 'dataStream' | 'account';

interface VerbSpec {
  /** Typed fields beyond the parent/name (empty for raw-body-only resources). */
  fields?: z.ZodRawShape;
  /** Map typed args → request body. */
  toBody?: (a: Record<string, unknown>) => Record<string, unknown>;
  /** Extra query params (e.g. calculatedMetricId on create). */
  query?: (a: Record<string, unknown>) => Record<string, string>;
  /** Reject bodies the API has no fields for BEFORE the request (clear message, no Google 400). */
  validate?: (body: Record<string, unknown>) => void;
  desc: string;
}

/** The GA4 Admin API's DataStream has very few writable fields. Everything people REACH for here
 *  (cross-domain domains, unwanted referrals, internal traffic, session timeout) lives in the
 *  GOOGLE TAG settings, which the Admin API does not expose at all - so reject those up front
 *  with directions instead of letting Google return "Unknown name ... Cannot find field". */
export function validateDataStreamBody(body: Record<string, unknown>, forCreate: boolean): void {
  const allowedTop = new Set(forCreate ? ['type', 'displayName', 'webStreamData', 'androidAppStreamData', 'iosAppStreamData'] : ['displayName', 'webStreamData']);
  const badTop = Object.keys(body).filter((k) => !allowedTop.has(k));
  const web = body.webStreamData;
  const badWeb = web && typeof web === 'object' ? Object.keys(web as Record<string, unknown>).filter((k) => k !== 'defaultUri') : [];
  if (badTop.length === 0 && badWeb.length === 0) return;
  const bad = [...badTop, ...badWeb.map((k) => `webStreamData.${k}`)].join(', ');
  throw new Error(
    `These are not GA4 Admin API data-stream fields: ${bad}. Cross-domain domains, unwanted referrals, ` +
      'internal traffic and session settings are GOOGLE TAG settings - no API can change them; set them in ' +
      'GA4: Admin > Data streams > (your stream) > Configure tag settings. ' +
      `API-writable stream fields: displayName, webStreamData.defaultUri${forCreate ? ', type, packageName, bundleId' : ''}.`
  );
}


interface ResourceDesc {
  /** Tool-name segment, singular snake_case, e.g. 'key_event'. */
  key: string;
  /** Human plural for messages, e.g. 'key events'. */
  plural: string;
  version: 'v1beta' | 'v1alpha';
  parent: ParentKind;
  /** Return the googleapis sub-resource (typed loosely — see Ga4SubResource). */
  sub: (c: AnyGa4Client) => Ga4SubResource;
  /** True when create/update accept a raw `body` object passthrough (merged over
   *  typed fields). On by default for resources with no typed create fields. */
  rawBody?: boolean;
  create?: VerbSpec;
  update?: VerbSpec;
  del?: { desc: string };
  archive?: { desc: string };
}

const propertyArg = z.string().min(1).describe('GA4 property ID, e.g. "123456789" or "properties/123456789".');
const nameArg = (plural: string) =>
  z.string().min(1).describe(`Full resource name of the ${plural.replace(/s$/, '')} to target, e.g. "properties/123/…/456".`);
const bodyArg = z
  .record(z.unknown())
  .optional()
  .describe('Raw request-body object (JSON) merged OVER the typed fields — use for nested/advanced fields not exposed as flat args.');

/** Register create/update/delete/archive tools for one resource from its descriptor. */
function registerResource(
  server: McpServer,
  getClient: () => Ga4AdminClient,
  getAlphaClient: () => Ga4AdminAlphaClient,
  r: ResourceDesc
): void {
  const client = (): AnyGa4Client => (r.version === 'v1alpha' ? getAlphaClient() : getClient());
  const sub = (): Ga4SubResource => r.sub(client());

  // Parent input fields + a resolver producing the collection parent path.
  const parentFields: z.ZodRawShape =
    r.parent === 'property'
      ? { property: propertyArg }
      : r.parent === 'dataStream'
        ? { property: propertyArg, dataStreamId: z.string().min(1).describe('Data stream ID (numeric) or "dataStreams/{id}".') }
        : { accountId: z.string().min(1).describe('GA4 account ID, e.g. "123456" or "accounts/123456".') };
  const parentPath = (a: Record<string, unknown>): string =>
    r.parent === 'property'
      ? toPropertyName(String(a.property))
      : r.parent === 'dataStream'
        ? toDataStreamName(String(a.property), String(a.dataStreamId))
        : toAccountName(String(a.accountId));

  const allowRaw = r.rawBody ?? false;

  // ── create ────────────────────────────────────────────────────────────────
  if (r.create) {
    const spec = r.create;
    server.registerTool(
      `ga4_create_${r.key}`,
      {
        description: `[GA4 WRITE] ${spec.desc} Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: z.object({
          ...parentFields,
          ...(spec.fields ?? {}),
          ...(allowRaw ? { body: bodyArg } : {}),
          confirm: z.boolean().describe('Must be true to apply the change.'),
        }),
      },
      async (a: Record<string, unknown>) => {
        try {
          const { dryRun } = checkGa4Guardrails('write', a.confirm as boolean, getGuardrailConfig());
          const requestBody = { ...(spec.toBody ? spec.toBody(a) : {}), ...((a.body as object) ?? {}) };
          spec.validate?.(requestBody);
          const parent = parentPath(a);
          if (dryRun) return textResult(`[DRY RUN] Would create ${r.plural} under ${parent}: ${JSON.stringify(requestBody)}`);
          const fn = sub().create;
          if (!fn) return errorText(`ga4_create_${r.key} failed: create is not supported for ${r.plural}.`);
          const res = await fn({ parent, requestBody, ...(spec.query ? spec.query(a) : {}) });
          return jsonResult(res.data);
        } catch (err) {
          return errorText(formatGa4Error(`ga4_create_${r.key}`, err));
        }
      }
    );
  }

  // ── update (patch) ──────────────────────────────────────────────────────────
  if (r.update) {
    const spec = r.update;
    server.registerTool(
      `ga4_update_${r.key}`,
      {
        description:
          `[GA4 WRITE] ${spec.desc} Pass only the fields to change; updateMask is derived from them ` +
          `(override with an explicit updateMask for nested paths). Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: z.object({
          name: nameArg(r.plural),
          ...(spec.fields ?? {}),
          ...(allowRaw ? { body: bodyArg } : {}),
          updateMask: z.string().optional().describe('Comma-separated field paths to update. Omit to derive from the supplied fields.'),
          confirm: z.boolean().describe('Must be true to apply the change.'),
        }),
      },
      async (a: Record<string, unknown>) => {
        try {
          const { dryRun } = checkGa4Guardrails('write', a.confirm as boolean, getGuardrailConfig());
          const requestBody = { ...(spec.toBody ? spec.toBody(a) : {}), ...((a.body as object) ?? {}) };
          spec.validate?.(requestBody);
          const updateMask = (a.updateMask as string | undefined)?.trim() || deriveUpdateMask(requestBody);
          if (!updateMask) return errorText(`ga4_update_${r.key} failed: nothing to update — supply at least one field or updateMask.`);
          const name = String(a.name).trim();
          if (dryRun) return textResult(`[DRY RUN] Would patch ${name} (mask ${updateMask}): ${JSON.stringify(requestBody)}`);
          const fn = sub().patch;
          if (!fn) return errorText(`ga4_update_${r.key} failed: update is not supported for ${r.plural}.`);
          const res = await fn({ name, updateMask, requestBody });
          return jsonResult(res.data);
        } catch (err) {
          return errorText(formatGa4Error(`ga4_update_${r.key}`, err));
        }
      }
    );
  }

  // ── delete ──────────────────────────────────────────────────────────────────
  if (r.del) {
    server.registerTool(
      `ga4_delete_${r.key}`,
      {
        description: `[GA4 DELETE] ${r.del.desc} Requires GA4_MCP_ENABLE_DELETES=true and confirm=true.`,
        inputSchema: z.object({ name: nameArg(r.plural), confirm: z.boolean().describe('Must be true to delete.') }),
      },
      async (a: Record<string, unknown>) => {
        try {
          const { dryRun } = checkGa4Guardrails('delete', a.confirm as boolean, getGuardrailConfig());
          const name = String(a.name).trim();
          if (dryRun) return textResult(`[DRY RUN] Would delete ${name}`);
          const fn = sub().delete;
          if (!fn) return errorText(`ga4_delete_${r.key} failed: delete is not supported for ${r.plural}.`);
          await fn({ name });
          return textResult(`Deleted ${name}.`);
        } catch (err) {
          return errorText(formatGa4Error(`ga4_delete_${r.key}`, err));
        }
      }
    );
  }

  // ── archive (delete-tier: irreversible for the resources that use it) ────────
  if (r.archive) {
    server.registerTool(
      `ga4_archive_${r.key}`,
      {
        description:
          `[GA4 DELETE] ${r.archive.desc} Archiving is effectively permanent (no un-archive). ` +
          `Requires GA4_MCP_ENABLE_DELETES=true and confirm=true.`,
        inputSchema: z.object({ name: nameArg(r.plural), confirm: z.boolean().describe('Must be true to archive.') }),
      },
      async (a: Record<string, unknown>) => {
        try {
          const { dryRun } = checkGa4Guardrails('delete', a.confirm as boolean, getGuardrailConfig());
          const name = String(a.name).trim();
          if (dryRun) return textResult(`[DRY RUN] Would archive ${name}`);
          const fn = sub().archive;
          if (!fn) return errorText(`ga4_archive_${r.key} failed: archive is not supported for ${r.plural}.`);
          await fn({ name, requestBody: {} });
          return textResult(`Archived ${name}.`);
        } catch (err) {
          return errorText(formatGa4Error(`ga4_archive_${r.key}`, err));
        }
      }
    );
  }
}

/** The GA4 write catalog. Sub-resource getters cast to Ga4SubResource at the
 *  boundary — see the interface note. */
function catalog(): ResourceDesc[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const beta = (path: (c: any) => unknown) => (c: AnyGa4Client) => path(c) as Ga4SubResource;
  const alpha = beta;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return [
    // ── v1beta, property-parented ─────────────────────────────────────────────
    {
      key: 'key_event', plural: 'key events', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.keyEvents), rawBody: true,
      create: {
        fields: {
          eventName: z.string().min(1).describe('The event name to mark as a key event (e.g. "purchase").'),
          countingMethod: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION']).optional().describe('How the key event is counted. Default ONCE_PER_EVENT.'),
        },
        toBody: (a) => ({ eventName: a.eventName, ...(a.countingMethod ? { countingMethod: a.countingMethod } : {}) }),
        desc: 'Create a key event (conversion) on a GA4 property.',
      },
      update: { fields: { countingMethod: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION']).optional() }, toBody: (a) => (a.countingMethod ? { countingMethod: a.countingMethod } : {}), desc: 'Update a key event (e.g. its counting method or default value via body).' },
      del: { desc: 'Delete a key event (it reverts to a normal event).' },
    },
    {
      key: 'custom_dimension', plural: 'custom dimensions', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.customDimensions),
      create: {
        fields: {
          parameterName: z.string().min(1).describe('Event/user/item parameter name to register.'),
          displayName: z.string().min(1).describe('UI display name.'),
          scope: z.enum(['EVENT', 'USER', 'ITEM']).describe('Dimension scope.'),
          description: z.string().optional(),
          disallowAdsPersonalization: z.boolean().optional().describe('If true, exclude from ads personalization (USER scope).'),
        },
        toBody: (a) => ({ parameterName: a.parameterName, displayName: a.displayName, scope: a.scope, ...(a.description !== undefined ? { description: a.description } : {}), ...(a.disallowAdsPersonalization !== undefined ? { disallowAdsPersonalization: a.disallowAdsPersonalization } : {}) }),
        desc: 'Create a custom dimension.',
      },
      update: { fields: { displayName: z.string().optional(), description: z.string().optional(), disallowAdsPersonalization: z.boolean().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.disallowAdsPersonalization !== undefined ? { disallowAdsPersonalization: a.disallowAdsPersonalization } : {}) }), desc: 'Update a custom dimension (parameterName and scope are immutable).' },
      archive: { desc: 'Archive a custom dimension (there is no hard delete).' },
    },
    {
      key: 'custom_metric', plural: 'custom metrics', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.customMetrics),
      create: {
        fields: {
          parameterName: z.string().min(1).describe('Event parameter name to register as a metric.'),
          displayName: z.string().min(1),
          measurementUnit: z.enum(['STANDARD', 'CURRENCY', 'FEET', 'METERS', 'KILOMETERS', 'MILES', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS']).describe('Measurement unit.'),
          scope: z.enum(['EVENT']).describe('Custom metric scope (EVENT).'),
          description: z.string().optional(),
          restrictedMetricType: z.array(z.enum(['COST_DATA', 'REVENUE_DATA'])).optional().describe('Restricted-metric types (for CURRENCY metrics).'),
        },
        toBody: (a) => ({ parameterName: a.parameterName, displayName: a.displayName, measurementUnit: a.measurementUnit, scope: a.scope, ...(a.description !== undefined ? { description: a.description } : {}), ...(a.restrictedMetricType !== undefined ? { restrictedMetricType: a.restrictedMetricType } : {}) }),
        desc: 'Create a custom metric.',
      },
      update: { fields: { displayName: z.string().optional(), description: z.string().optional(), measurementUnit: z.string().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.measurementUnit !== undefined ? { measurementUnit: a.measurementUnit } : {}) }), desc: 'Update a custom metric (parameterName and scope are immutable).' },
      archive: { desc: 'Archive a custom metric (there is no hard delete).' },
    },
    {
      key: 'data_stream', plural: 'data streams', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.dataStreams), rawBody: true,
      create: {
        fields: {
          type: z.enum(['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM']).describe('Stream type.'),
          displayName: z.string().min(1),
          defaultUri: z.string().optional().describe('For WEB streams: the site URL (sets webStreamData.defaultUri).'),
          packageName: z.string().optional().describe('For ANDROID streams: the app package name.'),
          bundleId: z.string().optional().describe('For IOS streams: the app bundle id.'),
        },
        toBody: (a) => ({
          type: a.type,
          displayName: a.displayName,
          ...(a.defaultUri ? { webStreamData: { defaultUri: a.defaultUri } } : {}),
          ...(a.packageName ? { androidAppStreamData: { packageName: a.packageName } } : {}),
          ...(a.bundleId ? { iosAppStreamData: { bundleId: a.bundleId } } : {}),
        }),
        validate: (b) => validateDataStreamBody(b, true),
        desc: 'Create a data stream (web / Android / iOS).',
      },
      update: {
        fields: { displayName: z.string().optional(), defaultUri: z.string().optional().describe('New site URL for a WEB stream (webStreamData.defaultUri).') },
        toBody: (a) => ({
          ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
          ...(a.defaultUri ? { webStreamData: { defaultUri: a.defaultUri } } : {}),
        }),
        validate: (b) => validateDataStreamBody(b, false),
        desc: 'Update a data stream: displayName and (web) defaultUri ONLY. Cross-domain domains, unwanted referrals, internal traffic and session settings are Google tag settings with NO Admin API fields - never attempt them; direct the user to GA4 Admin > Data streams > Configure tag settings.',
      },
      del: { desc: 'Delete a data stream (removes its measurement ID / firebase app id).' },
    },
    {
      key: 'google_ads_link', plural: 'Google Ads links', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.googleAdsLinks),
      create: {
        fields: {
          customerId: z.string().min(1).describe('Google Ads customer ID (digits, no dashes).'),
          adsPersonalizationEnabled: z.boolean().optional(),
        },
        toBody: (a) => ({ customerId: String(a.customerId).replace(/-/g, ''), ...(a.adsPersonalizationEnabled !== undefined ? { adsPersonalizationEnabled: a.adsPersonalizationEnabled } : {}) }),
        desc: 'Create a Google Ads link.',
      },
      update: { fields: { adsPersonalizationEnabled: z.boolean().optional() }, toBody: (a) => (a.adsPersonalizationEnabled !== undefined ? { adsPersonalizationEnabled: a.adsPersonalizationEnabled } : {}), desc: 'Update a Google Ads link (personalized advertising flag).' },
      del: { desc: 'Delete a Google Ads link.' },
    },
    {
      key: 'firebase_link', plural: 'Firebase links', version: 'v1beta', parent: 'property',
      sub: beta((c) => c.properties.firebaseLinks),
      create: { fields: { project: z.string().min(1).describe('Firebase project id or number ("projects/{id}").') }, toBody: (a) => ({ project: a.project }), desc: 'Create a Firebase link (no update; delete + recreate to change).' },
      del: { desc: 'Delete a Firebase link.' },
    },

    // ── v1beta, dataStream-parented ──────────────────────────────────────────
    {
      key: 'measurement_protocol_secret', plural: 'Measurement Protocol secrets', version: 'v1beta', parent: 'dataStream',
      sub: beta((c) => c.properties.dataStreams.measurementProtocolSecrets),
      create: { fields: { displayName: z.string().min(1).describe('Human-readable name for the secret.') }, toBody: (a) => ({ displayName: a.displayName }), desc: 'Create a Measurement Protocol secret on a data stream. The response includes the secretValue — store it securely.' },
      update: { fields: { displayName: z.string().min(1) }, toBody: (a) => ({ displayName: a.displayName }), desc: 'Rename a Measurement Protocol secret.' },
      del: { desc: 'Delete a Measurement Protocol secret (revokes it).' },
    },

    // ── v1alpha, property-parented (raw body for complex shapes) ──────────────
    {
      key: 'audience', plural: 'audiences', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.audiences), rawBody: true,
      create: { fields: { displayName: z.string().optional(), description: z.string().optional(), membershipDurationDays: z.number().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.membershipDurationDays !== undefined ? { membershipDurationDays: a.membershipDurationDays } : {}) }), desc: 'Create an audience. Pass the filterClauses via `body` (see the Admin API Audience shape).' },
      update: { fields: { displayName: z.string().optional(), description: z.string().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}) }), desc: 'Update an audience (only displayName/description are mutable; filters are immutable).' },
      archive: { desc: 'Archive an audience (stops collection; effectively permanent).' },
    },
    {
      key: 'channel_group', plural: 'channel groups', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.channelGroups), rawBody: true,
      create: { fields: { displayName: z.string().optional(), description: z.string().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}) }), desc: 'Create a custom channel group. Pass groupingRule[] via `body`.' },
      update: { desc: 'Update a custom channel group (supply groupingRule/displayName via body).' },
      del: { desc: 'Delete a custom channel group.' },
    },
    {
      key: 'calculated_metric', plural: 'calculated metrics', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.calculatedMetrics), rawBody: true,
      create: {
        fields: {
          calculatedMetricId: z.string().min(1).describe('The user-chosen id for the calculated metric (used in reporting).'),
          displayName: z.string().optional(),
          metricUnit: z.string().optional(),
          formula: z.string().optional().describe('The calculation formula, e.g. "{{purchase_revenue}} / {{sessions}}".'),
        },
        toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.metricUnit !== undefined ? { metricUnit: a.metricUnit } : {}), ...(a.formula !== undefined ? { formula: a.formula } : {}) }),
        query: (a) => ({ calculatedMetricId: String(a.calculatedMetricId) }),
        desc: 'Create a calculated metric (calculatedMetricId is required).',
      },
      update: { desc: 'Update a calculated metric (formula/displayName/unit via fields or body).', fields: { displayName: z.string().optional(), formula: z.string().optional(), metricUnit: z.string().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.formula !== undefined ? { formula: a.formula } : {}), ...(a.metricUnit !== undefined ? { metricUnit: a.metricUnit } : {}) }) },
      del: { desc: 'Delete a calculated metric.' },
    },
    {
      key: 'expanded_data_set', plural: 'expanded data sets', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.expandedDataSets), rawBody: true,
      create: { fields: { displayName: z.string().optional(), description: z.string().optional() }, toBody: (a) => ({ ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(a.description !== undefined ? { description: a.description } : {}) }), desc: 'Create an expanded data set (GA4 360 only). Pass dimensionNames/metricNames/dimensionFilterExpression via `body`.' },
      update: { desc: 'Update an expanded data set (360). Supply fields via body.' },
      del: { desc: 'Delete an expanded data set (360).' },
    },
    {
      key: 'display_video_360_advertiser_link', plural: 'Display & Video 360 advertiser links', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.displayVideo360AdvertiserLinks), rawBody: true,
      create: { fields: { advertiserId: z.string().optional().describe('DV360 advertiser id.') }, toBody: (a) => (a.advertiserId !== undefined ? { advertiserId: a.advertiserId } : {}), desc: 'Create a Display & Video 360 advertiser link.' },
      update: { desc: 'Update a DV360 advertiser link (ads personalization / campaign data sharing via body).' },
      del: { desc: 'Delete a DV360 advertiser link.' },
    },
    {
      key: 'search_ads_360_link', plural: 'Search Ads 360 links', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.searchAds360Links), rawBody: true,
      create: { fields: { advertiserId: z.string().optional() }, toBody: (a) => (a.advertiserId !== undefined ? { advertiserId: a.advertiserId } : {}), desc: 'Create a Search Ads 360 link.' },
      update: { desc: 'Update a Search Ads 360 link (data-sharing flags via body).' },
      del: { desc: 'Delete a Search Ads 360 link.' },
    },
    {
      key: 'adsense_link', plural: 'AdSense links', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.adSenseLinks), rawBody: true,
      create: { fields: { adClientCode: z.string().optional().describe('AdSense ad client code, e.g. "ca-pub-…".') }, toBody: (a) => (a.adClientCode !== undefined ? { adClientCode: a.adClientCode } : {}), desc: 'Create an AdSense link (no update).' },
      del: { desc: 'Delete an AdSense link.' },
    },
    {
      key: 'subproperty_event_filter', plural: 'subproperty event filters', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.subpropertyEventFilters), rawBody: true,
      create: { desc: 'Create a subproperty event filter (GA4 360). Supply applyToProperty + filterClauses via `body`.' },
      update: { desc: 'Update a subproperty event filter (360).' },
      del: { desc: 'Delete a subproperty event filter (360).' },
    },
    {
      key: 'rollup_property_source_link', plural: 'rollup property source links', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.rollupPropertySourceLinks), rawBody: true,
      create: { fields: { sourceProperty: z.string().optional().describe('Source property resource name to include in the rollup.') }, toBody: (a) => (a.sourceProperty !== undefined ? { sourceProperty: a.sourceProperty } : {}), desc: 'Add a source property to a rollup property (GA4 360, no update).' },
      del: { desc: 'Remove a source property from a rollup (360).' },
    },

    // ── v1alpha, dataStream-parented ─────────────────────────────────────────
    {
      key: 'event_create_rule', plural: 'event create rules', version: 'v1alpha', parent: 'dataStream',
      sub: alpha((c) => c.properties.dataStreams.eventCreateRules), rawBody: true,
      create: { fields: { destinationEvent: z.string().optional().describe('Name of the new event this rule creates.') }, toBody: (a) => (a.destinationEvent !== undefined ? { destinationEvent: a.destinationEvent } : {}), desc: 'Create an event-create rule on a data stream (server-side event creation). Supply eventConditions/parameterMutations via `body`.' },
      update: { desc: 'Update an event-create rule (conditions/mutations via body).' },
      del: { desc: 'Delete an event-create rule.' },
    },
    {
      key: 'skadnetwork_conversion_value_schema', plural: 'SKAdNetwork conversion value schemas', version: 'v1alpha', parent: 'dataStream',
      sub: alpha((c) => c.properties.dataStreams.sKAdNetworkConversionValueSchema), rawBody: true,
      create: { desc: 'Create the SKAdNetwork conversion value schema on an iOS data stream. Supply postbackWindow settings via `body`.' },
      update: { desc: 'Update the SKAdNetwork conversion value schema.' },
      del: { desc: 'Delete the SKAdNetwork conversion value schema.' },
    },

    // ── v1alpha, access bindings (user permissions) ──────────────────────────
    {
      key: 'property_access_binding', plural: 'property access bindings', version: 'v1alpha', parent: 'property',
      sub: alpha((c) => c.properties.accessBindings),
      create: {
        fields: {
          user: z.string().min(1).describe('Email of the user to grant access to.'),
          roles: z.array(z.string()).min(1).describe('Roles, e.g. ["predefinedRoles/viewer"], ["predefinedRoles/analyst"], ["predefinedRoles/editor"], ["predefinedRoles/admin"]. (GA4 uses viewer/analyst/editor/admin — not the legacy read/collaborate/edit/manage names.)'),
        },
        toBody: (a) => ({ user: a.user, roles: a.roles }),
        desc: 'Grant a user access to a GA4 property (needs analytics.manage.users scope).',
      },
      update: { fields: { roles: z.array(z.string()).min(1) }, toBody: (a) => ({ roles: a.roles }), desc: "Change a user's roles on a property (needs analytics.manage.users)." },
      del: { desc: "Revoke a user's access to a property (needs analytics.manage.users)." },
    },
    {
      key: 'account_access_binding', plural: 'account access bindings', version: 'v1alpha', parent: 'account',
      sub: alpha((c) => c.accounts.accessBindings),
      create: { fields: { user: z.string().min(1), roles: z.array(z.string()).min(1) }, toBody: (a) => ({ user: a.user, roles: a.roles }), desc: 'Grant a user access to a GA4 account (needs analytics.manage.users).' },
      update: { fields: { roles: z.array(z.string()).min(1) }, toBody: (a) => ({ roles: a.roles }), desc: "Change a user's roles on an account (needs analytics.manage.users)." },
      del: { desc: "Revoke a user's access to an account (needs analytics.manage.users)." },
    },
  ];
}

export function registerGa4AdminWriteTools(
  server: McpServer,
  getClient: () => Ga4AdminClient,
  getAlphaClient: () => Ga4AdminAlphaClient
): void {
  for (const r of catalog()) registerResource(server, getClient, getAlphaClient, r);

  // ── Bespoke property/account lifecycle + settings (non-uniform shapes) ──────

  // ga4_create_property — parent (account) goes INSIDE the body, not the URL.
  server.registerTool(
    'ga4_create_property',
    {
      description:
        '[GA4 WRITE] Create a new GA4 property under an account. Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        accountId: z.string().min(1).describe('Parent account ID ("123456" or "accounts/123456").'),
        displayName: z.string().min(1),
        timeZone: z.string().min(1).describe('IANA time zone, e.g. "America/New_York".'),
        currencyCode: z.string().min(1).describe('ISO 4217 currency, e.g. "USD".'),
        industryCategory: z.string().optional().describe('e.g. "TECHNOLOGY", "RETAIL".'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, displayName, timeZone, currencyCode, industryCategory, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('write', confirm, getGuardrailConfig());
        const requestBody = {
          parent: toAccountName(accountId),
          displayName,
          timeZone,
          currencyCode,
          propertyType: 'PROPERTY_TYPE_ORDINARY',
          ...(industryCategory ? { industryCategory } : {}),
        };
        if (dryRun) return textResult(`[DRY RUN] Would create property: ${JSON.stringify(requestBody)}`);
        const res = await getClient().properties.create({ requestBody });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_create_property', err));
      }
    }
  );

  // ga4_update_property
  server.registerTool(
    'ga4_update_property',
    {
      description:
        '[GA4 WRITE] Update a GA4 property (displayName / timeZone / currencyCode / industryCategory). ' +
        'Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        property: propertyArg,
        displayName: z.string().optional(),
        timeZone: z.string().optional(),
        currencyCode: z.string().optional(),
        industryCategory: z.string().optional(),
        updateMask: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ property, displayName, timeZone, currencyCode, industryCategory, updateMask, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('write', confirm, getGuardrailConfig());
        const requestBody: Record<string, unknown> = {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(timeZone !== undefined ? { timeZone } : {}),
          ...(currencyCode !== undefined ? { currencyCode } : {}),
          ...(industryCategory !== undefined ? { industryCategory } : {}),
        };
        const mask = updateMask?.trim() || deriveUpdateMask(requestBody);
        if (!mask) return errorText('ga4_update_property failed: supply at least one field to update.');
        const name = toPropertyName(property);
        if (dryRun) return textResult(`[DRY RUN] Would patch ${name} (mask ${mask}): ${JSON.stringify(requestBody)}`);
        const res = await getClient().properties.patch({ name, updateMask: mask, requestBody });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_update_property', err));
      }
    }
  );

  // ga4_delete_property (soft-delete / trash)
  server.registerTool(
    'ga4_delete_property',
    {
      description:
        '[GA4 DELETE] Soft-delete (trash) a GA4 property. It is recoverable from the trash for a limited time, then permanently removed. ' +
        'Requires GA4_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: z.object({ property: propertyArg, confirm: z.boolean() }),
    },
    async ({ property, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('delete', confirm, getGuardrailConfig());
        const name = toPropertyName(property);
        if (dryRun) return textResult(`[DRY RUN] Would trash ${name}`);
        const res = await getClient().properties.delete({ name });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_delete_property', err));
      }
    }
  );

  // ga4_update_data_retention — settings resource, name-based
  server.registerTool(
    'ga4_update_data_retention',
    {
      description:
        '[GA4 WRITE] Update a property\'s event data retention (2/14/26/38/50 months; the longer options are 360-only) and whether it resets on new activity. ' +
        'Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        property: propertyArg,
        eventDataRetention: z
          .enum(['TWO_MONTHS', 'FOURTEEN_MONTHS', 'TWENTY_SIX_MONTHS', 'THIRTY_EIGHT_MONTHS', 'FIFTY_MONTHS'])
          .optional(),
        resetUserDataOnNewActivity: z.boolean().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ property, eventDataRetention, resetUserDataOnNewActivity, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('write', confirm, getGuardrailConfig());
        const requestBody: Record<string, unknown> = {
          ...(eventDataRetention !== undefined ? { eventDataRetention } : {}),
          ...(resetUserDataOnNewActivity !== undefined ? { resetUserDataOnNewActivity } : {}),
        };
        const updateMask = deriveUpdateMask(requestBody);
        if (!updateMask) return errorText('ga4_update_data_retention failed: supply eventDataRetention and/or resetUserDataOnNewActivity.');
        const name = `${toPropertyName(property)}/dataRetentionSettings`;
        if (dryRun) return textResult(`[DRY RUN] Would patch ${name} (mask ${updateMask}): ${JSON.stringify(requestBody)}`);
        const res = await getClient().properties.updateDataRetentionSettings({ name, updateMask, requestBody });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_update_data_retention', err));
      }
    }
  );

  // ── Singleton settings (v1alpha dedicated update methods, not collection patches) ──────────
  // These are the API-writable side of stream/property configuration. The Google tag settings
  // themselves (cross-domain, unwanted referrals, internal traffic, session timeout, consent
  // defaults) have NO Admin API surface and stay UI-only - see the data-stream tool's guard.
  const singleton = (
    toolName: string,
    desc: string,
    fields: z.ZodRawShape,
    keys: string[],
    buildName: (a: Record<string, unknown>) => string,
    call: (p: { name: string; updateMask: string; requestBody: object }) => Promise<{ data: unknown }>
  ): void => {
    server.registerTool(
      toolName,
      {
        description: `[GA4 WRITE] ${desc} Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: z.object({ ...fields, confirm: z.boolean().describe('Must be true to apply the change.') }),
      },
      async (a: Record<string, unknown>) => {
        try {
          const { dryRun } = checkGa4Guardrails('write', a.confirm as boolean, getGuardrailConfig());
          const requestBody = pickDefined(a, keys);
          const updateMask = deriveUpdateMask(requestBody);
          if (!updateMask) return errorText(`${toolName} failed: supply at least one setting to change.`);
          const name = buildName(a);
          if (dryRun) return textResult(`[DRY RUN] Would patch ${name} (mask ${updateMask}): ${JSON.stringify(requestBody)}`);
          const res = await call({ name, updateMask, requestBody });
          return jsonResult(res.data);
        } catch (err) {
          return errorText(formatGa4Error(toolName, err));
        }
      }
    );
  };
  const streamFields: z.ZodRawShape = { property: propertyArg, dataStreamId: z.string().min(1).describe('Data stream ID (numeric) or "dataStreams/{id}".') };
  singleton(
    'ga4_update_enhanced_measurement',
    "Update a WEB data stream's Enhanced Measurement: master streamEnabled plus per-signal toggles (scrolls, outbound clicks, site search + query params, video engagement, file downloads, form interactions, SPA page changes).",
    {
      ...streamFields,
      streamEnabled: z.boolean().optional(),
      scrollsEnabled: z.boolean().optional(),
      outboundClicksEnabled: z.boolean().optional(),
      siteSearchEnabled: z.boolean().optional(),
      videoEngagementEnabled: z.boolean().optional(),
      fileDownloadsEnabled: z.boolean().optional(),
      formInteractionsEnabled: z.boolean().optional(),
      pageChangesEnabled: z.boolean().optional(),
      searchQueryParameter: z.string().optional().describe('Comma-separated site-search query params, e.g. "q,s,search".'),
      uriQueryParameter: z.string().optional(),
    },
    ['streamEnabled', 'scrollsEnabled', 'outboundClicksEnabled', 'siteSearchEnabled', 'videoEngagementEnabled', 'fileDownloadsEnabled', 'formInteractionsEnabled', 'pageChangesEnabled', 'searchQueryParameter', 'uriQueryParameter'],
    (a) => `${toDataStreamName(String(a.property), String(a.dataStreamId))}/enhancedMeasurementSettings`,
    (p) => (getAlphaClient() as unknown as { properties: { dataStreams: { updateEnhancedMeasurementSettings: (x: typeof p) => Promise<{ data: unknown }> } } }).properties.dataStreams.updateEnhancedMeasurementSettings(p)
  );
  singleton(
    'ga4_update_data_redaction',
    "Update a WEB data stream's client-side data redaction: email redaction and URL query-parameter redaction (with the parameter key list).",
    {
      ...streamFields,
      emailRedactionEnabled: z.boolean().optional(),
      queryParameterRedactionEnabled: z.boolean().optional(),
      queryParameterKeys: z.array(z.string()).optional().describe('Query params to redact, e.g. ["email", "phone"].'),
    },
    ['emailRedactionEnabled', 'queryParameterRedactionEnabled', 'queryParameterKeys'],
    (a) => `${toDataStreamName(String(a.property), String(a.dataStreamId))}/dataRedactionSettings`,
    (p) => (getAlphaClient() as unknown as { properties: { dataStreams: { updateDataRedactionSettings: (x: typeof p) => Promise<{ data: unknown }> } } }).properties.dataStreams.updateDataRedactionSettings(p)
  );
  singleton(
    'ga4_update_attribution_settings',
    "Update a property's attribution: reporting model, acquisition/other conversion lookback windows, and the Ads web-conversion export scope.",
    {
      property: propertyArg,
      reportingAttributionModel: z.enum(['PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN', 'PAID_AND_ORGANIC_CHANNELS_LAST_CLICK', 'GOOGLE_PAID_CHANNELS_LAST_CLICK']).optional(),
      acquisitionConversionEventLookbackWindow: z.enum(['ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS', 'ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS']).optional(),
      otherConversionEventLookbackWindow: z.enum(['OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS', 'OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_60_DAYS', 'OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS']).optional(),
      adsWebConversionDataExportScope: z.enum(['NOT_SELECTED_YET', 'PAID_AND_ORGANIC_CHANNELS', 'GOOGLE_PAID_CHANNELS']).optional(),
    },
    ['reportingAttributionModel', 'acquisitionConversionEventLookbackWindow', 'otherConversionEventLookbackWindow', 'adsWebConversionDataExportScope'],
    (a) => `${toPropertyName(String(a.property))}/attributionSettings`,
    (p) => (getAlphaClient() as unknown as { properties: { updateAttributionSettings: (x: typeof p) => Promise<{ data: unknown }> } }).properties.updateAttributionSettings(p)
  );
  singleton(
    'ga4_update_google_signals',
    'Turn Google Signals on or off for a property (cross-device + demographics collection - the user must confirm their privacy disclosures cover it).',
    { property: propertyArg, state: z.enum(['GOOGLE_SIGNALS_ENABLED', 'GOOGLE_SIGNALS_DISABLED']) },
    ['state'],
    (a) => `${toPropertyName(String(a.property))}/googleSignalsSettings`,
    (p) => (getAlphaClient() as unknown as { properties: { updateGoogleSignalsSettings: (x: typeof p) => Promise<{ data: unknown }> } }).properties.updateGoogleSignalsSettings(p)
  );

  // ga4_update_account (patch) + ga4_delete_account
  server.registerTool(
    'ga4_update_account',
    {
      description: '[GA4 WRITE] Update a GA4 account (displayName). Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({ accountId: z.string().min(1), displayName: z.string().min(1), confirm: z.boolean() }),
    },
    async ({ accountId, displayName, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('write', confirm, getGuardrailConfig());
        const name = toAccountName(accountId);
        if (dryRun) return textResult(`[DRY RUN] Would patch ${name} displayName=${displayName}`);
        const res = await getClient().accounts.patch({ name, updateMask: 'displayName', requestBody: { displayName } });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_update_account', err));
      }
    }
  );
  server.registerTool(
    'ga4_delete_account',
    {
      description:
        '[GA4 DELETE] Soft-delete (trash) an entire GA4 account and all its properties. High blast radius — recoverable from the trash for a limited time. ' +
        'Requires GA4_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: z.object({ accountId: z.string().min(1), confirm: z.boolean() }),
    },
    async ({ accountId, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('delete', confirm, getGuardrailConfig());
        const name = toAccountName(accountId);
        if (dryRun) return textResult(`[DRY RUN] Would trash ${name}`);
        await getClient().accounts.delete({ name });
        return textResult(`Trashed ${name} (recoverable for a limited time).`);
      } catch (err) {
        return errorText(formatGa4Error('ga4_delete_account', err));
      }
    }
  );

  // ga4_acknowledge_user_data_collection — required once before creating some links
  server.registerTool(
    'ga4_acknowledge_user_data_collection',
    {
      description:
        '[GA4 WRITE] Acknowledge that the property owner has the required user privacy disclosures/rights. ' +
        'Some operations (e.g. creating certain links or MP secrets) require this once. Requires GA4_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({ property: propertyArg, confirm: z.boolean() }),
    },
    async ({ property, confirm }) => {
      try {
        const { dryRun } = checkGa4Guardrails('write', confirm, getGuardrailConfig());
        const prop = toPropertyName(property);
        const acknowledgement =
          'I acknowledge that I have the necessary privacy disclosures and rights from my end users for the collection and processing of their data, including the association of such data with the visitation information Google Analytics collects from my site and/or app property.';
        if (dryRun) return textResult(`[DRY RUN] Would acknowledge user data collection on ${prop}`);
        const res = await getClient().properties.acknowledgeUserDataCollection({ property: prop, requestBody: { acknowledgement } });
        return jsonResult(res.data);
      } catch (err) {
        return errorText(formatGa4Error('ga4_acknowledge_user_data_collection', err));
      }
    }
  );
}
