/**
 * GTM MCP Server factory
 * Creates the McpServer instance and registers all tools.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuth2Client } from 'google-auth-library';
import { getGtmClient } from './utils/gtmClient.js';
import {
  getGa4AdminClient,
  getGa4AdminAlphaClient,
  getGa4DataClient,
} from './utils/ga4Client.js';
import { registerAllTools } from './tools/index.js';
import { registerServerSidePrompts } from './prompts/serverSide.js';
import { registerEcommerceFunnelPrompts } from './prompts/ecommerceFunnel.js';
import { registerCommandPrompts } from './prompts/commands.js';
import { getGuardrailConfig } from './utils/guardrails.js';
import { describeMode } from './utils/guardrailMode.js';
import { resolveAuth } from './auth/identityContext.js';

export const SERVER_NAME = 'samarth-gtm-mcp';

/**
 * The version advertised in every MCP initialize response (and shown in client UIs).
 *
 * This used to be a hard-coded '1.0.0' literal. semantic-release owns package.json's version, so
 * nothing ever moved the literal and clients were told '1.0.0' while the deployed build was
 * 1.4xx.0, which sends anyone debugging a hosted install after the wrong build. Read the real
 * version instead. package.json sits one directory above both src/ (tsx/dev) and dist/ (built and
 * npm-published), so the same relative path resolves in every case. The fallback exists only so a
 * missing or unreadable package.json cannot stop the server from starting.
 */
function readPackageVersion(): string {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const pkg = requireFromHere('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readPackageVersion();

export function createGtmMcpServer(auth: OAuth2Client): McpServer {
  const config = getGuardrailConfig();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: buildInstructions(config),
    }
  );

  // Lazy, per-request client getters. `auth` is the default/global identity;
  // when a request runs inside an identity context (multi-user mode),
  // resolveAuth() returns that request's identity instead. See
  // auth/identityContext.ts and docs/adr/0001.
  const getClient = () => getGtmClient(resolveAuth(auth));
  const getGa4Client = () => getGa4AdminClient(resolveAuth(auth));
  const getGa4AlphaClient = () => getGa4AdminAlphaClient(resolveAuth(auth));
  const getGa4DataClientFn = () => getGa4DataClient(resolveAuth(auth));

  registerAllTools(
    server,
    getClient,
    getGa4Client,
    getGa4AlphaClient,
    getGa4DataClientFn
  );

  // MCP prompts (prompts/list) - user-selectable templates shown in the client's "prompts" tab.
  registerServerSidePrompts(server);
  registerEcommerceFunnelPrompts(server);
  // Short verb-style slash commands: /audit, /report, /create-tag, /debug, /explain.
  registerCommandPrompts(server);

  return server;
}

/** Exported so the flag-to-prose contract can be tested without constructing a server. */
export function buildInstructions(config: ReturnType<typeof getGuardrailConfig>): string {
  return [
    'Samarth Analytics - Google Tag Manager MCP Server',
    '',
    'This server provides full access to the Google Tag Manager API v2, plus a Google Analytics ' +
      '(GA4) Admin API surface (reads always; config writes/deletes only when GA4_MCP_ENABLE_WRITES / ' +
      'GA4_MCP_ENABLE_DELETES are set) and read-only GA4 Data API reporting.',
    '',
    'Current mode: ' + describeMode(config),
    '',
    'IMPORTANT GUARDRAILS:',
    '- All write/delete/publish tools require confirm=true to proceed.',
    '- Set GTM_MCP_ENABLE_WRITES=true in .env to allow create/update operations.',
    '- Set GTM_MCP_ENABLE_DELETES=true to allow delete operations.',
    '- Set GTM_MCP_ENABLE_PUBLISH=true to allow publish operations.',
    '- Set GA4_MCP_ENABLE_WRITES=true to allow GA4 Admin creates/updates (also needs the analytics.edit scope).',
    '- Set GA4_MCP_ENABLE_DELETES=true to allow GA4 Admin deletes/archives (archive is effectively permanent).',
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
    '- clients_*, transformations_*, zones_*, templates_* (list/get/create/update/delete/revert), gtag_config_* (no revert) - server-side & advanced container resources',
    '- containers_snippet, containers_lookup, containers_combine, containers_move_tag_id',
    '- destinations_list, destinations_get, destinations_link',
    '- workspace_get_status - review the change diff (changed entities + conflicts) before versioning',
    '- audit_container - inspect for analytics issues',
    '- export_container - full workspace export as JSON',
    '',
    'GA4 ADMIN READS - Google Analytics Admin API v1beta:',
    '- ga4_account_summaries_list - discover GA4 accounts + property summaries',
    '- ga4_properties_list, ga4_property_get',
    '- ga4_data_streams_list, ga4_enhanced_measurement_get (web streams + measurement IDs)',
    '- ga4_custom_dimensions_list, ga4_custom_metrics_list',
    '- ga4_data_retention_get',
    '- ga4_key_events_list (formerly conversion events), ga4_google_ads_links_list',
    '  These READ tools never write/delete and need no confirm flag. They require the',
    "  'analytics.readonly' OAuth scope - re-run npm run auth:google if a 403 mentions scope.",
    '  Not READABLE through Admin API v1beta (documented limitations, not faked): internal-traffic/',
    '  unwanted-referral data filters, referral exclusions, channel groups, audiences. Audiences do',
    '  have gated v1alpha WRITE tools (see below); there is no audience READ tool.',
    '',
    'GA4 ADMIN WRITES - always registered, always gated:',
    '- ga4_create_* / ga4_update_* / ga4_delete_* / ga4_archive_* cover GA4 Admin config CRUD.',
    '  They appear in tools/list unconditionally and REFUSE unless the matching GA4_MCP_ENABLE_*',
    '  flag is true AND confirm=true is passed. Check "Current mode" above before telling a user',
    '  this server cannot change anything.',
    '',
    'GA4 DATA API (READ-ONLY) - Google Analytics Data API v1beta:',
    '- ga4_run_report - report dimensions/metrics over a date range (e.g. eventCount by eventName).',
    '- ga4_run_realtime_report - events in roughly the last 30 minutes for live QA.',
    '  Read-only; no confirm flag. Same analytics.readonly scope as the Admin tools.',
    '  Use to reconcile configured events vs. events GA4 actually reports.',
    '  Not exposed here (documented gaps, not stubbed): pivots, cohorts, funnels.',
    '',
    'PAGINATION: All list tools that support it auto-follow pagination to return all results. ',
    'Pass maxPages to bound the work; truncated results include truncated:true and nextPageToken to resume.',
  ].join('\n');
}
