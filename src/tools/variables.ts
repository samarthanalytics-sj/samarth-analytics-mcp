/**
 * GTM Variables tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';
import {
  googleErrorStatus, isDuplicateNameError, explainMissingEntity, explainDuplicateName,
} from '../utils/writeDiagnostics.js';
import { workspaceScope as wsBase } from '../utils/schemas.js';
import { gtmParameterArray as parameterSchema } from '../utils/paramSchema.js';
import { mergeParametersByKey } from '../utils/tagParams.js';
import type { tagmanager_v2 } from 'googleapis';

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
        return jsonResult(buildListResult('variables', result, { accountId, containerId, workspaceId }));
      } catch (err) {
        return errorResult('variables_list', err);
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
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('variables_get', err);
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
          return textResult(`[DRY RUN] Would create variable "${name}" (type: ${type})`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.variables.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, parameter, notes, parentFolderId, enablingTriggerId, disablingTriggerId },
        });
        return jsonResult(res.data);
      } catch (err) {
        // "Found entity with duplicate name" does not say what holds the name, and the
        // usual culprit is an enabled built-in, which variables_list does not return —
        // so the obvious pre-flight check finds nothing and the clash looks impossible.
        if (isDuplicateNameError(err)) {
          return errorText(
            await explainDuplicateName(getClient(), { accountId, containerId, workspaceId }, name, err),
          );
        }
        return errorResult('variables_create', err);
      }
    }
  );

  server.registerTool(
    'variables_update',
    {
      description:
        '[WRITE] Update a GTM variable (read-modify-write — omitted fields are preserved; `parameter` is merged by key). Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
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
          return textResult(`[DRY RUN] Would update variable ${variableId}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`;
        // GTM's update is a full replace — fetch, overlay only the provided fields, and
        // merge `parameter` by key so the rest of the variable isn't wiped.
        const existing = (await client.accounts.containers.workspaces.variables.get({ path })).data;
        const merged: tagmanager_v2.Schema$Variable = { ...existing };
        for (const [k, v] of Object.entries(updates)) {
          if (v === undefined) continue;
          if (k === 'parameter') {
            merged.parameter = mergeParametersByKey(existing.parameter ?? [], v as tagmanager_v2.Schema$Parameter[]);
          } else {
            (merged as Record<string, unknown>)[k] = v;
          }
        }
        const res = await client.accounts.containers.workspaces.variables.update({
          path,
          fingerprint: fingerprint ?? existing.fingerprint ?? undefined,
          requestBody: merged,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('variables_update', err);
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
          return textResult(`[DRY RUN] Would delete variable ${variableId}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.variables.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
        });
        return textResult(`Variable ${variableId} deleted successfully.`);
      } catch (err) {
        // See tags_delete: a 404 is far more often a cross-type id than missing access.
        if (googleErrorStatus(err) === 404) {
          return errorText(
            await explainMissingEntity(getClient(), { accountId, containerId, workspaceId }, 'variable', variableId, err),
          );
        }
        return errorResult('variables_delete', err);
      }
    }
  );
}
