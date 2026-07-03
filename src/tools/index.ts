/**
 * Tool registration index
 * Registers all GTM tool categories with the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GtmClient } from '../utils/gtmClient.js';
import type {
  Ga4AdminClient,
  Ga4AdminAlphaClient,
  Ga4DataClient,
} from '../utils/ga4Client.js';

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
import { registerGa4AdminTools } from './ga4Admin.js';
import { registerGa4AdminWriteTools } from './ga4AdminWrite.js';
import { registerGa4DataTools } from './ga4Data.js';

export function registerAllTools(
  server: McpServer,
  getClient: () => GtmClient,
  getGa4Client: () => Ga4AdminClient,
  getGa4AlphaClient: () => Ga4AdminAlphaClient,
  getGa4DataClient: () => Ga4DataClient
): void {
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
  registerGa4AdminTools(server, getGa4Client, getGa4AlphaClient);
  registerGa4AdminWriteTools(server, getGa4Client, getGa4AlphaClient);
  registerGa4DataTools(server, getGa4DataClient);
}
