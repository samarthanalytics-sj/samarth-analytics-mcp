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
  const server = createWebAuditMcpServer();

  if (transport === 'http') {
    const { startHttpServer } = await import('./http.js');
    await startHttpServer(server);
    return;
  }

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
