import type { GoogleDataService } from '../google/data-service';
import type { LlmToolDef, ToolExecutor } from '../llm/types';

// Read-only GTM/GA4 tools the LLM can call. Each handler runs against the ACTIVE
// account (GoogleDataService resolves it), so the model only ever sees the
// signed-in user's own data. Results are returned as JSON strings to the model.
interface Tool extends LlmToolDef {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

export function buildToolRegistry(data: GoogleDataService): ToolExecutor {
  const tools: Tool[] = [
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
        properties: { accountId: { type: 'string', description: 'GTM account id, e.g. "6004123456"' } },
        required: ['accountId'],
        additionalProperties: false,
      },
      handler: (args) => data.listGtmContainers(String(args.accountId ?? '')),
    },
    {
      name: 'list_ga4_accounts',
      description: 'List the Google Analytics 4 account summaries the signed-in user can access.',
      inputSchema: { ...EMPTY_SCHEMA },
      handler: () => data.listGa4Accounts(),
    },
    {
      name: 'list_ga4_properties',
      description: 'List GA4 properties under an account. Requires account resource name like "accounts/123456".',
      inputSchema: {
        type: 'object',
        properties: { account: { type: 'string', description: 'GA4 account resource name, e.g. "accounts/123456"' } },
        required: ['account'],
        additionalProperties: false,
      },
      handler: (args) => data.listGa4Properties(String(args.account ?? '')),
    },
    {
      name: 'list_gtm_workspaces',
      description: 'List the workspaces in a GTM container. Requires the numeric accountId and containerId.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'GTM account id' },
          containerId: { type: 'string', description: 'GTM container id' },
        },
        required: ['accountId', 'containerId'],
        additionalProperties: false,
      },
      handler: (args) =>
        data.listGtmWorkspaces(String(args.accountId ?? ''), String(args.containerId ?? '')),
    },
    {
      name: 'list_gtm_tags',
      description:
        'List the tags in a GTM workspace. Requires numeric accountId, containerId, and workspaceId (get workspaceId from list_gtm_workspaces).',
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
      handler: (args) =>
        data.listGtmTags(
          String(args.accountId ?? ''),
          String(args.containerId ?? ''),
          String(args.workspaceId ?? '')
        ),
    },
    {
      name: 'list_ga4_data_streams',
      description: 'List the data streams of a GA4 property. Requires property resource name like "properties/123456".',
      inputSchema: {
        type: 'object',
        properties: { property: { type: 'string', description: 'GA4 property, e.g. "properties/123456"' } },
        required: ['property'],
        additionalProperties: false,
      },
      handler: (args) => data.listGa4DataStreams(String(args.property ?? '')),
    },
    {
      name: 'run_ga4_report',
      description:
        'Run a GA4 report for a property. dimensions/metrics are GA4 API names (e.g. dimensions ["date","country"], metrics ["activeUsers","sessions"]). Dates accept "NdaysAgo", "today", "yesterday", or YYYY-MM-DD.',
      inputSchema: {
        type: 'object',
        properties: {
          property: { type: 'string', description: 'GA4 property, e.g. "properties/123456"' },
          startDate: { type: 'string', description: 'e.g. "28daysAgo" or "2024-01-01"' },
          endDate: { type: 'string', description: 'e.g. "today"' },
          dimensions: { type: 'array', items: { type: 'string' } },
          metrics: { type: 'array', items: { type: 'string' } },
        },
        required: ['property', 'startDate', 'endDate', 'metrics'],
        additionalProperties: false,
      },
      handler: (args) =>
        data.runGa4Report({
          property: String(args.property ?? ''),
          startDate: String(args.startDate ?? '28daysAgo'),
          endDate: String(args.endDate ?? 'today'),
          dimensions: Array.isArray(args.dimensions) ? args.dimensions.map(String) : [],
          metrics: Array.isArray(args.metrics) ? args.metrics.map(String) : [],
        }),
    },
  ];

  return {
    list: (): LlmToolDef[] => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    execute: async (name, args): Promise<string> => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return JSON.stringify(await tool.handler(args ?? {}));
    },
  };
}
