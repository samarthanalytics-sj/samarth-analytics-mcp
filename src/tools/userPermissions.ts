/**
 * GTM User Permissions tools — account-level CRUD.
 *
 * Permissions are account-scoped (accounts/{a}/user_permissions/{p}) and a
 * single permission record carries both the account-level access and an array
 * of per-container access entries.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gtmId } from '../utils/schemas.js';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import type { tagmanager_v2 } from 'googleapis';

const accountBase = z.object({
  accountId: gtmId.describe('The GTM account ID.'),
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
      containerId: gtmId.describe('The GTM container ID.'),
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
        return jsonResult(buildListResult('userPermissions', result));
      } catch (err) {
        return errorResult('user_permissions_list', err);
      }
    }
  );

  // ── user_permissions/get ─────────────────────────────────────────────────
  server.registerTool(
    'user_permissions_get',
    {
      description: 'Get a specific user permission record for a GTM account.',
      inputSchema: accountBase.extend({
        userPermissionId: gtmId.describe('The user permission ID.'),
      }),
    },
    async ({ accountId, userPermissionId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.user_permissions.get({
          path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('user_permissions_get', err);
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
          return textResult(`[DRY RUN] Would grant ${emailAddress} access on account ${accountId}`);
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
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('user_permissions_create', err);
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
        'Read-modify-write: an omitted accountPermission or containerAccess keeps the user\'s current value. ' +
        'containerAccess, when given, is the COMPLETE list (the API replaces the record): a container left out loses access. ' +
        'Removing access (noAccess at account or container level, or leaving a container out) is a revocation and ' +
        'also requires GTM_MCP_ENABLE_DELETES=true, the same as user_permissions_delete.',
      inputSchema: accountBase.extend({
        userPermissionId: gtmId.describe('The user permission ID to update.'),
        accountPermission: accountPermission.optional(),
        containerAccess: containerAccessSchema,
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, userPermissionId, accountPermission: acctPerm, containerAccess, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        // Revoking access is what user_permissions_delete does, and that tool is delete-tier.
        // This one used to let 'noAccess' through on the write flag alone, so a server configured
        // to refuse deletes could still lock a user out of the account. Tier by effect: an
        // explicit revocation needs the deletes flag too, checked before anything is sent.
        const explicitlyRevokes =
          acctPerm === 'noAccess' || (containerAccess ?? []).some((c) => c.permission === 'noAccess');
        if (explicitlyRevokes) checkGuardrails('delete', confirm, config);
        if (dryRun) {
          // A dry run sends nothing, not even the GET below that shows which containers this list
          // leaves out, so the dropped-container check cannot run here. Say what the real call
          // would need instead of implying the write flag alone is enough.
          const dropNote = !containerAccess
            ? ''
            : ' containerAccess is the COMPLETE list, and the user\'s current containers were not read in dry run: ' +
              'leaving out a container the user can reach now revokes their access to it' +
              (config.deletesEnabled
                ? '.'
                : ', which also requires GTM_MCP_ENABLE_DELETES=true (currently off); the real update would be refused in that case.');
          return textResult(`[DRY RUN] Would update permission ${userPermissionId} on account ${accountId}.${dropNote}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/user_permissions/${userPermissionId}`;
        // The update is a full replace, so a field the caller left out used to be sent as absent:
        // {accountPermission:'user'} alone could strip every container grant. Fetch the record
        // and carry forward what was not supplied, as environments_update / tags_update do.
        const existing = (await client.accounts.user_permissions.get({ path })).data;
        const before = (existing.containerAccess ?? []).filter(
          (c) => c.containerId && c.permission && c.permission !== 'noAccess'
        );
        const merged: tagmanager_v2.Schema$UserPermission = {
          ...(acctPerm
            ? { accountAccess: { permission: acctPerm } }
            : existing.accountAccess
              ? { accountAccess: existing.accountAccess }
              : {}),
          ...(containerAccess
            ? { containerAccess }
            : existing.containerAccess
              ? { containerAccess: existing.containerAccess }
              : {}),
        };
        // A supplied containerAccess is the whole list: any container the user could reach before
        // that is missing from it is revoked by this PUT, so it is delete-tier as well.
        if (containerAccess) {
          const kept = new Set(containerAccess.map((c) => c.containerId));
          const dropped = before.filter((c) => !kept.has(c.containerId as string)).map((c) => c.containerId);
          if (dropped.length > 0) {
            try {
              checkGuardrails('delete', confirm, config);
            } catch (gate) {
              return errorResult(
                'user_permissions_update',
                new Error(
                  `${(gate as Error).message} This update leaves out container(s) ${dropped.join(', ')}, ` +
                    'which revokes the user\'s access to them. List them in containerAccess to keep their access.'
                )
              );
            }
          }
        }
        const res = await client.accounts.user_permissions.update({
          path,
          requestBody: merged,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('user_permissions_update', err);
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
        userPermissionId: gtmId.describe('The user permission ID to delete.'),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async ({ accountId, userPermissionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete permission ${userPermissionId} from account ${accountId}`);
        }
        const client = getClient();
        await client.accounts.user_permissions.delete({
          path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
        });
        return textResult(`User permission ${userPermissionId} deleted from account ${accountId}.`);
      } catch (err) {
        return errorResult('user_permissions_delete', err);
      }
    }
  );
}
