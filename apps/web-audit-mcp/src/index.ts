#!/usr/bin/env node
/**
 * Entry point — stdio transport. stdout is the JSON-RPC channel, so all
 * logging goes to stderr. Needs a real browser host (local machine or a
 * container with Chromium); not deployable to Vercel serverless.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWebAuditMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = createWebAuditMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
