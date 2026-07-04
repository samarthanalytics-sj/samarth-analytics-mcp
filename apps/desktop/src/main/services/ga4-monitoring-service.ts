// Background GA4 monitoring scheduler. On a timer (and on demand) it fetches fresh GA4 data for the
// chosen property, runs the pure monitorGa4() engine, and — for issues that are NEW since the last run
// — posts a Slack alert and broadcasts the run to the renderer. Mirrors MonitorService (GTM) in shape:
// single active target, JSON-persisted config, reentrancy-guarded runOnce, unref'd timer. Read-only
// against GA4; the only outbound write is the Slack webhook POST.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { monitorGa4, firstMetric, noSourceSharePct, type Ga4MonitorInput } from '../google/ga4-monitor';
import { buildSlackPayload, buildSlackTestPayload, sendSlackWebhook, isValidSlackWebhook, type FetchLike } from './slack-notify';
import { withQuotaRetry } from '../google/quota-retry';
import type { GoogleDataService } from '../google/data-service';
import type { AccountView, Ga4MonitorConfig, Ga4MonitorRun, Ga4MonitorStatus } from '../../shared/ipc';

const MIN_INTERVAL_MINUTES = 15; // GA4 realtime + report quota — never hammer the API
const DEFAULT_CONFIG: Ga4MonitorConfig = { enabled: false, intervalMinutes: 60, propertyId: null, propertyLabel: '', days: 28, slackEnabled: true, slackLabel: '' };

/** Per-account secret ref for the Slack webhook (the URL is stored encrypted in the OS keychain). */
export const slackWebhookRef = (accountId: string): string => `ga4-slack-webhook:${accountId}`;

const YMD = (offsetDays: number, base: Date): string => {
  const d = new Date(base.getTime() - offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const hasEcommerce = (eventNames: string[]): boolean =>
  eventNames.some((n) => /purchase|add_to_cart|begin_checkout|view_item|add_payment_info/i.test(n));

/** Fetch everything monitorGa4() needs, best-effort — every query is caught so one failure degrades a
 *  check to "skipped" rather than failing the whole run. `now` is injected for deterministic dates. */
export async function gatherGa4MonitorInput(
  data: GoogleDataService,
  property: string,
  days: number,
  now: () => number = Date.now
): Promise<Ga4MonitorInput> {
  const base = new Date(now());
  const startDate = YMD(days, base);
  const endDate = YMD(0, base);

  const [snap, dqCounts, realtime, baseline] = await Promise.all([
    withQuotaRetry(() => data.getGa4PropertySnapshot(property)).catch(() => null),
    withQuotaRetry(() => data.getGa4DataQuality(property, days)).catch(() => null),
    data.runGa4RealtimeReport({ property, dimensions: [], metrics: ['activeUsers'] }).catch(() => null),
    withQuotaRetry(() => data.getGa4Baseline(property, startDate, endDate)).catch(() => null),
  ]);

  const keyEventNames = (snap?.keyEvents ?? []).map((k) => k.eventName);
  const ecom = hasEcommerce(keyEventNames);
  // Event deltas + transactions use the resolved data-quality window when available (matches the audit).
  const sd = dqCounts?.startDate ?? startDate;
  const ed = dqCounts?.endDate ?? endDate;
  // Prior-window data-quality (for consent/attribution DRIFT) — only when the baseline gave us prior
  // bounds. A separate report over the prior equal window; best-effort like the rest.
  const priorDqP =
    baseline?.priorStartDate && baseline?.priorEndDate
      ? withQuotaRetry(() => data.getGa4DataQuality(property, { startDate: baseline.priorStartDate, endDate: baseline.priorEndDate })).catch(() => null)
      : Promise.resolve(null);

  const [eventDeltas, transactions, priorDq] = await Promise.all([
    withQuotaRetry(() => data.getGa4EventDeltas(property, sd, ed)).catch(() => null),
    ecom ? withQuotaRetry(() => data.getGa4Transactions(property, sd, ed)).catch(() => null) : Promise.resolve(null),
    priorDqP,
  ]);

  return {
    property,
    realtimeActiveUsers: firstMetric(realtime),
    baseline,
    dqCounts,
    eventDeltas: eventDeltas ? { events: eventDeltas.events, keyEventNames } : null,
    transactions,
    keyEventNames,
    hasEcommerce: ecom,
    priorNoSourceShare: priorDq ? noSourceSharePct(priorDq) : null,
  };
}

interface RegistryLike {
  getActiveView(): AccountView | null;
}
interface SecretsLike {
  get(ref: string): string | null;
  has(ref: string): boolean;
  set(ref: string, value: string): void;
  delete(ref: string): void;
  available(): boolean;
}

export interface Ga4MonitoringDeps {
  registry: RegistryLike;
  data: GoogleDataService;
  secrets: SecretsLike;
  /** Broadcast a completed run to the renderer (main wires this to webContents.send). */
  emit: (run: Ga4MonitorRun) => void;
  now?: () => number;
  configPath?: string;
  /** Injectable fetch for Slack (tests); defaults to the global fetch. */
  slackFetch?: FetchLike;
}

export class Ga4MonitoringService {
  private config: Ga4MonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private lastRun: Ga4MonitorRun | null = null;
  /** ids of the alerts seen on the previous run — an issue only Slacks when it first appears. */
  private lastSeenIds = new Set<string>();
  private inFlight: Promise<Ga4MonitorRun | null> | null = null;

  constructor(private readonly deps: Ga4MonitoringDeps) {
    const loaded = deps.configPath ? readJsonFile<Ga4MonitorConfig>(deps.configPath, DEFAULT_CONFIG) : DEFAULT_CONFIG;
    this.config = this.normalize(loaded);
    if (this.config.enabled && this.config.propertyId) this.start(true);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private normalize(c: Partial<Ga4MonitorConfig> | null): Ga4MonitorConfig {
    return {
      enabled: Boolean(c?.enabled),
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(c?.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes)),
      propertyId: c?.propertyId ? String(c.propertyId) : null,
      propertyLabel: c?.propertyLabel ? String(c.propertyLabel) : '',
      days: Math.min(365, Math.max(1, Math.floor(Number(c?.days) || DEFAULT_CONFIG.days))),
      slackEnabled: c?.slackEnabled === undefined ? true : Boolean(c.slackEnabled),
      slackLabel: c?.slackLabel ? String(c.slackLabel).slice(0, 120) : '',
    };
  }

  private webhookRefForActive(): string | null {
    const active = this.deps.registry.getActiveView();
    return active ? slackWebhookRef(active.id) : null;
  }

  status(): Ga4MonitorStatus {
    const ref = this.webhookRefForActive();
    return {
      ...this.config,
      running: this.timer !== null,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      hasWebhook: ref ? this.deps.secrets.has(ref) : false,
      lastRun: this.lastRun,
    };
  }

  /** Update config; persist; (re)start the timer. Runs an immediate check only on a fresh
   *  disabled→enabled transition (or when a property is newly set), so editing the interval alone
   *  never triggers an extra API burst. */
  configure(patch: Partial<Ga4MonitorConfig>): Ga4MonitorStatus {
    const wasActive = this.config.enabled && Boolean(this.config.propertyId);
    this.config = this.normalize({ ...this.config, ...patch });
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    this.stop();
    const nowActive = this.config.enabled && Boolean(this.config.propertyId);
    if (nowActive) this.start(!wasActive);
    return this.status();
  }

  /** Store (or replace) the Slack webhook URL for the active account. Validates it's a Slack
   *  Incoming Webhook before persisting. */
  setWebhook(url: string): Ga4MonitorStatus {
    const ref = this.webhookRefForActive();
    if (!ref) throw new Error('No active account to attach a Slack webhook to.');
    const trimmed = (url ?? '').trim();
    if (!isValidSlackWebhook(trimmed)) throw new Error('That is not a valid Slack Incoming Webhook URL (expected https://hooks.slack.com/services/...).');
    if (!this.deps.secrets.available()) throw new Error('OS secret encryption is unavailable, so the webhook cannot be stored securely.');
    this.deps.secrets.set(ref, trimmed);
    return this.status();
  }

  clearWebhook(): Ga4MonitorStatus {
    const ref = this.webhookRefForActive();
    if (ref) this.deps.secrets.delete(ref);
    return this.status();
  }

  /** Post a confirmation message to the stored webhook so the user can SEE which channel/workspace it
   *  lands in (Slack does not expose that from the URL). Returns a structured result, never throws. */
  async sendTest(): Promise<{ ok: boolean; error: string | null }> {
    const ref = this.webhookRefForActive();
    const webhook = ref ? this.deps.secrets.get(ref) : null;
    if (!webhook) return { ok: false, error: 'No Slack webhook is saved for this account.' };
    const label = this.config.propertyLabel || this.config.propertyId || 'your GA4 property';
    const res = await sendSlackWebhook(webhook, buildSlackTestPayload(label), { fetchImpl: this.deps.slackFetch });
    return { ok: res.ok, error: res.ok ? null : res.error ?? 'Slack send failed.' };
  }

  start(runNow = false): void {
    if (this.timer) return;
    const ms = this.config.intervalMinutes * 60_000;
    this.timer = setInterval(() => void this.runOnce(), ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    if (runNow) void this.runOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one monitor cycle. Reentrancy-guarded (a timer tick, boot run and manual "Run now" join the
   *  same in-flight run). Returns the run, or null when there's nothing to monitor. */
  runOnce(): Promise<Ga4MonitorRun | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnceInner().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceInner(): Promise<Ga4MonitorRun | null> {
    const active = this.deps.registry.getActiveView();
    const property = this.config.propertyId;
    if (!active || !active.hasGoogleToken || !property) return null;
    try {
      const input = await gatherGa4MonitorInput(this.deps.data, property, this.config.days, () => this.now());
      // The desktop tab shows ALL alert types (no severity gate); the minSeverity knob stays on the
      // monitor_ga4_property MCP tool for headless callers that want to filter.
      const result = monitorGa4(input, { minSeverity: 'info' });
      const at = this.now();
      this.lastRunAt = at;
      this.lastError = null;

      const newAlerts = result.alerts.filter((a) => !this.lastSeenIds.has(a.id));
      this.lastSeenIds = new Set(result.alerts.map((a) => a.id));

      let slackSent = 0;
      let slackError: string | null = null;
      const ref = slackWebhookRef(active.id);
      if (this.config.slackEnabled && newAlerts.length && this.deps.secrets.has(ref)) {
        const webhook = this.deps.secrets.get(ref);
        if (webhook) {
          const label = this.config.propertyLabel || property;
          const send = await sendSlackWebhook(webhook, buildSlackPayload(label, result, newAlerts), { fetchImpl: this.deps.slackFetch });
          if (send.ok) slackSent = 1;
          else slackError = send.error ?? 'Slack send failed.';
        }
      }

      const run: Ga4MonitorRun = {
        at,
        property,
        propertyLabel: this.config.propertyLabel || property,
        health: result.health,
        summary: result.summary,
        checks: result.checks,
        alerts: result.alerts,
        newAlertIds: newAlerts.map((a) => a.id),
        slackSent,
        slackError,
      };
      this.lastRun = run;
      this.deps.emit(run);
      return run;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}
