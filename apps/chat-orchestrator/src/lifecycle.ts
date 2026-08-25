/**
 * The moving parts around events.ts: where the Slack switches come from, what the supervisor left
 * behind about the last stop, and the periodic self-check that turns "is it healthy" into a state
 * with a reason.
 *
 * Kept out of events.ts so that file stays pure. Everything here touches a clock, a file or the
 * network, and each piece takes its dependency as an argument so the tests can hand it a fake.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forLog } from './redact.js';
import {
  DEFAULT_SLACK_SETTINGS,
  deriveHealth,
  parseSlackSettings,
  type EventRecorder,
  type HealthState,
  type SlackSettings,
} from './events.js';

/* ────────────────────────── Slack settings poller ────────────────────────── */

export const SLACK_SETTINGS_KEY = 'orchestrator.slack';
export const SETTINGS_POLL_MS = 60_000;

/**
 * Reads the admin's Slack switches from system_settings, once a minute.
 *
 * Polling rather than realtime because this process already holds no websocket to Supabase and a
 * one-minute lag on a notification switch is nothing. The last good value is kept across a failed
 * read, so a database blip does not silently switch notifications off.
 */
export class SettingsPoller {
  private settings: SlackSettings = DEFAULT_SLACK_SETTINGS;
  private raw = '';
  private timer: NodeJS.Timeout | null = null;
  private lastOk = false;
  private lastError = '';
  readonly enabled: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly onChange: (next: SlackSettings, first: boolean) => void = () => undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Called with the webhook stored in Vault, or '' when there is none. */
    private readonly onWebhook: (url: string, first: boolean) => void = () => undefined,
  ) {
    this.enabled = Boolean(baseUrl && serviceRoleKey);
  }

  /**
   * The webhook from Vault, through a function only the service role may call.
   *
   * Returns null when it cannot be read at all, which is different from '' meaning "none is set":
   * a database blip must not look like an admin clearing the webhook.
   */
  async fetchWebhook(): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/orchestrator_slack_webhook`, {
        method: 'POST',
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(8_000),
      });
      // 404 is the migration not being applied yet, which is a deployment state rather than an
      // error worth logging every minute.
      if (res.status === 404) return '';
      if (!res.ok) throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 160)}`);
      const value = (await res.json()) as unknown;
      return typeof value === 'string' ? value : '';
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  current(): SlackSettings {
    return this.settings;
  }

  /** Whether the last read succeeded. The health check reads this as "is the database reachable". */
  reachable(): boolean {
    return this.lastOk;
  }

  error(): string {
    return this.lastError;
  }

  async refresh(): Promise<{ ok: boolean; changed: boolean; error?: string }> {
    if (!this.enabled) return { ok: false, changed: false, error: 'Supabase is not configured.' };
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/rest/v1/system_settings?key=eq.${encodeURIComponent(SLACK_SETTINGS_KEY)}&select=value`,
        {
          headers: { apikey: this.serviceRoleKey, Authorization: `Bearer ${this.serviceRoleKey}` },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 160)}`);
      const rows = (await res.json()) as Array<{ value?: unknown }>;
      const value = rows[0]?.value;
      const raw = JSON.stringify(value ?? null);
      const first = !this.lastOk && this.raw === '';
      const changed = raw !== this.raw;
      this.lastOk = true;
      this.lastError = '';
      if (changed) {
        this.raw = raw;
        this.settings = parseSlackSettings(value);
        this.onChange(this.settings, first);
      }
      // Read in the same pass so a webhook saved from the admin screen and the switch that turns it
      // on arrive together, rather than a minute apart.
      const webhook = await this.fetchWebhook();
      if (webhook !== null) this.onWebhook(webhook, first);
      return { ok: true, changed };
    } catch (err) {
      this.lastOk = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, changed: false, error: this.lastError };
    }
  }

  start(intervalMs = SETTINGS_POLL_MS): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/* ─────────────────────── What the supervisor left behind ─────────────────── */

export interface LastExit {
  /** ISO time the child exited. */
  at: string;
  code: number | null;
  signal: string | null;
  planned: boolean;
  reason: string;
  ranForMs: number;
  fastExits: number;
  /** True when the dying process already recorded this stop, so reporting it again would double up. */
  selfReported?: boolean;
}

export const LAST_EXIT_FILE = 'last-exit.json';
/**
 * Written by the crash handler when the process managed to record its own death.
 *
 * Without it a single crash is reported twice: once by the dying process, which has the stack
 * trace, and again by the next run reading the supervisor's note, which has the duration. Both are
 * true and the second is redundant, and with Slack on it is two pages for one stop.
 */
export const SELF_REPORTED_FILE = 'last-crash-reported.json';

/**
 * Reads and clears the note the supervisor writes when the previous run ended.
 *
 * The orchestrator's own shutdown handler is unreachable on the Windows host (every external stop
 * is TerminateProcess), so the stop is reported by the next run, from this file. Deleted on read so
 * a restart can never report the same stop twice.
 */
export function readLastExit(logDir: string): LastExit | null {
  const path = join(logDir, LAST_EXIT_FILE);
  if (!existsSync(path)) return null;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Losing this race means a duplicate line at worst.
    }
  }
  const exit = parseLastExit(raw);
  if (!exit) return null;
  return { ...exit, selfReported: consumeSelfReported(logDir, exit.at) };
}

/**
 * Whether the process that just died already said so itself, within a minute of the supervisor
 * noticing. The marker is always cleared, including when it is too old to believe: one left behind
 * would suppress the report of a later crash, which is the one failure mode worse than a duplicate.
 */
export function consumeSelfReported(logDir: string, exitAt: string): boolean {
  const path = join(logDir, SELF_REPORTED_FILE);
  if (!existsSync(path)) return false;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // As above: a duplicate at worst.
    }
  }
  try {
    const at = Date.parse((JSON.parse(raw) as { at?: string }).at ?? '');
    if (Number.isNaN(at)) return false;
    return Math.abs(Date.parse(exitAt) - at) <= 60_000;
  } catch {
    return false;
  }
}

export function markSelfReported(logDir: string, reason: string): void {
  try {
    writeFileSync(join(logDir, SELF_REPORTED_FILE), JSON.stringify({ at: new Date().toISOString(), reason }), 'utf8');
  } catch {
    // The cost of failing here is one duplicate message, so it must not get in the way of dying.
  }
}

export function parseLastExit(raw: string): LastExit | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  const at = typeof p.at === 'string' && !Number.isNaN(new Date(p.at).getTime()) ? p.at : null;
  if (!at) return null;
  return {
    at,
    code: typeof p.code === 'number' ? p.code : null,
    signal: typeof p.signal === 'string' ? p.signal : null,
    planned: p.planned === true,
    reason: typeof p.reason === 'string' && p.reason ? p.reason : '',
    ranForMs: typeof p.ranForMs === 'number' && p.ranForMs >= 0 ? p.ranForMs : 0,
    fastExits: typeof p.fastExits === 'number' ? p.fastExits : 0,
  };
}

/**
 * The package's logs/ directory, found from this module rather than the working directory.
 *
 * Compiled output lives at dist/chat-orchestrator/src and source at src, so the distance to the
 * package root differs; walking up to the directory holding scripts/supervise.mjs works for both.
 */
export function packageLogDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'scripts', 'supervise.mjs'))) return join(dir, 'logs');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'logs');
}

/* ───────────────────────────── Crash handlers ────────────────────────────── */

/**
 * An uncaught error is recorded, flushed and then fatal, in that order.
 *
 * Node's default for both is to print and exit, which is right: a process in an unknown state
 * should not keep serving. What was missing is the record. Without this, the only trace of a crash
 * is the supervisor's "exited UNEXPECTEDLY" line, which says that it died and nothing about why.
 * The flush is bounded so a crash cannot turn into a hang.
 */
export function installCrashHandlers(
  recorder: EventRecorder,
  exit: (code: number) => void = (code) => process.exit(code),
  logDir: string = packageLogDir(),
): void {
  const die = (kind: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : message;
    console.error(`[orchestrator] ${kind}:`, stack);
    // Before the record, not after: if writing the row hangs, the next run must still know this
    // stop was already accounted for.
    markSelfReported(logDir, kind);
    recorder.record({
      type: 'orchestrator.unexpected_shutdown',
      status: 'stopped',
      severity: 'critical',
      title: 'Orchestrator Unexpected Shutdown',
      reason: kind === 'uncaughtException' ? 'Unhandled error in the process' : 'Unhandled promise rejection',
      details: forLog(message, 200),
      error: stack,
      action: 'The supervisor will restart it',
    });
    void recorder.flush(3_000).finally(() => exit(1));
  };
  process.on('uncaughtException', (err) => die('uncaughtException', err));
  process.on('unhandledRejection', (err) => die('unhandledRejection', err));
}

/* ───────────────────────────── Health monitor ────────────────────────────── */

export const HEALTH_TICK_MS = 10 * 60_000;

export interface HealthProbe {
  paused: () => boolean;
  supabaseReachable: () => boolean;
  sinkFailures: () => number;
  slackFailures: () => number;
  mcpSessions: () => number;
}

/**
 * Turns what the process can see about itself into the states the dashboard names, and records a
 * change of state as an event. A steady state is one `health.completed` per tick, so the record
 * shows the checks happened; a change is `health.changed`, and a return to healthy after a failure
 * is `orchestrator.recovered`, which is the one people want in Slack.
 */
export class HealthMonitor {
  private state: HealthState = 'running';
  private reason = 'Starting';
  private sinkFailuresSeen = 0;
  private slackFailuresSeen = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly probe: HealthProbe,
    private readonly recorder: EventRecorder,
  ) {}

  current(): { state: HealthState; reason: string } {
    return { state: this.state, reason: this.reason };
  }

  /** One check. Public so the test endpoint and the tests can call it directly. */
  tick(): { state: HealthState; reason: string } {
    const sinkFailures = this.probe.sinkFailures();
    const slackFailures = this.probe.slackFailures();
    const next = deriveHealth({
      paused: this.probe.paused(),
      supabaseReachable: this.probe.supabaseReachable(),
      sinkFailures,
      sinkFailuresBefore: this.sinkFailuresSeen,
      slackFailures,
      slackFailuresBefore: this.slackFailuresSeen,
      mcpSessions: this.probe.mcpSessions(),
    });
    this.sinkFailuresSeen = sinkFailures;
    this.slackFailuresSeen = slackFailures;

    const previous = this.state;
    this.state = next.state;
    this.reason = next.reason;

    if (next.state === previous || (previous === 'running' && next.state === 'healthy')) {
      this.recorder.record({
        type: next.state === 'failed' ? 'health.failed' : 'health.completed',
        status: next.state === 'failed' ? 'failed' : next.state === 'warning' ? 'warning' : 'healthy',
        title: 'Health Check',
        reason: next.reason,
        details: `${this.probe.mcpSessions()} MCP session(s) open`,
      });
      return next;
    }

    // A change of state is the event; the check itself is the detail.
    if (next.state === 'healthy' && (previous === 'failed' || previous === 'warning')) {
      this.recorder.record({
        type: 'orchestrator.recovered',
        status: 'recovered',
        title: 'Orchestrator Recovered',
        reason: next.reason,
        details: `Was: ${previous}.`,
      });
    } else {
      this.recorder.record({
        type: next.state === 'failed' ? 'health.failed' : 'health.changed',
        status: next.state === 'failed' ? 'failed' : next.state === 'paused' ? 'paused' : 'warning',
        severity: next.state === 'failed' ? 'error' : 'warning',
        title: 'Health Status Changed',
        reason: next.reason,
        details: `Now ${next.state}, was ${previous}.`,
      });
    }
    return next;
  }

  start(intervalMs = HEALTH_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
