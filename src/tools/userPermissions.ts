/**
 * GTM User Permissions tools — account-level CRUD.
 *
 * Permissions are account-scoped (accounts/{a}/user_permissions/{p}) and a
 * single permission record carries both the account-level access and an array
 * of per-container access entries.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { formatGoogleError, checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import type { tagmanager_v2 } from 'googleapis';

const accountBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
});

const accountPermission = z
  .enum(['accountPermissionUnspecified', 'noAccess', 'user', 'admin'])
  .describe('Account-level permission.');

const containerPermission = z
  .enum(['containerPermissionUnspecified', 'noAccess', 'read', 'edit', 'approve', 'publish'])
  .describe('Container-level permission.');

const containerAccessSchema = z
  .array(
    z.object({
      containerId: z.string().describe('The GTM container ID.'),
      permission: containerPermission,
    })
  )
  .optional()
  .describe('Per-container access entries.');

export function registerUserPermissionTools(server: McpServer, getClient: () => GtmClient): void {
  // ── user_permissions/list ────────────────────────────────────────────────
  server.registerTool(
    'user_permissions_list',
    {
      description:
        'List all user permissions for a GTM account. Automatically follows pagination. ' +
        'Each record shows a user email plus their account and per-container access levels.',
      inputSchema: accountBase.extend(paginationFields),
    },
    async ({ accountId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}`;
        const result = await paginate(
          (token) => client.accounts.user_permissions.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.userPermission,
          { pageToken, maxPages }
        );
        return { content: [{ type: 'text', text: JSON.stringify(buildListResult('userPermissions', result), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `user_permissions_list failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── user_permissions/get ─────────────────────────────────────────────────
  server.registerTool(
    'user_permissions_get',
    {
      description: 'Get a specific user permission record for a GTM account.',
      inputSchema: accountBase.extend({
        userPermissionId: z.string().describe('The user permission ID.'),
      }),
    },
    async ({ accountId, userPermissionId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.user_permissions.get({
          path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `user_permissions_get failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── user_permissions/create ──────────────────────────────────────────────
  server.registerTool(
    'user_permissions_create',
    {
      description:
        '[WRITE] Grant a user access to a GTM account (and optionally containers). ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: accountBase.extend({
        emailAddress: z.string().describe('Email address of the user to grant access to.'),
        accountPermission: accountPermission.optional(),
        containerAccess: containerAccessSchema,
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, emailAddress, accountPermission: acctPerm, containerAccess, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would grant ${emailAddress} access on account ${accountId}` }] };
        }
        const client = getClient();
        const res = await client.accounts.user_permissions.create({
          parent: `accounts/${accountId}`,
          requestBody: {
            emailAddress,
            ...(acctPerm ? { accountAccess: { permission: acctPerm } } : {}),
            ...(containerAccess ? { containerAccess } : {}),
          },
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `user_permissions_create failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── user_permissions/update ──────────────────────────────────────────────
  server.registerTool(
    'user_permissions_update',
    {
      description:
        '[WRITE] Update a user\'s account and/or container access levels. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'Provide the full intended access (account + container) as the API replaces the record.',
      inputSchema: accountBase.extend({
        userPermissionId: z.string().describe('The user permission ID to update.'),
        accountPermission: accountPermission.optional(),
        containerAccess: containerAccessSchema,
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, userPermissionId, accountPermission: acctPerm, containerAccess, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would update permission ${userPermissionId} on account ${accountId}` }] };
        }
        const body: tagmanager_v2.Schema$UserPermission = {
          ...(acctPerm ? { accountAccess: { permission: acctPerm } } : {}),
          ...(containerAccess ? { containerAccess } : {}),
        };
        const client = getClient();
        const res = await client.accounts.user_permissions.update({
          path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
          requestBody: body,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `user_permissions_update failed: ${formatGoogleError(err)}` }] };
      }
    }
  );

  // ── user_permissions/delete ──────────────────────────────────────────────
  server.registerTool(
    'user_permissions_delete',
    {
      description:
        '[DELETE] Revoke a user\'s access to a GTM account. ' +
        'Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: accountBase.extend({
        userPermissionId: z.string().describe('The user permission ID to delete.'),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async ({ accountId, userPermissionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return { content: [{ type: 'text', text: `[DRY RUN] Would delete permission ${userPermissionId} from account ${accountId}` }] };
        }
        const client = getClient();
        await client.accounts.user_permissions.delete({
          path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
        });
        return { content: [{ type: 'text', text: `User permission ${userPermissionId} deleted from account ${accountId}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `user_permissions_delete failed: ${formatGoogleError(err)}` }] };
      }
    }
  );
}
