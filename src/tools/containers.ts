/**
 * GTM Containers tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';

export function registerContainerTools(server: McpServer, getClient: () => GtmClient): void {
  // ── containers/list ──────────────────────────────────────────────────────
  server.registerTool(
    'containers_list',
    {
      description: 'List all GTM containers within a GTM account.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
      }),
    },
    async ({ accountId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.list({ parent: `accounts/${accountId}` });
        const containers = res.data.container ?? [];
        return {
          content: [
            { type: 'text', text: JSON.stringify({ containers, count: containers.length }, null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_list failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── containers/get ───────────────────────────────────────────────────────
  server.registerTool(
    'containers_get',
    {
      description: 'Get details of a specific GTM container.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
      }),
    },
    async ({ accountId, containerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.get({
          path: `accounts/${accountId}/containers/${containerId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_get failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── containers/create ────────────────────────────────────────────────────
  server.registerTool(
    'containers_create',
    {
      description:
        '[WRITE] Create a new GTM container. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        name: z.string().describe('Container name.'),
        usageContext: z
          .array(z.enum(['web', 'androidSdk5', 'iosSdk5', 'amp', 'server']))
          .describe('Usage context(s) for the container.'),
        domainName: z.array(z.string()).optional().describe('Associated domain names.'),
        notes: z.string().optional().describe('Optional notes.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, name, usageContext, domainName, notes, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [
              {
                type: 'text',
                text: `[DRY RUN] Would create container "${name}" in account ${accountId} with context: ${usageContext.join(', ')}`,
              },
            ],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.create({
          parent: `accounts/${accountId}`,
          requestBody: { name, usageContext, domainName, notes },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_create failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );
}
