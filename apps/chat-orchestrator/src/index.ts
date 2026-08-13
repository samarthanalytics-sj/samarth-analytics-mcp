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
import { forLog, userRef, userTag } from './redact.js';
import { ApprovalBroker, ApprovalError } from './approvals.js';
import { isBillingFailure, OpenAiClient, OpenAiError } from './openai.js';
import { runTurn } from './loop.js';
import { AuditRecorder } from './audit.js';
import { UsageMeter, quotaMessage } from './usage.js';
import { planFix, FIXABLE_CATEGORIES, type AuditFinding } from './audit-fix.js';
import { SseStream } from './sse.js';
import { deadline, DeadlineError } from './deadline.js';
import { installTimestampedLogging } from './log-time.js';
import { scopeTools } from './tools.js';
import { checkAllowlistAgainstServer } from './integrations.js';
import { extractAll, type ExtractedAttachment } from './attachments.js';
import { MemoryStore } from './memory.js';
import { isSuperAdmin, tailLog, MAX_LINES } from './logs.js';
import { SiteScanner, ScanError, validPlatforms, MAX_SCAN_PAGES } from './scan-client.js';
import {
  ScanStore,
  toRows,
  selectRows,
  withMeasurementId,
  createSelected,
  imageForRow,
  splitCreatable,
} from './suggestions.js';
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

/* ───────────────────── Conversation titles and groups ─────────────────────── */

/** A renamed thread still has to fit the rail without becoming the rail. */
const MAX_CONVERSATION_TITLE = 200;
/** Matches the chat_conversation_groups name CHECK, so a refusal costs no round trip. */
const MAX_GROUP_NAME = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The (product, scopeId) pair a group belongs to, from a query string or a JSON body.
 *
 * Ids are shape-checked for the same reason the conversation list checks them: a malformed value
 * should be a clear 400, not a confusing PostgREST error. Returns null when the pair is incomplete,
 * because a group with no container is not a thing this design allows.
 */
function groupScopeFrom(source: unknown): { product: 'gtm' | 'ga4'; scopeId: string } | null {
  const q = (source ?? {}) as Record<string, unknown>;
  const id = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[0-9]{1,20}$/.test(v.trim()) ? v.trim() : undefined;

  if (q.product === 'ga4') {
    const propertyId = id(q.propertyId);
    return propertyId ? { product: 'ga4', scopeId: propertyId } : null;
  }
  if (q.product === 'gtm') {
    const containerId = id(q.containerId);
    return containerId ? { product: 'gtm', scopeId: containerId } : null;
  }
  return null;
}

/** True when Postgres refused a filing because the group belongs to another container. */
function isGroupMismatch(detail: string): boolean {
  return /this group belongs to|cannot put a|another user's group|group .* does not exist/i.test(detail);
}

/**
 * The human sentence out of a PostgREST error body.
 *
 * The trigger's RAISE text is written for the person reading it, and it arrives wrapped in JSON
 * with a hint and a code. Passing the raw body through would show them all of that.
 */
function pgMessage(detail: string): string {
  const match = detail.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const raw = match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : detail;
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

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
  // First, so every line below is dated. See log-time.ts for why the log needed this.
  installTimestampedLogging();

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
  // The scanner starts no child until a scan is asked for, so a deployment without a browser costs
  // nothing here and fails only on the page that needs it.
  const scanner = new SiteScanner(cfg);
  const scanStore = new ScanStore();
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
      // PATCH and DELETE are here for the conversation rail's pin, archive and remove. Both are
      // preflighted, so leaving them out fails in the browser rather than at the route.
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
      // Scope comes from the query string so the sidebar asks for the container it is showing.
      // Ids are shape-checked before reaching a filter, not because PostgREST would be injected
      // but because a malformed value should be an empty list, not a confusing 400.
      const idOf = (v: unknown): string | undefined =>
        typeof v === 'string' && /^[0-9]{1,20}$/.test(v.trim()) ? v.trim() : undefined;
      const scope = {
        containerId: idOf(req.query.containerId),
        propertyId: idOf(req.query.propertyId),
        archived: req.query.archived === 'true',
      };
      res.json({ conversations: await audit.listConversations(user.id, 30, scope) });
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
   * Pin or archive one conversation.
   *
   * Both are the user's own filing, so neither needs an approval step. Ownership is not checked
   * here and then trusted: it is part of the update's own filter, so a request naming somebody
   * else's conversation matches nothing and is answered as not found.
   */
  app.patch('/v1/conversations/:id', async (req, res) => {
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

    const body = (req.body ?? {}) as {
      pinned?: unknown;
      archived?: unknown;
      title?: unknown;
      groupId?: unknown;
    };
    const state: { pinned?: boolean; archived?: boolean; title?: string; groupId?: string | null } = {};
    if (typeof body.pinned === 'boolean') state.pinned = body.pinned;
    if (typeof body.archived === 'boolean') state.archived = body.archived;

    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > MAX_CONVERSATION_TITLE) {
        return res.status(400).json({
          error: 'bad_request',
          message: `A title must be between 1 and ${MAX_CONVERSATION_TITLE} characters.`,
        });
      }
      state.title = title;
    }

    // null is "take it out of its group", which is a different request from not mentioning the
    // group at all — hence undefined and null are distinguished rather than both read as falsy.
    if (body.groupId !== undefined) {
      if (body.groupId === null) {
        state.groupId = null;
      } else if (typeof body.groupId === 'string' && UUID_RE.test(body.groupId.trim())) {
        state.groupId = body.groupId.trim();
      } else {
        return res
          .status(400)
          .json({ error: 'bad_request', message: 'groupId must be a group id, or null to ungroup.' });
      }
    }

    if (Object.keys(state).length === 0) {
      return res
        .status(400)
        .json({ error: 'bad_request', message: 'Send pinned, archived, title, or groupId.' });
    }

    try {
      const conversation = await audit.setConversationState(user.id, req.params.id, state);
      if (!conversation) {
        return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
      }
      res.json({ conversation });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[conversations] update failed:', forLog(detail));
      // The group-matching trigger fires when a thread is filed under a group belonging to a
      // different container, and its message already says precisely what is wrong. That is the
      // caller's mistake rather than a server fault, so it goes back as a 409 with the reason
      // instead of being flattened into "could not update".
      if (isGroupMismatch(detail)) {
        return res.status(409).json({ error: 'group_mismatch', message: pgMessage(detail) });
      }
      res.status(502).json({ error: 'history_failed', message: 'Could not update that conversation.' });
    }
  });

  /**
   * The caller's groups for one container or property.
   *
   * Scope is required rather than optional. A group is bound to one container, so an unscoped list
   * would mix folders from every container the user has ever opened and offer them as targets the
   * database would then refuse.
   */
  app.get('/v1/conversation-groups', async (req, res) => {
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

    const scope = groupScopeFrom(req.query);
    if (!scope) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Send product=gtm with containerId, or product=ga4 with propertyId.',
      });
    }

    try {
      res.json({ groups: await audit.listGroups(user.id, scope) });
    } catch (err) {
      console.error('[groups] list failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'groups_failed', message: 'Could not load your groups.' });
    }
  });

  /** Create a group, or return the one that already has that name in this container. */
  app.post('/v1/conversation-groups', async (req, res) => {
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

    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_GROUP_NAME) {
      return res.status(400).json({
        error: 'bad_request',
        message: `A group name must be between 1 and ${MAX_GROUP_NAME} characters.`,
      });
    }
    const scope = groupScopeFrom(req.body ?? {});
    if (!scope) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Send product=gtm with containerId, or product=ga4 with propertyId.',
      });
    }

    try {
      const group = await audit.createGroup(user.id, { name, ...scope });
      if (!group) {
        return res.status(502).json({ error: 'groups_failed', message: 'Could not create that group.' });
      }
      res.status(201).json({ group });
    } catch (err) {
      console.error('[groups] create failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'groups_failed', message: 'Could not create that group.' });
    }
  });

  /** Rename a group. */
  app.patch('/v1/conversation-groups/:id', async (req, res) => {
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

    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_GROUP_NAME) {
      return res.status(400).json({
        error: 'bad_request',
        message: `A group name must be between 1 and ${MAX_GROUP_NAME} characters.`,
      });
    }

    try {
      const group = await audit.renameGroup(user.id, req.params.id, name);
      if (!group) return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
      res.json({ group });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[groups] rename failed:', forLog(detail));
      if (/23505|duplicate key/i.test(detail)) {
        return res.status(409).json({
          error: 'name_taken',
          message: 'A group with that name already exists for this container.',
        });
      }
      res.status(502).json({ error: 'groups_failed', message: 'Could not rename that group.' });
    }
  });

  /** Remove a group. The conversations in it survive, ungrouped. */
  app.delete('/v1/conversation-groups/:id', async (req, res) => {
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
      const removed = await audit.deleteGroup(user.id, req.params.id);
      if (!removed) return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[groups] delete failed:', forLog(err instanceof Error ? err.message : String(err)));
      res.status(502).json({ error: 'groups_failed', message: 'Could not remove that group.' });
    }
  });

  /**
   * Remove a conversation from the user's history.
   *
   * Soft on purpose. chat_tool_events cascades from chat_conversations and holds what the assistant
   * actually changed in a live container; a hard delete would let the subject of the audit erase
   * the record of their own writes. The user's history loses it either way.
   */
  app.delete('/v1/conversations/:id', async (req, res) => {
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
      const removed = await audit.deleteConversation(user.id, req.params.id);
      if (!removed) {
        return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(
        '[conversations] delete failed:',
        forLog(err instanceof Error ? err.message : String(err)),
      );
      res.status(502).json({ error: 'history_failed', message: 'Could not delete that conversation.' });
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
      mcp = await deadline(
        pool.acquire(user.id, userJwt),
        cfg.limits.resourceDeadlineMs,
        'Starting a tool session took too long.',
      );
    } catch (err) {
      if (err instanceof DeadlineError) {
        console.error(`[resources] ${req.path} timed out starting a session for ${userRef(user.id)}`);
        res.status(504).json({ code: 'timed_out', message: err.message });
        return;
      }
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
      res.json(
        await deadline(
          Promise.resolve(fn(mcp, user)),
          cfg.limits.resourceDeadlineMs,
          'That lookup took too long and was stopped.',
        ),
      );
    } catch (err) {
      if (err instanceof DeadlineError) {
        console.error(`[resources] ${req.path} exceeded the deadline for user ${userRef(user.id)}`);
        res.status(504).json({ code: 'timed_out', message: err.message });
        return;
      }
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

  /**
   * Scan a site and return the tags worth creating.
   *
   * No MCP child of the user's is involved: the scan reads public pages and touches nothing in their
   * account, so it authenticates the caller and then uses the shared, credential-free scanner.
   */
  app.post('/v1/suggestions/scan', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    // A crawl is far more expensive than a picker refresh, so it gets the turn budget, not the
    // looser lookup one.
    if (!limiter.allow(`scan:${user.id}`, cfg.limits.turnsPerMinutePerUser)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ code: 'rate_limited', message: 'Too many scans. Try again shortly.' });
    }
    const url = String(req.body?.url ?? '').trim();
    if (!url) return res.status(400).json({ code: 'bad_request', message: 'A site URL is required.' });

    const startedAt = Date.now();
    try {
      const platforms = validPlatforms(req.body?.platforms);
      const result = await scanner.scan(url, {
        maxPages: Number(req.body?.maxPages) || undefined,
        maxDepth: Number(req.body?.maxDepth) || undefined,
        ...(platforms.length ? { platforms } : {}),
        // This caller can display an image, which is the whole condition for asking for one.
        captureImages: req.body?.captureImages !== false,
        ...(req.body?.skipBlog === true ? { skipBlog: true } : {}),
      });
      const scan = scanStore.put(user.id, result);
      // The whole shape of the scan on one line: who ran it, what was asked for, what was read, and
      // what came back. "13 suggestions" alone cannot tell a thin site from a crawl that only got
      // one page in, and those need completely different answers.
      const pages = (result.pages ?? []).map((p) => p.page);
      console.log(
        `[scan] OK user=${userTag(user)} url=${forLog(url, 120)} ` +
          `platforms=${platforms.length ? platforms.join('+') : 'ga4'} ` +
          `budget=${Number(req.body?.maxPages) || 'default'} scanned=${pages.length} ` +
          `skipped=${result.notScanned?.length ?? 0} excluded=${result.excluded ?? 0} ` +
          `suggestions=${scan.suggestions.length} images=${scan.images.size} ` +
          `in ${Date.now() - startedAt}ms`,
      );
      if (pages.length) console.log(`[scan] pages read: ${forLog(pages.join(' '), 600)}`);
      // Named individually: a page that was found and not read is the usual reason a tag someone
      // expected is missing, and the reason differs per page.
      for (const miss of (result.notScanned ?? []).slice(0, 20)) {
        console.log(`[scan] not read: ${forLog(miss.url, 120)} - ${forLog(miss.reason, 80)}`);
      }
      res.json({
        scanId: scan.id,
        site: scan.site,
        suggestions: toRows(scan.suggestions, scan.images),
        warnings: scan.warnings,
        ...(result.scanned !== undefined ? { scanned: result.scanned } : {}),
        // What the crawl actually read, and what it did not. "10 pages" alone is not checkable by
        // the person reading it: a budget of 10 that found 4 and a budget of 10 that skipped 6 look
        // identical, and only one of them means the scan missed something.
        ...(result.pages ? { pages: result.pages } : {}),
        ...(result.notScanned?.length ? { notScanned: result.notScanned } : {}),
        ...(result.excluded ? { excluded: result.excluded } : {}),
        maxPages: MAX_SCAN_PAGES,
      });
    } catch (err) {
      const code = err instanceof ScanError ? err.code : 'scan_failed';
      const message = err instanceof Error ? err.message : 'The scan failed.';
      console.error(
        `[scan] FAILED user=${userTag(user)} url=${forLog(url, 120)} ` +
          `after ${Date.now() - startedAt}ms code=${code}: ${forLog(message)}`,
      );
      // 502 rather than 500: the failure is in the thing being scanned or in the scanner, and the
      // page shows this sentence to the user, so it has to be the sentence they can act on.
      res.status(502).json({ code, message });
    }
  });

  /**
   * The orchestrator's own log, for an operator looking at it from the website.
   *
   * Gated on an allowlist in THIS process's environment, not on a role in the database. The log is
   * cross-tenant: it holds every user's request paths, tool names and write payloads. A compromised
   * admin row must not be able to open a window onto other customers' activity, and an unconfigured
   * deployment must expose nothing at all, which is why an empty allowlist means nobody.
   */
  app.get('/v1/logs', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!(await isSuperAdmin(user.id, cfg.supabase))) {
      // 404, not 403: that this endpoint exists is not worth confirming to someone who may not read
      // it. An admin of the product is not enough; only a super admin is.
      return res.status(404).json({ code: 'not_found', message: 'No such endpoint.' });
    }
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const tail = tailLog({
      lines: Number(req.query.lines) || undefined,
      filter: typeof req.query.filter === 'string' ? req.query.filter : undefined,
      // An unrecognised category is ignored rather than honoured as a filter that matches nothing,
      // which would show an empty log and read as a quiet system.
      ...(['chat', 'suggestions', 'writes', 'system'].includes(category) ? { category: category as never } : {}),
      ...(req.query.problems === 'true' ? { problemsOnly: true } : {}),
    });
    if (!tail) {
      return res.status(503).json({
        code: 'no_log',
        message: 'No log file was found. The orchestrator writes one only when started by its supervisor.',
      });
    }
    // Named in the log itself: reading everyone's activity is an act worth leaving a trace of.
    console.log(`[logs] super admin ${user.id.slice(0, 8)} read ${tail.lines.length} line(s)`);
    res.json({ ...tail, maxLines: MAX_LINES });
  });

  /**
   * One row's page screenshot, as an image.
   *
   * A GET so the browser can hand it to an <img>, but still authenticated, so the fetch is done with
   * a header and turned into a blob URL on the page. Serving these unauthenticated would publish a
   * crawl of a customer's site to anyone holding a scan id.
   */
  app.get('/v1/suggestions/:scanId/image/:rowId', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    const scan = scanStore.get(user.id, req.params.scanId);
    if (!scan) {
      return res.status(404).json({ code: 'scan_expired', message: 'That scan is no longer available.' });
    }
    const image = imageForRow(scan, req.params.rowId);
    if (!image) {
      return res.status(404).json({ code: 'no_image', message: 'No screenshot was captured for that page.' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    // Private: this is a picture of someone's site, fetched under their session.
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(image);
  });

  /**
   * Create the ticked suggestions as draft tags.
   *
   * The request carries a scan id and row ids, never a tool name or arguments. The payload is
   * rebuilt from this process's own copy of the scan, so this endpoint can only ever create tags
   * that a scan actually produced for this user.
   */
  app.post('/v1/suggestions/create', (req, res) => {
    const ws = {
      accountId: idParam(req.body?.accountId) ?? '',
      containerId: idParam(req.body?.containerId) ?? '',
      workspaceId: idParam(req.body?.workspaceId) ?? '',
    };
    const scanId = String(req.body?.scanId ?? '');
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];

    void withUserMcp(
      req,
      res,
      async (mcp, user) => {
        if (!cfg.enableWriteTools) {
          throw new ResourceError('This deployment is read-only, so tags cannot be created.', 'read_only');
        }
        const scan = scanStore.get(user.id, scanId);
        if (!scan) {
          throw new ResourceError(
            'That scan has expired. Run the scan again and reselect the tags you want.',
            'scan_expired',
          );
        }
        const { selected, unknown } = selectRows(scan, ids);
        if (unknown.length > 0) {
          throw new ResourceError(
            `That scan has no suggestion with id ${unknown.join(', ')}. Run the scan again.`,
            'unknown_suggestion',
          );
        }
        if (selected.length === 0) throw new ResourceError('Select at least one tag to create.', 'nothing_selected');

        // Refused here, before a single write, rather than per row afterwards. The MCP's create tool
        // builds GA4 and Custom HTML tags only, and a Meta row sent to it used to come back "Created"
        // as a GA4 tag carrying a Meta pixel id.
        const { supported, unsupported } = splitCreatable(selected);
        if (supported.length === 0) {
          throw new ResourceError(
            unsupported[0]?.reason ?? 'None of the selected rows can be created here.',
            'unsupported_platform',
          );
        }
        const tags = withMeasurementId(supported, String(req.body?.measurementId ?? ''));
        const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
          const { ok, text } = await mcp.callTool(name, args);
          // Thrown, not returned: createSuggestedTags reads failures off the exception, and that is
          // where its duplicate-name and quota-backoff handling lives.
          if (!ok) throw new Error(text);
          return text;
        };

        const createStartedAt = Date.now();
        const result = await createSelected(execute, ws, tags);

        console.log(
          `[suggestions] INJECT user=${userTag(user)} site=${forLog(scan.site, 120)} ` +
            `container=${ws.containerId} workspace=${ws.workspaceId} ` +
            `selected=${tags.length} created=${result.created} existing=${result.existing} ` +
            `failed=${result.failed} unsupported=${unsupported.length} ` +
            `in ${Date.now() - createStartedAt}ms`,
        );

        // Every tag by name, with what happened to it. A count says three of five worked; only this
        // says WHICH two did not and why, which is the question asked five minutes later.
        for (const o of result.outcomes) {
          const row = tags.find((t) => t.id === o.id);
          const name = forLog(String(row?.tagName ?? o.id), 120);
          if (o.ok) {
            console.log(
              `[suggestions] created "${name}"` +
                (o.tagId ? ` id=${o.tagId}` : '') +
                ` trigger=${o.triggerReused ? 'reused' : 'created'}`,
            );
          } else if (o.existing) {
            console.log(`[suggestions] skipped "${name}": a tag with this name already exists`);
          } else {
            console.error(`[suggestions] FAILED "${name}": ${forLog(String(o.error ?? 'unknown error'))}`);
          }
        }
        for (const l of result.listeners) {
          if (l.ok) console.log(`[suggestions] listener created "${forLog(l.tagName, 120)}"`);
          else if (l.existing) console.log(`[suggestions] listener already present "${forLog(l.tagName, 120)}"`);
          else console.error(`[suggestions] listener FAILED "${forLog(l.tagName, 120)}": ${forLog(String(l.error))}`);
        }
        for (const u of unsupported) {
          console.log(`[suggestions] not creatable here: ${u.id} (${u.platform})`);
        }
        return { ...result, site: scan.site, ...(unsupported.length ? { unsupported } : {}) };
      },
      () => {
        if (!ws.accountId || !ws.containerId || !ws.workspaceId) {
          return 'A valid accountId, containerId and workspaceId are required.';
        }
        if (!scanId) return 'A scanId is required.';
        if (ids.length === 0) return 'Select at least one tag to create.';
        return null;
      },
    );
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

    /**
     * The group this thread is filed under, read from the row rather than taken from the request.
     *
     * Group memory is shared, so a client that could name its own group could name someone else's
     * and have its rules injected into this turn. The lookup is scoped by user_id, so an id that is
     * not theirs simply resolves to null. Best-effort: memory is an enhancement, and losing it is
     * better than failing the turn.
     */
    const groupId = conversationId
      ? await audit.getConversationGroupId(user.id, conversationId).catch((err) => {
          console.error('[chat] group lookup failed:', forLog(err instanceof Error ? err.message : String(err)));
          return null;
        })
      : null;

    // Who is asking, before the turn runs. A turn that hangs or crashes the process leaves no
    // "finished" line, and without this there is nothing in the file saying it was ever attempted.
    const turnStartedAt = Date.now();
    console.log(
      `[chat] turn START user=${userTag(user)} product=${product}` +
        (body.context?.containerId ? ` container=${body.context.containerId}` : '') +
        (body.context?.propertyId ? ` property=${body.context.propertyId}` : '') +
        ` messages=${body.messages?.length ?? 0}`,
    );

    try {
      await runTurn({
        cfg,
        mcp: userMcp,
        llm,
        history: body.messages,
        context: { ...body.context, product },
        groupId,
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
      console.log(
        `[chat] turn OK user=${userTag(user)} in ${Date.now() - turnStartedAt}ms`,
      );
    } catch (err) {
      // The reason, not just that it failed. friendlyError() is written for the person in the chat
      // window; the operator reading this needs the code and the upstream text behind it.
      const code = err instanceof OpenAiError ? err.code : 'internal_error';
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[chat] turn FAILED user=${userTag(user)} after ${Date.now() - turnStartedAt}ms ` +
          `code=${code}: ${forLog(detail)}`,
      );
      stream.send({
        type: 'error',
        code,
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
    // A 429 has two causes that need opposite responses from the reader, and "retry in a moment"
    // is only right for one of them.
    if (isBillingFailure(err.code)) {
      return 'The OpenAI account has no remaining credit, so this will not succeed on a retry. Add credits at platform.openai.com/settings/organization/billing, then send the message again.';
    }
    if (err.status === 429) {
      const ceiling = err.limitTokens
        ? ` This account is limited to ${err.limitTokens.toLocaleString()} tokens per minute, shared by every step of a turn.`
        : '';
      return (
        `OpenAI rate limit reached.${ceiling} Waiting a minute usually clears it; if the same ` +
        `request fails again straight away it is too large for that limit, so ask for less at once ` +
        `or raise the account's rate limit.`
      );
    }
    return `The model provider returned an error (${err.status}).`;
  }
  return err instanceof Error ? err.message : 'Unexpected error';
}

main().catch((err) => {
  console.error('[orchestrator] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
