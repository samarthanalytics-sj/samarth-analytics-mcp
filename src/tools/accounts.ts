/**
 * GTM Accounts tools
 * accounts/list
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { jsonResult, errorResult } from '../utils/toolResponse.js';

export function registerAccountTools(server: McpServer, getClient: () => GtmClient): void {
  // ── accounts/list ────────────────────────────────────────────────────────
  server.registerTool(
    'accounts_list',
    {
      description:
        'List all GTM accounts accessible to the authenticated user. ' +
        'Returns account IDs, names, and share-data flags.',
      inputSchema: z.object({
        includeGoogleTags: z
          .boolean()
          .optional()
          .describe('Also include results from the Google Tags accounts.'),
      }),
    },
    async ({ includeGoogleTags }) => {
      try {
        const client = getClient();
        const res = await client.accounts.list({
          ...(includeGoogleTags !== undefined ? { includeGoogleTags } : {}),
        });
        const accounts = res.data.account ?? [];
        return jsonResult({ accounts, count: accounts.length });
      } catch (err) {
        return errorResult('accounts_list', err);
      }
    }
  );

  // ── accounts/get ─────────────────────────────────────────────────────────
  server.registerTool(
    'accounts_get',
    {
      description: 'Get details of a specific GTM account.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID (numeric string).'),
      }),
    },
    async ({ accountId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.get({ path: `accounts/${accountId}` });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('accounts_get', err);
      }
    }
  );
}
