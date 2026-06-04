/**
 * GTM Environments tools — full CRUD + reauthorize
 *
 * Environments are container-scoped (accounts/{a}/containers/{c}/environments).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import type { tagmanager_v2 } from 'googleapis';

const containerBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
});

export function registerEnvironmentTools(server: McpServer, getClient: () => GtmClient): void {
  // ── environments/list ────────────────────────────────────────────────────
  server.registerTool(
    'environments_list',
    {
      description: 'List all environments in a GTM container. Automatically follows pagination.',
      inputSchema: containerBase.extend(paginationFields),
    },
    async ({ accountId, containerId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}`;
        const result = await paginate(
          (token) => client.accounts.containers.environments.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.environment,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult('environments', result));
      } catch (err) {
        return errorResult('environments_list', err);
      }
    }
  );

  // ── environments/get ─────────────────────────────────────────────────────
  server.registerTool(
    'environments_get',
    {
      description: 'Get details of a specific GTM environment.',
      inputSchema: containerBase.extend({ environmentId: z.string().describe('The GTM environment ID.') }),
    },
    async ({ accountId, containerId, environmentId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.environments.get({
          path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('environments_get', err);
      }
    }
  );

  // ── environments/create ──────────────────────────────────────────────────
  server.registerTool(
    'environments_create',
    {
      description:
        '[WRITE] Create a new GTM environment. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: containerBase.extend({
        name: z.string().describe('Environment name.'),
        description: z.string().optional().describe('Environment description.'),
        url: z.string().optional().describe('Default preview page URL for the environment.'),
        enableDebug: z.boolean().optional().describe('Whether to enable debug by default.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, name, description, url, enableDebug, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create environment "${name}" in container ${containerId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.environments.create({
          parent: `accounts/${accountId}/containers/${containerId}`,
          requestBody: { name, description, url, enableDebug },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('environments_create', err);
      }
    }
  );

  // ── environments/update ──────────────────────────────────────────────────
  server.registerTool(
    'environments_update',
    {
      description:
        '[WRITE] Update an existing GTM environment. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: containerBase.extend({
        environmentId: z.string().describe('The GTM environment ID to update.'),
        name: z.string().optional().describe('New environment name.'),
        description: z.string().optional().describe('New description.'),
        url: z.string().optional().describe('New default preview page URL.'),
        enableDebug: z.boolean().optional().describe('Whether to enable debug by default.'),
        fingerprint: z.string().optional().describe('Current fingerprint (for optimistic locking).'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, environmentId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update environment ${environmentId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.environments.update({
          path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
          ...(fingerprint ? { fingerprint } : {}),
          requestBody: updates as tagmanager_v2.Schema$Environment,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('environments_update', err);
      }
    }
  );

  // ── environments/reauthorize ─────────────────────────────────────────────
  server.registerTool(
    'environments_reauthorize',
    {
      description:
        '[PUBLISH] Re-generate the authorization code for a GTM environment. ' +
        'Requires GTM_MCP_ENABLE_PUBLISH=true and confirm=true. ' +
        '⚠️  This rotates the environment auth token; any embedded snippet using the old token stops working until updated.',
      inputSchema: containerBase.extend({
        environmentId: z.string().describe('The GTM environment ID to reauthorize.'),
        confirm: z.boolean().describe('Must be true to confirm this high-impact operation.'),
      }),
    },
    async ({ accountId, containerId, environmentId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('publish', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would reauthorize environment ${environmentId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.environments.reauthorize({
          path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
          requestBody: {},
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('environments_reauthorize', err);
      }
    }
  );

  // ── environments/delete ──────────────────────────────────────────────────
  server.registerTool(
    'environments_delete',
    {
      description:
        '[DELETE] Delete a GTM environment. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: containerBase.extend({
        environmentId: z.string().describe('The GTM environment ID to delete.'),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async ({ accountId, containerId, environmentId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete environment ${environmentId}`);
        }
        const client = getClient();
        await client.accounts.containers.environments.delete({
          path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
        });
        return textResult(`Environment ${environmentId} deleted successfully.`);
      } catch (err) {
        return errorResult('environments_delete', err);
      }
    }
  );
}
