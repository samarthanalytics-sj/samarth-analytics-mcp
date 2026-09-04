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
import { jsonResult, errorText } from '../utils/toolResponse.js';
import { formatGa4Error, toPropertyName } from '../utils/ga4Errors.js';
import { formatGoogleError } from '../utils/guardrails.js';
import { googleErrorStatus } from '../utils/writeDiagnostics.js';

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

/**
 * True when `name` appears in `text` as a whole API name.
 *
 * Used to read which requested field the Data API named in an incompatibility
 * rejection. The boundary check keeps "sessions" from matching inside
 * "sessionsPerUser", which would report a field Google never mentioned.
 */
function mentionsName(text: string, name: string): boolean {
  if (!name) return false;
  const isNameChar = (c: string) => /[A-Za-z0-9_:]/.test(c);
  for (let from = 0; ; ) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + name.length);
    if (!isNameChar(before) && !isNameChar(after)) return true;
    from = at + 1;
  }
}

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
        // GA4's rowCount is the TOTAL matching rows, independent of limit/offset — so it can exceed the
        // number of `rows` actually returned. Surface returnedRowCount + hasMore so a caller never mistakes
        // a truncated page for the complete result (e.g. filtering the returned rows and wrongly concluding
        // an event is absent when it only lives in an un-returned page). Page via `offset` when hasMore.
        const totalRows = data.rowCount ?? rows.length;
        return jsonResult({
          property: toPropertyName(property),
          dateRange: { startDate, endDate },
          rowCount: totalRows,
          returnedRowCount: rows.length,
          hasMore: totalRows > (offset ?? 0) + rows.length,
          dimensionHeaders: dimHeaders,
          metricHeaders: metHeaders,
          rows,
        });
      } catch (err) {
        return errorText(formatGa4Error('ga4_run_report', err));
      }
    }
  );

  // ── ga4_check_compatibility ─────────────────────────────────────────────────
  server.registerTool(
    'ga4_check_compatibility',
    {
      description:
        'Check which of the given GA4 dimensions/metrics can be combined in ONE report on this ' +
        'property (the Data API rejects incompatible pairs). Call this BEFORE ga4_run_report when ' +
        'combining unusual dimensions/metrics; drop or replace anything reported incompatible ' +
        'instead of retrying blind. Read-only.',
      inputSchema: z.object({
        property: propertyArg,
        dimensions: z.array(z.string()).optional().describe('Dimension API names to test.'),
        metrics: z.array(z.string()).optional().describe('Metric API names to test.'),
      }),
    },
    async ({ property, dimensions, metrics }) => {
      const askedDimensions = dimensions ?? [];
      const askedMetrics = metrics ?? [];
      try {
        // Both lists are optional, so a call with NEITHER is well-formed - and it would return two
        // empty buckets, which reads as "nothing is incompatible" for a check that tested nothing.
        // Refuse it instead of answering a question nobody asked.
        if (askedDimensions.length === 0 && askedMetrics.length === 0) {
          return errorText(
            'Nothing to check: pass at least one dimension or metric. An empty request would report no incompatibilities without having tested anything.'
          );
        }
        const res = await getClient().properties.checkCompatibility({
          property: toPropertyName(property),
          requestBody: {
            dimensions: askedDimensions.map((name) => ({ name })),
            metrics: askedMetrics.map((name) => ({ name })),
          },
        });
        const dims = res.data.dimensionCompatibilities ?? [];
        const mets = res.data.metricCompatibilities ?? [];
        // checkCompatibility does NOT grade the request field by field. It answers "what ELSE could
        // this report carry", returning the property's ENTIRE dimension/metric catalogue marked
        // COMPATIBLE/INCOMPATIBLE for being ADDED to the request, and it refuses the call outright
        // (400, handled below) when the requested set itself clashes. The old code bucketed that whole
        // catalogue, so a valid two-field request came back with dozens of never-requested names under
        // `incompatible` and a caller was told its working report was broken. Only the fields the
        // caller actually sent get a verdict now; the rest of the compatible catalogue is offered
        // separately as `canAlsoAdd` so the information is kept but can never read as a verdict.
        type CompatRow = {
          compatibility?: string | null;
          dimensionMetadata?: { apiName?: string | null } | null;
          metricMetadata?: { apiName?: string | null } | null;
        };
        const grade = (rows: CompatRow[], asked: string[]) => {
          const wanted = new Set(asked);
          const verdict = new Map<string, boolean>();
          const canAlsoAdd: string[] = [];
          for (const row of rows) {
            const name = (row.dimensionMetadata ?? row.metricMetadata)?.apiName ?? '';
            if (!name) continue;
            const ok = row.compatibility === 'COMPATIBLE';
            if (wanted.has(name)) verdict.set(name, ok);
            else if (ok) canAlsoAdd.push(name);
          }
          // Reaching here means the API accepted the set, and it only does that when the set is
          // compatible - so a requested field the catalogue happens not to list is compatible by that
          // contract, not an unanswered field. Only an explicit INCOMPATIBLE overrides it.
          return {
            compatible: asked.filter((n) => verdict.get(n) !== false),
            incompatible: asked.filter((n) => verdict.get(n) === false),
            canAlsoAdd,
          };
        };
        const d = grade(dims, askedDimensions);
        const m = grade(mets, askedMetrics);
        const incompatible = { dimensions: d.incompatible, metrics: m.incompatible };
        const allCompatible = incompatible.dimensions.length + incompatible.metrics.length === 0;
        return jsonResult({
          requested: { dimensions: askedDimensions, metrics: askedMetrics },
          allCompatible,
          compatible: { dimensions: d.compatible, metrics: m.compatible },
          incompatible,
          canAlsoAdd: { dimensions: d.canAlsoAdd, metrics: m.canAlsoAdd },
          note: allCompatible
            ? 'Every requested field is compatible: this set is safe to run as-is. `canAlsoAdd` lists the OTHER fields on this property that could join the same report, and is not a verdict on anything you asked about.'
            : 'Fields under `incompatible` cannot sit in the same report as the rest of this set. Two fields that clash are both reported, so removing one may make the other usable - drop them one at a time and re-check rather than discarding the whole list.',
        });
      } catch (err) {
        const apiMessage = formatGoogleError(err);
        // The API never answers "these clash" with a list: when the requested set is incompatible it
        // REFUSES the call with 400 and names the field(s) to remove in the message. Returning that as
        // a tool error - the old behaviour - meant the one question this tool exists to answer came
        // back as a failure. Report it as the verdict instead. Only a 400 that actually talks about
        // compatibility is converted; every other failure still surfaces as an error.
        if (googleErrorStatus(err) === 400 && /compatib/i.test(apiMessage)) {
          // Match Google's wording against the names WE sent rather than parsing its sentence shape,
          // so nothing is invented and a reworded message degrades to an empty list plus apiMessage.
          const named = (asked: string[]) => asked.filter((n) => mentionsName(apiMessage, n));
          return jsonResult({
            requested: { dimensions: askedDimensions, metrics: askedMetrics },
            allCompatible: false,
            compatible: { dimensions: [], metrics: [] },
            incompatible: { dimensions: named(askedDimensions), metrics: named(askedMetrics) },
            apiMessage,
            note:
              'The Data API rejected this combination outright, so it returned no per-field verdict: `compatible` is empty because nothing was graded, not because every field is unusable. `incompatible` lists only the fields Google named in `apiMessage`. Drop one of them and re-check.',
          });
        }
        return errorText(formatGa4Error('ga4_check_compatibility', err));
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
        // rowCount is the total; the realtime report has no offset, so rows beyond `limit` are
        // unreachable — flag truncated so the caller narrows dimensions / raises limit instead of
        // trusting an incomplete set.
        const totalRows = data.rowCount ?? rows.length;
        return jsonResult({
          property: toPropertyName(property),
          rowCount: totalRows,
          returnedRowCount: rows.length,
          truncated: totalRows > rows.length,
          dimensionHeaders: dimHeaders,
          metricHeaders: metHeaders,
          rows,
        });
      } catch (err) {
        return errorText(formatGa4Error('ga4_run_realtime_report', err));
      }
    }
  );
}
