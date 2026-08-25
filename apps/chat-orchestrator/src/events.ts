/**
 * Orchestrator lifecycle and activity events: one record per thing worth knowing about.
 *
 * The log file already says everything, in the order it happened, to someone who can read it. This
 * is for everyone else. Each event answers five questions in plain words: what happened, when, what
 * the status was, why, and what happened next. The same record is written three ways:
 *
 *   1. A line in the process log, tagged [event], so the existing log viewer files it.
 *   2. A row in orchestrator_events, so it survives this machine going to sleep.
 *   3. A Slack message, when the admin has switched that on for this kind of event.
 *
 * The technical detail (stack traces, upstream bodies) rides in `error`, kept out of the message
 * people read and available to the one who needs it.
 *
 * Everything here that formats or decides is pure and tested. The two things that talk to the
 * network (the row writer and the Slack poster) are fire-and-forget: a lost notification costs a
 * notification, never a user's turn.
 */
import { randomUUID } from 'node:crypto';
import { forLog, redactSecrets } from './redact.js';

/* ────────────────────────────── The catalog ──────────────────────────────── */

export type EventType =
  | 'orchestrator.started'
  | 'orchestrator.stopped'
  | 'orchestrator.paused'
  | 'orchestrator.resumed'
  | 'orchestrator.unexpected_shutdown'
  | 'orchestrator.recovered'
  | 'orchestrator.startup_failed'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.skipped'
  | 'task.retried'
  | 'api.request.started'
  | 'api.request.completed'
  | 'api.request.failed'
  | 'database.operation'
  | 'service.connection'
  | 'slack.sent'
  | 'slack.failed'
  | 'health.started'
  | 'health.completed'
  | 'health.failed'
  | 'health.changed'
  | 'config.changed'
  | 'schedule.triggered'
  | 'auth.failed'
  | 'timeout'
  | 'error'
  | 'critical';

export type EventStatus =
  | 'started'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'retried'
  | 'stopped'
  | 'paused'
  | 'resumed'
  | 'recovered'
  | 'healthy'
  | 'warning'
  | 'timeout'
  | 'info';

export type EventSeverity = 'info' | 'success' | 'warning' | 'error' | 'critical';

export interface OrchestratorEvent {
  id: string;
  /** ISO 8601, UTC. The zone people read it in is `timezone`. */
  at: string;
  timezone: string;
  type: EventType;
  status: EventStatus;
  severity: EventSeverity;
  /** What happened, as a short heading: "Orchestrator Started", "Task Failed". */
  title: string;
  /** Why, when there is a why. "Manual stop", "OpenAI rate limit". */
  reason?: string;
  /** One short sentence more. "1,250 records processed." */
  details?: string;
  /** What happened next, when something did. "Retry scheduled", "Restarted by supervisor". */
  action?: string;
  /** Technical detail for the detailed log only. Never in the Slack message. */
  error?: string;
  /** The job or turn this belongs to. */
  taskId?: string;
  /** A correlation id shared across related events (a whole turn, a whole sweep). */
  correlationId?: string;
  durationMs?: number;
  /** Which orchestrator. There is one today; the field is what lets there be two. */
  orchestrator: string;
  /** What started it: "Scheduled run", "Supervisor", "User request". */
  trigger?: string;
}

export type EventInput = Omit<OrchestratorEvent, 'id' | 'at' | 'timezone' | 'orchestrator' | 'severity'> & {
  severity?: EventSeverity;
  at?: string;
};

/* ─────────────────────────── Notification groups ─────────────────────────── */

/** The switches an admin sees. Every event type belongs to exactly one. */
export type NotifyGroup =
  | 'start_stop'
  | 'failure'
  | 'recovery'
  | 'health'
  | 'task_completion'
  | 'critical'
  | 'detailed';

export const NOTIFY_GROUPS: NotifyGroup[] = [
  'critical', 'start_stop', 'failure', 'recovery', 'health', 'task_completion', 'detailed',
];

const GROUP_OF: Record<EventType, NotifyGroup> = {
  'orchestrator.started': 'start_stop',
  'orchestrator.stopped': 'start_stop',
  'orchestrator.paused': 'start_stop',
  'orchestrator.resumed': 'start_stop',
  'orchestrator.unexpected_shutdown': 'critical',
  'orchestrator.startup_failed': 'critical',
  'orchestrator.recovered': 'recovery',
  'task.started': 'detailed',
  'task.completed': 'task_completion',
  'task.failed': 'failure',
  'task.skipped': 'detailed',
  'task.retried': 'detailed',
  'api.request.started': 'detailed',
  'api.request.completed': 'detailed',
  'api.request.failed': 'failure',
  'database.operation': 'detailed',
  'service.connection': 'detailed',
  'slack.sent': 'detailed',
  'slack.failed': 'detailed',
  'health.started': 'detailed',
  'health.completed': 'detailed',
  'health.failed': 'health',
  'health.changed': 'health',
  'config.changed': 'detailed',
  'schedule.triggered': 'detailed',
  // An expired session is routine, and a token rejected a hundred times an hour by a scanner is
  // not something to page anyone about. It is recorded; it posts only under "detailed".
  'auth.failed': 'detailed',
  timeout: 'failure',
  error: 'failure',
  critical: 'critical',
};

export function notifyGroupOf(type: EventType): NotifyGroup {
  return GROUP_OF[type];
}

const DEFAULT_SEVERITY: Record<EventType, EventSeverity> = {
  'orchestrator.started': 'success',
  'orchestrator.stopped': 'info',
  'orchestrator.paused': 'warning',
  'orchestrator.resumed': 'success',
  'orchestrator.unexpected_shutdown': 'critical',
  'orchestrator.startup_failed': 'critical',
  'orchestrator.recovered': 'success',
  'task.started': 'info',
  'task.completed': 'success',
  'task.failed': 'error',
  'task.skipped': 'info',
  'task.retried': 'warning',
  'api.request.started': 'info',
  'api.request.completed': 'success',
  'api.request.failed': 'error',
  'database.operation': 'info',
  'service.connection': 'info',
  'slack.sent': 'info',
  'slack.failed': 'warning',
  'health.started': 'info',
  'health.completed': 'success',
  'health.failed': 'error',
  'health.changed': 'warning',
  'config.changed': 'info',
  'schedule.triggered': 'info',
  'auth.failed': 'warning',
  timeout: 'warning',
  error: 'error',
  critical: 'critical',
};

/* ──────────────────────────── Slack settings ─────────────────────────────── */

/**
 * What the admin controls from the website. Stored as one JSON value under the system_settings key
 * `orchestrator.slack`; the orchestrator re-reads it every minute, so a switch flipped there takes
 * effect without a restart.
 *
 * The webhook URL is NOT here. It is a credential, and system_settings is readable by every admin
 * and written from a browser. It lives in this process's environment, like every other secret.
 */
export interface SlackSettings {
  enabled: boolean;
  /** Display only. An incoming webhook is bound to its channel when Slack issues it. */
  channelLabel: string;
  groups: Record<NotifyGroup, boolean>;
}

export const DEFAULT_SLACK_SETTINGS: SlackSettings = {
  enabled: false,
  channelLabel: '',
  groups: {
    critical: true,
    start_stop: true,
    failure: true,
    recovery: true,
    health: true,
    task_completion: false,
    detailed: false,
  },
};

/** Tolerant of anything the table holds: a missing switch takes its default, never "on". */
export function parseSlackSettings(raw: unknown): SlackSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = (o.events && typeof o.events === 'object' ? o.events : {}) as Record<string, unknown>;
  const groups = { ...DEFAULT_SLACK_SETTINGS.groups };
  for (const k of NOTIFY_GROUPS) {
    if (typeof g[k] === 'boolean') groups[k] = g[k] as boolean;
  }
  return {
    enabled: o.enabled === true,
    channelLabel: typeof o.channel_label === 'string' ? o.channel_label.slice(0, 80) : '',
    groups,
  };
}

/**
 * Whether this event goes to Slack under these settings.
 *
 * "detailed" is the everything switch: with it on, every event posts. With it off, an event posts
 * only when its own group is on. Critical events post whenever notifications are enabled at all,
 * because an admin who switched off "critical" and then missed a crash would not thank us for
 * honouring it; the switch exists so the list reads completely, and it is on by default.
 */
export function shouldNotify(type: EventType, s: SlackSettings): boolean {
  if (!s.enabled) return false;
  const group = notifyGroupOf(type);
  if (group === 'critical') return true;
  if (s.groups.detailed) return true;
  return s.groups[group] === true;
}

/* ───────────────────────────── Formatting ────────────────────────────────── */

/** "25 Aug 2026, 01:30 PM IST", in the zone named, with the zone NAMED so a mismatch shows. */
export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let text: string;
  try {
    text = d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone,
      timeZoneName: 'short',
    });
  } catch {
    // An unknown zone name throws. Fall back to UTC and say so, rather than to the host's zone,
    // which would be wrong quietly.
    text = `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
  // en-IN writes "am"/"pm" and, depending on the ICU build, a narrow no-break space before it.
  return text.replace(/ /g, ' ').replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
}

/** "45 minutes", "2h 05m", "12s", "850ms". Chosen for reading, not for arithmetic. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const STATUS_WORD: Record<EventStatus, string> = {
  started: 'Started',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  skipped: 'Skipped',
  retried: 'Retried',
  stopped: 'Stopped',
  paused: 'Paused',
  resumed: 'Resumed',
  recovered: 'Recovered',
  healthy: 'Healthy',
  warning: 'Warning',
  timeout: 'Timed out',
  info: 'Info',
};

export function statusWord(status: EventStatus): string {
  return STATUS_WORD[status] ?? status;
}

/**
 * The simple message, in the one shape every surface uses:
 *
 *   [EVENT]
 *   Time: ...
 *   Status: ...
 *   Reason: ...
 *   Details: ...
 *
 * Lines with nothing to say are left out rather than printed as "Reason: -". The technical `error`
 * is never here.
 */
export function simpleLines(e: OrchestratorEvent): string[] {
  const lines = [
    `Orchestrator: ${e.orchestrator}`,
    `Time: ${formatWhen(e.at, e.timezone)}`,
    `Status: ${statusWord(e.status)}`,
  ];
  if (e.taskId) lines.push(`Task: ${e.taskId}`);
  if (e.trigger) lines.push(`Trigger: ${e.trigger}`);
  if (e.reason) lines.push(`Reason: ${e.reason}`);
  if (e.details) lines.push(`Details: ${e.details}`);
  if (e.durationMs !== undefined && e.durationMs >= 0) lines.push(`Duration: ${formatDuration(e.durationMs)}`);
  if (e.action) lines.push(`Action: ${e.action}`);
  return lines;
}

export function simpleText(e: OrchestratorEvent): string {
  return [e.title, ...simpleLines(e)].join('\n');
}

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  info: ':information_source:',
  success: ':white_check_mark:',
  warning: ':warning:',
  error: ':x:',
  critical: ':rotating_light:',
};

/** The Slack payload: plain `text` for notifications and previews, one mrkdwn block for the body. */
export function slackPayload(e: OrchestratorEvent): Record<string, unknown> {
  const lines = simpleLines(e);
  const bold = lines.map((l) => {
    const i = l.indexOf(': ');
    return i > 0 ? `*${l.slice(0, i)}:* ${l.slice(i + 2)}` : l;
  });
  return {
    text: simpleText(e),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${SEVERITY_EMOJI[e.severity]} *${e.title}*\n${bold.join('\n')}`,
        },
      },
    ],
  };
}

/** The one line the process log gets. Fits the `[tag] message` shape the log viewer classifies. */
export function eventLine(e: OrchestratorEvent): string {
  const parts = [`[event] ${e.type} ${e.status}: ${e.title}`];
  if (e.taskId) parts.push(`task=${e.taskId}`);
  if (e.reason) parts.push(`reason="${e.reason}"`);
  if (e.details) parts.push(`details="${e.details}"`);
  if (e.durationMs !== undefined) parts.push(`duration=${formatDuration(e.durationMs)}`);
  if (e.action) parts.push(`next="${e.action}"`);
  if (e.error) parts.push(`error="${forLog(e.error, 300)}"`);
  return parts.join(' ');
}

/* ─────────────────────────── The in-memory store ─────────────────────────── */

export const MAX_STORED_EVENTS = 2000;

export interface EventQuery {
  limit?: number;
  type?: string;
  status?: string;
  severity?: string;
  taskId?: string;
  /** ISO timestamp; only events at or after it. */
  since?: string;
  /** Free text, matched against title, reason, details and task id. */
  search?: string;
}

/** A ring of the newest events, for /v1/events when the database is not the thing being asked. */
export class EventStore {
  private readonly events: OrchestratorEvent[] = [];

  constructor(private readonly max = MAX_STORED_EVENTS) {}

  push(e: OrchestratorEvent): void {
    this.events.push(e);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }

  size(): number {
    return this.events.length;
  }

  /** Newest first. */
  tail(q: EventQuery = {}): OrchestratorEvent[] {
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), this.max);
    const sinceMs = q.since ? new Date(q.since).getTime() : Number.NaN;
    const needle = q.search?.trim().toLowerCase();
    const out: OrchestratorEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (q.type && e.type !== q.type && !e.type.startsWith(`${q.type}.`)) continue;
      if (q.status && e.status !== q.status) continue;
      if (q.severity && e.severity !== q.severity) continue;
      if (q.taskId && e.taskId !== q.taskId) continue;
      if (!Number.isNaN(sinceMs) && new Date(e.at).getTime() < sinceMs) continue;
      if (needle) {
        const hay = `${e.title} ${e.reason ?? ''} ${e.details ?? ''} ${e.taskId ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push(e);
    }
    return out;
  }
}

/* ───────────────────────────── The row writer ────────────────────────────── */

export interface EventSink {
  write(e: OrchestratorEvent): Promise<void>;
}

/**
 * Writes each event to orchestrator_events with the service role key. Same shape as audit.ts: a
 * failure logs and counts, and never propagates.
 */
export class SupabaseEventSink implements EventSink {
  private failures = 0;
  private readonly enabled: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.enabled = Boolean(baseUrl && serviceRoleKey);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  stats(): { enabled: boolean; failures: number } {
    return { enabled: this.enabled, failures: this.failures };
  }

  async write(e: OrchestratorEvent): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/rest/v1/orchestrator_events`, {
        method: 'POST',
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(toRow(e)),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 200)}`);
    } catch (err) {
      this.failures++;
      console.error(
        `[events] row write failed (${this.failures} total): ${forLog(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
}

export function toRow(e: OrchestratorEvent): Record<string, unknown> {
  return {
    id: e.id,
    occurred_at: e.at,
    timezone: e.timezone,
    orchestrator: e.orchestrator,
    event_type: e.type,
    status: e.status,
    severity: e.severity,
    title: e.title,
    reason: e.reason ?? null,
    details: e.details ?? null,
    action: e.action ?? null,
    error: e.error ? forLog(e.error, 2000) : null,
    task_id: e.taskId ?? null,
    correlation_id: e.correlationId ?? null,
    duration_ms: e.durationMs ?? null,
    trigger: e.trigger ?? null,
  };
}

/* ───────────────────────────── The Slack poster ──────────────────────────── */

/** Slack webhooks live on exactly one host. Anything else is an SSRF vector wearing a config field. */
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;

/** No more than this many posts in a rolling window, then one line saying the rest were held. */
export const SLACK_BURST_LIMIT = 20;
export const SLACK_BURST_WINDOW_MS = 10 * 60_000;
/**
 * How many times the SAME critical event may post in that window.
 *
 * Critical events are exempt from the burst budget, because an operator who missed a crash because
 * twenty routine messages came first would be right to be angry. But a crash loop is a critical
 * event repeating every sixty seconds, and with no cap at all this feature turns one outage into a
 * pager storm. Three is enough to be unmissable; the fourth says it is still happening and stops.
 */
export const SLACK_REPEAT_LIMIT = 3;

/** What makes two events "the same" for the repeat cap: the kind of thing and why. */
export function signatureOf(e: OrchestratorEvent): string {
  return `${e.type}::${e.reason ?? ''}`;
}

/** Where the webhook came from, so the operator screen can say. */
export type WebhookSource = 'env' | 'vault' | 'none';

export class SlackNotifier {
  private sent = 0;
  private failures = 0;
  private recent: number[] = [];
  private repeats = new Map<string, number[]>();
  private throttledNotice = false;
  private webhookUrl: string;
  private source: WebhookSource;

  constructor(
    webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    source: WebhookSource = 'env',
  ) {
    this.webhookUrl = SLACK_WEBHOOK_RE.test(webhookUrl) ? webhookUrl : '';
    this.source = this.webhookUrl ? source : 'none';
  }

  get configured(): boolean {
    return this.webhookUrl.length > 0;
  }

  /**
   * Replaces the webhook while running, so one stored in Vault and changed from the admin screen
   * takes effect on the next poll rather than on the next restart.
   *
   * Returns whether this changed anything, so the caller can record a config event without one
   * firing every minute. A URL that is not a Slack webhook is refused rather than stored and then
   * failing on every post; the caller reports that as a rejected setting.
   */
  setWebhook(url: string, source: WebhookSource): { changed: boolean; valid: boolean } {
    const next = (url ?? '').trim();
    if (next && !SLACK_WEBHOOK_RE.test(next)) return { changed: false, valid: false };
    if (next === this.webhookUrl) return { changed: false, valid: true };
    this.webhookUrl = next;
    this.source = next ? source : 'none';
    // A new destination is a fresh audience: what was held back for the old channel was held for
    // people who are no longer the ones being told.
    this.recent = [];
    this.repeats.clear();
    this.throttledNotice = false;
    return { changed: true, valid: true };
  }

  stats(): { configured: boolean; sent: number; failures: number; source: WebhookSource } {
    return { configured: this.configured, sent: this.sent, failures: this.failures, source: this.source };
  }

  /** True when a post would be held back by the burst limit. Resets itself as the window moves. */
  private overBurst(): boolean {
    const cutoff = this.now() - SLACK_BURST_WINDOW_MS;
    this.recent = this.recent.filter((t) => t > cutoff);
    return this.recent.length >= SLACK_BURST_LIMIT;
  }

  /**
   * Posts one event. Resolves to what happened rather than throwing, so the caller can record
   * `slack.sent` / `slack.failed` without a try block around every call.
   */
  async post(e: OrchestratorEvent): Promise<{ ok: boolean; error?: string; throttled?: boolean }> {
    if (!this.configured) return { ok: false, error: 'No Slack webhook is configured.' };

    // The same thing, again. A crash loop restarts every sixty seconds and each attempt is
    // critical; saying so three times is a warning, saying so forty times is a channel nobody
    // reads. A DIFFERENT critical event is never held by this.
    const signature = signatureOf(e);
    const cutoff = this.now() - SLACK_BURST_WINDOW_MS;
    const seen = (this.repeats.get(signature) ?? []).filter((t) => t > cutoff);
    if (seen.length >= SLACK_REPEAT_LIMIT) {
      this.repeats.set(signature, seen);
      if (seen.length === SLACK_REPEAT_LIMIT) {
        seen.push(this.now());
        this.repeats.set(signature, seen);
        await this.send({
          text: `:hourglass: *${e.title}* has now happened ${SLACK_REPEAT_LIMIT + 1} times in ${SLACK_BURST_WINDOW_MS / 60_000} minutes${e.reason ? ` (${e.reason})` : ''}. Further messages about this one are held; the full record is in the dashboard.`,
        }).catch(() => undefined);
      }
      return { ok: false, throttled: true };
    }

    // A crash loop or a flood of failed turns must not become a flood of Slack messages. Critical
    // events always go through; everything else is held once the window fills.
    if (e.severity !== 'critical' && this.overBurst()) {
      if (!this.throttledNotice) {
        this.throttledNotice = true;
        await this.send({
          text: `:hourglass: Orchestrator notifications are being held: more than ${SLACK_BURST_LIMIT} in ${SLACK_BURST_WINDOW_MS / 60_000} minutes. The full record is in the dashboard.`,
        }).catch(() => undefined);
      }
      return { ok: false, throttled: true };
    }
    this.throttledNotice = false;

    try {
      await this.send(slackPayload(e));
      this.sent++;
      this.recent.push(this.now());
      this.repeats.set(signature, [...seen, this.now()]);
      return { ok: true };
    } catch (err) {
      this.failures++;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      // Slack answers a bad webhook with a short plain-text body ("no_service", "invalid_payload").
      throw new Error(`Slack answered ${res.status} ${forLog(await res.text().catch(() => ''), 120)}`);
    }
  }
}

/* ────────────────────────────── The recorder ─────────────────────────────── */

export interface EventRecorderOptions {
  orchestrator: string;
  timezone: string;
  store?: EventStore;
  sink?: EventSink;
  slack?: SlackNotifier;
  /** Current Slack settings. A function so the recorder always sees the latest poll. */
  slackSettings?: () => SlackSettings;
  log?: (line: string) => void;
}

/**
 * The one door every event goes through: log line, ring buffer, row, Slack. Returns the event so
 * the caller can hold on to its id for a follow-up.
 */
export class EventRecorder {
  private readonly store: EventStore;
  private readonly log: (line: string) => void;
  private inFlight = new Set<Promise<unknown>>();

  constructor(private readonly opts: EventRecorderOptions) {
    this.store = opts.store ?? new EventStore();
    this.log = opts.log ?? ((line) => console.log(line));
  }

  get events(): EventStore {
    return this.store;
  }

  record(input: EventInput): OrchestratorEvent {
    const e: OrchestratorEvent = {
      ...input,
      id: randomUUID(),
      at: input.at ?? new Date().toISOString(),
      timezone: this.opts.timezone,
      orchestrator: this.opts.orchestrator,
      severity: input.severity ?? DEFAULT_SEVERITY[input.type],
      reason: input.reason ? redactSecrets(input.reason) : undefined,
      details: input.details ? redactSecrets(input.details) : undefined,
      error: input.error ? redactSecrets(input.error) : undefined,
    };
    this.log(eventLine(e));
    this.store.push(e);
    this.track(this.opts.sink?.write(e));
    this.notify(e);
    return e;
  }

  private notify(e: OrchestratorEvent): void {
    const slack = this.opts.slack;
    const settings = this.opts.slackSettings?.() ?? DEFAULT_SLACK_SETTINGS;
    // The record of a Slack post must not itself be posted to Slack, or one failure is forever.
    if (!slack || e.type === 'slack.sent' || e.type === 'slack.failed') return;
    if (!shouldNotify(e.type, settings)) return;
    this.track(
      slack.post(e).then((r) => {
        if (r.throttled) return;
        this.record({
          type: r.ok ? 'slack.sent' : 'slack.failed',
          status: r.ok ? 'success' : 'failed',
          title: r.ok ? 'Slack Notification Sent' : 'Slack Notification Failed',
          details: `${e.title}${settings.channelLabel ? ` to ${settings.channelLabel}` : ''}`,
          reason: r.ok ? undefined : r.error,
          correlationId: e.id,
        });
      }),
    );
  }

  private track(p: Promise<unknown> | undefined): void {
    if (!p) return;
    const tracked = p.catch(() => undefined).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * Waits for whatever is still being written, for at most `ms`. Called on the way out of the
   * process, where "the row was lost" is acceptable and "the process hung on exit" is not.
   */
  async flush(ms = 3_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
    ]);
  }
}

/* ────────────────────────── Health, as a state machine ───────────────────── */

export type HealthState = 'healthy' | 'running' | 'stopped' | 'paused' | 'warning' | 'failed' | 'recovering';

/**
 * The state the dashboard names, from what the orchestrator can observe about itself. Pure, so the
 * transitions are testable without a process.
 */
export function deriveHealth(input: {
  paused: boolean;
  supabaseReachable: boolean;
  sinkFailures: number;
  sinkFailuresBefore: number;
  slackFailures: number;
  slackFailuresBefore: number;
  mcpSessions: number;
}): { state: HealthState; reason: string } {
  if (input.paused) return { state: 'paused', reason: 'Paused by an administrator' };
  if (!input.supabaseReachable) return { state: 'failed', reason: 'Database is unreachable' };
  if (input.sinkFailures > input.sinkFailuresBefore) {
    return { state: 'warning', reason: 'Some event records could not be saved' };
  }
  if (input.slackFailures > input.slackFailuresBefore) {
    return { state: 'warning', reason: 'Some Slack notifications could not be sent' };
  }
  return { state: 'healthy', reason: 'All services available' };
}
