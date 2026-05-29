/**
 * GTM Export tool
 *
 * Exports a container workspace as a structured summary JSON.
 * Useful for documentation, diffing, or feeding to other tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError } from '../utils/guardrails.js';

export function registerExportTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'export_container',
    {
      description:
        'Export a full GTM workspace summary as structured JSON. ' +
        'Returns all tags, triggers, variables, folders, and built-in variables. ' +
        'This is a read-only operation. ' +
        'Use this for documentation, auditing, or feeding container data to other tools.',
      inputSchema: z.object({
        accountId: z.string(),
        containerId: z.string(),
        workspaceId: z.string(),
        format: z
          .enum(['full', 'summary', 'names_only'])
          .optional()
          .default('summary')
          .describe(
            '"full" = all fields, "summary" = key fields only, "names_only" = just names and IDs'
          ),
      }),
    },
    async ({ accountId, containerId, workspaceId, format }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;

        // Fetch everything in parallel
        const [tagsRes, triggersRes, variablesRes, foldersRes, bivRes, wsRes] = await Promise.all([
          client.accounts.containers.workspaces.tags.list({ parent }),
          client.accounts.containers.workspaces.triggers.list({ parent }),
          client.accounts.containers.workspaces.variables.list({ parent }),
          client.accounts.containers.workspaces.folders.list({ parent }),
          client.accounts.containers.workspaces.built_in_variables.list({ parent }),
          client.accounts.containers.workspaces.get({ path: parent }),
        ]);

        const tags = tagsRes.data.tag ?? [];
        const triggers = triggersRes.data.trigger ?? [];
        const variables = variablesRes.data.variable ?? [];
        const folders = foldersRes.data.folder ?? [];
        const builtInVariables = bivRes.data.builtInVariable ?? [];
        const workspace = wsRes.data;

        let exportData: unknown;

        if (format === 'full') {
          exportData = {
            exportedAt: new Date().toISOString(),
            workspace,
            tags,
            triggers,
            variables,
            folders,
            builtInVariables,
          };
        } else if (format === 'summary') {
          exportData = {
            exportedAt: new Date().toISOString(),
            workspace: {
              workspaceId: workspace.workspaceId,
              name: workspace.name,
              description: workspace.description,
              fingerprint: workspace.fingerprint,
            },
            stats: {
              tags: tags.length,
              triggers: triggers.length,
              variables: variables.length,
              folders: folders.length,
              builtInVariables: builtInVariables.length,
            },
            tags: tags.map((t) => ({
              tagId: t.tagId,
              name: t.name,
              type: t.type,
              paused: t.paused,
              firingTriggerId: t.firingTriggerId,
              blockingTriggerId: t.blockingTriggerId,
              parentFolderId: t.parentFolderId,
              notes: t.notes,
              paramCount: t.parameter?.length ?? 0,
            })),
            triggers: triggers.map((t) => ({
              triggerId: t.triggerId,
              name: t.name,
              type: t.type,
              parentFolderId: t.parentFolderId,
              notes: t.notes,
              filterCount: t.filter?.length ?? 0,
            })),
            variables: variables.map((v) => ({
              variableId: v.variableId,
              name: v.name,
              type: v.type,
              parentFolderId: v.parentFolderId,
              notes: v.notes,
              paramCount: v.parameter?.length ?? 0,
            })),
            folders: folders.map((f) => ({
              folderId: f.folderId,
              name: f.name,
              notes: f.notes,
            })),
            builtInVariables: builtInVariables.map((b) => ({
              type: b.type,
              name: b.name,
            })),
          };
        } else {
          // names_only
          exportData = {
            exportedAt: new Date().toISOString(),
            workspaceName: workspace.name,
            tags: tags.map((t) => ({ id: t.tagId, name: t.name, type: t.type })),
            triggers: triggers.map((t) => ({ id: t.triggerId, name: t.name, type: t.type })),
            variables: variables.map((v) => ({ id: v.variableId, name: v.name, type: v.type })),
            folders: folders.map((f) => ({ id: f.folderId, name: f.name })),
            builtInVariables: builtInVariables.map((b) => b.type),
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(exportData, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `export_container failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );
}
