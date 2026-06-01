/**
 * Google Analytics Data API (GA4) — read-only reporting MCP tools.
 *
 * Wraps the googleapis `analyticsdata` v1beta client and exposes ONLY the
 * read-only report methods (`runReport`, `runRealtimeReport`). There are no
 * create/update/delete tools and no `confirm` gate because reporting never
 * mutates GA4 state. These power "intent-vs-reality" reconciliation in the
 * audit: comparing the events a container is *configured* to send against the
 * events GA4 actually *reports*.
 *
 * AUTH: Requires the `https://www.googleapis.com/auth/analytics.readonly` scope
 * on the active credentials — the SAME scope the GA4 Admin tools use, so no
 * additional consent is needed. A 403 mentioning scope means re-run
 * `npm run auth:google`.
 *
 * The tool inputs cover the common reporting shape (dimensions, metrics, date
 * ranges, row limit, ordering). Advanced features (pivots, cohorts, funnels)
 * are intentionally NOT exposed here — they are documented gaps, not stubs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ga4DataClient } from '../utils/ga4Client.js';
import { formatGoogleError } from '../utils/guardrails.js';
import { GA4_ADMIN_READONLY_SCOPE } from '../auth/googleAuth.js';

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

const propertyArg = z
  .string()
  .min(1)
  .describe('GA4 property ID, e.g. "123456789" or "properties/123456789".');

const dimensionsArg = z
  .array(z.string().min(1))
  .max(9)
  .optional()
  .describe(
    'Dimension names, e.g. ["eventName","date"]. Max 9. Omit for a metric-only report.'
  );

const metricsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(10)
  .describe('Metric names, e.g. ["eventCount","totalUsers"]. At least 1, max 10.');

export function registerGa4DataTools(
  server: McpServer,
  getClient: () => Ga4DataClient
): void {
  // ── ga4_run_report ─────────────────────────────────────────────────────────
  server.registerTool(
    'ga4_run_report',
    {
      description:
        'Run a read-only GA4 Data API report for a property over a date range. ' +
        'Returns dimension/metric rows (e.g. event counts by eventName). Useful ' +
        'for reconciling configured GTM/GA4 events against events GA4 actually ' +
        'reports (zero reported activity for a configured event is a red flag). ' +
        'Read-only — never writes. Requires the analytics.readonly scope.',
      inputSchema: z.object({
        property: propertyArg,
        dimensions: dimensionsArg,
        metrics: metricsArg,
        startDate: z
          .string()
          .min(1)
          .default('7daysAgo')
          .describe('Start date: YYYY-MM-DD, "NdaysAgo", "today", or "yesterday".'),
        endDate: z
          .string()
          .min(1)
          .default('today')
          .describe('End date: YYYY-MM-DD, "NdaysAgo", "today", or "yesterday".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250000)
          .default(250)
          .describe('Max rows to return (default 250).'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Row offset for paging (default 0).'),
        orderByMetric: z
          .string()
          .min(1)
          .optional()
          .describe('Metric name to order by (descending). Optional.'),
      }),
    },
    async ({
      property,
      dimensions,
      metrics,
      startDate,
      endDate,
      limit,
      offset,
      orderByMetric,
    }) => {
      try {
        const client = getClient();
        const res = await client.properties.runReport({
          property: toPropertyName(property),
          requestBody: {
            dimensions: (dimensions ?? []).map((name) => ({ name })),
            metrics: metrics.map((name) => ({ name })),
            dateRanges: [{ startDate, endDate }],
            limit: String(limit),
            ...(typeof offset === 'number' ? { offset: String(offset) } : {}),
            ...(orderByMetric
              ? {
                  orderBys: [
                    { metric: { metricName: orderByMetric }, desc: true },
                  ],
                }
              : {}),
          },
        });
        const data = res.data;
        const dimHeaders = (data.dimensionHeaders ?? []).map((h) => h.name);
        const metHeaders = (data.metricHeaders ?? []).map((h) => h.name);
        const rows = (data.rows ?? []).map((row) => {
          const out: Record<string, string> = {};
          (row.dimensionValues ?? []).forEach((v, i) => {
            const key = dimHeaders[i] ?? `dimension_${i}`;
            if (key) out[key] = v.value ?? '';
          });
          (row.metricValues ?? []).forEach((v, i) => {
            const key = metHeaders[i] ?? `metric_${i}`;
            if (key) out[key] = v.value ?? '';
          });
          return out;
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  property: toPropertyName(property),
                  dateRange: { startDate, endDate },
                  rowCount: data.rowCount ?? rows.length,
                  dimensionHeaders: dimHeaders,
                  metricHeaders: metHeaders,
                  rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: formatGa4Error('ga4_run_report', err) }],
        };
      }
    }
  );

  // ── ga4_run_realtime_report ─────────────────────────────────────────────────
  server.registerTool(
    'ga4_run_realtime_report',
    {
      description:
        'Run a read-only GA4 Data API Realtime report (events in roughly the last ' +
        '30 minutes). Useful to confirm a tag is firing right now during live QA. ' +
        'Read-only — never writes. Requires the analytics.readonly scope.',
      inputSchema: z.object({
        property: propertyArg,
        dimensions: dimensionsArg,
        metrics: metricsArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .default(100)
          .describe('Max rows to return (default 100).'),
      }),
    },
    async ({ property, dimensions, metrics, limit }) => {
      try {
        const client = getClient();
        const res = await client.properties.runRealtimeReport({
          property: toPropertyName(property),
          requestBody: {
            dimensions: (dimensions ?? []).map((name) => ({ name })),
            metrics: metrics.map((name) => ({ name })),
            limit: String(limit),
          },
        });
        const data = res.data;
        const dimHeaders = (data.dimensionHeaders ?? []).map((h) => h.name);
        const metHeaders = (data.metricHeaders ?? []).map((h) => h.name);
        const rows = (data.rows ?? []).map((row) => {
          const out: Record<string, string> = {};
          (row.dimensionValues ?? []).forEach((v, i) => {
            const key = dimHeaders[i] ?? `dimension_${i}`;
            if (key) out[key] = v.value ?? '';
          });
          (row.metricValues ?? []).forEach((v, i) => {
            const key = metHeaders[i] ?? `metric_${i}`;
            if (key) out[key] = v.value ?? '';
          });
          return out;
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  property: toPropertyName(property),
                  rowCount: data.rowCount ?? rows.length,
                  dimensionHeaders: dimHeaders,
                  metricHeaders: metHeaders,
                  rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text', text: formatGa4Error('ga4_run_realtime_report', err) },
          ],
        };
      }
    }
  );
}
