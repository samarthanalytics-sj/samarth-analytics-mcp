/**
 * Tool registration index
 * Registers all GTM tool categories with the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GtmClient } from '../utils/gtmClient.js';

import { registerAccountTools } from './accounts.js';
import { registerContainerTools } from './containers.js';
import { registerWorkspaceTools } from './workspaces.js';
import { registerTagTools } from './tags.js';
import { registerTriggerTools } from './triggers.js';
import { registerVariableTools } from './variables.js';
import { registerFolderTools } from './folders.js';
import { registerBuiltInVariableTools } from './builtInVariables.js';
import { registerVersionTools } from './versions.js';
import { registerPublishTools } from './publish.js';
import { registerAuditTools } from './audit.js';
import { registerExportTools } from './export.js';
import { registerEnvironmentTools } from './environments.js';
import { registerUserPermissionTools } from './userPermissions.js';
import { registerServerSideTools } from './serverSide.js';

export function registerAllTools(server: McpServer, getClient: () => GtmClient): void {
  registerAccountTools(server, getClient);
  registerContainerTools(server, getClient);
  registerWorkspaceTools(server, getClient);
  registerTagTools(server, getClient);
  registerTriggerTools(server, getClient);
  registerVariableTools(server, getClient);
  registerFolderTools(server, getClient);
  registerBuiltInVariableTools(server, getClient);
  registerVersionTools(server, getClient);
  registerPublishTools(server, getClient);
  registerEnvironmentTools(server, getClient);
  registerUserPermissionTools(server, getClient);
  registerServerSideTools(server, getClient);
  registerAuditTools(server, getClient);
  registerExportTools(server, getClient);
}
