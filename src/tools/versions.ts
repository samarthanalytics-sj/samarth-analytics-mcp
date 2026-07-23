/**
 * GTM Container Versions tools
 * Covers: list/get/create (checkpoint) + live version
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';

const containerBase = z.object({
  accountId: z.string(),
  containerId: z.string(),
});

const wsBase = containerBase.extend({ workspaceId: z.string() });

export function registerVersionTools(server: McpServer, getClient: () => GtmClient): void {
  // ── versions/list ────────────────────────────────────────────────────────
  server.registerTool(
    'versions_list',
    {
      description: 'List all container version headers (summary) for a GTM container.',
      inputSchema: containerBase.extend({
        ...paginationFields,
        includeDeleted: z.boolean().optional().describe('Include deleted versions in results.'),
      }),
    },
    async ({ accountId, containerId, includeDeleted, pageToken, maxPages }) => {
      try {
        const client = getClient();
        // GTM API v2 uses version_headers.list for listing version summaries. It paginates, and a
        // long-lived container accumulates versions faster than anything else here, so this was the
        // most likely of the three to be silently cut short.
        const result = await paginate(
          (token) =>
            client.accounts.containers.version_headers
              .list({
                parent: `accounts/${accountId}/containers/${containerId}`,
                ...(includeDeleted !== undefined ? { includeDeleted } : {}),
                pageToken: token,
              })
              .then((r) => r.data),
          (data) => data.containerVersionHeader,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult('versions', result));
      } catch (err) {
        return errorResult('versions_list', err);
      }
    }
  );

  // ── versions/get ─────────────────────────────────────────────────────────
  server.registerTool(
    'versions_get',
    {
      description: 'Get the full contents of a specific GTM container version. Pass "live" as containerVersionId to get the currently live version.',
      inputSchema: containerBase.extend({
        containerVersionId: z.string().describe('The container version ID, or "live" for the current live version.'),
      }),
    },
    async ({ accountId, containerId, containerVersionId }) => {
      try {
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/versions/${containerVersionId}`;
        const res = containerVersionId === 'live'
          ? await client.accounts.containers.versions.live({ parent: `accounts/${accountId}/containers/${containerId}` })
          : await client.accounts.containers.versions.get({ path });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('versions_get', err);
      }
    }
  );

  // ── versions/create (checkpoint) ────────────────────────────────────────
  server.registerTool(
    'versions_create',
    {
      description:
        '[WRITE] Create a new GTM container version from a workspace (checkpoint). ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'This takes a snapshot of the workspace into a versioned checkpoint without publishing.',
      inputSchema: wsBase.extend({
        name: z.string().optional().describe('Version name/label.'),
        notes: z.string().optional().describe('Version notes / change description.'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, notes, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create version "${name}" from workspace ${workspaceId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.create_version({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, notes },
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('versions_create', err);
      }
    }
  );

  // ── versions/set_latest ──────────────────────────────────────────────────
  server.registerTool(
    'versions_set_latest',
    {
      description:
        '[WRITE] Set a specific container version as the "latest" (synchronizes the default workspace with this version). ' +
        'Note: This does NOT publish. Use versions_publish to go live. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: containerBase.extend({
        containerVersionId: z.string().describe('The version ID to set as latest.'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, containerVersionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would set version ${containerVersionId} as latest.`);
        }
        const client = getClient();
        const res = await client.accounts.containers.versions.set_latest({
          path: `accounts/${accountId}/containers/${containerId}/versions/${containerVersionId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('versions_set_latest', err);
      }
    }
  );

  // ── versions/undelete ────────────────────────────────────────────────────
  server.registerTool(
    'versions_undelete',
    {
      description:
        '[WRITE] Undelete a previously deleted GTM container version. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: containerBase.extend({
        containerVersionId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, containerVersionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would undelete version ${containerVersionId}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.versions.undelete({
          path: `accounts/${accountId}/containers/${containerId}/versions/${containerVersionId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('versions_undelete', err);
      }
    }
  );

  // ── versions/delete ──────────────────────────────────────────────────────
  server.registerTool(
    'versions_delete',
    {
      description:
        '[DELETE] Delete a GTM container version. ' +
        'Requires GTM_MCP_ENABLE_DELETES=true and confirm=true. ' +
        'Cannot delete a currently published (live) version.',
      inputSchema: containerBase.extend({
        containerVersionId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, containerVersionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete version ${containerVersionId}`);
        }
        const client = getClient();
        await client.accounts.containers.versions.delete({
          path: `accounts/${accountId}/containers/${containerId}/versions/${containerVersionId}`,
        });
        return textResult(`Version ${containerVersionId} deleted (marked as deleted).`);
      } catch (err) {
        return errorResult('versions_delete', err);
      }
    }
  );
}
