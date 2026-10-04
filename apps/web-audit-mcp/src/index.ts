#!/usr/bin/env node
/**
 * Entry point. Two transports:
 *   WEB_AUDIT_TRANSPORT=stdio  (default) — Claude Desktop / CLI / Cursor.
 *   WEB_AUDIT_TRANSPORT=http             — hosted Streamable HTTP (Render/Fly/
 *                                          Railway/VPS/Docker).
 *
 * Either way this needs a real browser host (Chromium); it cannot run on
 * Vercel serverless. On stdio, stdout is the JSON-RPC channel — all logging
 * goes to stderr.
 */

import { createWebAuditMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const transport = process.env.WEB_AUDIT_TRANSPORT ?? 'stdio';

  if (transport === 'http') {
    const { startHttpServer } = await import('./http.js');
    // A factory, not an instance: HTTP builds one McpServer per session, because an
    // McpServer can only ever be connected to one transport.
    await startHttpServer(createWebAuditMcpServer);
    return;
  }

  const server = createWebAuditMcpServer();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

// Process-level safety nets, registered before main() so startup is covered too. Everything goes
// to stderr: on stdio, stdout IS the JSON-RPC channel. Mirrors the root server (src/index.ts):
//   - unhandledRejection: log and keep serving. Node's default terminates the process, so one
//     stray rejection in a single HTTP request would take every other session down with it.
//   - uncaughtException: log and exit non-zero. Process state after one is undefined, so
//     restarting beats continuing; the handler exists for the diagnostic.
process.on('unhandledRejection', (reason) => {
  console.error(`[${SERVER_NAME}] unhandled promise rejection:`, reason);
});

process.on('uncaughtException', (err) => {
  console.error(`[${SERVER_NAME}] uncaught exception:`, err);
  process.exit(1);
});

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
