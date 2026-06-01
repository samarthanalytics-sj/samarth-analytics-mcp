/**
 * GTM Containers tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';

export function registerContainerTools(server: McpServer, getClient: () => GtmClient): void {
  // ── containers/list ──────────────────────────────────────────────────────
  server.registerTool(
    'containers_list',
    {
      description: 'List all GTM containers within a GTM account. Automatically follows pagination to return all containers.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
      }).extend(paginationFields),
    },
    async ({ accountId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}`;
        const result = await paginate(
          (token) => client.accounts.containers.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.container,
          { pageToken, maxPages }
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(buildListResult('containers', result), null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_list failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── containers/get ───────────────────────────────────────────────────────
  server.registerTool(
    'containers_get',
    {
      description: 'Get details of a specific GTM container.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
      }),
    },
    async ({ accountId, containerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.get({
          path: `accounts/${accountId}/containers/${containerId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_get failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── containers/create ────────────────────────────────────────────────────
  server.registerTool(
    'containers_create',
    {
      description:
        '[WRITE] Create a new GTM container. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        name: z.string().describe('Container name.'),
        usageContext: z
          .array(z.enum(['web', 'androidSdk5', 'iosSdk5', 'amp', 'server']))
          .describe('Usage context(s) for the container.'),
        domainName: z.array(z.string()).optional().describe('Associated domain names.'),
        notes: z.string().optional().describe('Optional notes.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, name, usageContext, domainName, notes, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return {
            content: [
              {
                type: 'text',
                text: `[DRY RUN] Would create container "${name}" in account ${accountId} with context: ${usageContext.join(', ')}`,
              },
            ],
          };
        }
        const client = getClient();
        const res = await client.accounts.containers.create({
          parent: `accounts/${accountId}`,
          requestBody: { name, usageContext, domainName, notes },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `containers_create failed: ${formatGoogleError(err)}` }],
        };
      }
    }
  );

  // ── containers/snippet ─────────────────────────────────────────────────────
  server.registerTool(
    'containers_snippet',
    {
      description: 'Get the GTM installation snippet (HTML/JS tagging code) for a container.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
      }),
    },
    async ({ accountId, containerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.snippet({
          path: `accounts/${accountId}/containers/${containerId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ snippet: res.data.snippet }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `containers_snippet failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── containers/lookup ──────────────────────────────────────────────────────
  server.registerTool(
    'containers_lookup',
    {
      description:
        'Look up a GTM container by its linked destination ID (e.g. a GA4 measurement ID or tag ID).',
      inputSchema: z.object({
        destinationId: z.string().describe('The destination/tag ID to look up (e.g. "G-XXXXXXX").'),
      }),
    },
    async ({ destinationId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.lookup({ destinationId });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `containers_lookup failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── containers/combine ─────────────────────────────────────────────────────
  server.registerTool(
    'containers_combine',
    {
      description:
        '[WRITE] Combine (merge) another container into this one. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        '⚠️  This merges the source container identified by containerIdToCombine into the target container.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The target container ID (the surviving container).'),
        containerIdToCombine: z.string().describe('The container ID to merge into the target.'),
        settingSource: z
          .enum(['settingSourceUnspecified', 'current', 'other'])
          .optional()
          .describe('Which container\'s settings to keep.'),
        allowUserPermissionFeatureUpdate: z
          .boolean()
          .optional()
          .describe('Allow updating the user-permission feature during combine.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, containerIdToCombine, settingSource, allowUserPermissionFeatureUpdate, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would combine container ${containerIdToCombine} into ${containerId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.combine({
          path: `accounts/${accountId}/containers/${containerId}`,
          containerId: containerIdToCombine,
          ...(settingSource ? { settingSource } : {}),
          ...(allowUserPermissionFeatureUpdate !== undefined ? { allowUserPermissionFeatureUpdate } : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `containers_combine failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── containers/move_tag_id ─────────────────────────────────────────────────
  server.registerTool(
    'containers_move_tag_id',
    {
      description:
        '[WRITE] Move a Tag ID out of a container into a new container. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The source container ID.'),
        tagId: z.string().describe('The Tag ID to move.'),
        tagName: z.string().optional().describe('Name for the new tag created in the destination container.'),
        copySettings: z.boolean().optional().describe('Whether to copy container settings.'),
        copyUsers: z.boolean().optional().describe('Whether to copy users.'),
        copyTermsOfService: z.boolean().optional().describe('Whether to copy terms of service.'),
        allowUserPermissionFeatureUpdate: z.boolean().optional(),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, tagId, tagName, copySettings, copyUsers, copyTermsOfService, allowUserPermissionFeatureUpdate, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would move tag ID ${tagId} out of container ${containerId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.move_tag_id({
          path: `accounts/${accountId}/containers/${containerId}`,
          tagId,
          ...(tagName ? { tagName } : {}),
          ...(copySettings !== undefined ? { copySettings } : {}),
          ...(copyUsers !== undefined ? { copyUsers } : {}),
          ...(copyTermsOfService !== undefined ? { copyTermsOfService } : {}),
          ...(allowUserPermissionFeatureUpdate !== undefined ? { allowUserPermissionFeatureUpdate } : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `containers_move_tag_id failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── destinations/list ──────────────────────────────────────────────────────
  server.registerTool(
    'destinations_list',
    {
      description: 'List all destinations (linked Google tags / GA4 destinations) for a GTM container.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
      }),
    },
    async ({ accountId, containerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.destinations.list({
          parent: `accounts/${accountId}/containers/${containerId}`,
        });
        const destinations = res.data.destination ?? [];
        return { content: [{ type: 'text', text: JSON.stringify({ destinations, count: destinations.length }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `destinations_list failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── destinations/get ───────────────────────────────────────────────────────
  server.registerTool(
    'destinations_get',
    {
      description: 'Get details of a specific GTM destination.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
        destinationId: z.string().describe('The destination ID.'),
      }),
    },
    async ({ accountId, containerId, destinationId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.destinations.get({
          path: `accounts/${accountId}/containers/${containerId}/destinations/${destinationId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `destinations_get failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── destinations/link ──────────────────────────────────────────────────────
  server.registerTool(
    'destinations_link',
    {
      description:
        '[WRITE] Link a destination (Google tag / GA4 destination) to a GTM container. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: z.object({
        accountId: z.string().describe('The GTM account ID.'),
        containerId: z.string().describe('The GTM container ID.'),
        destinationId: z.string().describe('The destination ID to link (e.g. "G-XXXXXXX").'),
        allowUserPermissionFeatureUpdate: z.boolean().optional(),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, destinationId, allowUserPermissionFeatureUpdate, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would link destination ${destinationId} to container ${containerId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.containers.destinations.link({
          parent: `accounts/${accountId}/containers/${containerId}`,
          destinationId,
          ...(allowUserPermissionFeatureUpdate !== undefined ? { allowUserPermissionFeatureUpdate } : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `destinations_link failed: ${formatGoogleError(err)}` }] };
      }
    }
  );
}
