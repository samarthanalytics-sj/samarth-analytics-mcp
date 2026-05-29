#!/usr/bin/env node
/**
 * Samarth GTM MCP Server — Entry Point
 *
 * Supports two transport modes:
 *   GTM_MCP_TRANSPORT=stdio  (default) — for Claude Desktop, Cursor, Claude Code
 *   GTM_MCP_TRANSPORT=http   — for cloud/team Streamable HTTP server
 *
 * Usage:
 *   # stdio (default)
 *   node dist/index.js
 *
 *   # HTTP server
 *   GTM_MCP_TRANSPORT=http GTM_MCP_HTTP_PORT=3001 node dist/index.js
 */

import 'dotenv/config';
import { buildGoogleAuth } from './auth/googleAuth.js';
import { createGtmMcpServer } from './server.js';

async function main(): Promise<void> {
  const transport = process.env.GTM_MCP_TRANSPORT ?? 'stdio';

  // Build Google auth client
  const auth = await buildGoogleAuth();

  // Create the MCP server with all tools registered
  const server = createGtmMcpServer(auth);

  if (transport === 'http') {
    await startHttpServer(server);
  } else {
    await startStdioServer(server);
  }
}

async function startStdioServer(server: Awaited<ReturnType<typeof createGtmMcpServer>>): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the JSON-RPC transport channel
  console.error('[samarth-gtm-mcp] Server ready on stdio transport');
  console.error('[samarth-gtm-mcp] Guardrails: writes=' + (process.env.GTM_MCP_ENABLE_WRITES ?? 'false') +
    ' publish=' + (process.env.GTM_MCP_ENABLE_PUBLISH ?? 'false') +
    ' deletes=' + (process.env.GTM_MCP_ENABLE_DELETES ?? 'false') +
    ' dryRun=' + (process.env.DRY_RUN ?? 'false'));
}

async function startHttpServer(server: Awaited<ReturnType<typeof createGtmMcpServer>>): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { randomUUID } = await import('crypto');
  const { default: express } = await import('express');

  const app = express();
  app.use(express.json());

  const port = parseInt(process.env.GTM_MCP_HTTP_PORT ?? '3001', 10);

  // Map of session ID → transport (for stateful sessions)
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: InstanceType<typeof StreamableHTTPServerTransport>;

    if (sessionId && transports.has(sessionId)) {
      // Resume existing session
      transport = transports.get(sessionId)!;
    } else {
      // New session
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          console.error(`[samarth-gtm-mcp] New HTTP session: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          console.error(`[samarth-gtm-mcp] HTTP session closed: ${sid}`);
        }
      };

      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // SSE stream endpoint (GET /mcp) — for clients that support SSE-style streaming
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header.' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — client-initiated session termination
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found.' });
    }
  });

  // OAuth callback endpoint (used when redirect URI is this server)
  app.get('/oauth/callback', async (req, res) => {
    const code = req.query['code'] as string | undefined;
    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }
    try {
      const { exchangeCodeForTokens } = await import('./auth/googleAuth.js');
      await exchangeCodeForTokens(code);
      res.send(
        '<html><body><h1>Authorization successful!</h1>' +
          '<p>Copy the tokens from the server console and add them to your .env file.</p>' +
          '<p>You can close this tab.</p></body></html>'
      );
    } catch (err) {
      res.status(500).send('Token exchange failed: ' + String(err));
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: 'samarth-gtm-mcp',
      transport: 'http',
      activeSessions: transports.size,
      guardrails: {
        writesEnabled: process.env.GTM_MCP_ENABLE_WRITES === 'true',
        publishEnabled: process.env.GTM_MCP_ENABLE_PUBLISH === 'true',
        deletesEnabled: process.env.GTM_MCP_ENABLE_DELETES === 'true',
        dryRun: process.env.DRY_RUN === 'true',
      },
    });
  });

  app.listen(port, () => {
    console.error(`[samarth-gtm-mcp] HTTP server running on http://localhost:${port}`);
    console.error(`[samarth-gtm-mcp] MCP endpoint: POST http://localhost:${port}/mcp`);
    console.error(`[samarth-gtm-mcp] Health: GET http://localhost:${port}/health`);
  });
}

main().catch((err) => {
  console.error('[samarth-gtm-mcp] Fatal error:', err);
  process.exit(1);
});
