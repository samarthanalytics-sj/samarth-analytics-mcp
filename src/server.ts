/**
 * GTM MCP Server factory
 * Creates the McpServer instance and registers all tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuth2Client } from 'google-auth-library';
import { getGtmClient } from './utils/gtmClient.js';
import {
  getGa4AdminClient,
  getGa4AdminAlphaClient,
  getGa4DataClient,
} from './utils/ga4Client.js';
import { registerAllTools } from './tools/index.js';
import { getGuardrailConfig } from './utils/guardrails.js';

export const SERVER_NAME = 'samarth-gtm-mcp';
export const SERVER_VERSION = '1.0.0';

export function createGtmMcpServer(auth: OAuth2Client): McpServer {
  const config = getGuardrailConfig();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(config),
    }
  );

  // Lazy client getters — created once auth is available
  const getClient = () => getGtmClient(auth);
  const getGa4Client = () => getGa4AdminClient(auth);
  const getGa4AlphaClient = () => getGa4AdminAlphaClient(auth);
  const getGa4DataClientFn = () => getGa4DataClient(auth);

  registerAllTools(
    server,
    getClient,
    getGa4Client,
    getGa4AlphaClient,
    getGa4DataClientFn
  );

  return server;
}

function buildInstructions(config: ReturnType<typeof getGuardrailConfig>): string {
  const modes: string[] = [];
  if (!config.writesEnabled) modes.push('READ-ONLY (writes disabled)');
  if (!config.publishEnabled) modes.push('PUBLISH DISABLED');
  if (!config.deletesEnabled) modes.push('DELETES DISABLED');
  if (config.dryRun) modes.push('DRY RUN MODE');

  return [
    'Samarth Analytics — Google Tag Manager MCP Server',
    '',
    'This server provides full access to the Google Tag Manager API v2, plus a ' +
      'read-only Google Analytics (GA4) Admin API tool surface.',
    '',
    'Current mode: ' + (modes.length > 0 ? modes.join(', ') : 'Full write access enabled'),
    '',
    'IMPORTANT GUARDRAILS:',
    '- All write/delete/publish tools require confirm=true to proceed.',
    '- Set GTM_MCP_ENABLE_WRITES=true in .env to allow create/update operations.',
    '- Set GTM_MCP_ENABLE_DELETES=true to allow delete operations.',
    '- Set GTM_MCP_ENABLE_PUBLISH=true to allow publish operations.',
    '- Set DRY_RUN=true to simulate all operations without calling the API.',
    '',
    'TOOL NAMING CONVENTION:',
    '- accounts_list, accounts_get',
    '- containers_list, containers_get, containers_create',
    '- workspaces_list, workspaces_get, workspaces_create',
    '- workspace_sync, workspace_resolve_conflict, workspace_quick_preview',
    '- workspace_create_version_and_publish',
    '- tags_list, tags_get, tags_create, tags_update, tags_delete',
    '- triggers_list, triggers_get, triggers_create, triggers_update, triggers_delete',
    '- variables_list, variables_get, variables_create, variables_update, variables_delete',
    '- folders_list, folders_get, folders_create, folders_update, folders_delete, folders_entities, folders_move_entities',
    '- built_in_variables_list, built_in_variables_enable, built_in_variables_disable, built_in_variables_revert',
    '- versions_list, versions_get, versions_create, versions_publish, versions_set_latest, versions_undelete, versions_delete',
    '- environments_list, environments_get, environments_create, environments_update, environments_reauthorize, environments_delete',
    '- user_permissions_list, user_permissions_get, user_permissions_create, user_permissions_update, user_permissions_delete',
    '- clients_*, transformations_*, zones_*, templates_* (list/get/create/update/delete/revert), gtag_config_* (no revert) — server-side & advanced container resources',
    '- containers_snippet, containers_lookup, containers_combine, containers_move_tag_id',
    '- destinations_list, destinations_get, destinations_link',
    '- workspace_get_status — review the change diff (changed entities + conflicts) before versioning',
    '- audit_container — inspect for analytics issues',
    '- export_container — full workspace export as JSON',
    '',
    'GA4 ADMIN (READ-ONLY) — Google Analytics Admin API v1beta:',
    '- ga4_account_summaries_list — discover GA4 accounts + property summaries',
    '- ga4_properties_list, ga4_property_get',
    '- ga4_data_streams_list, ga4_enhanced_measurement_get (web streams + measurement IDs)',
    '- ga4_custom_dimensions_list, ga4_custom_metrics_list',
    '- ga4_data_retention_get',
    '- ga4_key_events_list (formerly conversion events), ga4_google_ads_links_list',
    '  These tools never write/delete and need no confirm flag. They require the',
    "  'analytics.readonly' OAuth scope — re-run npm run auth:google if a 403 mentions scope.",
    '  Not exposed by Admin API v1beta (documented limitations, not faked): internal-traffic/',
    '  unwanted-referral data filters, referral exclusions, channel groups, audiences.',
    '',
    'GA4 DATA API (READ-ONLY) — Google Analytics Data API v1beta:',
    '- ga4_run_report — report dimensions/metrics over a date range (e.g. eventCount by eventName).',
    '- ga4_run_realtime_report — events in roughly the last 30 minutes for live QA.',
    '  Read-only; no confirm flag. Same analytics.readonly scope as the Admin tools.',
    '  Use to reconcile configured events vs. events GA4 actually reports.',
    '  Not exposed here (documented gaps, not stubbed): pivots, cohorts, funnels.',
    '',
    'PAGINATION: All list tools that support it auto-follow pagination to return all results. ',
    'Pass maxPages to bound the work; truncated results include truncated:true and nextPageToken to resume.',
  ].join('\n');
}
