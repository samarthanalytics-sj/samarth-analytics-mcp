/**
 * Streamable HTTP transport for hosted deployments (Render/Fly/Railway/VPS/
 * Docker). Mirrors the root server's HTTP wiring (src/index.ts) so clients see
 * the same /mcp + /health surface, minus OAuth (this server has no Google auth).
 *
 * The /mcp endpoint is gated by a bearer token (WEB_AUDIT_HTTP_AUTH_TOKEN).
 * Without one the server REFUSES TO START, mirroring the root server
 * (src/utils/httpBinding.ts). WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true is the
 * local-development opt-in, and it binds 127.0.0.1 only.
 *
 * The pure helpers (isAuthorized, buildHealthBody, resolveHttpBinding,
 * bindingBanner, decidePostRoute) are exported and unit-tested; the express
 * glue is thin and follows the proven root pattern.
 */

import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './utils/config.js';
import { loadPlaywright } from './agent/browser.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

export const LOOPBACK = '127.0.0.1';

export interface HttpBinding {
  /** Interface to bind. Undefined = Node's default (every interface), which is exactly how an
   *  authenticated server has always listened, so hosted deployments are unchanged. */
  host: string | undefined;
  authRequired: boolean;
  /** Set when the server must NOT start; the string is the operator-facing reason. */
  refuse?: string;
}

/**
 * Decide whether the HTTP transport may start, and where it listens.
 *
 * Without a token, isAuthorized() lets every request through, and the listener
 * used to bind every interface behind a single stderr warning — so anyone who
 * could reach the port could drive this server's headless browser (crawls,
 * consent-banner clicks, and real form submits when verify is enabled).
 *
 *  1. Token set: authenticated, listen as before (all interfaces).
 *  2. No token: refuse to start, unless WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED is
 *     exactly 'true' (the `=== 'true'` idiom every other gate here uses).
 *  3. No token, opted in: bind 127.0.0.1 only, so the opt-in covers local
 *     development without also publishing the port.
 */
export function resolveHttpBinding(env: NodeJS.ProcessEnv = process.env): HttpBinding {
  // Same truthiness isAuthorized() uses, so "authenticated" means the same thing in both places.
  const authRequired = Boolean(env.WEB_AUDIT_HTTP_AUTH_TOKEN);
  if (authRequired) return { host: undefined, authRequired };
  if (env.WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED !== 'true') {
    return {
      host: LOOPBACK,
      authRequired,
      refuse:
        'HTTP transport refused to start: WEB_AUDIT_HTTP_AUTH_TOKEN is not set, so /mcp would let ' +
        "anyone who can reach the port drive this server's headless browser. Set " +
        'WEB_AUDIT_HTTP_AUTH_TOKEN (e.g. `openssl rand -hex 32`). For local development only, set ' +
        `WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true (it then binds ${LOOPBACK} only).`,
    };
  }
  return { host: LOOPBACK, authRequired };
}

/** Startup banner from the address ACTUALLY bound — never a hardcoded "localhost". */
export function bindingBanner(address: string, port: number, authRequired: boolean): string {
  const shown = address === '::' || address === '0.0.0.0' ? `all interfaces (${address})` : address;
  const auth = authRequired ? 'bearer token' : 'NONE (WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true)';
  return `HTTP server listening on ${shown}, port ${port} - authentication: ${auth}`;
}

/** Constant-time bearer-token check. Empty token = auth disabled, which startHttpServer only
 *  permits with WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true and a loopback bind. */
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
  /** The address actually bound (e.g. '127.0.0.1', or '::' for every interface). */
  host: string;
  close: () => Promise<void>;
}

/**
 * Start the HTTP server. `createServer` is called once PER SESSION: an McpServer
 * accepts exactly one transport, so a single shared instance threw "Already
 * connected to a transport" on the second client's initialize. Resolves once the
 * socket is listening; the returned handle exposes the bound port and a close().
 * Rejects, before anything listens, when no auth token is configured and the
 * unauthenticated opt-in is not set (see resolveHttpBinding).
 */
export async function startHttpServer(createServer: () => McpServer): Promise<HttpServerHandle> {
  const binding = resolveHttpBinding(process.env);
  if (binding.refuse) throw new Error(binding.refuse);

  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { randomUUID } = await import('node:crypto');
  const { default: express } = await import('express');

  const app = express();
  const bodyLimit = '8mb'; // GTM container exports can be large. Kept in step with the root server.
  app.use(express.json({ limit: bodyLimit }));
  // Body-parser failures (oversized or malformed JSON) never reach a route, so convert them here
  // into a JSON-RPC error body. Express's default error handler would send HTML, which a JSON-RPC
  // client cannot parse. Mirrors the root server (src/index.ts).
  app.use(
    (
      err: Error & { status?: number; type?: string },
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ): void => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const tooLarge = err.type === 'entity.too.large';
      const message = tooLarge
        ? `Request body exceeds the ${bodyLimit} limit.`
        : `Malformed request body: ${err.message}`;
      res
        .status(typeof err.status === 'number' ? err.status : 400)
        .json({ jsonrpc: '2.0', error: { code: tooLarge ? -32600 : -32700, message }, id: null });
    },
  );

  // PORT is the conventional var injected by Render/Fly; the explicit
  // WEB_AUDIT_HTTP_PORT wins when set.
  const port = parseInt(process.env.WEB_AUDIT_HTTP_PORT ?? process.env.PORT ?? '8080', 10);
  const authToken = process.env.WEB_AUDIT_HTTP_AUTH_TOKEN ?? '';
  if (!authToken) {
    console.error(
      `[${SERVER_NAME}] WARNING: WEB_AUDIT_HTTP_AUTH_TOKEN is not set — /mcp is unauthenticated ` +
        `(WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true), so it listens on ${LOOPBACK} only.`,
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
    const onListening = (): void => {
      const { address, port: bound } = httpServer.address() as AddressInfo;
      console.error(`[${SERVER_NAME}] ${bindingBanner(address, bound, binding.authRequired)}`);
      console.error(`[${SERVER_NAME}] MCP endpoint: POST /mcp`);
      console.error(`[${SERVER_NAME}] Health: GET /health`);
      resolve({
        port: bound,
        host: address,
        close: () =>
          new Promise<void>((r) => {
            for (const { transport, server } of sessions.values()) {
              void Promise.resolve(transport.close()).catch(() => undefined);
              void server.close().catch(() => undefined);
            }
            httpServer.close(() => r());
          }),
      });
    };
    // No host when authenticated: Node's default (every interface), exactly as before.
    const httpServer = binding.host
      ? app.listen(port, binding.host, onListening)
      : app.listen(port, onListening);
  });
}
