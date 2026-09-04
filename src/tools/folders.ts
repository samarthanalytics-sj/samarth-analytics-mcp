/**
 * GTM Folders tools — full CRUD + entities listing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult, DEFAULT_MAX_PAGES } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { workspaceScope as wsBase } from '../utils/schemas.js';

export function registerFolderTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'folders_list',
    {
      description: 'List all GTM folders in a workspace. Automatically follows pagination to return all folders.',
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.folders.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.folder,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult('folders', result, { accountId, containerId, workspaceId }));
      } catch (err) {
        return errorResult('folders_list', err);
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
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('folders_get', err);
      }
    }
  );

  server.registerTool(
    'folders_entities',
    {
      description:
        'List all entities (tags, triggers, variables) within a specific GTM folder. ' +
        'Automatically follows pagination to return all entities.',
      inputSchema: wsBase.extend({
        folderId: z.string(),
        pageToken: paginationFields.pageToken,
        maxPages: paginationFields.maxPages.describe(
          `Maximum number of API pages to fetch (default ${DEFAULT_MAX_PAGES}). GTM returns one ` +
            'nextPageToken for tags, triggers and variables together, so this bounds the whole walk ' +
            'rather than each collection.'
        ),
      }),
    },
    async ({ accountId, containerId, workspaceId, folderId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`;
        // One un-tokened call was the whole implementation and res.data went out raw, so page 2 was
        // unreachable: the schema exposed no pageToken to feed the returned token back with. The
        // failure was silent and confidently wrong - a folder whose triggers all landed on page 2
        // came back with no `trigger` key at all, which reads as "this folder has no triggers"
        // rather than as a short answer.
        //
        // paginate() accumulates ONE list and this response carries three, so accumulate the page
        // BODIES and fan them out below. Walking the token stream three times would triple the API
        // calls for identical data.
        const pages = await paginate(
          (token) =>
            client.accounts.containers.workspaces.folders
              .entities({ path, pageToken: token })
              .then((r) => r.data),
          (data) => [data],
          { pageToken, maxPages }
        );
        // Always-present arrays: absent-versus-empty was the confusion the defect produced, so an
        // empty folder now says so instead of returning {}. No summed `count` - one total across
        // three collections, sitting next to a 3-element `tag` array, is a live misread.
        const tag = pages.items.flatMap((p) => p.tag ?? []);
        const trigger = pages.items.flatMap((p) => p.trigger ?? []);
        const variable = pages.items.flatMap((p) => p.variable ?? []);
        return jsonResult({
          tag,
          trigger,
          variable,
          counts: { tag: tag.length, trigger: trigger.length, variable: variable.length },
          ...(pages.truncated ? { truncated: true, nextPageToken: pages.nextPageToken } : {}),
        });
      } catch (err) {
        return errorResult('folders_entities', err);
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
          return textResult(`[DRY RUN] Would create folder "${name}"`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.folders.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, notes },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('folders_create', err);
      }
    }
  );

  server.registerTool(
    'folders_update',
    {
      description:
        '[WRITE] Update a GTM folder (read-modify-write: omitted fields are preserved). ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
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
          return textResult(`[DRY RUN] Would update folder ${folderId}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`;
        // GTM's folders.update is a full replace, not a patch. The body used to be the bare
        // `{ name, notes }` the caller passed, so renaming a folder silently wiped its notes and a
        // notes-only edit sent no name at all (GTM blanks or rejects it) even though the schema
        // declares both optional. Fetch first and overlay only what was actually supplied, exactly
        // as tags_update / triggers_update / variables_update already do.
        const existing = (await client.accounts.containers.workspaces.folders.get({ path })).data;
        const merged = { ...existing };
        if (name !== undefined) merged.name = name;
        if (notes !== undefined) merged.notes = notes;
        const res = await client.accounts.containers.workspaces.folders.update({
          path,
          fingerprint: fingerprint ?? existing.fingerprint ?? undefined,
          requestBody: merged,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('folders_update', err);
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
          return textResult(`[DRY RUN] Would delete folder ${folderId}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.folders.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        });
        return textResult(`Folder ${folderId} deleted. Contents moved to root.`);
      } catch (err) {
        return errorResult('folders_delete', err);
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
          return textResult(`[DRY RUN] Would move ${(tagId?.length ?? 0) + (triggerId?.length ?? 0) + (variableId?.length ?? 0)} entities into folder ${folderId}`);
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
        return textResult(`Entities moved to folder ${folderId} successfully.`);
      } catch (err) {
        return errorResult('folders_move_entities', err);
      }
    }
  );
}
