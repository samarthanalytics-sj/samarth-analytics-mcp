// Background GA4 monitoring scheduler. On a timer (and on demand) it sweeps the LIST of monitored
// properties sequentially: for each enabled target it fetches fresh GA4 data, runs the pure
// monitorGa4() engine, and — for issues that are NEW since that property's last run — posts a Slack
// alert and broadcasts the run to the renderer. Mirrors MonitorService (GTM) in shape: JSON-persisted
// config, reentrancy-guarded sweeps, unref'd timer. Read-only against GA4; the only outbound write is
// the Slack webhook POST. Older single-property configs ({propertyId, propertyLabel}) migrate to a
// one-entry targets list on load.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { monitorGa4, firstMetric, noSourceSharePct, type Ga4MonitorInput } from '../google/ga4-monitor';
import { buildSlackPayload, buildSlackDigestPayload, buildSlackAuditPayload, buildSlackTestPayload, sendSlackWebhook, isValidSlackWebhook, type FetchLike } from './slack-notify';
import { withQuotaRetry } from '../google/quota-retry';
import { rankGa4Campaigns } from '../google/ga4-campaigns';
import type { GoogleDataService } from '../google/data-service';
import type { AccountView, Ga4ExecSummaryView, Ga4MonitorConfig, Ga4MonitorRun, Ga4MonitorStatus, Ga4MonitorTarget, Ga4MonitorTargetStatus } from '../../shared/ipc';

const MIN_INTERVAL_MINUTES = 15; // GA4 realtime + report quota — never hammer the API
// Each target costs ~7 GA4 API calls per sweep, so the list is capped to keep a 15-min interval sane.
const MAX_TARGETS = 10;
const DEFAULT_CONFIG: Ga4MonitorConfig = { enabled: false, intervalMinutes: 60, targets: [], days: 28, slackEnabled: true, digestEnabled: false, auditEnabled: false, slackLabel: '' };
// One digest per property per week, posted after a sweep once due.
const DIGEST_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// One FULL audit per property per week (heavy: the whole audit pipeline), run after a sweep once due.
const AUDIT_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

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
 *  check to "skipped" rather than failing the whole run. The FIRST underlying error message is kept
 *  (fetchError) so a run where EVERYTHING failed can tell the user the real cause (expired session,
 *  lost property access, quota) instead of six silent skips. `now` is injected for deterministic dates. */
export async function gatherGa4MonitorInput(
  data: GoogleDataService,
  property: string,
  days: number,
  now: () => number = Date.now
): Promise<Ga4MonitorInput> {
  const base = new Date(now());
  const startDate = YMD(days, base);
  const endDate = YMD(0, base);
  const errors: string[] = [];
  const grab = <T>(p: Promise<T>): Promise<T | null> =>
    p.catch((e) => {
      errors.push(e instanceof Error ? e.message : String(e));
      return null;
    });

  const [snap, dqCounts, realtime, baseline] = await Promise.all([
    grab(withQuotaRetry(() => data.getGa4PropertySnapshot(property))),
    grab(withQuotaRetry(() => data.getGa4DataQuality(property, days))),
    grab(data.runGa4RealtimeReport({ property, dimensions: [], metrics: ['activeUsers'] })),
    grab(withQuotaRetry(() => data.getGa4Baseline(property, startDate, endDate))),
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
      ? grab(withQuotaRetry(() => data.getGa4DataQuality(property, { startDate: baseline.priorStartDate, endDate: baseline.priorEndDate })))
      : Promise.resolve(null);

  const [eventDeltas, transactions, priorDq, campaigns] = await Promise.all([
    grab(withQuotaRetry(() => data.getGa4EventDeltas(property, sd, ed))),
    ecom ? grab(withQuotaRetry(() => data.getGa4Transactions(property, sd, ed))) : Promise.resolve(null),
    priorDqP,
    // Campaign performance feeds the revenue-reconciliation + untagged-share checks (the audit's
    // HIGH finding, now watched on a schedule). Best-effort like everything else.
    grab(withQuotaRetry(() => data.getGa4CampaignPerformance(property, days)).then(rankGa4Campaigns)),
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
    fetchError: errors[0] ?? null,
    campaigns,
    snapshot: snap,
    priorChannelGroups: priorDq?.channelGroups ?? null,
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
  /** Run the FULL audit pipeline for a property (wired to runGa4AuditPipeline in main). Optional so
   *  tests and older callers work; without it the weekly-audit toggle is inert. */
  runAudit?: (property: string, days: number) => Promise<Ga4ExecSummaryView>;
  /** Probe the property's site for a live Consent Mode signal (wired to probeConsentSignal in main;
   *  injectable for tests). Optional; without it the consent-signal check never renders. */
  probeConsent?: (url: string) => Promise<{ observedHit: boolean; gcsPresent: boolean; gcs: string | null } | null>;
}

/** Per-target runtime state — the alert-dedup memory and latest run live PER PROPERTY so one
 *  property's ongoing issue never suppresses (or re-triggers) another's. */
interface TargetState {
  lastRunAt: number | null;
  lastError: string | null;
  lastRun: Ga4MonitorRun | null;
  /** When this property's alerts last actually POSTED to Slack (not tests). */
  lastSlackAt: number | null;
  /** Consent-signal probe cache: a headless page load is heavy, so at most once per 24h per target;
   *  the cached result (and the previous one, for regression detection) feed the sweeps in between. */
  consentProbeAt: number | null;
  consentProbe: { observedHit: boolean; gcsPresent: boolean; gcs: string | null } | null;
  priorGcsPresent: boolean | null;
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
    this.config = this.normalize(loaded, this.deps.registry.getActiveView()?.id ?? null);
    if (this.isActive()) this.start(true);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private isActive(): boolean {
    return this.config.enabled && this.config.targets.some((t) => t.enabled);
  }

  private activeId(): string | null {
    return this.deps.registry.getActiveView()?.id ?? null;
  }

  /** The ACTIVE account's targets — the only ones shown, configured and swept. A property added under
   *  one mail must never appear (or be queried, with the wrong token) under another. */
  private mine(owner: string | null): Ga4MonitorTarget[] {
    return this.config.targets.filter((t) => t.accountId === (owner ?? undefined) || (!t.accountId && owner === null));
  }

  /** Configs from before per-account scoping have ownerless targets: stamp them with the active
   *  account the first time one is known (they were added while that user was working). */
  private stampOwnerless(owner: string): void {
    let changed = false;
    for (const t of this.config.targets) {
      if (!t.accountId) {
        t.accountId = owner;
        changed = true;
      }
    }
    if (changed && this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
  }

  /** `owner` stamps targets that arrive without an accountId (new adds from the active account's
   *  panel). Dedupe + the size cap are PER ACCOUNT. */
  private normalizeTargets(c: Partial<Ga4MonitorConfig> | null, owner: string | null): Ga4MonitorTarget[] {
    const raw = Array.isArray(c?.targets) ? c.targets : [];
    const seen = new Set<string>();
    const perAccount = new Map<string, number>();
    const targets: Ga4MonitorTarget[] = [];
    for (const t of raw) {
      const id = t && typeof t === 'object' && (t as Ga4MonitorTarget).propertyId ? String((t as Ga4MonitorTarget).propertyId) : '';
      if (!id) continue;
      const acct = (t as Ga4MonitorTarget).accountId ? String((t as Ga4MonitorTarget).accountId) : owner ?? undefined;
      const key = `${acct ?? '?'}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = perAccount.get(acct ?? '?') ?? 0;
      if (n >= MAX_TARGETS) continue;
      perAccount.set(acct ?? '?', n + 1);
      targets.push({
        propertyId: id,
        propertyLabel: (t as Ga4MonitorTarget).propertyLabel ? String((t as Ga4MonitorTarget).propertyLabel).slice(0, 200) : '',
        enabled: (t as Ga4MonitorTarget).enabled === undefined ? true : Boolean((t as Ga4MonitorTarget).enabled),
        slackLabel: (t as Ga4MonitorTarget).slackLabel ? String((t as Ga4MonitorTarget).slackLabel).slice(0, 120) : undefined,
        // Per-target notification choices. Targets from BEFORE per-property preferences are seeded
        // from the old global toggles, so nobody's alerts silently stop (or start) on upgrade.
        notify: (t as Ga4MonitorTarget).notify
          ? {
              alerts: Boolean((t as Ga4MonitorTarget).notify!.alerts),
              digest: Boolean((t as Ga4MonitorTarget).notify!.digest),
              audit: Boolean((t as Ga4MonitorTarget).notify!.audit),
            }
          : { alerts: c?.slackEnabled !== false, digest: Boolean(c?.digestEnabled), audit: Boolean(c?.auditEnabled) },
        accountId: acct,
        lastDigestAt: Number.isFinite(Number((t as Ga4MonitorTarget).lastDigestAt)) && Number((t as Ga4MonitorTarget).lastDigestAt) > 0 ? Number((t as Ga4MonitorTarget).lastDigestAt) : undefined,
        lastAuditAt: Number.isFinite(Number((t as Ga4MonitorTarget).lastAuditAt)) && Number((t as Ga4MonitorTarget).lastAuditAt) > 0 ? Number((t as Ga4MonitorTarget).lastAuditAt) : undefined,
      });
    }
    // Legacy single-property config ({propertyId, propertyLabel}) → a one-entry list, so an existing
    // installation keeps monitoring what it was monitoring.
    const legacy = c as Partial<Ga4MonitorConfig> & { propertyId?: string | null; propertyLabel?: string };
    if (!targets.length && legacy?.propertyId) {
      targets.push({ propertyId: String(legacy.propertyId), propertyLabel: legacy.propertyLabel ? String(legacy.propertyLabel) : '', enabled: true, accountId: owner ?? undefined });
    }
    return targets;
  }

  private normalize(c: Partial<Ga4MonitorConfig> | null, owner: string | null): Ga4MonitorConfig {
    return {
      enabled: Boolean(c?.enabled),
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(c?.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes)),
      targets: this.normalizeTargets(c, owner),
      days: Math.min(365, Math.max(1, Math.floor(Number(c?.days) || DEFAULT_CONFIG.days))),
      slackEnabled: c?.slackEnabled === undefined ? true : Boolean(c.slackEnabled),
      digestEnabled: Boolean(c?.digestEnabled),
      auditEnabled: Boolean(c?.auditEnabled),
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
    const mine = this.mine(accountId);
    if (!this.deps.secrets.has(defRef) || !mine.length) return;
    const url = this.deps.secrets.get(defRef);
    if (url) {
      let labelChanged = false;
      for (const t of mine) {
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

  /** Runtime state is keyed per account+property so the same property monitored under two mails
   *  never shares (or clobbers) alert-dedup memory. */
  private stateFor(owner: string | null, propertyId: string): TargetState {
    const key = `${owner ?? '?'}:${propertyId}`;
    let s = this.state.get(key);
    if (!s) {
      s = { lastRunAt: null, lastError: null, lastRun: null, lastSlackAt: null, consentProbeAt: null, consentProbe: null, priorGcsPresent: null, seenIds: new Set() };
      this.state.set(key, s);
    }
    return s;
  }

  status(): Ga4MonitorStatus {
    const active = this.deps.registry.getActiveView();
    if (active) {
      this.stampOwnerless(active.id);
      this.migrateDefaultWebhook(active.id);
    }
    const owner = active?.id ?? null;
    const ref = this.webhookRefForActive();
    const mine = this.mine(owner);
    const targetStatuses: Ga4MonitorTargetStatus[] = mine.map((t) => {
      const s = this.state.get(`${owner ?? '?'}:${t.propertyId}`);
      const ownRef = this.propertyWebhookRefForActive(t.propertyId);
      return { ...t, lastRunAt: s?.lastRunAt ?? null, lastError: s?.lastError ?? null, lastRun: s?.lastRun ?? null, hasWebhook: ownRef ? this.deps.secrets.has(ownRef) : false, lastSlackAt: s?.lastSlackAt ?? null };
    });
    const lastRunAt = targetStatuses.reduce<number | null>((m, t) => (t.lastRunAt !== null && (m === null || t.lastRunAt > m) ? t.lastRunAt : m), null);
    const lastSlackAt = targetStatuses.reduce<number | null>((m, t) => (t.lastSlackAt !== null && (m === null || t.lastSlackAt > m) ? t.lastSlackAt : m), null);
    return {
      ...this.config,
      // Only the ACTIVE account's targets go to the renderer, so its configure() round-trips can
      // never touch (or leak) another mail's properties.
      targets: mine,
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
    const owner = this.activeId();
    if (owner) this.stampOwnerless(owner);
    const wasActive = this.isActive();
    const prevMine = new Set(this.mine(owner).map((t) => t.propertyId));
    // A targets patch from the renderer contains ONLY the active account's list (status() scopes it),
    // so merge it with the other accounts' targets instead of replacing everything.
    let merged: Partial<Ga4MonitorConfig> = { ...this.config, ...patch };
    if (patch.targets !== undefined && owner) {
      const others = this.config.targets.filter((t) => t.accountId !== owner);
      merged = { ...merged, targets: [...others, ...(Array.isArray(patch.targets) ? patch.targets : [])] };
    }
    this.config = this.normalize(merged, owner);
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    // Drop runtime state AND the per-property Slack webhook for the active account's removed targets,
    // so a re-add starts with a clean alert-dedup slate and no orphaned channel secret lingers.
    const nowMine = new Set(this.mine(owner).map((t) => t.propertyId));
    for (const id of prevMine) {
      if (nowMine.has(id)) continue;
      this.state.delete(`${owner ?? '?'}:${id}`);
      const ref = this.propertyWebhookRefForActive(id);
      if (ref) this.deps.secrets.delete(ref);
    }
    this.stop();
    if (this.isActive()) {
      this.start(!wasActive);
      if (wasActive) {
        // Already running and still running: give any brand-new enabled targets an immediate first
        // check so adding a property shows results without waiting a full interval.
        const added = this.mine(owner).filter((t) => t.enabled && !prevMine.has(t.propertyId)).map((t) => t.propertyId);
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
      const owner = this.activeId();
      this.config = this.normalize({ ...this.config, targets: this.config.targets.map((t) => (t.propertyId === propertyId && t.accountId === (owner ?? undefined) ? { ...t, slackLabel: undefined } : t)) }, owner);
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
    const t = this.mine(active.id).find((x) => x.propertyId === propertyId);
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
    // Background sweeps may run before the tab is ever opened — stamp legacy ownerless targets and
    // migrate the legacy default webhook here too so alerts keep flowing.
    this.stampOwnerless(active.id);
    this.migrateDefaultWebhook(active.id);
    const wanted = only === undefined ? null : new Set(Array.isArray(only) ? only : [only]);
    // Only the ACTIVE account's targets are sweepable — another mail's property would be queried with
    // the wrong token and fail anyway. A manual "Run now" on a paused target still runs it (the user
    // asked); the timer only sweeps enabled ones (wanted === null).
    const targets = this.mine(active.id).filter((t) => (wanted ? wanted.has(t.propertyId) : t.enabled));
    if (!targets.length) return [];

    const runs: Ga4MonitorRun[] = [];
    let sweepError: string | null = null;
    for (const target of targets) {
      const st = this.stateFor(active.id, target.propertyId);
      try {
        const input = await gatherGa4MonitorInput(this.deps.data, target.propertyId, this.config.days, () => this.now());
        // Consent-signal probe (Tier 2): a real page load of the property's own site, so throttled to
        // once per target per 24h; between probes the cached verdict keeps feeding the check.
        if (this.deps.probeConsent) {
          const uri = input.snapshot?.dataStreams?.find((d) => d.defaultUri)?.defaultUri ?? null;
          if (uri) {
            const probeDue = !st.consentProbeAt || this.now() - st.consentProbeAt >= 24 * 60 * 60 * 1000;
            if (probeDue) {
              const prev = st.consentProbe;
              const res = await this.deps.probeConsent(uri).catch(() => null);
              st.consentProbeAt = this.now();
              // Only remember a DEFINITE previous verdict (a failed probe must not fake a regression).
              if (prev && prev.observedHit) st.priorGcsPresent = prev.gcsPresent;
              st.consentProbe = res;
            }
            input.consentProbe = st.consentProbe;
            input.priorConsentGcsPresent = st.priorGcsPresent;
          }
        }
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
        if (target.notify?.alerts !== false && newAlerts.length) {
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

        // Weekly scheduled AUDIT: the full audit pipeline, at most once per property per 7 days,
        // with its executive summary posted to the property's own channel. Runs BEFORE the digest so
        // a first sweep with both enabled posts audit-then-digest deterministically. lastAuditAt is
        // persisted even when Slack is off/unconnected - the run happened; do not re-burn the quota.
        if (target.notify?.audit && this.deps.runAudit) {
          const auditDue = !target.lastAuditAt || at - target.lastAuditAt >= AUDIT_EVERY_MS;
          if (auditDue) {
            try {
              const exec = await this.deps.runAudit(target.propertyId, this.config.days);
              target.lastAuditAt = at;
              if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
              const auditHook = this.webhookForTarget(active.id, target.propertyId);
              if (auditHook) {
                await sendSlackWebhook(auditHook, buildSlackAuditPayload(target.propertyLabel || target.propertyId, exec), { fetchImpl: this.deps.slackFetch });
              }
            } catch (e) {
              // A failed audit never breaks the health sweep; it surfaces as the target's lastError.
              st.lastError = `weekly audit: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
        }

        // Weekly digest: post THIS property's health to its own channel even when nothing is wrong,
        // so a silent channel proves the monitor is alive. One per property per 7 days, persisted on
        // the target so restarts don't re-send; never counted as lastSlackAt (that's alerts only).
        if (target.notify?.digest) {
          const due = !target.lastDigestAt || at - target.lastDigestAt >= DIGEST_EVERY_MS;
          const webhook = due ? this.webhookForTarget(active.id, target.propertyId) : null;
          if (due && webhook) {
            const counts = { pass: 0, warn: 0, fail: 0 };
            for (const c of result.checks) if (c.status === 'pass' || c.status === 'warn' || c.status === 'fail') counts[c.status]++;
            const digest = buildSlackDigestPayload(target.propertyLabel || target.propertyId, result, {
              checksPass: counts.pass, checksWarn: counts.warn, checksFail: counts.fail,
              openAlerts: result.alerts.length, intervalMinutes: this.config.intervalMinutes,
            });
            const sent = await sendSlackWebhook(webhook, digest, { fetchImpl: this.deps.slackFetch });
            if (sent.ok) {
              target.lastDigestAt = at;
              if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
            }
          }
        }
      } catch (e) {
        st.lastError = e instanceof Error ? e.message : String(e);
        sweepError = `${target.propertyLabel || target.propertyId}: ${st.lastError}`;
      }
    }
    this.lastError = sweepError;
    return runs;
  }
}
