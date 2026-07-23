/**
 * GTM Export tool
 *
 * Exports a container workspace as a structured summary JSON.
 * Useful for documentation, diffing, or feeding to other tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { paginate } from '../utils/pagination.js';
import { jsonResult, errorResult } from '../utils/toolResponse.js';

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

        // Fetch everything in parallel, each one PAGINATED. These were single .list() calls, which
        // is a worse bug here than in a list tool: this output is named an export, so it gets used
        // as a backup or a migration source, and a silently short one loses entities that nobody
        // will miss until they are needed.
        const [tagsP, triggersP, variablesP, foldersP, bivP, wsRes] = await Promise.all([
          paginate((t) => client.accounts.containers.workspaces.tags.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.tag),
          paginate((t) => client.accounts.containers.workspaces.triggers.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.trigger),
          paginate((t) => client.accounts.containers.workspaces.variables.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.variable),
          paginate((t) => client.accounts.containers.workspaces.folders.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.folder),
          paginate((t) => client.accounts.containers.workspaces.built_in_variables.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.builtInVariable),
          client.accounts.containers.workspaces.get({ path: parent }),
        ]);

        const tags = tagsP.items;
        const triggers = triggersP.items;
        const variables = variablesP.items;
        const folders = foldersP.items;
        const builtInVariables = bivP.items;
        const workspace = wsRes.data;
        // If even the 50-page ceiling was not enough, the export is INCOMPLETE and must say so on
        // the artifact itself. A caller who stores this file will not re-read the tool response.
        const short = [
          ['tags', tagsP], ['triggers', triggersP], ['variables', variablesP],
          ['folders', foldersP], ['builtInVariables', bivP],
        ].filter(([, r]) => (r as { truncated: boolean }).truncated).map(([k]) => k as string);
        const incomplete = short.length
          ? { incomplete: true, truncatedCollections: short, warning: `This export is INCOMPLETE: ${short.join(', ')} hit the page ceiling, so entities are missing. Do not use it as a backup.` }
          : {};

        let exportData: unknown;

        if (format === 'full') {
          exportData = {
            exportedAt: new Date().toISOString(),
            ...incomplete,
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

        return jsonResult(exportData);
      } catch (err) {
        return errorResult('export_container', err);
      }
    }
  );
}
