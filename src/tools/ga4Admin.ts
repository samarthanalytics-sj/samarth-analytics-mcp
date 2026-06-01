/**
 * Google Analytics Admin API (GA4) — read-only MCP tools.
 *
 * These tools wrap the googleapis `analyticsadmin` v1beta client and expose ONLY
 * list/get methods. There are deliberately no create/update/delete tools and no
 * `confirm` gate, because nothing here mutates GA4 state. They power the senior
 * audit framework's GA4_ADMIN checks: custom dimensions/metrics, data streams &
 * measurement IDs, data retention, enhanced measurement, conversion/key events,
 * and Google Ads links.
 *
 * AUTH: Requires the `https://www.googleapis.com/auth/analytics.readonly` scope
 * to be present on the active credentials (see ALL_SCOPES in auth/googleAuth).
 * If that scope is missing, Google returns a 403 and the tools surface a clear
 * hint to re-run `npm run auth:google`.
 *
 * LIMITATIONS (not exposed by the GA4 Admin API v1beta and therefore NOT faked):
 *   - Internal traffic / unwanted-referral *data filters*: the Admin API has no
 *     public "dataFilters" collection. Internal-traffic and developer-traffic
 *     filtering is configured per data stream and is not separately listable.
 *   - Referral exclusions / "list unwanted referrals": no dedicated Admin API
 *     resource. (Referral configuration lives inside data stream settings.)
 *   - Channel groups and audiences exist only on the v1alpha surface; they are
 *     intentionally omitted from this read-only v1beta tool set.
 * These gaps are documented rather than stubbed so the audit never reports a
 * false signal.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ga4AdminClient, Ga4AdminAlphaClient } from '../utils/ga4Client.js';
import { formatGoogleError } from '../utils/guardrails.js';
import { paginate, buildListResult, paginationFields } from '../utils/pagination.js';
import { GA4_ADMIN_READONLY_SCOPE } from '../auth/googleAuth.js';

/**
 * Format a GA4 Admin error. When the failure is a missing-scope / permission
 * problem, append a hint pointing at the read-only analytics scope so users
 * know to re-consent rather than chasing a GA4 permissions red herring.
 */
function formatGa4Error(toolName: string, err: unknown): string {
  const base = formatGoogleError(err);
  const lower = base.toLowerCase();
  const looksLikeScopeIssue =
    lower.includes('insufficient') ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied') ||
    lower.includes('403') ||
    lower.includes('scope') ||
    lower.includes('access_token_scope_insufficient');
  const hint = looksLikeScopeIssue
    ? `\nHint: this often means the GA4 read scope is missing. Re-run "npm run auth:google" ` +
      `to grant ${GA4_ADMIN_READONLY_SCOPE}, or confirm the account has GA4 access.`
    : '';
  return `${toolName} failed: ${base}${hint}`;
}

/** Normalize a property identifier into the API's `properties/{id}` form. */
function toPropertyName(property: string): string {
  const trimmed = property.trim();
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}

/** Normalize an account identifier into the API's `accounts/{id}` form. */
function toAccountName(account: string): string {
  const trimmed = account.trim();
  return trimmed.startsWith('accounts/') ? trimmed : `accounts/${trimmed}`;
}

const propertyArg = z
  .string()
  .min(1)
  .describe('GA4 property ID, e.g. "123456789" or "properties/123456789".');

export function registerGa4AdminTools(
  server: McpServer,
  getClient: () => Ga4AdminClient,
  getAlphaClient: () => Ga4AdminAlphaClient
): void {
  // ── ga4_account_summaries_list ────────────────────────────────────────────
  server.registerTool(
    'ga4_account_summaries_list',
    {
      description:
        'List GA4 account summaries accessible to the authenticated user. Each ' +
        'summary includes the account plus a lightweight list of its property ' +
        'summaries (property ID + display name). Best starting point to discover ' +
        'available GA4 accounts and properties. Read-only.',
      inputSchema: z.object({ ...paginationFields }),
    },
    async ({ pageToken, maxPages }) => {
      try {
        const client = getClient();
        const result = await paginate(
          (token) =>
            client.accountSummaries
              .list({ pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.accountSummaries ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(buildListResult('accountSummaries', result), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_account_summaries_list', err) }],
        };
      }
    }
  );

  // ── ga4_properties_list ───────────────────────────────────────────────────
  server.registerTool(
    'ga4_properties_list',
    {
      description:
        'List GA4 properties under a given parent account. Returns full property ' +
        'records (display name, time zone, currency, industry, service level). ' +
        'Read-only.',
      inputSchema: z.object({
        accountId: z
          .string()
          .min(1)
          .describe('Parent GA4 account ID, e.g. "123456" or "accounts/123456".'),
        showDeleted: z
          .boolean()
          .optional()
          .describe('Include soft-deleted (trashed) properties in the results.'),
        ...paginationFields,
      }),
    },
    async ({ accountId, showDeleted, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const filter = `parent:${toAccountName(accountId)}`;
        const result = await paginate(
          (token) =>
            client.properties
              .list({
                filter,
                pageSize: 200,
                ...(showDeleted !== undefined ? { showDeleted } : {}),
                ...(token ? { pageToken: token } : {}),
              })
              .then((r) => r.data),
          (data) => data.properties ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(buildListResult('properties', result), null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_properties_list', err) }],
        };
      }
    }
  );

  // ── ga4_property_get ──────────────────────────────────────────────────────
  server.registerTool(
    'ga4_property_get',
    {
      description:
        'Get a single GA4 property by ID, including display name, time zone, ' +
        'currency, industry category, and service level. Read-only.',
      inputSchema: z.object({ property: propertyArg }),
    },
    async ({ property }) => {
      try {
        const client = getClient();
        const res = await client.properties.get({ name: toPropertyName(property) });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_property_get', err) }],
        };
      }
    }
  );

  // ── ga4_data_streams_list ─────────────────────────────────────────────────
  server.registerTool(
    'ga4_data_streams_list',
    {
      description:
        'List data streams for a GA4 property (web, Android, iOS). Web streams ' +
        'include the measurement ID and default URI; app streams include package ' +
        'name / bundle ID. Use this to audit measurement IDs and stream config. ' +
        'Read-only.',
      inputSchema: z.object({ property: propertyArg, ...paginationFields }),
    },
    async ({ property, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = toPropertyName(property);
        const result = await paginate(
          (token) =>
            client.properties.dataStreams
              .list({ parent, pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.dataStreams ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(buildListResult('dataStreams', result), null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_data_streams_list', err) }],
        };
      }
    }
  );

  // ── ga4_enhanced_measurement_get ──────────────────────────────────────────
  server.registerTool(
    'ga4_enhanced_measurement_get',
    {
      description:
        'Get the enhanced measurement settings for a specific WEB data stream ' +
        '(scrolls, outbound clicks, site search, video engagement, file ' +
        'downloads, form interactions). Only valid for web streams. Served via ' +
        'the Admin API v1alpha surface (not yet in v1beta). Read-only.',
      inputSchema: z.object({
        property: propertyArg,
        dataStreamId: z
          .string()
          .min(1)
          .describe('The data stream ID (numeric) or full "dataStreams/{id}" suffix.'),
      }),
    },
    async ({ property, dataStreamId }) => {
      try {
        const client = getAlphaClient();
        const streamSuffix = dataStreamId.trim().startsWith('dataStreams/')
          ? dataStreamId.trim()
          : `dataStreams/${dataStreamId.trim()}`;
        const name = `${toPropertyName(property)}/${streamSuffix}/enhancedMeasurementSettings`;
        const res = await client.properties.dataStreams.getEnhancedMeasurementSettings({ name });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text', text: formatGa4Error('ga4_enhanced_measurement_get', err) },
          ],
        };
      }
    }
  );

  // ── ga4_custom_dimensions_list ────────────────────────────────────────────
  server.registerTool(
    'ga4_custom_dimensions_list',
    {
      description:
        'List custom dimensions configured on a GA4 property (parameter name, ' +
        'display name, scope: EVENT/USER/ITEM). Read-only.',
      inputSchema: z.object({ property: propertyArg, ...paginationFields }),
    },
    async ({ property, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = toPropertyName(property);
        const result = await paginate(
          (token) =>
            client.properties.customDimensions
              .list({ parent, pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.customDimensions ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(buildListResult('customDimensions', result), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_custom_dimensions_list', err) }],
        };
      }
    }
  );

  // ── ga4_custom_metrics_list ───────────────────────────────────────────────
  server.registerTool(
    'ga4_custom_metrics_list',
    {
      description:
        'List custom metrics configured on a GA4 property (parameter name, ' +
        'display name, measurement unit, scope, restricted-metric type). ' +
        'Read-only.',
      inputSchema: z.object({ property: propertyArg, ...paginationFields }),
    },
    async ({ property, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = toPropertyName(property);
        const result = await paginate(
          (token) =>
            client.properties.customMetrics
              .list({ parent, pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.customMetrics ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(buildListResult('customMetrics', result), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_custom_metrics_list', err) }],
        };
      }
    }
  );

  // ── ga4_data_retention_get ────────────────────────────────────────────────
  server.registerTool(
    'ga4_data_retention_get',
    {
      description:
        'Get the data retention settings for a GA4 property (event data retention ' +
        'duration and whether retention resets on new activity). Read-only.',
      inputSchema: z.object({ property: propertyArg }),
    },
    async ({ property }) => {
      try {
        const client = getClient();
        const name = `${toPropertyName(property)}/dataRetentionSettings`;
        const res = await client.properties.getDataRetentionSettings({ name });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_data_retention_get', err) }],
        };
      }
    }
  );

  // ── ga4_key_events_list ───────────────────────────────────────────────────
  server.registerTool(
    'ga4_key_events_list',
    {
      description:
        'List key events (formerly "conversion events") for a GA4 property — the ' +
        'current Admin API naming. Returns event name, counting method, and ' +
        'whether the event is deletable. Read-only.',
      inputSchema: z.object({ property: propertyArg, ...paginationFields }),
    },
    async ({ property, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = toPropertyName(property);
        const result = await paginate(
          (token) =>
            client.properties.keyEvents
              .list({ parent, pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.keyEvents ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(buildListResult('keyEvents', result), null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_key_events_list', err) }],
        };
      }
    }
  );

  // ── ga4_google_ads_links_list ─────────────────────────────────────────────
  server.registerTool(
    'ga4_google_ads_links_list',
    {
      description:
        'List Google Ads links for a GA4 property (linked customer ID, ' +
        'personalized-advertising and auto-tagging flags). Read-only.',
      inputSchema: z.object({ property: propertyArg, ...paginationFields }),
    },
    async ({ property, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = toPropertyName(property);
        const result = await paginate(
          (token) =>
            client.properties.googleAdsLinks
              .list({ parent, pageSize: 200, ...(token ? { pageToken: token } : {}) })
              .then((r) => r.data),
          (data) => data.googleAdsLinks ?? [],
          { pageToken, maxPages }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(buildListResult('googleAdsLinks', result), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_google_ads_links_list', err) }],
        };
      }
    }
  );
}
