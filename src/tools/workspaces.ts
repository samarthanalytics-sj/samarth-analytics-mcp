/**
 * GTM Workspaces tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';

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
        return jsonResult(buildListResult('workspaces', result));
      } catch (err) {
        return errorResult('workspaces_list', err);
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
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('workspaces_get', err);
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
          return textResult(`[DRY RUN] Would create workspace "${name}" in container ${containerId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.create({
          parent: `accounts/${accountId}/containers/${containerId}`,
          requestBody: { name, description },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('workspaces_create', err);
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
        return jsonResult({
          workspaceChange: changes,
          changeCount: changes.length,
          mergeConflict: conflicts,
          conflictCount: conflicts.length,
        });
      } catch (err) {
        return errorResult('workspace_get_status', err);
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
          return textResult(`[DRY RUN] Would sync workspace ${workspaceId} to latest container version.`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.sync({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('workspace_sync', err);
      }
    }
  );

  // ── workspace/resolve_conflict ───────────────────────────────────────────
  server.registerTool(
    'workspace_resolve_conflict',
    {
      description:
        'Resolve a merge conflict for a workspace entity. ' +
        'You supply the resolved entity body plus its type; the GTM API wraps it in an ' +
        'Entity envelope ({ "tag": {...} } / { "trigger": {...} } / …), which this tool builds for you. ' +
        'NOTE: This is a complex operation — review the GTM UI conflict resolution first.',
      inputSchema: workspaceBase.extend({
        workspaceId: z.string().describe('The GTM workspace ID.'),
        fingerprint: z
          .string()
          .describe('The workspace fingerprint at the time of conflict resolution.'),
        entityType: z
          .enum([
            'tag',
            'trigger',
            'variable',
            'folder',
            'client',
            'customTemplate',
            'gtagConfig',
            'transformation',
            'zone',
            'builtInVariable',
          ])
          .describe(
            'Which Entity slot the resolved body fills. The resolve_conflict API takes an Entity ' +
              'envelope, so a resolved tag is sent as { "tag": {...} }, a trigger as { "trigger": {...} }, etc.'
          ),
        entityJson: z
          .string()
          .describe(
            'JSON string of the RAW entity body (e.g. the tag object itself), NOT the Entity envelope — ' +
              'it is wrapped under entityType for you. If you pass an already-wrapped { "<entityType>": {...} } ' +
              'object it is used as-is.'
          ),
        changeStatus: z
          .enum(['added', 'deleted', 'modified', 'none'])
          .optional()
          .describe(
            'How the resolved entity changed relative to the base version (added/deleted/modified/none). Optional.'
          ),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({
      accountId,
      containerId,
      workspaceId,
      fingerprint,
      entityType,
      entityJson,
      changeStatus,
      confirm,
    }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would resolve conflict in workspace ${workspaceId}.`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(entityJson);
        } catch {
          return errorText('entityJson must be valid JSON.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return errorText('entityJson must be a JSON object (the entity body).');
        }
        const parsedObj = parsed as Record<string, unknown>;
        // The GTM resolve_conflict API expects an Entity envelope keyed by type
        // ({ tag }, { trigger }, …), NOT the raw entity. Wrap the raw body under
        // entityType; if the caller already passed a wrapped object, use it as-is.
        const alreadyWrapped =
          typeof parsedObj[entityType] === 'object' && parsedObj[entityType] !== null;
        const entity: Record<string, unknown> = alreadyWrapped
          ? { ...parsedObj }
          : { [entityType]: parsedObj };
        if (changeStatus && entity.changeStatus === undefined) {
          entity.changeStatus = changeStatus;
        }
        const client = getClient();
        // GTM API: accounts.containers.workspaces.resolve_conflict
        // Takes a fingerprint query param and the Entity body.
        const res = await client.accounts.containers.workspaces.resolve_conflict({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          fingerprint,
          requestBody: entity,
        });
        return jsonResult(res.data ?? { success: true });
      } catch (err) {
        return errorResult('workspace_resolve_conflict', err);
      }
    }
  );
}
