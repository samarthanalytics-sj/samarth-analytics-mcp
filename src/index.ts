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
import type { OAuth2Client } from 'google-auth-library';
import { buildGoogleAuth, GTM_SCOPES, GA4_ADMIN_READONLY_SCOPE } from './auth/googleAuth.js';
import { createGtmMcpServer } from './server.js';
import { runWithAuth } from './auth/identityContext.js';
import { existsSync } from 'node:fs';
import {
  createGoogleIdentityResolver,
  deriveApiBase,
  GoogleScopeError,
} from './auth/googleIdentityResolver.js';
import { resolveHttpBinding, bindingBanner } from './utils/httpBinding.js';
import { getGuardrailConfig } from './utils/guardrails.js';
import { guardrailBanner, guardrailStatus } from './utils/guardrailMode.js';
import { decidePostRoute, UNKNOWN_SESSION_MESSAGE } from './utils/mcpSession.js';
import { createStytchTokenValidator } from './auth/stytchTokenValidator.js';
import type { StytchClaims } from './auth/stytchTokenValidator.js';

async function main(): Promise<void> {
  const transport = process.env.GTM_MCP_TRANSPORT ?? 'stdio';

  // Build Google auth client
  const auth = await buildGoogleAuth();

  if (transport === 'http') {
    // HTTP builds one MCP server PER SESSION (see startHttpServer): an McpServer can only ever be
    // connected to a single transport, so a shared instance cannot serve two clients.
    await startHttpServer(auth);
  } else {
    await startStdioServer(createGtmMcpServer(auth));
  }
}

async function startStdioServer(server: Awaited<ReturnType<typeof createGtmMcpServer>>): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the JSON-RPC transport channel
  console.error('[samarth-gtm-mcp] Server ready on stdio transport');
  console.error('[samarth-gtm-mcp] ' + guardrailBanner(getGuardrailConfig()));
}

async function startHttpServer(auth: OAuth2Client): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { randomUUID, timingSafeEqual } = await import('crypto');
  const { default: express } = await import('express');

  const app = express();
  // Body limit. express.json()'s 100 kB default rejected legitimate calls before they ever reached
  // the transport (templates_create / templates_update carrying a real template's templateData, a
  // large tags_create html parameter), and body-parser answers with an HTML 413 that a JSON-RPC
  // client cannot parse - so the identical call succeeded over stdio and died over HTTP with an
  // unreadable error. 8mb matches the sibling apps/web-audit-mcp HTTP server.
  const bodyLimit = process.env.GTM_MCP_HTTP_BODY_LIMIT ?? '8mb';
  app.use(express.json({ limit: bodyLimit }));
  // Body-parser failures (oversized or malformed JSON) never reach a route, so convert them here
  // into a JSON-RPC error body. Express's default error handler would send HTML.
  app.use(
    (
      err: Error & { status?: number; type?: string },
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction
    ): void => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const tooLarge = err.type === 'entity.too.large';
      const message = tooLarge
        ? `Request body exceeds the ${bodyLimit} limit. Raise GTM_MCP_HTTP_BODY_LIMIT if this call is legitimate.`
        : `Malformed request body: ${err.message}`;
      res
        .status(typeof err.status === 'number' ? err.status : 400)
        .json({ jsonrpc: '2.0', error: { code: tooLarge ? -32600 : -32700, message }, id: null });
    }
  );

  // PORT is the conventional env var injected by hosts like Render/Fly;
  // GTM_MCP_HTTP_PORT takes precedence when explicitly set.
  const port = parseInt(process.env.GTM_MCP_HTTP_PORT ?? process.env.PORT ?? '3001', 10);

  // ── Auth modes ─────────────────────────────────────────────────────────────
  // Multi-user mode (Stytch Connected Apps) activates when STYTCH_PROJECT_ID is
  // set: each /mcp request carries a Stytch-issued JWT, which we validate and
  // resolve to that user's own Google identity (per-request). Otherwise the
  // server runs in single-identity mode behind the static GTM_MCP_HTTP_AUTH_TOKEN
  // gate — today's behavior, unchanged. See docs/PHASE3_IMPLEMENTATION_SPEC.md.
  const stytchProjectId = process.env.STYTCH_PROJECT_ID ?? '';
  const multiUser = stytchProjectId.length > 0;

  const staticToken = process.env.GTM_MCP_HTTP_AUTH_TOKEN ?? '';
  // Decide the bind host and whether we may start AT ALL, before anything listens. An
  // unauthenticated HTTP transport used to start on EVERY interface behind a single stderr
  // warning, so anyone who could reach the port got this server's Google credentials.
  const binding = resolveHttpBinding(process.env);
  if (binding.refuse) {
    console.error(`[samarth-gtm-mcp] ${binding.refuse}`);
    process.exit(1);
  }
  if (binding.warning) {
    console.error(`[samarth-gtm-mcp] WARNING: ${binding.warning}`);
  }
  if (!multiUser && !staticToken) {
    console.error(
      '[samarth-gtm-mcp] WARNING: GTM_MCP_HTTP_AUTH_TOKEN is not set — /mcp is unauthenticated. ' +
        'Set it before exposing this server beyond localhost.'
    );
  }

  const publicUrl = (
    process.env.GTM_MCP_PUBLIC_URL ?? `http://localhost:${port}`
  ).replace(/\/+$/, '');
  const prmUrl = `${publicUrl}/.well-known/oauth-protected-resource`;

  let validator: ReturnType<typeof createStytchTokenValidator> | undefined;
  let resolver: ReturnType<typeof createGoogleIdentityResolver> | undefined;
  // Authorization-server endpoints. Stytch's own discovery doc omits the DCR
  // registration_endpoint and doesn't serve RFC 8414 metadata, so we advertise
  // a complete authorization-server metadata document ourselves (issuer = this
  // server; authorize = our page; token/register/jwks = Stytch). All confirmed
  // against the live project. See docs/PHASE3_IMPLEMENTATION_SPEC.md.
  let jwksUri = '';
  let tokenEndpoint = '';
  let registrationEndpoint = '';
  if (multiUser) {
    const secret = process.env.STYTCH_SECRET ?? '';
    if (!secret) {
      console.error(
        '[samarth-gtm-mcp] FATAL: STYTCH_PROJECT_ID is set but STYTCH_SECRET is missing.'
      );
      process.exit(1);
    }
    const apiBase = process.env.STYTCH_API_BASE ?? deriveApiBase(stytchProjectId);
    jwksUri =
      process.env.STYTCH_JWKS_URL ??
      `${apiBase}/v1/public/${stytchProjectId}/.well-known/jwks.json`;
    tokenEndpoint =
      process.env.STYTCH_TOKEN_ENDPOINT ??
      `${apiBase}/v1/public/${stytchProjectId}/oauth2/token`;
    registrationEndpoint =
      process.env.STYTCH_REGISTRATION_ENDPOINT ??
      `${apiBase}/v1/public/${stytchProjectId}/oauth2/register`;
    validator = createStytchTokenValidator({
      jwksUrl: jwksUri,
      issuer: process.env.STYTCH_JWT_ISSUER || undefined,
      audience: process.env.STYTCH_JWT_AUDIENCE || undefined,
      debugClaims: process.env.STYTCH_DEBUG_CLAIMS === 'true',
    });
    if (!process.env.STYTCH_JWT_ISSUER || !process.env.STYTCH_JWT_AUDIENCE) {
      console.error(
        '[samarth-gtm-mcp] WARNING: STYTCH_JWT_ISSUER / STYTCH_JWT_AUDIENCE are not both set — ' +
          'tokens are accepted on JWKS signature + expiry alone, without issuer/audience pinning. ' +
          'Read the values from a STYTCH_DEBUG_CLAIMS log once, set both, then disable debug.'
      );
    }
    // Require the grant to carry at least one scope we actually use, so an
    // incomplete Google consent fails at sign-in resolution with a clear 403
    // rather than as a raw Google 403 inside a tool call. GTM_SCOPES[0] is
    // tagmanager.readonly; GA4_ADMIN_READONLY_SCOPE is analytics.readonly.
    resolver = createGoogleIdentityResolver({
      projectId: stytchProjectId,
      secret,
      apiBase,
      requiredAnyScopes: [GTM_SCOPES[0], GA4_ADMIN_READONLY_SCOPE],
    });
    console.error(`[samarth-gtm-mcp] Multi-user mode (Stytch) enabled. JWKS: ${jwksUri}`);
  }

  function send401(res: import('express').Response, reason: string): void {
    // In multi-user mode, point MCP clients at the Protected Resource Metadata
    // so they can discover the authorization server (RFC 9728).
    if (multiUser) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${prmUrl}"`);
    }
    res.status(401).json({ error: reason });
  }

  // Resolve the OAuth2Client to use for a request, applying the right gate.
  // Returns undefined (and sends a 401) when the request is not authorized.
  async function resolveAuthForRequest(
    req: import('express').Request,
    res: import('express').Response
  ): Promise<OAuth2Client | undefined> {
    if (multiUser) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (!m) {
        send401(res, 'Missing bearer token.');
        return undefined;
      }
      // Step 1 — validate the Stytch JWT. A failure here is genuinely an
      // auth problem (bad signature/expiry/issuer), so it stays a 401 challenge.
      let claims: StytchClaims;
      try {
        claims = await validator!.validate(m[1]);
      } catch (err) {
        console.error(
          '[samarth-gtm-mcp] token validation failed:',
          err instanceof Error ? err.message : String(err)
        );
        send401(res, 'Invalid or expired token.');
        return undefined;
      }
      // Step 2 — resolve the member's Google identity via Stytch. The token was
      // valid, so this is NOT a 401: a missing-scope grant is the user's to fix
      // (403 + actionable message); anything else is an upstream broker failure
      // (502). Either way we log the real cause for the Render logs.
      const who = `${claims.organizationId}:${claims.memberId}`;
      try {
        return await resolver!.resolve(claims.organizationId, claims.memberId);
      } catch (err) {
        if (err instanceof GoogleScopeError) {
          console.error(`[samarth-gtm-mcp] Google scope check failed for ${who}: ${err.message}`);
          res.status(403).json({ error: err.message });
          return undefined;
        }
        console.error(
          `[samarth-gtm-mcp] Google identity resolution failed for ${who}:`,
          err instanceof Error ? err.message : String(err)
        );
        res.status(502).json({
          error:
            'Could not resolve your Google identity from the authorization server. ' +
            'Try reconnecting; if this persists, the upstream token broker may be unavailable.',
        });
        return undefined;
      }
    }
    // single-identity mode: static token gate (timing-safe).
    if (staticToken) {
      const expected = Buffer.from(`Bearer ${staticToken}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!ok) {
        res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>.' });
        return undefined;
      }
    } else {
      // No token configured. Reaching here means the operator opted in with
      // GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED=true (startup refuses otherwise), so the request is
      // served - but say so per request rather than letting an open server look like a
      // configured one in the logs.
      console.error('[samarth-gtm-mcp] serving an UNAUTHENTICATED /mcp request (no auth configured)');
    }
    return auth;
  }

  /** Live stateful sessions, keyed by mcp-session-id, each with its OWN MCP server.
   *  An McpServer refuses a second `connect()` ("Already connected to a transport"), so sharing one
   *  instance meant the SECOND client to arrive threw inside an async handler, and with no rejection
   *  net that killed the process and took the first client's session with it. Keeping the server
   *  beside its transport also lets us close it when the session ends. */
  const sessions = new Map<
    string,
    {
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      server: ReturnType<typeof createGtmMcpServer>;
      /** Epoch ms of the last request seen on this session. Drives the idle sweep below. */
      lastActivity: number;
      /** Requests currently being handled on this session (a POST, or an open SSE GET). A session
       *  with one in flight must never be swept, even if lastActivity - stamped at request START,
       *  not refreshed during it - has aged past the TTL, or a long tool call / held-open stream
       *  would be torn down mid-flight. */
      inFlight: number;
    }
  >();

  /** Idle-session sweep. A session used to live until the client sent an explicit DELETE, and a
   *  client that crashes, relaunches or loses the network never sends one: every reconnect minted a
   *  fresh McpServer (every tool registration plus the prompts) and left its predecessor resident
   *  for the life of the process, so activeSessions and memory only ever climbed, and anyone able to
   *  reach /mcp could mint sessions without bound by looping initialize. Set
   *  GTM_MCP_HTTP_SESSION_TTL_MS=0 to turn the sweep off. */
  const ttlRaw = parseInt(process.env.GTM_MCP_HTTP_SESSION_TTL_MS ?? '', 10);
  const sessionTtlMs = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : 30 * 60_000;
  if (sessionTtlMs > 0) {
    const sweep = setInterval(() => {
      const cutoff = Date.now() - sessionTtlMs;
      for (const [sid, entry] of [...sessions]) {
        if (entry.inFlight > 0 || entry.lastActivity > cutoff) continue;
        // Drop the entry first: transport.close() fires onclose, whose delete then finds nothing,
        // and if the transport was already closed the entry still goes away.
        sessions.delete(sid);
        console.error(
          `[samarth-gtm-mcp] Closing idle HTTP session: ${sid} (active: ${sessions.size})`
        );
        void Promise.resolve(entry.transport.close()).catch(() => undefined);
        void entry.server.close().catch(() => undefined);
      }
    }, Math.min(sessionTtlMs, 60_000));
    // The listener is what keeps this process alive; the sweep must never be the reason it stays up.
    sweep.unref();
  }

  /** JSON-RPC error body for a handler that threw, so a failure is a protocol error the client can read
   *  rather than a dead socket (or a dead process). Guarded on headersSent because the transport may
   *  already have started streaming a response by the time it throws. */
  const rpcError = (res: import('express').Response, message: string): void => {
    if (res.headersSent) return;
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message }, id: null });
  };

  /** Guard a session against the idle sweep for the LIFE of a request. Counts it as in-flight and
   *  stamps lastActivity now; on the response closing (normal end, abort, or an SSE stream the client
   *  finally disconnects) decrements and re-stamps. Without this, lastActivity is only set when a
   *  request begins, so a tool call or event stream that outlives the TTL gets closed mid-flight. */
  const trackRequest = (
    entry: { inFlight: number; lastActivity: number },
    res: import('express').Response,
  ): void => {
    entry.inFlight += 1;
    entry.lastActivity = Date.now();
    res.once('close', () => {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastActivity = Date.now();
    });
  };

  app.post('/mcp', async (req, res) => {
    try {
      const reqAuth = await resolveAuthForRequest(req, res);
      if (!reqAuth) return; // 401 already sent

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const route = decidePostRoute(sessionId, !!sessionId && sessions.has(sessionId), req.body);

      let transport: InstanceType<typeof StreamableHTTPServerTransport>;

      if (route.kind === 'resume') {
        const entry = sessions.get(route.sessionId)!;
        trackRequest(entry, res); // in-flight for the whole request, so a long call is never swept
        transport = entry.transport;
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
        const sessionServer = createGtmMcpServer(auth);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: sessionServer, lastActivity: Date.now(), inFlight: 0 });
            console.error(`[samarth-gtm-mcp] New HTTP session: ${sid} (active: ${sessions.size})`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            console.error(`[samarth-gtm-mcp] HTTP session closed: ${sid} (active: ${sessions.size})`);
          }
          void sessionServer.close().catch(() => undefined); // release this session's server
        };

        await sessionServer.connect(transport);
      }

      // Run tool dispatch inside the resolved identity context: the per-user
      // Google client in multi-user mode, or the default identity otherwise.
      await runWithAuth(reqAuth, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error('[samarth-gtm-mcp] POST /mcp failed:', err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error handling this request.');
    }
  });

  // SSE stream endpoint (GET /mcp) — for clients that support SSE-style streaming
  app.get('/mcp', async (req, res) => {
    try {
      const reqAuth = await resolveAuthForRequest(req, res);
      if (!reqAuth) return;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: 'Missing or invalid mcp-session-id header.' });
        return;
      }
      const entry = sessions.get(sessionId)!;
      trackRequest(entry, res); // a held-open event stream stays in-flight until the client disconnects
      const { transport } = entry;
      await runWithAuth(reqAuth, () => transport.handleRequest(req, res));
    } catch (err) {
      console.error('[samarth-gtm-mcp] GET /mcp failed:', err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error opening the event stream.');
    }
  });

  // DELETE /mcp — client-initiated session termination
  app.delete('/mcp', async (req, res) => {
    try {
      const reqAuth = await resolveAuthForRequest(req, res);
      if (!reqAuth) return;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await runWithAuth(reqAuth, () => transport.handleRequest(req, res));
        sessions.delete(sessionId); // transport.onclose also fires and closes that session's server
      } else {
        res.status(404).json({ error: 'Session not found.' });
      }
    } catch (err) {
      console.error('[samarth-gtm-mcp] DELETE /mcp failed:', err instanceof Error ? err.message : String(err));
      rpcError(res, 'Internal server error closing the session.');
    }
  });

  // ── Multi-user OAuth surface (RFC 9728 + Stytch authorize page) ─────────────
  // Protected Resource Metadata — tells MCP clients where the authorization
  // server is. Always served; authorization_servers is populated in multi-user
  // mode. See docs/PHASE3_IMPLEMENTATION_SPEC.md.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: publicUrl,
      // Point clients at OUR authorization-server metadata (below), which fills
      // the gaps in Stytch's discovery doc (registration_endpoint + RFC 8414).
      authorization_servers: multiUser ? [publicUrl] : [],
    });
  });

  // RFC 8414 authorization-server metadata. Stytch's own openid-configuration
  // omits registration_endpoint and it serves no oauth-authorization-server
  // doc, so we advertise a complete one: issuer = this server, authorize = our
  // page, token/register/jwks = Stytch (all verified against the live project).
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    if (!multiUser) {
      res.status(404).json({ error: 'authorization server not configured' });
      return;
    }
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: tokenEndpoint,
      registration_endpoint: registrationEndpoint,
      jwks_uri: jwksUri,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      // Only advertise universally-grantable OIDC scopes. mcp-remote requests
      // whatever we advertise; full_access/offline_access were rejected by
      // Stytch ("invalid scope") for the DCR'd connected app. We only need to
      // identify the member, so openid/email/profile suffices.
      scopes_supported: ['openid', 'email', 'profile'],
    });
  });

  // Authorization URL configured in the Stytch dashboard — serves the prebuilt
  // React authorize app (login + consent) from apps/mcp-authorize. The public
  // token is injected at runtime (token-agnostic bundle). See that app + the
  // PHASE3 spec. Routes are registered before the static mount so config.js
  // isn't shadowed.
  app.get('/oauth/authorize/config.js', (_req, res) => {
    res.type('application/javascript').send(
      'window.__MCP_AUTHORIZE_CONFIG__=' +
        JSON.stringify({ stytchPublicToken: process.env.STYTCH_PUBLIC_TOKEN ?? '' }) +
        ';'
    );
  });
  const authorizeDir = process.env.AUTHORIZE_UI_DIR ?? 'apps/mcp-authorize/dist';
  if (existsSync(authorizeDir)) {
    app.use('/oauth/authorize', express.static(authorizeDir));
  } else {
    console.error(
      `[samarth-gtm-mcp] authorize UI not found at ${authorizeDir} — /oauth/authorize will 404. ` +
        'Build apps/mcp-authorize (or set AUTHORIZE_UI_DIR).'
    );
  }

  // NOTE: there is deliberately NO /oauth/callback route here. It used to accept an authorization code
  // with no auth gate and call exchangeCodeForTokens(code), whose `persist` defaults to true - so an
  // unauthenticated request could overwrite this server's stored Google credentials, on exactly the
  // hosted deployments where /mcp is token-gated and the listener binds all interfaces. It was also
  // unnecessary: `npm run auth:google` runs its own loopback listener on 127.0.0.1
  // (src/scripts/auth-google.ts), which is how onboarding actually completes the flow.

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: 'samarth-gtm-mcp',
      transport: 'http',
      activeSessions: sessions.size,
      guardrails: guardrailStatus(getGuardrailConfig()),
    });
  });

  app.listen(port, binding.host, () => {
    // The banner reports the host ACTUALLY bound. It used to say "localhost" unconditionally
    // while listening on every interface, and that sentence is what an operator trusts when
    // deciding whether the port is exposed.
    console.error(`[samarth-gtm-mcp] HTTP server ${bindingBanner(binding, port)}`);
    console.error('[samarth-gtm-mcp] MCP endpoint: POST /mcp');
    console.error('[samarth-gtm-mcp] Health: GET /health');
  });
}

// Process-level safety nets. Registered before main() runs so startup failures are covered too.
// Everything goes to stderr: on the stdio transport stdout IS the JSON-RPC channel, and a stray
// log line there corrupts the stream for the client.
//
// The two are deliberately asymmetric:
//   - unhandledRejection: log and keep serving. Node's default is to terminate the process, so a
//     single orphaned promise (a closed HTTP session's in-flight Google call, say) would take down
//     every other session with it. The loud stderr line is what makes it debuggable instead of
//     invisible.
//   - uncaughtException: log and exit non-zero. Process state after one is undefined, so continuing
//     is worse than restarting; the point of the handler is the diagnostic, not the recovery.
process.on('unhandledRejection', (reason) => {
  console.error('[samarth-gtm-mcp] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[samarth-gtm-mcp] Uncaught exception:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error('[samarth-gtm-mcp] Fatal error:', err);
  process.exit(1);
});
