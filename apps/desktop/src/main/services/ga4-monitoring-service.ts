// Background GA4 monitoring scheduler. On a timer (and on demand) it sweeps the LIST of monitored
// properties sequentially: for each enabled target it fetches fresh GA4 data, runs the pure
// monitorGa4() engine, and — for issues that are NEW since that property's last run — posts a Slack
// alert and broadcasts the run to the renderer. Mirrors MonitorService (GTM) in shape: JSON-persisted
// config, reentrancy-guarded sweeps, unref'd timer. Read-only against GA4; the only outbound write is
// the Slack webhook POST. Older single-property configs ({propertyId, propertyLabel}) migrate to a
// one-entry targets list on load.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { monitorGa4, firstMetric, noSourceSharePct, type Ga4MonitorInput } from '../google/ga4-monitor';
import { buildSlackPayload, buildSlackTestPayload, sendSlackWebhook, isValidSlackWebhook, type FetchLike } from './slack-notify';
import { withQuotaRetry } from '../google/quota-retry';
import type { GoogleDataService } from '../google/data-service';
import type { AccountView, Ga4MonitorConfig, Ga4MonitorRun, Ga4MonitorStatus, Ga4MonitorTarget, Ga4MonitorTargetStatus } from '../../shared/ipc';

const MIN_INTERVAL_MINUTES = 15; // GA4 realtime + report quota — never hammer the API
// Each target costs ~7 GA4 API calls per sweep, so the list is capped to keep a 15-min interval sane.
const MAX_TARGETS = 10;
const DEFAULT_CONFIG: Ga4MonitorConfig = { enabled: false, intervalMinutes: 60, targets: [], days: 28, slackEnabled: true, slackLabel: '' };

/** Per-account secret ref for the DEFAULT Slack webhook (encrypted in the OS keychain). Properties
 *  without their own channel post here. */
export const slackWebhookRef = (accountId: string): string => `ga4-slack-webhook:${accountId}`;
/** Per-account+property secret ref for a property's OWN Slack channel (one property, one channel). */
export const slackWebhookRefForProperty = (accountId: string, propertyId: string): string => `ga4-slack-webhook:${accountId}:${propertyId}`;

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

/** Per-target runtime state — the alert-dedup memory and latest run live PER PROPERTY so one
 *  property's ongoing issue never suppresses (or re-triggers) another's. */
interface TargetState {
  lastRunAt: number | null;
  lastError: string | null;
  lastRun: Ga4MonitorRun | null;
  /** When this property's alerts last actually POSTED to Slack (not tests). */
  lastSlackAt: number | null;
  seenIds: Set<string>;
}

export class Ga4MonitoringService {
  private config: Ga4MonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private state = new Map<string, TargetState>();
  private inFlight: Promise<Ga4MonitorRun[]> | null = null;

  constructor(private readonly deps: Ga4MonitoringDeps) {
    const loaded = deps.configPath ? readJsonFile<Ga4MonitorConfig>(deps.configPath, DEFAULT_CONFIG) : DEFAULT_CONFIG;
    this.config = this.normalize(loaded);
    if (this.isActive()) this.start(true);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private isActive(): boolean {
    return this.config.enabled && this.config.targets.some((t) => t.enabled);
  }

  private normalizeTargets(c: Partial<Ga4MonitorConfig> | null): Ga4MonitorTarget[] {
    const raw = Array.isArray(c?.targets) ? c.targets : [];
    const seen = new Set<string>();
    const targets: Ga4MonitorTarget[] = [];
    for (const t of raw) {
      const id = t && typeof t === 'object' && (t as Ga4MonitorTarget).propertyId ? String((t as Ga4MonitorTarget).propertyId) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      targets.push({
        propertyId: id,
        propertyLabel: (t as Ga4MonitorTarget).propertyLabel ? String((t as Ga4MonitorTarget).propertyLabel).slice(0, 200) : '',
        enabled: (t as Ga4MonitorTarget).enabled === undefined ? true : Boolean((t as Ga4MonitorTarget).enabled),
        slackLabel: (t as Ga4MonitorTarget).slackLabel ? String((t as Ga4MonitorTarget).slackLabel).slice(0, 120) : undefined,
      });
      if (targets.length >= MAX_TARGETS) break;
    }
    // Legacy single-property config ({propertyId, propertyLabel}) → a one-entry list, so an existing
    // installation keeps monitoring what it was monitoring.
    const legacy = c as Partial<Ga4MonitorConfig> & { propertyId?: string | null; propertyLabel?: string };
    if (!targets.length && legacy?.propertyId) {
      targets.push({ propertyId: String(legacy.propertyId), propertyLabel: legacy.propertyLabel ? String(legacy.propertyLabel) : '', enabled: true });
    }
    return targets;
  }

  private normalize(c: Partial<Ga4MonitorConfig> | null): Ga4MonitorConfig {
    return {
      enabled: Boolean(c?.enabled),
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(c?.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes)),
      targets: this.normalizeTargets(c),
      days: Math.min(365, Math.max(1, Math.floor(Number(c?.days) || DEFAULT_CONFIG.days))),
      slackEnabled: c?.slackEnabled === undefined ? true : Boolean(c.slackEnabled),
      slackLabel: c?.slackLabel ? String(c.slackLabel).slice(0, 120) : '',
    };
  }

  private webhookRefForActive(): string | null {
    const active = this.deps.registry.getActiveView();
    return active ? slackWebhookRef(active.id) : null;
  }

  private propertyWebhookRefForActive(propertyId: string): string | null {
    const active = this.deps.registry.getActiveView();
    return active ? slackWebhookRefForProperty(active.id, propertyId) : null;
  }

  /** The webhook a property's alerts POST to: its OWN channel, or null (one property, one channel —
   *  there is no shared/default channel any more). */
  private webhookForTarget(accountId: string, propertyId: string): string | null {
    const own = slackWebhookRefForProperty(accountId, propertyId);
    return this.deps.secrets.has(own) ? this.deps.secrets.get(own) : null;
  }

  /** One-time migration away from the removed DEFAULT channel: if the account still holds a legacy
   *  account-level webhook, copy it to every monitored property that has no channel of its own
   *  (inheriting the old global channel label), then delete the legacy secret. Idempotent; runs
   *  lazily whenever an active account is known, and only once targets exist so the URL is never
   *  discarded with nowhere to go. */
  private migrateDefaultWebhook(accountId: string): void {
    const defRef = slackWebhookRef(accountId);
    if (!this.deps.secrets.has(defRef) || !this.config.targets.length) return;
    const url = this.deps.secrets.get(defRef);
    if (url) {
      let labelChanged = false;
      for (const t of this.config.targets) {
        const own = slackWebhookRefForProperty(accountId, t.propertyId);
        if (!this.deps.secrets.has(own)) {
          this.deps.secrets.set(own, url);
          if (!t.slackLabel && this.config.slackLabel) {
            t.slackLabel = this.config.slackLabel;
            labelChanged = true;
          }
        }
      }
      if (labelChanged && this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    }
    this.deps.secrets.delete(defRef);
  }

  private stateFor(propertyId: string): TargetState {
    let s = this.state.get(propertyId);
    if (!s) {
      s = { lastRunAt: null, lastError: null, lastRun: null, lastSlackAt: null, seenIds: new Set() };
      this.state.set(propertyId, s);
    }
    return s;
  }

  status(): Ga4MonitorStatus {
    const active = this.deps.registry.getActiveView();
    if (active) this.migrateDefaultWebhook(active.id);
    const ref = this.webhookRefForActive();
    const targetStatuses: Ga4MonitorTargetStatus[] = this.config.targets.map((t) => {
      const s = this.state.get(t.propertyId);
      const ownRef = this.propertyWebhookRefForActive(t.propertyId);
      return { ...t, lastRunAt: s?.lastRunAt ?? null, lastError: s?.lastError ?? null, lastRun: s?.lastRun ?? null, hasWebhook: ownRef ? this.deps.secrets.has(ownRef) : false, lastSlackAt: s?.lastSlackAt ?? null };
    });
    const lastRunAt = targetStatuses.reduce<number | null>((m, t) => (t.lastRunAt !== null && (m === null || t.lastRunAt > m) ? t.lastRunAt : m), null);
    const lastSlackAt = targetStatuses.reduce<number | null>((m, t) => (t.lastSlackAt !== null && (m === null || t.lastSlackAt > m) ? t.lastSlackAt : m), null);
    return {
      ...this.config,
      running: this.timer !== null,
      lastRunAt,
      lastError: this.lastError,
      hasWebhook: ref ? this.deps.secrets.has(ref) : false,
      lastSlackAt,
      targetStatuses,
    };
  }

  /** Update config; persist; (re)start the timer. An immediate check runs only on a fresh
   *  disabled→enabled transition (all targets) or for NEWLY ADDED targets while active — editing the
   *  interval alone never triggers an extra API burst. */
  configure(patch: Partial<Ga4MonitorConfig>): Ga4MonitorStatus {
    const wasActive = this.isActive();
    const prevIds = new Set(this.config.targets.map((t) => t.propertyId));
    this.config = this.normalize({ ...this.config, ...patch });
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    // Drop runtime state AND the per-property Slack webhook for removed targets, so a re-add starts
    // with a clean alert-dedup slate and no orphaned channel secret lingers in the keychain.
    const ids = new Set(this.config.targets.map((t) => t.propertyId));
    for (const id of prevIds) {
      if (ids.has(id)) continue;
      this.state.delete(id);
      const ref = this.propertyWebhookRefForActive(id);
      if (ref) this.deps.secrets.delete(ref);
    }
    this.stop();
    if (this.isActive()) {
      this.start(!wasActive);
      if (wasActive) {
        // Already running and still running: give any brand-new enabled targets an immediate first
        // check so adding a property shows results without waiting a full interval.
        const added = this.config.targets.filter((t) => t.enabled && !prevIds.has(t.propertyId)).map((t) => t.propertyId);
        if (added.length) void this.runOnce(added);
      }
    }
    return this.status();
  }

  /** Store (or replace) a Slack webhook URL for the active account — the DEFAULT channel when no
   *  propertyId is given, or a property's OWN channel (one property, one channel) when it is.
   *  Validates it's a Slack Incoming Webhook before persisting. */
  setWebhook(url: string, propertyId?: string): Ga4MonitorStatus {
    const ref = propertyId ? this.propertyWebhookRefForActive(propertyId) : this.webhookRefForActive();
    if (!ref) throw new Error('No active account to attach a Slack webhook to.');
    const trimmed = (url ?? '').trim();
    if (!isValidSlackWebhook(trimmed)) throw new Error('That is not a valid Slack Incoming Webhook URL (expected https://hooks.slack.com/services/...).');
    if (!this.deps.secrets.available()) throw new Error('OS secret encryption is unavailable, so the webhook cannot be stored securely.');
    this.deps.secrets.set(ref, trimmed);
    return this.status();
  }

  /** Remove a property's channel (its alerts stop posting until a new one is connected). Also clears
   *  the property's channel label so no stale name lingers. Without a propertyId it removes any
   *  leftover legacy account-level webhook. */
  clearWebhook(propertyId?: string): Ga4MonitorStatus {
    const ref = propertyId ? this.propertyWebhookRefForActive(propertyId) : this.webhookRefForActive();
    if (ref) this.deps.secrets.delete(ref);
    if (propertyId) {
      this.config = this.normalize({ ...this.config, targets: this.config.targets.map((t) => (t.propertyId === propertyId ? { ...t, slackLabel: undefined } : t)) });
      if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    }
    return this.status();
  }

  /** Post a confirmation message so the user can SEE which channel/workspace it lands in (Slack does
   *  not expose that from the URL). Tests the property's OWN channel — one property, one channel.
   *  Returns a structured result, never throws. */
  async sendTest(propertyId?: string): Promise<{ ok: boolean; error: string | null }> {
    const active = this.deps.registry.getActiveView();
    if (!active) return { ok: false, error: 'No active account.' };
    this.migrateDefaultWebhook(active.id);
    if (!propertyId) return { ok: false, error: 'Pick a property to test — each property has its own Slack channel.' };
    const webhook = this.webhookForTarget(active.id, propertyId);
    const t = this.config.targets.find((x) => x.propertyId === propertyId);
    const label = t?.propertyLabel || propertyId;
    if (!webhook) return { ok: false, error: 'No Slack channel is connected for this property.' };
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

  /** Run one monitor sweep over the enabled targets (or the subset in `only`). Reentrancy-guarded:
   *  a timer tick, boot run and manual "Run now" join the same in-flight sweep. Returns the runs
   *  produced (empty when there's nothing to monitor). Targets are checked SEQUENTIALLY so N
   *  properties never burst N×7 GA4 calls at once; one target failing degrades to its own lastError
   *  and never stops the rest of the sweep. */
  runOnce(only?: string | string[]): Promise<Ga4MonitorRun[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnceInner(only).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceInner(only?: string | string[]): Promise<Ga4MonitorRun[]> {
    const active = this.deps.registry.getActiveView();
    if (!active || !active.hasGoogleToken) return [];
    // Background sweeps may run before the tab is ever opened — migrate the legacy default webhook
    // here too so alerts keep flowing to the (now per-property) channels.
    this.migrateDefaultWebhook(active.id);
    const wanted = only === undefined ? null : new Set(Array.isArray(only) ? only : [only]);
    // A manual "Run now" on a paused target still runs it (the user asked); the timer only sweeps
    // enabled ones (wanted === null).
    const targets = this.config.targets.filter((t) => (wanted ? wanted.has(t.propertyId) : t.enabled));
    if (!targets.length) return [];

    const runs: Ga4MonitorRun[] = [];
    let sweepError: string | null = null;
    for (const target of targets) {
      const st = this.stateFor(target.propertyId);
      try {
        const input = await gatherGa4MonitorInput(this.deps.data, target.propertyId, this.config.days, () => this.now());
        // The desktop tab shows ALL alert types (no severity gate); the minSeverity knob stays on the
        // monitor_ga4_property MCP tool for headless callers that want to filter.
        const result = monitorGa4(input, { minSeverity: 'info' });
        const at = this.now();
        st.lastRunAt = at;
        st.lastError = null;

        const newAlerts = result.alerts.filter((a) => !st.seenIds.has(a.id));
        st.seenIds = new Set(result.alerts.map((a) => a.id));

        let slackSent = 0;
        let slackError: string | null = null;
        if (this.config.slackEnabled && newAlerts.length) {
          // One property, one channel: the property's OWN webhook wins; the account default is the
          // fallback for properties that never connected their own.
          const webhook = this.webhookForTarget(active.id, target.propertyId);
          if (webhook) {
            const label = target.propertyLabel || target.propertyId;
            const send = await sendSlackWebhook(webhook, buildSlackPayload(label, result, newAlerts), { fetchImpl: this.deps.slackFetch });
            if (send.ok) { slackSent = 1; st.lastSlackAt = at; }
            else slackError = send.error ?? 'Slack send failed.';
          }
        }

        const run: Ga4MonitorRun = {
          at,
          property: target.propertyId,
          propertyLabel: target.propertyLabel || target.propertyId,
          health: result.health,
          summary: result.summary,
          checks: result.checks,
          alerts: result.alerts,
          newAlertIds: newAlerts.map((a) => a.id),
          slackSent,
          slackError,
        };
        st.lastRun = run;
        this.deps.emit(run);
        runs.push(run);
      } catch (e) {
        st.lastError = e instanceof Error ? e.message : String(e);
        sweepError = `${target.propertyLabel || target.propertyId}: ${st.lastError}`;
      }
    }
    this.lastError = sweepError;
    return runs;
  }
}
