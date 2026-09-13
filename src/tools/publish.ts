/**
 * GTM Publish + Preview tools
 *
 * - workspace/quick_preview — preview without publishing
 * - versions/publish        — publish a version to live
 * - workspace_publish       — create a version and publish in one step
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';

const containerBase = z.object({
  accountId: z.string(),
  containerId: z.string(),
});

const wsBase = containerBase.extend({ workspaceId: z.string() });

export function registerPublishTools(server: McpServer, getClient: () => GtmClient): void {
  // ── workspace/quick_preview ──────────────────────────────────────────────
  server.registerTool(
    'workspace_quick_preview',
    {
      description:
        'Generate a quick-preview (debug) link for a GTM workspace. ' +
        'This does NOT publish — it just enables preview mode. ' +
        'Returns a preview container version with any compilation errors.',
      inputSchema: wsBase,
    },
    async ({ accountId, containerId, workspaceId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.quick_preview({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        const data = res.data;
        const result: Record<string, unknown> = {
          compilerError: data.compilerError ?? false,
          syncStatus: data.syncStatus,
        };
        if (data.containerVersion) {
          result['containerVersion'] = {
            containerVersionId: data.containerVersion.containerVersionId,
            name: data.containerVersion.name,
            tagManagerUrl: data.containerVersion.tagManagerUrl,
          };
        }
        return jsonResult(result);
      } catch (err) {
        return errorResult('workspace_quick_preview', err);
      }
    }
  );

  // ── versions/publish ─────────────────────────────────────────────────────
  server.registerTool(
    'versions_publish',
    {
      description:
        '[PUBLISH] Publish a specific GTM container version to live. ' +
        'Requires GTM_MCP_ENABLE_PUBLISH=true and confirm=true. ' +
        '⚠️  This immediately makes the version live in production.',
      inputSchema: containerBase.extend({
        containerVersionId: z.string().describe('The version ID to publish.'),
        confirm: z.boolean().describe('Must be true to confirm this publish operation.'),
      }),
    },
    async ({ accountId, containerId, containerVersionId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('publish', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would publish version ${containerVersionId} to live.`);
        }
        const client = getClient();
        const res = await client.accounts.containers.versions.publish({
          path: `accounts/${accountId}/containers/${containerId}/versions/${containerVersionId}`,
        });
        return jsonResult({
          success: true,
          compilerError: res.data.compilerError ?? false,
          containerVersion: res.data.containerVersion,
        });
      } catch (err) {
        return errorResult('versions_publish', err);
      }
    }
  );

  // ── workspace/create_and_publish ─────────────────────────────────────────
  server.registerTool(
    'workspace_create_version_and_publish',
    {
      description:
        '[PUBLISH] Create a new container version from a workspace and immediately publish it. ' +
        'Requires GTM_MCP_ENABLE_PUBLISH=true and confirm=true. ' +
        '⚠️  This is the most powerful write operation — it goes live in production immediately.',
      inputSchema: wsBase.extend({
        name: z.string().optional().describe('Version name.'),
        notes: z.string().optional().describe('Version notes.'),
        confirm: z.boolean().describe('Must be true to confirm this publish operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, notes, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('publish', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create version "${name}" from workspace ${workspaceId} and publish it.`);
        }
        const client = getClient();

        // Step 1: create version from workspace
        const createRes = await client.accounts.containers.workspaces.create_version({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, notes },
        });

        const versionId = createRes.data.containerVersion?.containerVersionId;
        const sync = createRes.data.syncStatus;
        const syncFailed = sync?.syncError === true || sync?.mergeConflict === true;

        // Diagnose BEFORE the missing-versionId guard. A workspace that fails to compile, or that
        // is out of sync with the live container, comes back as compilerError / syncStatus with NO
        // containerVersion at all. The old order ran the versionId guard first, so the one case the
        // compilerError branch was written for answered with a bare "Failed to get version ID" and
        // threw away the only field that says what to fix. syncStatus was never read in either
        // branch.
        if (createRes.data.compilerError || syncFailed) {
          const cause = createRes.data.compilerError
            ? 'compiler errors'
            : sync?.mergeConflict === true
              ? 'a merge conflict with the latest container version'
              : 'a sync error';
          const head = versionId
            ? `Version created (${versionId}) but the workspace has ${cause}`
            : `No version was created: the workspace has ${cause}`;
          return errorText(
            `${head}. NOT published. Fix that before publishing.\n${JSON.stringify(createRes.data, null, 2)}`
          );
        }

        if (!versionId) {
          // Dump the response: without it the caller has nothing to act on.
          return errorText(
            `Failed to get version ID from create_version response.\n${JSON.stringify(createRes.data, null, 2)}`
          );
        }

        // Step 2: publish the new version
        const publishRes = await client.accounts.containers.versions.publish({
          path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
        });

        return jsonResult({
          success: true,
          publishedVersionId: versionId,
          compilerError: publishRes.data.compilerError ?? false,
          containerVersion: publishRes.data.containerVersion,
        });
      } catch (err) {
        return errorResult('workspace_create_version_and_publish', err);
      }
    }
  );
}
