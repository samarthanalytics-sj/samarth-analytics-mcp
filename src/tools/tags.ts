/**
 * GTM Tags tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { addEventParameters, mergeParametersByKey } from '../utils/tagParams.js';

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
        return jsonResult(buildListResult('tags', result));
      } catch (err) {
        return errorResult('tags_list', err);
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
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('tags_get', err);
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
          return textResult(`[DRY RUN] Would create tag "${name}" (type: ${type}) in workspace ${workspaceId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.tags.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, parameter: parameter as import('googleapis').tagmanager_v2.Schema$Parameter[] | undefined, firingTriggerId, blockingTriggerId, notes, parentFolderId, paused },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('tags_create', err);
      }
    }
  );

  // ── tags/update ──────────────────────────────────────────────────────────
  server.registerTool(
    'tags_update',
    {
      description:
        '[WRITE] Update an existing GTM tag (read-modify-write). Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'GTM\'s API replaces the WHOLE tag on update, so this tool first fetches the tag and only overlays the fields you pass — omitted fields are preserved. ' +
        '`parameter` is MERGED with the existing parameters BY KEY (a same-key param replaces, new keys are added, untouched keys are kept), so you will NOT wipe a GA4 tag\'s eventName/measurementId. ' +
        'To add GA4 EVENT parameters to a gaawe tag, prefer tags_add_ga4_event_parameters (event params live in the nested eventSettingsTable, which this generic parameter list cannot express).',
      inputSchema: wsBase.extend({
        tagId: z.string().describe('The GTM tag ID to update.'),
        name: z.string().optional().describe('New tag name.'),
        type: z.string().optional().describe('New tag type.'),
        parameter: parameterSchema,
        firingTriggerId: z.array(z.string()).optional().describe('IDs of firing triggers.'),
        blockingTriggerId: z.array(z.string()).optional().describe('IDs of blocking triggers.'),
        notes: z.string().optional().describe('Optional notes.'),
        paused: z.boolean().optional().describe('Whether the tag is paused.'),
        fingerprint: z.string().optional().describe('Current tag fingerprint (for optimistic locking). Defaults to the fetched one.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, tagId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update tag ${tagId} in workspace ${workspaceId}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
        // Read-modify-write: fetch the full tag, overlay only the provided fields, and
        // merge `parameter` by key — GTM's update is a full replace, so anything we
        // don't send back would otherwise be cleared.
        const existing = (await client.accounts.containers.workspaces.tags.get({ path })).data;
        const merged: import('googleapis').tagmanager_v2.Schema$Tag = { ...existing };
        if (updates.name !== undefined) merged.name = updates.name;
        if (updates.type !== undefined) merged.type = updates.type;
        if (updates.notes !== undefined) merged.notes = updates.notes;
        if (updates.paused !== undefined) merged.paused = updates.paused;
        if (updates.firingTriggerId !== undefined) merged.firingTriggerId = updates.firingTriggerId;
        if (updates.blockingTriggerId !== undefined) merged.blockingTriggerId = updates.blockingTriggerId;
        if (updates.parameter !== undefined) {
          merged.parameter = mergeParametersByKey(
            existing.parameter ?? [],
            updates.parameter as import('googleapis').tagmanager_v2.Schema$Parameter[],
          );
        }
        const res = await client.accounts.containers.workspaces.tags.update({
          path,
          fingerprint: fingerprint ?? existing.fingerprint ?? undefined,
          requestBody: merged,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('tags_update', err);
      }
    }
  );

  // ── tags/add GA4 event parameters ────────────────────────────────────────
  server.registerTool(
    'tags_add_ga4_event_parameters',
    {
      description:
        '[WRITE] Add GA4 event parameters to a GA4 Event tag (type "gaawe"). Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'Fetches the tag, APPENDS the parameters to its eventSettingsTable (the correct place for GA4 event parameters — top-level params are ignored by GA4 event tags), and saves the FULL tag so eventName/measurementId stay intact. ' +
        'A parameter whose name already exists has its value updated (not duplicated). Values may be GTM variables, e.g. {{Click Text}}.',
      inputSchema: wsBase.extend({
        tagId: z.string().describe('The GA4 Event (gaawe) tag ID to update.'),
        parameters: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .min(1)
          .describe('Event parameters to add, e.g. [{"name":"click_text","value":"{{Click Text}}"},{"name":"page_path","value":"{{Page Path}}"}].'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, tagId, parameters, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would add ${parameters.length} event parameter(s) to GA4 tag ${tagId}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
        const existing = (await client.accounts.containers.workspaces.tags.get({ path })).data;
        if (existing.type !== 'gaawe') {
          return errorResult(
            'tags_add_ga4_event_parameters',
            new Error(`Tag ${tagId} is type "${existing.type ?? 'unknown'}", not a GA4 Event tag (gaawe). This tool only edits gaawe tags.`),
          );
        }
        const updated = addEventParameters(existing, parameters);
        const res = await client.accounts.containers.workspaces.tags.update({
          path,
          fingerprint: existing.fingerprint ?? undefined,
          requestBody: updated,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('tags_add_ga4_event_parameters', err);
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
          return textResult(`[DRY RUN] Would delete tag ${tagId} from workspace ${workspaceId}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.tags.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
        });
        return textResult(`Tag ${tagId} deleted successfully from workspace ${workspaceId}.`);
      } catch (err) {
        return errorResult('tags_delete', err);
      }
    }
  );
}
