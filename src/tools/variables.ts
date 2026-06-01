/**
 * GTM Variables tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';

const wsBase = z.object({
  accountId: z.string(),
  containerId: z.string(),
  workspaceId: z.string(),
});

const parameterSchema = z
  .array(z.object({ type: z.string(), key: z.string().optional(), value: z.string().optional() }))
  .optional();

export function registerVariableTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'variables_list',
    {
      description: 'List all user-defined GTM variables in a workspace. Automatically follows pagination to return all variables.',
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.variables.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.variable,
          { pageToken, maxPages }
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(buildListResult('variables', result), null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `variables_list failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'variables_get',
    {
      description: 'Get a specific GTM variable.',
      inputSchema: wsBase.extend({ variableId: z.string() }),
    },
    async ({ accountId, containerId, workspaceId, variableId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.variables.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `variables_get failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'variables_create',
    {
      description: '[WRITE] Create a GTM variable. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Variable name.'),
        type: z.string().describe('Variable type (e.g. "v" for data layer, "k" for first-party cookie, "u" for URL, "c" for constant, "jsm" for custom JS, "smm" for lookup table, "gas" for GA settings).'),
        parameter: parameterSchema,
        notes: z.string().optional(),
        parentFolderId: z.string().optional(),
        enablingTriggerId: z.array(z.string()).optional(),
        disablingTriggerId: z.array(z.string()).optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, type, parameter, notes, parentFolderId, enablingTriggerId, disablingTriggerId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would create variable "${name}" (type: ${type})` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.variables.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, parameter, notes, parentFolderId, enablingTriggerId, disablingTriggerId },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `variables_create failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'variables_update',
    {
      description: '[WRITE] Update a GTM variable. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        variableId: z.string(),
        name: z.string().optional(),
        type: z.string().optional(),
        parameter: parameterSchema,
        notes: z.string().optional(),
        fingerprint: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, variableId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would update variable ${variableId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.variables.update({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
          ...(fingerprint ? { fingerprint } : {}),
          requestBody: updates,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `variables_update failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'variables_delete',
    {
      description: '[DELETE] Delete a GTM variable. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: wsBase.extend({
        variableId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, variableId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would delete variable ${variableId}` }] };
        }
        const client = getClient();
        await client.accounts.containers.workspaces.variables.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
        });
        return { content: [{ type: 'text', text: `Variable ${variableId} deleted successfully.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `variables_delete failed: ${formatGoogleError(err)}` }] };
      }
    }
  );
}
