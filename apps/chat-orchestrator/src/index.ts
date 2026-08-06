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
import { ApprovalBroker, ApprovalError } from './approvals.js';
import { OpenAiClient, OpenAiError } from './openai.js';
import { runTurn } from './loop.js';
import { SseStream } from './sse.js';
import { scopeTools } from './tools.js';
import {
  findGtmContainer,
  listGa4Properties,
  listGtmAccounts,
  listGtmContainers,
  listGtmWorkspaces,
  normalizeContainerQuery,
  ResourceError,
} from './resources.js';
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
      (cfg.enableWriteTools
        ? cfg.enableDeleteTools
          ? ' (writes ENABLED, deletes ENABLED)'
          : ' (writes ENABLED)'
        : ' (read-only)'),
  );

  const llm = new OpenAiClient(cfg);
  const limiter = new RateLimiter();
  // Only constructed when writes are enabled. Its absence is what makes a write impossible: the
  // turn loop refuses any write tool it cannot route through a broker.
  const approvals = cfg.enableWriteTools ? new ApprovalBroker() : null;
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
      deleteToolsVisible: cfg.enableDeleteTools,
      // What actually stops for the user. The UI states a safety property, so it has to read this
      // rather than assume: claiming every change is reviewed when most now apply directly would be
      // worse than saying nothing.
      approvals: {
        draftWritesApplyDirectly: true,
        liveWritesRequireApproval: cfg.approveLiveWrites,
        deletesRequireTypedConfirmation: true,
      },
      authRequired: !cfg.devNoAuth,
      googleIdentityMode: cfg.googleIdentity.mode,
      mcpSessions: sessions,
      mcpSessionsBusy: busy,
      pendingApprovals: approvals?.stats().pending ?? 0,
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

  /**
   * Records a decision on a parked write. The turn is blocked on this call.
   *
   * The body may carry corrected arguments, because an approval card that cannot be edited is just
   * a confirmation dialog, and people click through those.
   */
  app.post('/v1/approvals/:id', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!approvals) {
      return res.status(409).json({ code: 'read_only', message: 'This deployment is read-only.' });
    }

    const decision = req.body?.decision === 'approve' ? 'approve' : 'decline';
    const args =
      req.body?.arguments && typeof req.body.arguments === 'object'
        ? (req.body.arguments as Record<string, unknown>)
        : undefined;

    const typed = typeof req.body?.confirm === 'string' ? req.body.confirm : undefined;

    try {
      approvals.resolve(req.params.id, user.id, decision, args, typed);
      res.json({ ok: true, decision });
    } catch (err) {
      const code = err instanceof ApprovalError ? err.code : 'unknown_approval';
      // A missing typed confirmation is a 400 the user can correct; everything else is reported as
      // not-found so an approval id cannot be probed for.
      const status = code === 'confirmation_required' ? 400 : 404;
      res.status(status).json({
        code: code === 'not_yours' ? 'unknown_approval' : code,
        message: err instanceof Error ? err.message : 'Unknown approval',
      });
    }
  });

  /**
   * Runs a read against this user's own MCP session and returns JSON.
   *
   * Shares the chat path's identity handling on purpose: a picker that could list containers the
   * chat cannot then read would be worse than no picker, and 428 (Google account not connected) has
   * to mean the same thing on both surfaces.
   */
  async function withUserMcp(
    req: express.Request,
    res: express.Response,
    fn: (mcp: McpConnection) => Promise<unknown>,
    validate?: () => string | null,
  ): Promise<void> {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }

    // Pickers refresh far more often than turns are sent, so they get their own, looser budget.
    if (!limiter.allow(`resources:${user.id}`, cfg.limits.turnsPerMinutePerUser * 4)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ code: 'rate_limited', message: 'Too many lookups. Try again shortly.' });
      return;
    }

    // Checked after authentication, so an anonymous caller cannot tell a malformed request from a
    // well-formed one, and before a child is spawned, so a bad id costs nothing.
    const invalid = validate?.();
    if (invalid) {
      res.status(400).json({ code: 'bad_request', message: invalid });
      return;
    }

    const userJwt = extractBearer(req.headers.authorization);

    let mcp: McpConnection;
    try {
      mcp = await pool.acquire(user.id, userJwt);
    } catch (err) {
      if (err instanceof GoogleIdentityError) {
        console.error(`[identity] ${err.code} for user ${userRef(user.id)}: ${forLog(err.message)}`);
        res.status(err.code === 'not_connected' ? 428 : 502).json({
          code: err.code,
          message: err.message,
        });
        return;
      }
      res.status(503).json({
        code: 'mcp_unavailable',
        message: err instanceof Error ? err.message : 'Could not start a tool session.',
      });
      return;
    }

    try {
      res.json(await fn(mcp));
    } catch (err) {
      const code = err instanceof ResourceError ? err.code : 'resource_failed';
      console.error(`[resources] ${req.path} failed for user ${userRef(user.id)}: ${forLog(String(err))}`);
      res.status(502).json({
        code,
        message: err instanceof Error ? err.message : 'Could not load that list.',
      });
    } finally {
      pool.release(user.id);
    }
  }

  /** GTM accounts this user can reach. First step of the container picker. */
  app.get('/v1/resources/gtm/accounts', (req, res) => {
    void withUserMcp(req, res, (mcp) => listGtmAccounts(mcp));
  });

  app.get('/v1/resources/gtm/containers', (req, res) => {
    void withUserMcp(
      req,
      res,
      (mcp) => listGtmContainers(mcp, idParam(req.query.accountId)!),
      () => (idParam(req.query.accountId) ? null : 'A valid accountId is required.'),
    );
  });

  app.get('/v1/resources/gtm/workspaces', (req, res) => {
    void withUserMcp(
      req,
      res,
      (mcp) => listGtmWorkspaces(mcp, idParam(req.query.accountId)!, idParam(req.query.containerId)!),
      () =>
        idParam(req.query.accountId) && idParam(req.query.containerId)
          ? null
          : 'A valid accountId and containerId are required.',
    );
  });

  /**
   * Resolves a pasted container id to the account that holds it.
   *
   * Someone who already knows their GTM-XXXXXXX should not have to work out which account it is
   * under before they can ask a question about it.
   */
  app.get('/v1/resources/gtm/container-lookup', (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q.slice(0, 300) : '';
    void withUserMcp(
      req,
      res,
      (mcp) => findGtmContainer(mcp, normalizeContainerQuery(raw)!),
      () =>
        normalizeContainerQuery(raw)
          ? null
          : 'Enter a container id like GTM-ABC1234, its numeric id, or a Tag Manager URL.',
    );
  });

  /** Every GA4 property across every account, in one call. */
  app.get('/v1/resources/ga4/properties', (req, res) => {
    void withUserMcp(req, res, (mcp) => listGa4Properties(mcp));
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
      // A parked write whose user has navigated away must not sit waiting for a decision that can
      // no longer arrive.
      approvals?.abortFor(user.id);
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
        approvals: approvals ?? undefined,
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

/**
 * Accepts a resource id from the query string, or nothing.
 *
 * GTM ids are numeric today, but the check stays deliberately permissive about character set and
 * strict about shape: the goal is to reject a value that is obviously not an id before it reaches
 * the Google API, not to encode an assumption about their format that a future id could break.
 */
function idParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
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
