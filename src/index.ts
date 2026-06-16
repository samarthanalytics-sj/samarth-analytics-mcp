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
import { createStytchTokenValidator } from './auth/stytchTokenValidator.js';
import type { StytchClaims } from './auth/stytchTokenValidator.js';

async function main(): Promise<void> {
  const transport = process.env.GTM_MCP_TRANSPORT ?? 'stdio';

  // Build Google auth client
  const auth = await buildGoogleAuth();

  // Create the MCP server with all tools registered
  const server = createGtmMcpServer(auth);

  if (transport === 'http') {
    await startHttpServer(server, auth);
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

async function startHttpServer(
  server: Awaited<ReturnType<typeof createGtmMcpServer>>,
  auth: OAuth2Client
): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { randomUUID, timingSafeEqual } = await import('crypto');
  const { default: express } = await import('express');

  const app = express();
  app.use(express.json());

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
    }
    return auth;
  }

  // Map of session ID → transport (for stateful sessions)
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  app.post('/mcp', async (req, res) => {
    const reqAuth = await resolveAuthForRequest(req, res);
    if (!reqAuth) return; // 401 already sent

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

    // Run tool dispatch inside the resolved identity context: the per-user
    // Google client in multi-user mode, or the default identity otherwise.
    await runWithAuth(reqAuth, () => transport.handleRequest(req, res, req.body));
  });

  // SSE stream endpoint (GET /mcp) — for clients that support SSE-style streaming
  app.get('/mcp', async (req, res) => {
    const reqAuth = await resolveAuthForRequest(req, res);
    if (!reqAuth) return;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header.' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await runWithAuth(reqAuth, () => transport.handleRequest(req, res));
  });

  // DELETE /mcp — client-initiated session termination
  app.delete('/mcp', async (req, res) => {
    const reqAuth = await resolveAuthForRequest(req, res);
    if (!reqAuth) return;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await runWithAuth(reqAuth, () => transport.handleRequest(req, res));
      transports.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found.' });
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
