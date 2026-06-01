/**
 * GTM Tags tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';

const wsBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
  workspaceId: z.string().describe('The GTM workspace ID.'),
});

const singleParamSchema = z.object({
  type: z.string().describe('Parameter type: template, integer, boolean, list, map, tagReference, triggerReference.'),
  key: z.string().optional(),
  value: z.string().optional(),
});

// GTM parameters can be nested (list/map of parameters), but the googleapis SDK
// expects Schema$Parameter[] for nested entries. We accept plain objects and cast.
const parameterSchema = z
  .array(singleParamSchema)
  .optional()
  .describe('GTM parameter list. For list/map parameters, use the GTM UI or pass via raw JSON update.');

export function registerTagTools(server: McpServer, getClient: () => GtmClient): void {
  // ── tags/list ────────────────────────────────────────────────────────────
  server.registerTool(
    'tags_list',
    {
      description: 'List all GTM tags in a workspace. Automatically follows pagination to return all tags.',
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.tags.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.tag,
          { pageToken, maxPages }
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(buildListResult('tags', result), null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `tags_list failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── tags/get ─────────────────────────────────────────────────────────────
  server.registerTool(
    'tags_get',
    {
      description: 'Get details of a specific GTM tag.',
      inputSchema: wsBase.extend({
        tagId: z.string().describe('The GTM tag ID.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, tagId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.tags.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `tags_get failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── tags/create ──────────────────────────────────────────────────────────
  server.registerTool(
    'tags_create',
    {
      description:
        '[WRITE] Create a new GTM tag. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'Pass the full tag configuration as parameters.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Tag name.'),
        type: z.string().describe('Tag type (e.g. "ua", "ga4", "html", "img").'),
        parameter: parameterSchema,
        firingTriggerId: z.array(z.string()).optional().describe('IDs of firing triggers.'),
        blockingTriggerId: z.array(z.string()).optional().describe('IDs of blocking triggers.'),
        notes: z.string().optional().describe('Optional notes.'),
        parentFolderId: z.string().optional().describe('Parent folder ID.'),
        paused: z.boolean().optional().describe('Whether the tag is paused.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({
      accountId, containerId, workspaceId,
      name, type, parameter, firingTriggerId, blockingTriggerId, notes, parentFolderId, paused, confirm,
    }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [{ type: 'text', text: `[DRY RUN] Would create tag "${name}" (type: ${type}) in workspace ${workspaceId}` }],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.tags.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, parameter: parameter as import('googleapis').tagmanager_v2.Schema$Parameter[] | undefined, firingTriggerId, blockingTriggerId, notes, parentFolderId, paused },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `tags_create failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── tags/update ──────────────────────────────────────────────────────────
  server.registerTool(
    'tags_update',
    {
      description:
        '[WRITE] Update an existing GTM tag. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'Only the fields provided will be updated (partial update via the API fingerprint).',
      inputSchema: wsBase.extend({
        tagId: z.string().describe('The GTM tag ID to update.'),
        name: z.string().optional().describe('New tag name.'),
        type: z.string().optional().describe('New tag type.'),
        parameter: parameterSchema,
        firingTriggerId: z.array(z.string()).optional().describe('IDs of firing triggers.'),
        blockingTriggerId: z.array(z.string()).optional().describe('IDs of blocking triggers.'),
        notes: z.string().optional().describe('Optional notes.'),
        paused: z.boolean().optional().describe('Whether the tag is paused.'),
        fingerprint: z.string().optional().describe('Current tag fingerprint (for optimistic locking).'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, tagId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [{ type: 'text', text: `[DRY RUN] Would update tag ${tagId} in workspace ${workspaceId}` }],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.tags.update({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
          ...(fingerprint ? { fingerprint } : {}),
          requestBody: updates as import('googleapis').tagmanager_v2.Schema$Tag,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `tags_update failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── tags/delete ──────────────────────────────────────────────────────────
  server.registerTool(
    'tags_delete',
    {
      description:
        '[DELETE] Delete a GTM tag. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true. ' +
        'This is irreversible in the workspace (the tag is removed from the workspace).',
      inputSchema: wsBase.extend({
        tagId: z.string().describe('The GTM tag ID to delete.'),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, tagId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return {
            content: [{ type: 'text', text: `[DRY RUN] Would delete tag ${tagId} from workspace ${workspaceId}` }],
          };
        }
        const client = getClient();
        await client.accounts.containers.workspaces.tags.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
        });
        return {
          content: [{ type: 'text', text: `Tag ${tagId} deleted successfully from workspace ${workspaceId}.` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `tags_delete failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );
}
