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
import {
  EventRecorder,
  SlackNotifier,
  SupabaseEventSink,
  formatDuration,
  MAX_STORED_EVENTS,
} from './events.js';
import {
  HealthMonitor,
  SettingsPoller,
  installCrashHandlers,
  packageLogDir,
  readLastExit,
} from './lifecycle.js';
import { explainError, explainExit } from './explain.js';
import { SiteScanner, ScanError, validPlatforms, MAX_SCAN_PAGES, MAX_SELECTED_PAGES } from './scan-client.js';
import {
  ScanStore,
  toRows,
  selectRows,
  withMeasurementId,
  createSelected,
  imageForRow,
  splitCreatable,
  droppedConditions,
  planGa4Config,
  type RowEdit,
} from './suggestions.js';
import { fetchWorkspaceSnapshot } from './workspace-snapshot.js';
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
 * The lifecycle record. Module-level so the two functions outside main() that have something to
 * report (a rejected token, a failed start) can reach it; null until main() has built it.
 */
let recorder: EventRecorder | null = null;

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
  const bootStartedAt = Date.now();

  // The lifecycle record, built before anything that can fail so a failed start is itself recorded.
  // Settings are read once here, before the first event, so the startup message honours the
  // switches rather than posting under the defaults and then learning better a minute later.
  const slack = new SlackNotifier(cfg.events.slackWebhookUrl);
  const eventSink = new SupabaseEventSink(cfg.supabase.url ?? '', cfg.supabase.serviceRoleKey ?? '');
  const settings = new SettingsPoller(
    cfg.supabase.url ?? '',
    cfg.supabase.serviceRoleKey ?? '',
    (next, first) => {
      if (first) return;
      events.record({
        type: 'config.changed',
        status: 'info',
        title: 'Configuration Changed',
        details: `Slack notifications ${next.enabled ? 'enabled' : 'disabled'}` +
          (next.channelLabel ? ` for ${next.channelLabel}` : '') +
          `; on: ${Object.entries(next.groups).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'}.`,
        trigger: 'Admin dashboard',
      });
    },
    undefined,
    /**
     * The webhook from Vault, so it can be set and rotated from the admin screen without a shell on
     * this machine or a restart.
     *
     * An explicit ORCHESTRATOR_SLACK_WEBHOOK_URL wins and is never overwritten: someone who set it
     * in this host's environment meant it, and a stored value silently replacing it would be a
     * surprise at the worst moment. Everyone else gets the stored one.
     */
    (url, first) => {
      if (cfg.events.slackWebhookUrl) return;
      const { changed, valid } = slack.setWebhook(url, 'vault');
      if (!valid) {
        console.warn('[events] the stored Slack webhook is not a hooks.slack.com URL; ignoring it');
        return;
      }
      if (!changed || first) return;
      events.record({
        type: 'config.changed',
        status: 'info',
        title: 'Configuration Changed',
        details: url ? 'A Slack webhook was stored; notifications can now be delivered.' : 'The Slack webhook was removed; nothing will be delivered.',
        trigger: 'Admin dashboard',
      });
    },
  );
  const events = new EventRecorder({
    orchestrator: cfg.events.orchestratorName,
    timezone: cfg.events.timezone,
    sink: eventSink,
    slack,
    slackSettings: () => settings.current(),
  });
  recorder = events;
  await settings.refresh();
  settings.start();
  installCrashHandlers(events);

  // What the previous run left behind. On this host the stop cannot be recorded by the process
  // that stopped, so the next one reports it, from the supervisor's note. See lifecycle.ts.
  const lastExit = readLastExit(packageLogDir());
  // A stop the dying process already recorded, with its stack trace, is not reported again here:
  // one crash, one critical event. The recovery below still fires, because that is news.
  if (lastExit && !(lastExit.selfReported && !lastExit.planned)) {
    // An exit code is not a reason. explainExit says what that number means on this host, where
    // every external stop arrives as the same unsigned -1.
    const why = lastExit.planned
      ? { reason: /supervisor stopped/i.test(lastExit.reason) ? 'Manual stop' : 'Planned restart', action: undefined }
      : explainExit(lastExit.code, lastExit.signal, lastExit.fastExits);
    events.record({
      type: lastExit.planned ? 'orchestrator.stopped' : 'orchestrator.unexpected_shutdown',
      status: 'stopped',
      at: lastExit.at,
      title: lastExit.planned ? 'Orchestrator Stopped' : 'Orchestrator Unexpected Shutdown',
      reason: why.reason,
      details: lastExit.planned
        ? lastExit.reason
        : `Exit code ${lastExit.code ?? 'none'}${lastExit.signal ? `, signal ${lastExit.signal}` : ''}.`,
      ...(lastExit.ranForMs > 0 ? { durationMs: lastExit.ranForMs } : {}),
      trigger: lastExit.planned ? 'Operator' : 'Unexpected',
      action: why.action ?? 'Restarted by the supervisor',
    });
  }

  console.log(
    `[orchestrator] lifecycle events ${eventSink.isEnabled() ? 'ON (orchestrator_events)' : 'log only: no Supabase credentials'}; ` +
      `Slack ${
        slack.configured
          ? `${settings.current().enabled ? 'ON' : 'configured, switched off in admin'} (webhook from ${slack.stats().source === 'vault' ? 'Vault' : 'this host\'s .env'})`
          : 'no webhook: set one under Admin > Orchestrator, or ORCHESTRATOR_SLACK_WEBHOOK_URL here'
      }; times in ${cfg.events.timezone}`,
  );

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

  /**
   * Paused means /v1/chat answers 503 and nothing else changes: sessions stay open, the log
   * endpoints keep working, and resuming is instant. For when a bad model rollout or a runaway
   * bill should stop taking turns without stopping the process an operator may be inspecting.
   */
  let paused: { since: string; by: string; reason: string } | null = null;
  const startedAtIso = new Date().toISOString();

  const health = new HealthMonitor(
    {
      paused: () => paused !== null,
      supabaseReachable: () => !settings.enabled || settings.reachable(),
      sinkFailures: () => eventSink.stats().failures,
      slackFailures: () => slack.stats().failures,
      mcpSessions: () => pool.stats().sessions,
    },
    events,
  );
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
      // The lifecycle, in the words the dashboard uses. No secrets: the webhook is reported as
      // configured or not, never as a value.
      lifecycle: {
        name: cfg.events.orchestratorName,
        timezone: cfg.events.timezone,
        startedAt: startedAtIso,
        uptimeMs: Date.now() - new Date(startedAtIso).getTime(),
        paused: paused !== null,
        pausedSince: paused?.since ?? null,
        ...health.current(),
      },
      events: { ...eventSink.stats(), buffered: events.events.size(), max: MAX_STORED_EVENTS },
      // `source` says where the webhook came from, so the admin screen can explain why a webhook
      // saved there is or is not the one in force. Never the URL itself.
      slack: { ...slack.stats(), enabled: settings.current().enabled, channel: settings.current().channelLabel },
    });
  });

  /**
   * The lifecycle record, for the dashboard's activity view.
   *
   * Super admin only, like /v1/logs, and for the same reason: an event names the task it belongs to,
   * and the tasks are other tenants' turns. The database copy of the same events is readable by any
   * admin; it carries no user identifiers.
   */
  app.get('/v1/events', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!(await isSuperAdmin(user.id, cfg.supabase))) {
      return res.status(404).json({ code: 'not_found', message: 'No such endpoint.' });
    }
    const q = (name: string): string | undefined =>
      typeof req.query[name] === 'string' ? (req.query[name] as string) : undefined;
    const list = events.events.tail({
      limit: Number(req.query.limit) || undefined,
      type: q('type'),
      status: q('status'),
      severity: q('severity'),
      taskId: q('task'),
      since: q('since'),
      search: q('search'),
    });
    res.json({ events: list, buffered: events.events.size(), max: MAX_STORED_EVENTS, lifecycle: health.current() });
  });

  /**
   * Sends one test message down the exact path a real notification takes.
   *
   * Settings are re-read first so a switch flipped seconds ago is what gets tested. The filter is
   * the one thing bypassed: the admin asked for a message, so the message is sent whatever the
   * switches say, and the result names what would have stopped a real one.
   */
  app.post('/v1/events/test-slack', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    if (!(await isSuperAdmin(user.id, cfg.supabase))) {
      return res.status(404).json({ code: 'not_found', message: 'No such endpoint.' });
    }
    await settings.refresh();
    if (!slack.configured) {
      return res.status(409).json({
        code: 'slack_not_configured',
        message: 'No Slack webhook is stored. Paste one into the Webhook field above and save it, then test again.',
      });
    }
    const test = events.record({
      type: 'config.changed',
      status: 'info',
      title: 'Orchestrator Test Notification',
      details: 'Sent from the admin dashboard. If you can read this, orchestrator alerts reach this channel.',
      trigger: 'Admin dashboard',
    });
    const result = await slack.post(test);
    events.record({
      type: result.ok ? 'slack.sent' : 'slack.failed',
      status: result.ok ? 'success' : 'failed',
      title: result.ok ? 'Slack Test Sent' : 'Slack Test Failed',
      reason: result.ok ? undefined : result.error ?? (result.throttled ? 'Held by the burst limit' : 'Unknown'),
      correlationId: test.id,
    });
    const current = settings.current();
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      error: result.error,
      throttled: result.throttled === true,
      enabled: current.enabled,
      channel: current.channelLabel,
      note: current.enabled
        ? undefined
        : 'Sent, but notifications are switched off, so real events will not post until they are enabled.',
    });
  });

  /** Pause and resume taking chat turns. Super admin, and recorded either way. */
  for (const verb of ['pause', 'resume'] as const) {
    app.post(`/v1/orchestrator/${verb}`, async (req, res) => {
      let user: AuthedUser;
      try {
        user = await authenticate(req.headers.authorization);
      } catch (err) {
        return sendAuthError(res, err);
      }
      if (!(await isSuperAdmin(user.id, cfg.supabase))) {
        return res.status(404).json({ code: 'not_found', message: 'No such endpoint.' });
      }
      const reason = forLog(String(req.body?.reason ?? ''), 200) || 'No reason given';
      if (verb === 'pause') {
        if (!paused) {
          paused = { since: new Date().toISOString(), by: user.id, reason };
          events.record({
            type: 'orchestrator.paused',
            status: 'paused',
            title: 'Orchestrator Paused',
            reason,
            details: 'Chat turns are refused until resumed. Nothing else changes.',
            trigger: `Admin ${userRef(user.id)}`,
          });
        }
      } else if (paused) {
        const pausedFor = Date.now() - new Date(paused.since).getTime();
        paused = null;
        events.record({
          type: 'orchestrator.resumed',
          status: 'resumed',
          title: 'Orchestrator Resumed',
          reason,
          durationMs: pausedFor,
          trigger: `Admin ${userRef(user.id)}`,
        });
      }
      health.tick();
      res.json({ paused: paused !== null, since: paused?.since ?? null, ...health.current() });
    });
  }

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
  /**
   * List a site's pages so the user can choose what to scan.
   *
   * A separate step from the scan on purpose. The scan opens a real browser per page and the budget
   * is 25; which 25 used to be the crawler's guess, and on a content site that guess spends the whole
   * budget on posts before reaching /contact. This costs a few HTTP GETs and replaces the guess with
   * a choice.
   */
  app.post('/v1/suggestions/discover', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    // Cheaper than a scan and expected to run before every one of them, so it gets the looser
    // allowance rather than the scan's.
    if (!limiter.allow(`discover:${user.id}`, cfg.limits.turnsPerMinutePerUser * 2)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ code: 'rate_limited', message: 'Too many lookups. Try again shortly.' });
    }
    const url = String(req.body?.url ?? '').trim();
    if (!url) return res.status(400).json({ code: 'bad_request', message: 'A site URL is required.' });

    const sitemaps = Array.isArray(req.body?.sitemaps)
      ? (req.body.sitemaps as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : [];

    const startedAt = Date.now();
    try {
      const result = await scanner.discover(url, {
        ...(sitemaps.length ? { sitemaps } : {}),
        ...(req.body?.crawlOnly === true ? { crawlOnly: true } : {}),
      });
      console.log(
        `[scan] DISCOVER user=${userTag(user)} url=${forLog(url, 120)} ` +
          `pages=${result.pages.length} total=${result.total} sitemap=${result.sitemapStatus} ` +
          `sitemaps=${result.sitemapsRead.length} viaCrawl=${result.viaCrawl} ` +
          `given=${sitemaps.length} rejected=${result.rejected.length} in ${Date.now() - startedAt}ms`,
      );
      // Each sitemap that failed, by name. "Only 12 pages" is almost always one of these, and the
      // count alone cannot say which file did not answer.
      for (const s of result.sitemapsRead.filter((r) => !r.ok)) {
        console.log(`[scan] sitemap unread: ${forLog(s.url, 160)} - ${forLog(String(s.error), 80)}`);
      }
      res.json({ ...result, maxSelectedPages: MAX_SELECTED_PAGES });
    } catch (err) {
      const code = err instanceof ScanError ? err.code : 'discover_failed';
      const message = err instanceof Error ? err.message : 'Listing the pages failed.';
      console.error(
        `[scan] DISCOVER FAILED user=${userTag(user)} url=${forLog(url, 120)} ` +
          `after ${Date.now() - startedAt}ms code=${code}: ${forLog(message)}`,
      );
      res.status(502).json({ code, message });
    }
  });

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

    // Chosen pages, capped here as well as in the scanner. The scanner reports what it cut, but a
    // request carrying ten thousand URLs should not travel that far to be trimmed.
    const chosenPages = Array.isArray(req.body?.pages)
      ? (req.body.pages as unknown[]).map(String).map((p) => p.trim()).filter(Boolean).slice(0, MAX_SELECTED_PAGES)
      : [];

    const startedAt = Date.now();
    const scanTask = `scan-${startedAt.toString(36)}`;
    events.record({
      type: 'task.started',
      status: 'started',
      title: 'Site Scan Started',
      taskId: scanTask,
      details: `${chosenPages.length ? `${chosenPages.length} chosen page(s)` : 'Crawl'} of ${forLog(url, 120)}.`,
      trigger: 'User request',
    });
    try {
      const platforms = validPlatforms(req.body?.platforms);
      const result = await scanner.scan(url, {
        maxPages: Number(req.body?.maxPages) || undefined,
        maxDepth: Number(req.body?.maxDepth) || undefined,
        ...(platforms.length ? { platforms } : {}),
        // This caller can display an image, which is the whole condition for asking for one.
        captureImages: req.body?.captureImages !== false,
        ...(req.body?.skipBlog === true ? { skipBlog: true } : {}),
        ...(chosenPages.length ? { pages: chosenPages } : {}),
      });
      const scan = scanStore.put(user.id, result);
      // The whole shape of the scan on one line: who ran it, what was asked for, what was read, and
      // what came back. "13 suggestions" alone cannot tell a thin site from a crawl that only got
      // one page in, and those need completely different answers.
      const pages = (result.pages ?? []).map((p) => p.page);
      console.log(
        `[scan] OK user=${userTag(user)} url=${forLog(url, 120)} ` +
          `platforms=${platforms.length ? platforms.join('+') : 'ga4'} ` +
          `mode=${chosenPages.length ? `chosen(${chosenPages.length})` : 'crawl'} ` +
          `budget=${Number(req.body?.maxPages) || 'default'} scanned=${pages.length} ` +
          `skipped=${result.notScanned?.length ?? 0} excluded=${result.excluded ?? 0} ` +
          `suggestions=${scan.suggestions.length} images=${scan.images.size} ` +
          `in ${Date.now() - startedAt}ms`,
      );
      if (pages.length) console.log(`[scan] pages read: ${forLog(pages.join(' '), 600)}`);
      events.record({
        type: 'task.completed',
        status: 'success',
        title: 'Site Scan Completed',
        taskId: scanTask,
        details: `${pages.length} page(s) read, ${scan.suggestions.length} suggestion(s).`,
        durationMs: Date.now() - startedAt,
      });
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
        // Two ceilings, because they bound different things: how far a CRAWL goes, and how many
        // pages a chosen list may hold. Sent so the page shows the server's real numbers rather
        // than a copy that can drift.
        maxPages: MAX_SCAN_PAGES,
        maxSelectedPages: MAX_SELECTED_PAGES,
      });
    } catch (err) {
      const code = err instanceof ScanError ? err.code : 'scan_failed';
      const message = err instanceof Error ? err.message : 'The scan failed.';
      console.error(
        `[scan] FAILED user=${userTag(user)} url=${forLog(url, 120)} ` +
          `after ${Date.now() - startedAt}ms code=${code}: ${forLog(message)}`,
      );
      const why = explainError(message, { kind: 'scan', code });
      events.record({
        type: 'task.failed',
        status: 'failed',
        title: 'Site Scan Failed',
        taskId: scanTask,
        reason: why.reason,
        details: `${forLog(url, 100)}.`,
        error: `${code}: ${message}`,
        durationMs: Date.now() - startedAt,
        action: why.action ?? 'The user was shown the reason',
      });
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
      events.record({
        type: 'auth.failed',
        status: 'failed',
        title: 'Authorization Failed',
        reason: 'Not a super admin',
        details: `A signed-in user asked for the orchestrator log.`,
      });
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
   * Change one suggested row before it is created.
   *
   * Named fields only: the tag name, the event name, the trigger name, and the value or operator of
   * a condition the scan already put on that trigger. Everything else in the request is refused and
   * said so. This is not a relaxation of the rule the create path relies on - the edit is applied to
   * the SERVER's copy of the scan, so /v1/suggestions/create still builds from what this process
   * holds and still cannot be handed a tag payload by a browser.
   *
   * No write to GTM happens here. The row is only changed in memory, for the scan's remaining life.
   */
  app.patch('/v1/suggestions/:scanId/row/:rowId', async (req, res) => {
    let user: AuthedUser;
    try {
      user = await authenticate(req.headers.authorization);
    } catch (err) {
      return sendAuthError(res, err);
    }
    // The picker's allowance, not the turn allowance. An edit is a cheap in-memory change and
    // someone renaming ten rows before creating them is normal use, not abuse.
    if (!limiter.allow(`edit:${user.id}`, cfg.limits.turnsPerMinutePerUser * 4)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ code: 'rate_limited', message: 'Too many edits. Try again shortly.' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const edit: RowEdit = {
      ...(typeof body.tagName === 'string' ? { tagName: body.tagName } : {}),
      ...(typeof body.eventName === 'string' ? { eventName: body.eventName } : {}),
      ...(typeof body.triggerName === 'string' ? { triggerName: body.triggerName } : {}),
      ...(Array.isArray(body.conditions)
        ? {
            conditions: (body.conditions as Record<string, unknown>[])
              .filter((c) => c && typeof c.variable === 'string')
              .map((c) => ({
                variable: String(c.variable),
                ...(typeof c.operator === 'string' ? { operator: c.operator } : {}),
                ...(typeof c.value === 'string' ? { value: c.value } : {}),
              })),
          }
        : {}),
    };

    const result = scanStore.editRow(user.id, req.params.scanId, req.params.rowId, edit);
    if (!result) {
      // One message for both cases on purpose. Whether the scan expired or the row id is wrong, the
      // action is the same, and distinguishing them tells a caller which scan ids exist.
      return res.status(404).json({
        code: 'scan_expired',
        message: 'That scan or row is no longer available. Run the scan again.',
      });
    }

    // Logged with the same weight as a create. An edited row is the one row in the table that the
    // site cannot be rescanned to verify, so what it used to say has to live somewhere.
    if (result.changed.length) {
      console.log(
        `[suggestions] EDIT user=${userTag(user)} row=${req.params.rowId} ` +
          `${forLog(result.changed.join('; '), 400)}`,
      );
    }
    for (const reason of result.rejected) {
      console.log(`[suggestions] edit refused user=${userTag(user)} row=${req.params.rowId}: ${forLog(reason, 200)}`);
    }

    res.json({ row: toRows([result.row])[0], changed: result.changed, rejected: result.rejected });
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
        // No withMeasurementId here any more. It used to stamp an id onto each row, and the GA4
        // configuration below replaces that entirely: the id lives in one Constant and every tag
        // references it. Leaving the call in would suggest the tags still carry an id of their own.
        const tags = supported;
        // Plain: createSelected adds the confirm every guarded write needs, so that it can be
        // tested rather than depending on each caller remembering.
        const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
          const { ok, text } = await mcp.callTool(name, args);
          // Thrown, not returned: createSuggestedTags reads failures off the exception, and that is
          // where its duplicate-name and quota-backoff handling lives.
          if (!ok) throw new Error(text);
          return text;
        };

        /**
         * The GA4 configuration, when a Measurement ID was given.
         *
         * Gated on the field rather than always on. Without an id there is nothing to put in the
         * Constant, and the tool's existing behaviour (read the id off the container's Google tag)
         * is the right answer for a container that already has one.
         *
         * The snapshot is what makes this safe: it says whether the Constant and a base tag are
         * already there, so a second run adds nothing, and it says when a list could not be read,
         * so "absent" is never inferred from "unknown".
         */
        const givenId = String(req.body?.measurementId ?? '').trim();
        const snapshot = await fetchWorkspaceSnapshot(mcp, ws);
        const ga4 = planGa4Config(snapshot, givenId);
        if (ga4.blocked) throw new ResourceError(ga4.blocked, 'ga4_config_blocked');
        console.log(
          `[suggestions] ga4 config user=${userTag(user)} id=${ga4.measurementId} source=${ga4.source} ` +
            `variable=${ga4.createVariable ? 'create' : 'reuse'} ` +
            `configTag=${ga4.createConfigTag ? 'create' : `reuse "${forLog(String(ga4.existingConfigTag), 80)}"`} ` +
            `reference=${ga4.reference}${ga4.warning ? ' WARNING' : ''}`,
        );

        const createStartedAt = Date.now();
        const result = await createSelected(execute, ws, tags, undefined, ga4);

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
        if (result.ga4Config) {
          const g = result.ga4Config;
          console.log(
            `[suggestions] ga4 config result variable=${g.variable} configTag=${g.configTag} ` +
              `reference=${g.reference}${g.error ? ` error=${forLog(g.error, 200)}` : ''}`,
          );
          if (g.warning) console.log(`[suggestions] ga4 config WARNING: ${forLog(g.warning, 240)}`);
        }
        for (const l of result.listeners) {
          if (l.ok) console.log(`[suggestions] listener created "${forLog(l.tagName, 120)}"`);
          else if (l.existing) console.log(`[suggestions] listener already present "${forLog(l.tagName, 120)}"`);
          else console.error(`[suggestions] listener FAILED "${forLog(l.tagName, 120)}": ${forLog(String(l.error))}`);
        }
        for (const u of unsupported) {
          console.log(`[suggestions] not creatable here: ${u.id} (${u.platform})`);
        }

        // Named per tag, before the counts are read as "all good". A trigger that lost its
        // dataLayer or lookup-table scope was still created, and it fires far wider than the row
        // said it would.
        const dropped = droppedConditions(tags);
        for (const d of dropped) {
          console.log(
            `[suggestions] conditions NOT carried on "${forLog(d.tagName, 120)}": ` +
              `${forLog(d.conditions.join('; '), 300)}`,
          );
        }

        return {
          ...result,
          site: scan.site,
          ...(unsupported.length ? { unsupported } : {}),
          ...(dropped.length ? { dropped } : {}),
        };
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

    if (paused) {
      res.setHeader('Retry-After', '120');
      return res.status(503).json({
        code: 'paused',
        message: 'The assistant is paused for maintenance. Try again in a few minutes.',
      });
    }

    if (!limiter.allow(user.id, cfg.limits.turnsPerMinutePerUser)) {
      res.setHeader('Retry-After', '60');
      events.record({
        type: 'task.skipped',
        status: 'skipped',
        title: 'Chat Turn Refused',
        reason: `Rate limit: ${cfg.limits.turnsPerMinutePerUser} messages per minute`,
        details: `User ${userRef(user.id)}.`,
      });
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
      events.record({
        type: 'task.skipped',
        status: 'skipped',
        title: 'Chat Turn Refused',
        reason: `Plan ${quota.reason} limit reached`,
        details: `User ${userRef(user.id)}, plan ${quota.planType ?? 'unknown'}.`,
      });
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
        const why = err.code === 'not_connected'
          ? { reason: 'The user has not connected a Google account', action: 'They connect it from Settings' }
          : explainError(err.message, { kind: 'identity', code: err.code });
        events.record({
          type: 'service.connection',
          status: 'failed',
          severity: err.code === 'not_connected' ? 'info' : 'error',
          title: 'Google Connection Failed',
          reason: why.reason,
          details: `User ${userRef(user.id)}.`,
          ...(why.action ? { action: why.action } : {}),
          error: err.message,
        });
        return res.status(err.code === 'not_connected' ? 428 : 502).json({
          code: err.code,
          message: err.message,
        });
      }
      const mcpWhy = explainError(err instanceof Error ? err.message : String(err), { kind: 'startup' });
      events.record({
        type: 'service.connection',
        status: 'failed',
        severity: 'error',
        title: 'MCP Session Failed',
        reason: mcpWhy.reason,
        details: `A tool session could not be started for user ${userRef(user.id)}.`,
        ...(mcpWhy.action ? { action: mcpWhy.action } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
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
    // The task id is the conversation where there is one, so every turn of a thread files together.
    const taskId = conversationId ? `chat-${conversationId.slice(0, 8)}` : `chat-${turnStartedAt.toString(36)}`;
    events.record({
      type: 'task.started',
      status: 'started',
      title: 'Chat Turn Started',
      taskId,
      correlationId: conversationId ?? undefined,
      details: `${product.toUpperCase()} chat, ${body.messages?.length ?? 0} message(s) of history.`,
      trigger: 'User request',
    });

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
        onEvent: (e) => events.record({ ...e, correlationId: conversationId ?? undefined }),
        taskId,
      });
      console.log(
        `[chat] turn OK user=${userTag(user)} in ${Date.now() - turnStartedAt}ms`,
      );
      events.record({
        type: 'task.completed',
        status: 'success',
        title: 'Chat Turn Completed',
        taskId,
        correlationId: conversationId ?? undefined,
        durationMs: Date.now() - turnStartedAt,
      });
    } catch (err) {
      // The reason, not just that it failed. friendlyError() is written for the person in the chat
      // window; the operator reading this needs the code and the upstream text behind it.
      const code = err instanceof OpenAiError ? err.code : 'internal_error';
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[chat] turn FAILED user=${userTag(user)} after ${Date.now() - turnStartedAt}ms ` +
          `code=${code}: ${forLog(detail)}`,
      );
      const why = explainError(detail, {
        kind: 'turn',
        code,
        ...(err instanceof OpenAiError ? { status: err.status } : {}),
      });
      events.record({
        type: 'task.failed',
        status: 'failed',
        title: 'Chat Turn Failed',
        taskId,
        correlationId: conversationId ?? undefined,
        reason: why.reason,
        details: forLog(friendlyError(err), 200),
        error: `${code}: ${detail}`,
        durationMs: Date.now() - turnStartedAt,
        action: why.action ?? 'The user was shown the reason',
      });
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
    // Started means serving, not booting: this is the first moment a request would succeed.
    events.record({
      type: 'orchestrator.started',
      status: 'started',
      title: 'Orchestrator Started',
      trigger: lastExit
        ? lastExit.planned ? 'Supervisor restart' : 'Supervisor restart after an unexpected stop'
        : 'Process start',
      details:
        `Model ${cfg.openai.model}, ${all.length} MCP tools, ` +
        (cfg.enableWriteTools ? (cfg.enableDeleteTools ? 'writes and deletes enabled' : 'writes enabled') : 'read-only') +
        `, listening on ${cfg.host}:${cfg.port}.`,
      durationMs: Date.now() - bootStartedAt,
    });
    if (lastExit && !lastExit.planned) {
      events.record({
        type: 'orchestrator.recovered',
        status: 'recovered',
        title: 'Orchestrator Recovered',
        reason: 'Restarted by the supervisor after an unexpected stop',
        details: `Down for about ${formatDuration(Date.now() - new Date(lastExit.at).getTime())}.`,
      });
    }
    health.tick();
    health.start();
  });

  // Reached on SIGINT/SIGTERM only, which on the Windows host means Ctrl-C in a terminal; external
  // stops there are TerminateProcess and are reported by the next run instead (see lastExit).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[orchestrator] shutting down...');
    events.record({
      type: 'orchestrator.stopped',
      status: 'stopped',
      title: 'Orchestrator Stopped',
      reason: 'Manual stop',
      details: `Received ${signal}.`,
      durationMs: Date.now() - new Date(startedAtIso).getTime(),
      trigger: 'Operator',
    });
    server.close();
    health.stop();
    settings.stop();
    await pool.shutdown();
    await probe.close();
    await events.flush(3_000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
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
  // Only a token that was presented and rejected is worth a record. A request with no token at all
  // is a scanner or a signed-out tab, and the [req] line already counts those.
  if (res.req?.headers.authorization) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    recorder?.record({
      type: 'auth.failed',
      status: 'failed',
      title: 'Authentication Failed',
      reason: code === 'misconfigured'
        ? 'This deployment cannot verify tokens at all, so every signed-in request is refused'
        : /expired/i.test(message)
          ? "The caller's session had expired"
          : /audience|issuer/i.test(message)
            ? 'The token was issued for a different project'
            : /missing bearer/i.test(message)
              ? 'The request carried no token'
              : 'The token was rejected as invalid',
      details: forLog(message, 120),
      ...(code === 'misconfigured' ? { action: 'Set SUPABASE_JWKS_URL on the orchestrator host' } : {}),
    });
  }
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
  const message = err instanceof Error ? err.message : String(err);
  // The recorder exists once main() has built it, which is before anything that can fail here. A
  // failure earlier than that (loadConfig throwing) never reaches this handler at all: it is a
  // module-level throw, printed by Node, and reported by the supervisor's next-run note instead.
  const why = explainError(message, {
    kind: 'startup',
    ...((err as { code?: string })?.code ? { code: String((err as { code?: string }).code) } : {}),
  });
  recorder?.record({
    type: 'orchestrator.startup_failed',
    status: 'failed',
    severity: 'critical',
    title: 'Orchestrator Failed To Start',
    reason: why.reason,
    details: forLog(message, 200),
    error: err instanceof Error && err.stack ? err.stack : message,
    action: why.action ?? 'The supervisor will retry with backoff',
  });
  void (recorder ? recorder.flush(3_000) : Promise.resolve()).finally(() => process.exit(1));
});
