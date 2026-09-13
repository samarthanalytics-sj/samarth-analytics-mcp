/**
 * Streamable HTTP transport for hosted deployments (Render/Fly/Railway/VPS/
 * Docker). Mirrors the root server's HTTP wiring (src/index.ts) so clients see
 * the same /mcp + /health surface, minus OAuth (this server has no Google auth).
 *
 * The /mcp endpoint is gated by a bearer token (WEB_AUDIT_HTTP_AUTH_TOKEN).
 * When unset, the endpoint is open and a warning is logged — never expose an
 * ungated /mcp to the public internet.
 *
 * The pure helpers (isAuthorized, buildHealthBody) are exported and unit-tested;
 * the express glue is thin and follows the proven root pattern.
 */

import { timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './utils/config.js';
import { loadPlaywright } from './agent/browser.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

/** Constant-time bearer-token check. Empty token = auth disabled (caller warns). */
export function isAuthorized(authHeader: string | undefined, token: string): boolean {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authHeader ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface HealthBody {
  status: 'ok';
  server: string;
  version: string;
  transport: 'http';
  activeSessions: number;
  playwrightAvailable: boolean;
  authRequired: boolean;
  config: {
    interactionEnabled: boolean;
    allowlist: string[];
    maxPages: number;
    maxDepth: number;
  };
}

export function buildHealthBody(opts: {
  activeSessions: number;
  playwrightAvailable: boolean;
  authRequired: boolean;
  config: ReturnType<typeof loadConfig>;
}): HealthBody {
  return {
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http',
    activeSessions: opts.activeSessions,
    playwrightAvailable: opts.playwrightAvailable,
    authRequired: opts.authRequired,
    config: {
      interactionEnabled: opts.config.interactionEnabled,
      allowlist: opts.config.allowlist,
      maxPages: opts.config.maxPages,
      maxDepth: opts.config.maxDepth,
    },
  };
}

export interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the HTTP server bound to the given MCP server. Resolves once the socket
 * is listening; the returned handle exposes the bound port and a close().
 */
export async function startHttpServer(server: McpServer): Promise<HttpServerHandle> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { randomUUID } = await import('node:crypto');
  const { default: express } = await import('express');

  const app = express();
  app.use(express.json({ limit: '8mb' })); // GTM container exports can be large.

  // PORT is the conventional var injected by Render/Fly; the explicit
  // WEB_AUDIT_HTTP_PORT wins when set.
  const port = parseInt(process.env.WEB_AUDIT_HTTP_PORT ?? process.env.PORT ?? '8080', 10);
  const authToken = process.env.WEB_AUDIT_HTTP_AUTH_TOKEN ?? '';
  if (!authToken) {
    console.error(
      `[${SERVER_NAME}] WARNING: WEB_AUDIT_HTTP_AUTH_TOKEN is not set — /mcp is unauthenticated. ` +
        'Set it before exposing this server beyond localhost.',
    );
  }

  const requireAuth: import('express').RequestHandler = (req, res, next) => {
    if (isAuthorized(req.headers.authorization, authToken)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>.' });
  };

  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  app.post('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: InstanceType<typeof StreamableHTTPServerTransport>;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          console.error(`[${SERVER_NAME}] new HTTP session: ${sid}`);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          console.error(`[${SERVER_NAME}] HTTP session closed: ${sid}`);
        }
      };
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header.' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  app.delete('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found.' });
    }
  });

  // Health/liveness — also reports whether the browser is actually available,
  // so a misconfigured host (missing Chromium) is visible before the first audit.
  let playwrightAvailable: boolean | null = null;
  app.get('/health', async (_req, res) => {
    if (playwrightAvailable === null) playwrightAvailable = (await loadPlaywright()) !== null;
    res.json(
      buildHealthBody({
        activeSessions: transports.size,
        playwrightAvailable,
        authRequired: Boolean(authToken),
        config: loadConfig(),
      }),
    );
  });

  return await new Promise<HttpServerHandle>((resolve) => {
    const httpServer = app.listen(port, () => {
      const bound = (httpServer.address() as { port: number }).port;
      console.error(`[${SERVER_NAME}] HTTP server on http://localhost:${bound}`);
      console.error(`[${SERVER_NAME}] MCP endpoint: POST http://localhost:${bound}/mcp`);
      console.error(`[${SERVER_NAME}] Health: GET http://localhost:${bound}/health`);
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((r) => {
            for (const t of transports.values()) void t.close?.();
            httpServer.close(() => r());
          }),
      });
    });
  });
}
