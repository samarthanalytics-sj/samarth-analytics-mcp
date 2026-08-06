/**
 * Chat orchestrator HTTP server.
 *
 * This is the only public surface of the AI plane. The browser talks to it, it talks to OpenAI and
 * to the MCP server. It exists because the MCP cannot be called from a browser: its HTTP transport
 * sets no CORS headers, its sessions live in process memory, and an agentic turn runs far longer
 * than a serverless function may.
 */
import express from 'express';
import cors from 'cors';
import { loadConfig, type OrchestratorConfig, type Product } from './config.js';
import { AuthError, SupabaseTokenVerifier } from './auth.js';
import { McpConnection } from './mcp-client.js';
import { McpPool } from './mcp-pool.js';
import { createTokenProvider, GoogleIdentityError } from './google-identity.js';
import { forLog, userRef } from './redact.js';
import { OpenAiClient, OpenAiError } from './openai.js';
import { runTurn } from './loop.js';
import { SseStream } from './sse.js';
import { scopeTools } from './tools.js';
import type { AuthedUser, ChatRequestBody } from './types.js';

const cfg: OrchestratorConfig = loadConfig();

/** Fixed-window per-user turn limiter. Replace with Redis when this runs on more than one node. */
class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(key: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const window = now - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > window);
    if (recent.length >= maxPerMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

async function main(): Promise<void> {
  const tokenProvider = createTokenProvider(cfg);
  const pool = new McpPool(cfg, tokenProvider);
  pool.start();

  console.log(`[orchestrator] Google identity mode: ${cfg.googleIdentity.mode}`);
  if (cfg.googleIdentity.mode !== 'supabase') {
    console.warn(
      `[orchestrator] WARNING: every user shares one Google account in "${cfg.googleIdentity.mode}" mode. ` +
        'Use GOOGLE_IDENTITY_MODE=supabase before real users sign in.',
    );
  }

  // A catalog probe at boot: it proves the MCP binary is reachable and gives the tool inventory,
  // which is identical across user sessions. Deliberately built with no Google token.
  console.log('[orchestrator] probing MCP server...');
  const probe = new McpConnection(cfg, cfg.googleIdentity.mode === 'inherit' ? undefined : 'probe');
  await probe.connect();

  const all = probe.listTools();
  const reads = all.filter((t) => !t.isWrite).length;
  console.log(
    `[orchestrator] MCP connected: ${all.length} tools (${reads} read, ${all.length - reads} write-gated), ` +
      `${probe.listPrompts().length} prompts`,
  );
  console.log(
    `[orchestrator] visible to model: GTM ${scopeTools(all, { product: 'gtm', includeWrites: cfg.enableWriteTools }).length}, ` +
      `GA4 ${scopeTools(all, { product: 'ga4', includeWrites: cfg.enableWriteTools }).length}` +
      (cfg.enableWriteTools ? ' (writes ENABLED)' : ' (read-only)'),
  );

  const llm = new OpenAiClient(cfg);
  const limiter = new RateLimiter();
  const verifier = cfg.supabase.jwksUrl
    ? new SupabaseTokenVerifier(cfg.supabase.jwksUrl, {
        issuer: cfg.supabase.issuer,
        audience: cfg.supabase.audience,
        authUrl: cfg.supabase.authUrl,
        anonKey: cfg.supabase.anonKey,
      })
    : null;

  const app = express();
  app.disable('x-powered-by');

  // One line per request. Without it there is no way to tell a request that never arrived from one
  // that arrived and was rejected before reaching a handler, which is the first question worth
  // answering when a browser reports a bare network failure.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      const origin = req.headers.origin ?? '-';
      console.log(
        `[req] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - startedAt}ms origin=${origin}`,
      );
    });
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin and server-to-server calls arrive without an Origin header.
        if (!origin) return cb(null, true);
        cb(null, cfg.allowedOrigins.includes(origin));
      },
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    }),
  );

  async function authenticate(header: string | undefined): Promise<AuthedUser> {
    if (cfg.devNoAuth) return { id: 'dev-user', email: 'dev@localhost' };
    const token = extractBearer(header);
    if (!token) throw new AuthError('Missing bearer token');
    if (!verifier) throw new AuthError('Token verification is not configured', 'misconfigured');
    return verifier.verify(token);
  }

  app.get('/health', (_req, res) => {
    const { sessions, busy } = pool.stats();
    res.json({
      status: 'ok',
      service: 'samarth-chat-orchestrator',
      model: cfg.openai.model,
      mcpTools: all.length,
      writeToolsVisible: cfg.enableWriteTools,
      authRequired: !cfg.devNoAuth,
      googleIdentityMode: cfg.googleIdentity.mode,
      mcpSessions: sessions,
      mcpSessionsBusy: busy,
    });
  });

  /** Slash commands for the UI, sourced from the MCP's own registered prompts. */
  app.get('/v1/commands', async (req, res) => {
    try {
      await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    res.json({
      commands: probe.listPrompts().map((p) => ({
        name: p.name,
        title: p.title ?? p.name,
        description: p.description ?? '',
        arguments: p.arguments ?? [],
      })),
    });
  });

  /** Expands a registered MCP prompt into the user-message text that starts a turn. */
  app.post('/v1/commands/:name', async (req, res) => {
    try {
      await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    const args = (req.body?.arguments ?? {}) as Record<string, string>;
    try {
      // Prompt templates are static text, identical for every user, so the probe connection serves
      // them without needing a per-user session.
      const text = await probe.getPromptText(req.params.name, args);
      res.json({ text });
    } catch (err) {
      res.status(400).json({
        code: 'unknown_command',
        message: err instanceof Error ? err.message : 'Unknown command',
      });
    }
  });

  app.post('/v1/chat', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }

    if (!limiter.allow(user.id, cfg.limits.turnsPerMinutePerUser)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({
        code: 'rate_limited',
        message: `You can send ${cfg.limits.turnsPerMinutePerUser} messages per minute. Try again shortly.`,
      });
    }

    const body = req.body as ChatRequestBody;
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return res.status(400).json({ code: 'bad_request', message: 'messages array is required' });
    }
    const product: Product = body.context?.product === 'ga4' ? 'ga4' : 'gtm';

    const userJwt = extractBearer(req.headers.authorization);

    // Resolve this user's own Google identity before opening the stream, so an unconnected account
    // is a clean JSON error the UI can act on rather than an error buried inside a stream.
    let userMcp: McpConnection;
    try {
      userMcp = await pool.acquire(user.id, userJwt);
    } catch (err) {
      if (err instanceof GoogleIdentityError) {
        console.error(`[identity] ${err.code} for user ${userRef(user.id)}: ${forLog(err.message)}`);
        return res.status(err.code === 'not_connected' ? 428 : 502).json({
          code: err.code,
          message: err.message,
        });
      }
      return res.status(503).json({
        code: 'mcp_unavailable',
        message: err instanceof Error ? err.message : 'Could not start a tool session.',
      });
    }

    const stream = new SseStream(res);
    const controller = new AbortController();
    req.on('close', () => {
      controller.abort();
      stream.close();
    });

    try {
      await runTurn({
        cfg,
        mcp: userMcp,
        llm,
        history: body.messages,
        context: { ...body.context, product },
        user,
        emit: (event) => stream.send(event),
        signal: controller.signal,
        // Only offer a refresh when there is an identity provider that could actually mint a new
        // token. Without one, the retry replaces the MCP's own actionable message ("run
        // npm run auth:google") with a confusing one about refresh being unavailable.
        onAuthFailure: tokenProvider
          ? () => pool.refreshIdentity(user.id, userJwt)
          : undefined,
      });
    } catch (err) {
      stream.send({
        type: 'error',
        code: err instanceof OpenAiError ? err.code : 'internal_error',
        message: friendlyError(err),
      });
      stream.send({ type: 'done', reason: 'aborted' });
    } finally {
      pool.release(user.id);
      stream.close();
    }
  });

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[orchestrator] listening on http://${cfg.host}:${cfg.port}`);
    if (cfg.devNoAuth) {
      console.warn('[orchestrator] WARNING: auth is disabled (ORCHESTRATOR_DEV_NO_AUTH=true).');
    }
  });

  const shutdown = async (): Promise<void> => {
    console.log('[orchestrator] shutting down...');
    server.close();
    await pool.shutdown();
    await probe.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function extractBearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function sendAuthError(res: express.Response, err: unknown): void {
  const code = err instanceof AuthError ? err.code : 'unauthorized';
  const status = code === 'misconfigured' ? 500 : 401;
  res.status(status).json({
    code,
    message: err instanceof Error ? err.message : 'Authentication failed',
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof OpenAiError) {
    if (err.code === 'model_not_found') {
      return `The configured model "${cfg.openai.model}" was rejected by OpenAI. Run "npm run models" to list the ids your key can use, then set OPENAI_MODEL.`;
    }
    if (err.status === 429) {
      return 'OpenAI rate limit reached. Please retry in a moment.';
    }
    return `The model provider returned an error (${err.status}).`;
  }
  return err instanceof Error ? err.message : 'Unexpected error';
}

main().catch((err) => {
  console.error('[orchestrator] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
