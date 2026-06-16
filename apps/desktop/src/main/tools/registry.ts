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
