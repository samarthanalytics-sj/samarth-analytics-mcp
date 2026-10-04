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

/**
 * Routing decision for a POST /mcp request, mirroring the root server's
 * src/utils/mcpSession.ts (this package cannot import across the app boundary).
 *
 * Only an `initialize` may open a session. Anything else that carries a missing
 * or unknown session id is told to start over, instead of minting an orphan
 * transport that never enters the session map (the SDK only calls
 * `onsessioninitialized` for an actual initialize).
 */
export type PostRoute =
  /** Known session id: hand the request to that session's existing transport. */
  | { kind: 'resume'; sessionId: string }
  /** An initialize with no (or an unknown) session id: mint a session, with its own server. */
  | { kind: 'create' }
  /** Not an initialize, and the session id is missing or unknown: 404, mint nothing. */
  | { kind: 'unknown-session' };

/** Does this JSON-RPC body contain an `initialize` call? A batch counts if any member is one. */
export function isInitializeRequest(body: unknown): boolean {
  const one = (b: unknown): boolean =>
    typeof b === 'object' && b !== null && (b as { method?: unknown }).method === 'initialize';
  return Array.isArray(body) ? body.some(one) : one(body);
}

export function decidePostRoute(
  sessionId: string | undefined,
  hasSession: boolean,
  body: unknown,
): PostRoute {
  if (sessionId && hasSession) return { kind: 'resume', sessionId };
  if (isInitializeRequest(body)) return { kind: 'create' };
  return { kind: 'unknown-session' };
}

/** Message returned with the 404 for {@link PostRoute} `unknown-session`. */
export const UNKNOWN_SESSION_MESSAGE =
  'Unknown or expired mcp-session-id. Start a new session with an initialize request.';

export interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the HTTP server. `createServer` is called once PER SESSION: an McpServer
 * accepts exactly one transport, so a single shared instance threw "Already
 * connected to a transport" on the second client's initialize. Resolves once the
 * socket is listening; the returned handle exposes the bound port and a close().
 */
export async function startHttpServer(createServer: () => McpServer): Promise<HttpServerHandle> {
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

  type Transport = InstanceType<typeof StreamableHTTPServerTransport>;
  /** Each session owns its transport AND its McpServer, so closing one releases both. */
  const sessions = new Map<string, { transport: Transport; server: McpServer }>();

  /** JSON-RPC error body for a handler that threw, so a failure is a protocol error the client can
   *  read rather than a dead socket. Express 4 does not catch async handler rejections, and with no
   *  process net Node exits on one. Guarded on headersSent: the transport may already be streaming. */
  const rpcError = (res: import('express').Response, message: string): void => {
    if (res.headersSent) return;
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message }, id: null });
  };

  app.post('/mcp', requireAuth, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const route = decidePostRoute(sessionId, !!sessionId && sessions.has(sessionId), req.body);

      let transport: Transport;
      if (route.kind === 'resume') {
        transport = sessions.get(route.sessionId)!.transport;
      } else if (route.kind === 'unknown-session') {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: UNKNOWN_SESSION_MESSAGE },
          id: null,
        });
        return;
      } else {
        // New session: its own server instance, connected to its own transport.
        const newSessionId = randomUUID();
        const sessionServer = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: sessionServer });
            console.error(`[${SERVER_NAME}] new HTTP session: ${sid}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            console.error(`[${SERVER_NAME}] HTTP session closed: ${sid}`);
          }
          void sessionServer.close().catch(() => undefined); // release this session's server
        };
        await sessionServer.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[${SERVER_NAME}] POST /mcp failed:`, err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error handling this request.');
    }
  });

  app.get('/mcp', requireAuth, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: 'Missing or invalid mcp-session-id header.' });
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[${SERVER_NAME}] GET /mcp failed:`, err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error opening the event stream.');
    }
  });

  app.delete('/mcp', requireAuth, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        sessions.delete(sessionId); // transport.onclose also fires and closes that session's server
      } else {
        res.status(404).json({ error: 'Session not found.' });
      }
    } catch (err) {
      console.error(`[${SERVER_NAME}] DELETE /mcp failed:`, err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error closing the session.');
    }
  });

  // Health/liveness — also reports whether the browser is actually available,
  // so a misconfigured host (missing Chromium) is visible before the first audit.
  let playwrightAvailable: boolean | null = null;
  app.get('/health', async (_req, res) => {
    if (playwrightAvailable === null) playwrightAvailable = (await loadPlaywright()) !== null;
    res.json(
      buildHealthBody({
        activeSessions: sessions.size,
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
            for (const { transport, server } of sessions.values()) {
              void Promise.resolve(transport.close()).catch(() => undefined);
              void server.close().catch(() => undefined);
            }
            httpServer.close(() => r());
          }),
      });
    });
  });
}
