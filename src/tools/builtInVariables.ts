/**
 * GTM Built-In Variables tools
 * GTM API uses enable/disable for built-in variables (not create/delete in the CRUD sense)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';

const wsBase = z.object({
  accountId: z.string(),
  containerId: z.string(),
  workspaceId: z.string(),
});

// Known built-in variable types for GTM v2
const BUILT_IN_VARIABLE_TYPES = [
  'pageUrl', 'pageHostname', 'pagePath', 'referrer', 'event', 'clickElement',
  'clickClasses', 'clickId', 'clickTarget', 'clickUrl', 'clickText', 'firstPartyServingUrl',
  'formElement', 'formClasses', 'formId', 'formTarget', 'formUrl', 'formText',
  'errorMessage', 'errorUrl', 'errorLine', 'newHistoryUrl', 'oldHistoryUrl',
  'newHistoryFragment', 'oldHistoryFragment', 'newHistoryState', 'oldHistoryState',
  'historySource', 'containerVersion', 'debugMode', 'randomNumber', 'containerId',
  'appId', 'appName', 'appVersionCode', 'appVersionName', 'language', 'osVersion',
  'platform', 'sdkVersion', 'deviceName', 'resolution', 'advertiserId', 'advertisingTrackingEnabled',
  'htmlId', 'ampBrowserLanguage', 'ampCanonicalPath', 'ampCanonicalUrl', 'ampCanonicalHost',
  'ampReferrer', 'ampTitle', 'ampClientId', 'ampClientTimezone', 'ampClientTimestamp',
  'ampGtmEvent', 'ampPageDownloadTime', 'ampPageLoadTime', 'ampPageViewId', 'ampScrollX',
  'ampScrollY', 'ampScrollBoundary', 'ampTotalEngagedTime', 'ampCount', 'ampSum',
  'videoProvider', 'videoUrl', 'videoTitle', 'videoDuration', 'videoPercent',
  'videoVisible', 'videoStatus', 'videoCurrentTime', 'scrollDepthThreshold',
  'scrollDepthUnits', 'scrollDepthDirection', 'elementVisibilityRatio',
  'elementVisibilityTime', 'elementVisibilityFirstTime', 'elementVisibilityRecentTime',
  'requestPath', 'requestQueryString', 'serverPageLocationUrl', 'serverPageLocationPath',
  'serverPageLocationHostname', 'visitorRegion',
] as const;

export function registerBuiltInVariableTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'built_in_variables_list',
    {
      description: 'List all currently enabled built-in variables in a GTM workspace.',
      inputSchema: wsBase,
    },
    async ({ accountId, containerId, workspaceId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.built_in_variables.list({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        });
        const builtInVariables = res.data.builtInVariable ?? [];
        return jsonResult({ builtInVariables, count: builtInVariables.length });
      } catch (err) {
        return errorResult('built_in_variables_list', err);
      }
    }
  );

  server.registerTool(
    'built_in_variables_enable',
    {
      description:
        '[WRITE] Enable one or more built-in variables in a GTM workspace. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        types: z
          .array(z.string())
          .describe(
            `Array of built-in variable types to enable. Known types include: ${BUILT_IN_VARIABLE_TYPES.slice(0, 10).join(', ')}, and more.`
          ),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, types, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would enable built-in variables: ${types.join(', ')}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.built_in_variables.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          type: types,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('built_in_variables_enable', err);
      }
    }
  );

  server.registerTool(
    'built_in_variables_disable',
    {
      description:
        '[DELETE] Disable one or more built-in variables in a GTM workspace. ' +
        'Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: wsBase.extend({
        types: z.array(z.string()).describe('Array of built-in variable types to disable.'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, types, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would disable built-in variables: ${types.join(', ')}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.built_in_variables.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          type: types,
        });
        return textResult(`Built-in variables disabled: ${types.join(', ')}`);
      } catch (err) {
        return errorResult('built_in_variables_disable', err);
      }
    }
  );

  server.registerTool(
    'built_in_variables_revert',
    {
      description:
        '[WRITE] Revert changes to a built-in variable in the workspace to the original container version. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        type: z.string().describe('The built-in variable type to revert.'),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, type, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would revert built-in variable: ${type}`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.built_in_variables.revert({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          type,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('built_in_variables_revert', err);
      }
    }
  );
}
