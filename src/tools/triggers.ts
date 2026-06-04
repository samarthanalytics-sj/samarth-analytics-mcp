/**
 * GTM Triggers tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { workspaceScope as wsBase } from '../utils/schemas.js';

const conditionSchema = z
  .array(
    z.object({
      type: z.string().describe('Condition type: contains, cssSelector, endsWith, equals, greater, greaterOrEquals, less, lessOrEquals, matchRegex, startsWith, urlMatches.'),
      parameter: z.array(
        z.object({ type: z.string(), key: z.string().optional(), value: z.string().optional() })
      ),
    })
  )
  .optional();

const paramSchema = z
  .object({ type: z.string(), key: z.string().optional(), value: z.string().optional() })
  .optional();

export function registerTriggerTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'triggers_list',
    {
      description: 'List all GTM triggers in a workspace. Automatically follows pagination to return all triggers.',
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.triggers.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.trigger,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult('triggers', result));
      } catch (err) {
        return errorResult('triggers_list', err);
      }
    }
  );

  server.registerTool(
    'triggers_get',
    {
      description: 'Get a specific GTM trigger.',
      inputSchema: wsBase.extend({ triggerId: z.string() }),
    },
    async ({ accountId, containerId, workspaceId, triggerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.triggers.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_get', err);
      }
    }
  );

  server.registerTool(
    'triggers_create',
    {
      description: '[WRITE] Create a GTM trigger. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Trigger name.'),
        type: z.string().describe('Trigger type (e.g. "click", "pageview", "customEvent", "domReady", "windowLoaded", "historyChange", "jsError", "scrollDepth", "elementVisibility", "timer", "youTubeVideo", "formSubmission", "linkClick").'),
        filter: conditionSchema.describe('Conditions that must be met for the trigger to fire.'),
        customEventFilter: conditionSchema.describe('Used for custom event triggers.'),
        eventName: paramSchema.describe('Custom event name (for customEvent type).'),
        notes: z.string().optional(),
        parentFolderId: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, type, filter, customEventFilter, eventName, notes, parentFolderId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create trigger "${name}" (type: ${type})`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.triggers.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, filter, customEventFilter, eventName, notes, parentFolderId },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_create', err);
      }
    }
  );

  server.registerTool(
    'triggers_update',
    {
      description: '[WRITE] Update a GTM trigger. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        triggerId: z.string(),
        name: z.string().optional(),
        type: z.string().optional(),
        filter: conditionSchema,
        customEventFilter: conditionSchema,
        eventName: paramSchema,
        notes: z.string().optional(),
        fingerprint: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, triggerId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update trigger ${triggerId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.triggers.update({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
          ...(fingerprint ? { fingerprint } : {}),
          requestBody: updates,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_update', err);
      }
    }
  );

  server.registerTool(
    'triggers_delete',
    {
      description: '[DELETE] Delete a GTM trigger. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: wsBase.extend({
        triggerId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, triggerId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete trigger ${triggerId}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.triggers.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        });
        return textResult(`Trigger ${triggerId} deleted successfully.`);
      } catch (err) {
        return errorResult('triggers_delete', err);
      }
    }
  );
}
