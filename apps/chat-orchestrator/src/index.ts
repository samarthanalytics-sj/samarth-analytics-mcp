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
import { AuditRecorder } from './audit.js';
import { UsageMeter, quotaMessage } from './usage.js';
import { planFix, FIXABLE_CATEGORIES, type AuditFinding } from './audit-fix.js';
import { SseStream } from './sse.js';
import { scopeTools } from './tools.js';
import { checkAllowlistAgainstServer } from './integrations.js';
import { extractAll, type ExtractedAttachment } from './attachments.js';
import { MemoryStore } from './memory.js';
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

/**
 * Failures that describe the REQUEST rather than an upstream fault, so they answer 400.
 *
 * The distinction matters to a client: a 502 invites a retry, and retrying a fix that was refused
 * because it needs a typed confirmation will fail identically every time.
 */
const REQUEST_FAULT_CODES = new Set([
  'not_fixable',
  'confirmation_required',
  'deletes_disabled',
  'bad_result',
]);

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
  // Scoped with the SAME options the turn loop uses. Omitting includeDeletes here printed 82 GTM
  // tools on a server that hands the model 94, under a banner that said "deletes ENABLED": the
  // operator surface and the real one disagreeing about what a write-enabled server can reach.
  const bannerScope = (product: Product): number =>
    scopeTools(all, {
      product,
      includeWrites: cfg.enableWriteTools,
      includeDeletes: cfg.enableDeleteTools,
    }).length;
  console.log(
    `[orchestrator] visible to model: GTM ${bannerScope('gtm')}, ` +
      `GA4 ${bannerScope('ga4')}` +
      (cfg.enableWriteTools
        ? cfg.enableDeleteTools
          ? ' (writes ENABLED, deletes ENABLED)'
          : ' (writes ENABLED)'
        : ' (read-only)'),
  );

  // A cross-platform allowlist entry that matches no registered tool withholds that write silently
  // while the prompt still describes the workflow. Surfaced at boot, where it is cheap to notice.
  const missingAllowlisted = checkAllowlistAgainstServer(all.map((t) => t.name));
  if (missingAllowlisted.length > 0) {
    console.warn(
      `[orchestrator] WARNING: ${missingAllowlisted.length} cross-platform allowlist entr(ies) match no registered tool ` +
        `and will never be offered: ${missingAllowlisted.join(', ')}. Check integrations.ts against the server's tool names.`,
    );
  }

  const audit = new AuditRecorder(cfg.supabase.url ?? '', cfg.supabase.serviceRoleKey ?? '');
  if (audit.isEnabled()) {
    console.log('[orchestrator] audit trail ON (chat_conversations, chat_messages, chat_tool_events)');
  } else {
    // Stated at boot rather than discovered later. A write surface with no record of what it did is
    // a deliberate choice, and it should be a visible one.
    console.warn(
      '[orchestrator] WARNING: audit trail OFF. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to ' +
        'record what the assistant changes. Writes will leave no durable trace.',
    );
  }

  const memory = new MemoryStore(cfg.supabase.url ?? '', cfg.supabase.serviceRoleKey ?? '');
  console.log(
    memory.isEnabled()
      ? '[orchestrator] chat memory ON (chat_memories: durable preferences applied to future turns)'
      : '[orchestrator] chat memory OFF: preferences will not survive a conversation.',
  );

  const usage = new UsageMeter(cfg.supabase.url ?? '', cfg.supabase.serviceRoleKey ?? '');
  console.log(
    usage.isEnabled()
      ? '[orchestrator] usage metering ON (user_plans.current_usage_chat / current_usage_tokens)'
      : '[orchestrator] usage metering OFF: turns are not counted against any plan.',
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

  // 28mb, not 256kb: attachments arrive base64 in the body, and base64 inflates by a third. The
  // real ceilings are enforced in attachments.ts (15 MB per file, 20 MB per message, 5 files) so
  // this only has to be comfortably above them rather than be the limit itself.
  app.use(express.json({ limit: '28mb' }));
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
      // Surfaced so a trail that stopped recording is visible to a monitor rather than discovered
      // the day somebody needs it.
      audit: audit.stats(),
      usage: usage.stats(),
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

  /**
   * The caller's recent conversations.
   *
   * Everything needed to resume is here: the product and the container/property the conversation
   * was held about. Resuming into a different container than the one the answers describe would
   * make the transcript quietly wrong, so the client restores the selection too.
   */
  app.get('/v1/conversations', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!audit.isEnabled()) {
      // Distinguished from "you have none": the feature is off, and saying so stops a user
      // concluding their history was lost.
      return res.status(503).json({
        error: 'history_unavailable',
        message: 'Conversation history is not configured on this deployment.',
      });
    }
    try {
      res.json({ conversations: await audit.listConversations(user.id) });
    } catch (err) {
      console.error('[conversations] list failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'history_failed', message: 'Could not load your conversations.' });
    }
  });

  /** One conversation, for replay into the transcript. */
  app.get('/v1/conversations/:id', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!audit.isEnabled()) {
      return res.status(503).json({
        error: 'history_unavailable',
        message: 'Conversation history is not configured on this deployment.',
      });
    }
    try {
      const conversation = await audit.getConversation(user.id, req.params.id);
      // Missing and not-yours answer identically; see getConversation.
      if (!conversation) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
      res.json({ conversation });
    } catch (err) {
      console.error('[conversations] get failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'history_failed', message: 'Could not load that conversation.' });
    }
  });

  /**
   * What the assistant remembers about this user.
   *
   * Exposed so it is inspectable and removable. A system that stores standing instructions about
   * someone, and shapes its behaviour by them, must let that person see and correct the list.
   */
  app.get('/v1/memories', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!memory.isEnabled()) return res.json({ memories: [], enabled: false });
    try {
      res.json({ memories: await memory.list(user.id), enabled: true });
    } catch (err) {
      console.error('[memories] list failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'memory_failed', message: 'Could not load what is remembered.' });
    }
  });

  app.delete('/v1/memories/:id', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    const removed = await memory.forget(user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'No such memory.' });
    res.json({ ok: true });
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
    fn: (mcp: McpConnection, user: AuthedUser) => Promise<unknown>,
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
      res.json(await fn(mcp, user));
    } catch (err) {
      const code = err instanceof ResourceError ? err.code : 'resource_failed';
      console.error(`[resources] ${req.path} failed for user ${userRef(user.id)}: ${forLog(String(err))}`);
      // Not everything reaching here is an upstream fault. A refused fix and a missing typed
      // confirmation are answers about the request, and returning 502 for them would tell the
      // client to retry something that will never succeed until they change it.
      const status = REQUEST_FAULT_CODES.has(code) ? 400 : code === 'read_only' ? 409 : 502;
      res.status(status).json({
        code,
        message: err instanceof Error ? err.message : 'Could not complete that request.',
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

  /**
   * Runs the container audit and returns its findings verbatim.
   *
   * Read-only: audit_container never modifies anything, so this needs no write flag and no gate.
   */
  app.post('/v1/audit/gtm', (req, res) => {
    const ws = {
      accountId: idParam(req.body?.accountId),
      containerId: idParam(req.body?.containerId),
      workspaceId: idParam(req.body?.workspaceId),
    };
    void withUserMcp(
      req,
      res,
      async (mcp) => {
        const { ok, text } = await mcp.callTool('audit_container', {
          accountId: ws.accountId,
          containerId: ws.containerId,
          workspaceId: ws.workspaceId,
          includeInfo: req.body?.includeInfo === true,
        });
        if (!ok) throw new ResourceError(text, 'tool_failed');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new ResourceError('The audit returned a result that was not JSON.', 'bad_result');
        }
        // Which findings have an automatic fix is decided here, not in the browser, so the button
        // the user sees and the action the server will accept can never disagree.
        return { ...body, fixableCategories: FIXABLE_CATEGORIES };
      },
      () =>
        ws.accountId && ws.containerId && ws.workspaceId
          ? null
          : 'A valid accountId, containerId and workspaceId are required.',
    );
  });

  /**
   * Applies the fix for one finding.
   *
   * The plan is recomputed here from the finding rather than trusting a tool name and arguments
   * sent by the browser. Accepting those would turn this into an open write endpoint: anyone could
   * post any tool with any arguments and have it executed under their Google identity.
   */
  app.post('/v1/audit/fix', (req, res) => {
    const ws = {
      accountId: idParam(req.body?.accountId) ?? '',
      containerId: idParam(req.body?.containerId) ?? '',
      workspaceId: idParam(req.body?.workspaceId) ?? '',
    };
    const finding = req.body?.finding as AuditFinding | undefined;

    void withUserMcp(
      req,
      res,
      async (mcp, user) => {
        if (!cfg.enableWriteTools) {
          throw new ResourceError('This deployment is read-only.', 'read_only');
        }
        const plan = planFix(finding!, ws);
        if (!plan.fixable) throw new ResourceError(plan.reason, 'not_fixable');

        if (plan.destructive) {
          if (!cfg.enableDeleteTools) {
            throw new ResourceError('Deletes are not enabled on this deployment.', 'deletes_disabled');
          }
          // Same gate as the chat: a removal takes the typed word, checked on the server because a
          // client-side check is a suggestion.
          if (String(req.body?.confirm ?? '').trim() !== plan.confirmWord) {
            throw new ResourceError(
              `This fix removes something. Send confirm: "${plan.confirmWord}" to proceed.`,
              'confirmation_required',
            );
          }
        }

        const startedAt = Date.now();
        const { ok, text } = await mcp.callTool(plan.tool, { ...plan.args, confirm: true });

        // A fix changes somebody's container exactly as a chat write does, so it leaves the same
        // record. Without this, the one write path that bypasses the chat would also bypass the
        // audit trail, and "who changed this tag" would have a blind spot shaped like this button.
        const conversationId = await audit.beginConversation(
          user.id,
          { product: 'gtm', ...ws },
          `Container audit fix: ${plan.label}`,
        );
        audit.recordToolEvent(conversationId, user.id, {
          ...ws,
          toolName: plan.tool,
          product: 'gtm',
          surface: 'gtm_draft',
          isWrite: true,
          isDelete: plan.destructive,
          // The click IS the approval, and a destructive one also required the typed word above.
          approval: 'approved',
          args: plan.args,
          ok,
          resultSummary: text,
          durationMs: Date.now() - startedAt,
        });

        if (!ok) throw new ResourceError(text, 'fix_failed');
        return { applied: true, tool: plan.tool, label: plan.label, result: forLog(text, 400) };
      },
      () => {
        if (!ws.accountId || !ws.containerId || !ws.workspaceId) {
          return 'A valid accountId, containerId and workspaceId are required.';
        }
        if (!finding || typeof finding.category !== 'string') return 'A finding is required.';
        return null;
      },
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

    // Checked before the MCP child is spawned and before a token is spent. A quota enforced after
    // the work is done is not a quota.
    const quota = await usage.check(user.id);
    if (quota && !quota.allowed) {
      console.log(`[usage] ${userRef(user.id)} is over their ${quota.reason} limit; turn refused`);
      return res.status(429).json({
        code: 'quota_exceeded',
        message: quotaMessage(quota),
        quota: {
          reason: quota.reason,
          usedChat: quota.usedChat,
          limitChat: quota.limitChat,
          usedTokens: quota.usedTokens,
          limitTokens: quota.limitTokens,
          planType: quota.planType,
        },
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

    // Opened before the stream so a failure here is a plain log line rather than a mid-stream error.
    // Returns null when auditing is off or unreachable, and the turn then records nothing.
    // Extracted before the stream opens, so a refusal ("that .doc is the old format") is a clean
    // 400 the composer can show against the file, rather than a message mid-answer.
    let extracted: ExtractedAttachment[] = [];
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      const { ok, rejected } = await extractAll(body.attachments);
      extracted = ok;
      if (ok.length === 0 && rejected.length > 0) {
        return res.status(400).json({
          error: 'attachments_unreadable',
          message: rejected.map((r) => r.reason).join(' '),
          rejected,
        });
      }
      // Some read, some did not: the turn proceeds, and the user is told which were left out
      // rather than being left to wonder why the model ignored one.
      if (rejected.length > 0) {
        console.warn(`[chat] ${rejected.length} attachment(s) rejected:`, rejected.map((r) => r.name).join(', '));
      }
    }

    const lastUserMessage = body.messages[body.messages.length - 1]?.content ?? '';
    const conversationId = await audit.beginConversation(
      user.id,
      { ...body.context, product },
      lastUserMessage,
      typeof body.conversationId === 'string' ? body.conversationId : undefined,
    );
    audit.recordUserMessage(conversationId, user.id, lastUserMessage);

    const stream = new SseStream(res);
    const controller = new AbortController();
    req.on('close', () => {
      controller.abort();
      // A parked write whose user has navigated away must not sit waiting for a decision that can
      // no longer arrive.
      approvals?.abortFor(user.id);
      stream.close();
    });

    if (conversationId) stream.send({ type: 'conversation', conversationId });

    try {
      await runTurn({
        cfg,
        mcp: userMcp,
        llm,
        history: body.messages,
        context: { ...body.context, product },
        user,
        attachments: extracted,
        emit: (event) => stream.send(event),
        signal: controller.signal,
        // Only offer a refresh when there is an identity provider that could actually mint a new
        // token. Without one, the retry replaces the MCP's own actionable message ("run
        // npm run auth:google") with a confusing one about refresh being unavailable.
        onAuthFailure: tokenProvider
          ? () => pool.refreshIdentity(user.id, userJwt)
          : undefined,
        approvals: approvals ?? undefined,
        memory,
        audit,
        conversationId,
        usage,
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
