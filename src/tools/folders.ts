/**
 * GTM Folders tools — full CRUD + entities listing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';

const wsBase = z.object({
  accountId: z.string(),
  containerId: z.string(),
  workspaceId: z.string(),
});

export function registerFolderTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'folders_list',
    {
      description: 'List all GTM folders in a workspace.',
      inputSchema: wsBase,
    },
    async ({ accountId, containerId, workspaceId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.list({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        const folders = res.data.folder ?? [];
        return {
          content: [{ type: 'text', text: JSON.stringify({ folders, count: folders.length }, null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_list failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_get',
    {
      description: 'Get a specific GTM folder.',
      inputSchema: wsBase.extend({ folderId: z.string() }),
    },
    async ({ accountId, containerId, workspaceId, folderId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_get failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_entities',
    {
      description: 'List all entities (tags, triggers, variables) within a specific GTM folder.',
      inputSchema: wsBase.extend({ folderId: z.string() }),
    },
    async ({ accountId, containerId, workspaceId, folderId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.entities({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_entities failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_create',
    {
      description: '[WRITE] Create a GTM folder. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string(),
        notes: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, notes, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would create folder "${name}"` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, notes },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_create failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_update',
    {
      description: '[WRITE] Update a GTM folder. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        folderId: z.string(),
        name: z.string().optional(),
        notes: z.string().optional(),
        fingerprint: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, folderId, name, notes, fingerprint, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would update folder ${folderId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.update({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
          ...(fingerprint ? { fingerprint } : {}),
          requestBody: { name, notes },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_update failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_delete',
    {
      description: '[DELETE] Delete a GTM folder. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true. Contents of the folder will be unfoldered, not deleted.',
      inputSchema: wsBase.extend({
        folderId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, folderId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would delete folder ${folderId}` }] };
        }
        const client = getClient();
        await client.accounts.containers.workspaces.folders.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        });
        return { content: [{ type: 'text', text: `Folder ${folderId} deleted. Contents moved to root.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_delete failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  server.registerTool(
    'folders_move_entities',
    {
      description: '[WRITE] Move tags/triggers/variables into a folder. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        folderId: z.string().describe('The destination folder ID.'),
        tagId: z.array(z.string()).optional().describe('Tag IDs to move.'),
        triggerId: z.array(z.string()).optional().describe('Trigger IDs to move.'),
        variableId: z.array(z.string()).optional().describe('Variable IDs to move.'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, folderId, tagId, triggerId, variableId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [{ type: 'text', text: `[DRY RUN] Would move ${(tagId?.length ?? 0) + (triggerId?.length ?? 0) + (variableId?.length ?? 0)} entities into folder ${folderId}` }],
          };
        }
        const client = getClient();
        // tagId, triggerId, variableId are passed as query params, not in requestBody
        await client.accounts.containers.workspaces.folders.move_entities_to_folder({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
          tagId,
          triggerId,
          variableId,
          requestBody: {},
        });
        return { content: [{ type: 'text', text: `Entities moved to folder ${folderId} successfully.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `folders_move_entities failed: ${formatGoogleError(err)}` }] };
      }
    }
  );
}
