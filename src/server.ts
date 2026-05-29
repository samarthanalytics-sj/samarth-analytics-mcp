/**
 * GTM MCP Server factory
 * Creates the McpServer instance and registers all tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuth2Client } from 'google-auth-library';
import { getGtmClient } from './utils/gtmClient.js';
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

  // Lazy client getter — created once auth is available
  const getClient = () => getGtmClient(auth);

  registerAllTools(server, getClient);

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
    'This server provides full access to the Google Tag Manager API v2.',
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
    '- audit_container — inspect for analytics issues',
    '- export_container — full workspace export as JSON',
  ].join('\n');
}
