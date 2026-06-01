/**
 * GTM Workspaces tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';

const workspaceBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
});

export function registerWorkspaceTools(server: McpServer, getClient: () => GtmClient): void {
  // ── workspaces/list ──────────────────────────────────────────────────────
  server.registerTool(
    'workspaces_list',
    {
      description: 'List all workspaces within a GTM container. Automatically follows pagination to return all workspaces.',
      inputSchema: workspaceBase.extend(paginationFields),
    },
    async ({ accountId, containerId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.workspace,
          { pageToken, maxPages }
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(buildListResult('workspaces', result), null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `workspaces_list failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── workspaces/get ───────────────────────────────────────────────────────
  server.registerTool(
    'workspaces_get',
    {
      description: 'Get details of a specific GTM workspace.',
      inputSchema: workspaceBase.extend({
        workspaceId: z.string().describe('The GTM workspace ID.'),
      }),
    },
    async ({ accountId, containerId, workspaceId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `workspaces_get failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── workspaces/create ────────────────────────────────────────────────────
  server.registerTool(
    'workspaces_create',
    {
      description: '[WRITE] Create a new workspace. Requires GTM_MCP_ENABLE_WRITES=true.',
      inputSchema: workspaceBase.extend({
        name: z.string().describe('Workspace name.'),
        description: z.string().optional().describe('Workspace description.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, name, description, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [
              { type: 'text', text: `[DRY RUN] Would create workspace "${name}" in container ${containerId}` },
            ],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.create({
          parent: `accounts/${accountId}/containers/${containerId}`,
          requestBody: { name, description },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `workspaces_create failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── workspace/get_status ─────────────────────────────────────────────────
  server.registerTool(
    'workspace_get_status',
    {
      description:
        'Get the status of a GTM workspace: the list of changed entities (workspaceChange) ' +
        'relative to the latest container version, plus any merge conflicts. ' +
        'Use this to review a change diff before creating a version or publishing.',
      inputSchema: workspaceBase.extend({
        workspaceId: z.string().describe('The GTM workspace ID.'),
      }),
    },
    async ({ accountId, containerId, workspaceId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.getStatus({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        const changes = res.data.workspaceChange ?? [];
        const conflicts = res.data.mergeConflict ?? [];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  workspaceChange: changes,
                  changeCount: changes.length,
                  mergeConflict: conflicts,
                  conflictCount: conflicts.length,
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
          content: [{ type: 'text', text: `workspace_get_status failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── workspace/sync ───────────────────────────────────────────────────────
  server.registerTool(
    'workspace_sync',
    {
      description:
        'Syncs a workspace to the latest container version by updating all unmodified workspace entities. ' +
        'Returns a list of merge conflicts if any.',
      inputSchema: workspaceBase.extend({
        workspaceId: z.string().describe('The GTM workspace ID.'),
        confirm: z.boolean().describe('Must be true to confirm this operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [
              { type: 'text', text: `[DRY RUN] Would sync workspace ${workspaceId} to latest container version.` },
            ],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.sync({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `workspace_sync failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── workspace/resolve_conflict ───────────────────────────────────────────
  server.registerTool(
    'workspace_resolve_conflict',
    {
      description:
        'Resolve a merge conflict for a workspace entity. ' +
        'You must supply the full entity body to write into the workspace (overwriting the conflict). ' +
        'NOTE: This is a complex operation — review the GTM UI conflict resolution first.',
      inputSchema: workspaceBase.extend({
        workspaceId: z.string().describe('The GTM workspace ID.'),
        fingerprint: z
          .string()
          .describe('The workspace fingerprint at the time of conflict resolution.'),
        entityJson: z
          .string()
          .describe(
            'JSON string of the full entity (tag/trigger/variable/folder) to use as the resolved version.'
          ),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, fingerprint, entityJson, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [
              { type: 'text', text: `[DRY RUN] Would resolve conflict in workspace ${workspaceId}.` },
            ],
          };
        }
        let entity: unknown;
        try {
          entity = JSON.parse(entityJson);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text', text: 'entityJson must be valid JSON.' }],
          };
        }
        const client = getClient();
        // GTM API: accounts.containers.workspaces.resolve_conflict
        // This API takes a fingerprint query param and the entity body.
        const res = await client.accounts.containers.workspaces.resolve_conflict({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          fingerprint,
          requestBody: entity as Record<string, unknown>,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data ?? { success: true }, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `workspace_resolve_conflict failed: ${formatGoogleError(err)}` },
          ],
        };
      }
    }
  );
}
