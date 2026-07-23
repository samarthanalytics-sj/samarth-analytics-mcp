// Background Google Ads monitoring scheduler. On a timer (and on demand) it sweeps the list of
// monitored Ads accounts sequentially: for each enabled target it runs the SAME reads as the
// audit_google_ads_conversion_health chat tool, folds them through the pure conversion-health
// composite + monitor engine, and - for issues NEW since that account's last sweep - posts a Slack
// alert and broadcasts the run to the renderer. Mirrors Ga4MonitoringService in shape (JSON-persisted
// config, per-account target scoping, reentrancy-guarded sweeps, unref'd timer, issue log + run
// history persisted on the live target) minus the GA4-only extras (digest/audit/monthly schedules,
// consent probe). Read-only against Google Ads; the only outbound write is the Slack webhook POST.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { assembleConversionHealth } from '../google/ads-map';
import { buildAdsMonitorResult, buildAdsSlackPayload, buildAdsSlackTestPayload } from '../google/ads-monitor';
import { sendSlackWebhook, isValidSlackWebhook, type FetchLike } from './slack-notify';
import type { GoogleAdsService } from '../google/ads-service';
import type { AccountView, AdsMonitorConfig, AdsMonitorRun, AdsMonitorStatus, AdsMonitorTarget, AdsMonitorTargetStatus } from '../../shared/ipc';

// Every sweep of one target costs ~7 Ads API reads and the developer token's daily quota is shared
// across every account the operator manages, so the floor is a full hour and the list stays short.
const MIN_INTERVAL_MINUTES = 60;
const MAX_TARGETS = 5;
const HISTORY_KEEP = 30;
const ISSUE_LOG_KEEP = 50;
const DEFAULT_CONFIG: AdsMonitorConfig = { enabled: false, intervalMinutes: 360, targets: [], days: 30 };

/** Per app-account + Ads-account secret ref for the target's Slack channel. */
export const adsSlackWebhookRef = (accountId: string, customerId: string): string => `ads-slack-webhook:${accountId}:${customerId}`;

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

export interface AdsMonitoringDeps {
  registry: RegistryLike;
  ads: GoogleAdsService;
  secrets: SecretsLike;
  /** Broadcast a completed run to the renderer (main wires this to webContents.send). */
  emit: (run: AdsMonitorRun) => void;
  now?: () => number;
  configPath?: string;
  slackFetch?: FetchLike;
}

/** Per-target runtime state - alert-dedup memory and the latest run live PER ACCOUNT so one
 *  account's ongoing issue never suppresses (or re-triggers) another's. */
interface TargetState {
  lastRunAt: number | null;
  lastError: string | null;
  lastRun: AdsMonitorRun | null;
  lastSlackAt: number | null;
  seenIds: Set<string>;
}

export class AdsMonitoringService {
  private config: AdsMonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private state = new Map<string, TargetState>();
  private inFlight: Promise<AdsMonitorRun[]> | null = null;

  constructor(private readonly deps: AdsMonitoringDeps) {
    const loaded = deps.configPath ? readJsonFile<AdsMonitorConfig>(deps.configPath, DEFAULT_CONFIG) : DEFAULT_CONFIG;
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

  /** The ACTIVE app account's targets - the only ones shown, configured and swept. An Ads account
   *  added under one mail must never appear (or be queried with the wrong token) under another. */
  private mine(owner: string | null): AdsMonitorTarget[] {
    return this.config.targets.filter((t) => t.accountId === (owner ?? undefined) || (!t.accountId && owner === null));
  }

  /** `owner` stamps targets that arrive without an accountId. Dedupe + the size cap are PER ACCOUNT.
   *  Server-owned fields (issue log, run history) are written by the SWEEP, never the renderer: for
   *  an existing target the CURRENT config's copies win over an incoming (possibly stale) echo. */
  private normalizeTargets(c: Partial<AdsMonitorConfig> | null, owner: string | null): AdsMonitorTarget[] {
    const raw = Array.isArray(c?.targets) ? c.targets : [];
    const currentByKey = new Map<string, AdsMonitorTarget>((this.config?.targets ?? []).map((x) => [`${x.accountId ?? '?'}|${x.customerId}`, x]));
    const seen = new Set<string>();
    const perAccount = new Map<string, number>();
    const targets: AdsMonitorTarget[] = [];
    for (const t of raw) {
      const idRaw = t && typeof t === 'object' && (t as AdsMonitorTarget).customerId ? String((t as AdsMonitorTarget).customerId) : '';
      const id = idRaw.replace(/-/g, '');
      if (!/^\d{4,}$/.test(id)) continue;
      const acct = (t as AdsMonitorTarget).accountId ? String((t as AdsMonitorTarget).accountId) : owner ?? undefined;
      const key = `${acct ?? '?'}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = perAccount.get(acct ?? '?') ?? 0;
      if (n >= MAX_TARGETS) continue;
      perAccount.set(acct ?? '?', n + 1);
      const loginRaw = (t as AdsMonitorTarget).loginCustomerId ? String((t as AdsMonitorTarget).loginCustomerId).replace(/-/g, '') : '';
      const cur = currentByKey.get(key);
      const src = cur ?? (t as AdsMonitorTarget);
      targets.push({
        customerId: id,
        label: (t as AdsMonitorTarget).label ? String((t as AdsMonitorTarget).label).slice(0, 200) : id,
        ...(/^\d{4,}$/.test(loginRaw) ? { loginCustomerId: loginRaw } : {}),
        enabled: (t as AdsMonitorTarget).enabled === undefined ? true : Boolean((t as AdsMonitorTarget).enabled),
        ...((t as AdsMonitorTarget).slackLabel ? { slackLabel: String((t as AdsMonitorTarget).slackLabel).slice(0, 120) } : {}),
        ...(acct ? { accountId: acct } : {}),
        ...(Array.isArray(src.issueLog) ? { issueLog: src.issueLog.slice(-ISSUE_LOG_KEEP) } : {}),
        ...(Array.isArray(src.history) ? { history: src.history.slice(-HISTORY_KEEP) } : {}),
      });
    }
    return targets;
  }

  private normalize(c: Partial<AdsMonitorConfig> | null, owner: string | null): AdsMonitorConfig {
    return {
      enabled: Boolean(c?.enabled),
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(c?.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes)),
      targets: this.normalizeTargets(c, owner),
      days: [7, 14, 30].includes(Number(c?.days)) ? Number(c?.days) : DEFAULT_CONFIG.days,
    };
  }

  private webhookRefForActive(customerId: string): string | null {
    const active = this.deps.registry.getActiveView();
    return active ? adsSlackWebhookRef(active.id, customerId) : null;
  }

  private webhookForTarget(accountId: string, customerId: string): string | null {
    const ref = adsSlackWebhookRef(accountId, customerId);
    return this.deps.secrets.has(ref) ? this.deps.secrets.get(ref) : null;
  }

  /** Runtime state keyed per app-account + Ads account. The seen-alert set seeds from the PERSISTED
   *  issue log's still-open entries so an app restart doesn't re-treat every ongoing issue as new
   *  (which would re-ping Slack and reset the issue's openedAt timeline). */
  private stateFor(owner: string | null, customerId: string): TargetState {
    const key = `${owner ?? '?'}:${customerId}`;
    let s = this.state.get(key);
    if (!s) {
      const t =
        this.config.targets.find((x) => (x.accountId ?? null) === owner && x.customerId === customerId) ??
        this.config.targets.find((x) => x.customerId === customerId);
      const openIds = (t?.issueLog ?? []).filter((e) => !e.closedAt).map((e) => e.id);
      s = { lastRunAt: null, lastError: null, lastRun: null, lastSlackAt: null, seenIds: new Set(openIds) };
      this.state.set(key, s);
    }
    return s;
  }

  status(): AdsMonitorStatus {
    const owner = this.activeId();
    const mine = this.mine(owner);
    const targetStatuses: AdsMonitorTargetStatus[] = mine.map((t) => {
      const s = this.state.get(`${owner ?? '?'}:${t.customerId}`);
      const ref = this.webhookRefForActive(t.customerId);
      return { ...t, lastRunAt: s?.lastRunAt ?? null, lastError: s?.lastError ?? null, lastRun: s?.lastRun ?? null, hasWebhook: ref ? this.deps.secrets.has(ref) : false, lastSlackAt: s?.lastSlackAt ?? null };
    });
    const lastRunAt = targetStatuses.reduce<number | null>((m, t) => (t.lastRunAt !== null && (m === null || t.lastRunAt > m) ? t.lastRunAt : m), null);
    const lastSlackAt = targetStatuses.reduce<number | null>((m, t) => (t.lastSlackAt !== null && (m === null || t.lastSlackAt > m) ? t.lastSlackAt : m), null);
    return { ...this.config, targets: mine, running: this.timer !== null, lastRunAt, lastError: this.lastError, lastSlackAt, targetStatuses };
  }

  /** Update config; persist; (re)start the timer. An immediate sweep runs only on a fresh
   *  disabled-to-enabled transition, or for NEWLY ADDED targets while already active. */
  configure(patch: Partial<AdsMonitorConfig>): AdsMonitorStatus {
    const owner = this.activeId();
    const wasActive = this.isActive();
    const prevMine = new Set(this.mine(owner).map((t) => t.customerId));
    // A targets patch from the renderer contains ONLY the active account's list (status() scopes
    // it), so merge with the other accounts' targets instead of replacing everything.
    let merged: Partial<AdsMonitorConfig> = { ...this.config, ...patch };
    if (patch.targets !== undefined && owner) {
      const others = this.config.targets.filter((t) => t.accountId !== owner);
      merged = { ...merged, targets: [...others, ...(Array.isArray(patch.targets) ? patch.targets : [])] };
    }
    this.config = this.normalize(merged, owner);
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    // Removed targets: drop runtime state AND the channel secret so a re-add starts clean.
    const nowMine = new Set(this.mine(owner).map((t) => t.customerId));
    for (const id of prevMine) {
      if (nowMine.has(id)) continue;
      this.state.delete(`${owner ?? '?'}:${id}`);
      const ref = this.webhookRefForActive(id);
      if (ref) this.deps.secrets.delete(ref);
    }
    this.stop();
    if (this.isActive()) {
      this.start(!wasActive);
      if (wasActive) {
        const added = this.mine(owner).filter((t) => t.enabled && !prevMine.has(t.customerId)).map((t) => t.customerId);
        if (added.length) void this.runOnce(added);
      }
    }
    return this.status();
  }

  /** Store (or replace) the Slack webhook for one monitored Ads account (one account, one channel). */
  setWebhook(url: string, customerId: string): AdsMonitorStatus {
    const ref = this.webhookRefForActive(customerId);
    if (!ref) throw new Error('No active account to attach a Slack webhook to.');
    const trimmed = (url ?? '').trim();
    if (!isValidSlackWebhook(trimmed)) throw new Error('That is not a valid Slack Incoming Webhook URL (expected https://hooks.slack.com/services/...).');
    if (!this.deps.secrets.available()) throw new Error('OS secret encryption is unavailable, so the webhook cannot be stored securely.');
    this.deps.secrets.set(ref, trimmed);
    return this.status();
  }

  clearWebhook(customerId: string): AdsMonitorStatus {
    const ref = this.webhookRefForActive(customerId);
    if (ref) this.deps.secrets.delete(ref);
    const owner = this.activeId();
    this.config = this.normalize({ ...this.config, targets: this.config.targets.map((t) => (t.customerId === customerId && t.accountId === (owner ?? undefined) ? { ...t, slackLabel: undefined } : t)) }, owner);
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    return this.status();
  }

  /** Post a confirmation so the user can SEE which channel the webhook lands in. Never throws. */
  async sendTest(customerId: string): Promise<{ ok: boolean; error: string | null }> {
    const active = this.deps.registry.getActiveView();
    if (!active) return { ok: false, error: 'No active account.' };
    const webhook = this.webhookForTarget(active.id, customerId);
    if (!webhook) return { ok: false, error: 'No Slack channel is connected for this Ads account.' };
    const t = this.mine(active.id).find((x) => x.customerId === customerId);
    const res = await sendSlackWebhook(webhook, buildAdsSlackTestPayload(t?.label || customerId), { fetchImpl: this.deps.slackFetch });
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

  /** One sweep over the enabled targets (or the subset in `only`). Reentrancy-guarded; targets run
   *  SEQUENTIALLY so N accounts never burst N x 7 Ads API calls at once; one target failing degrades
   *  to its own lastError and never stops the rest. */
  runOnce(only?: string | string[], trigger: 'manual' | 'scheduled' = 'scheduled'): Promise<AdsMonitorRun[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnceInner(only, trigger).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceInner(only?: string | string[], trigger: 'manual' | 'scheduled' = 'scheduled'): Promise<AdsMonitorRun[]> {
    const active = this.deps.registry.getActiveView();
    if (!active || !active.hasGoogleToken) return [];
    const wanted = only === undefined ? null : new Set((Array.isArray(only) ? only : [only]).map((x) => x.replace(/-/g, '')));
    // A manual "Run now" on a paused target still runs it (the user asked); the timer only sweeps
    // enabled ones.
    const targets = this.mine(active.id).filter((t) => (wanted ? wanted.has(t.customerId) : t.enabled));
    if (!targets.length) return [];

    // Readiness up front: a missing developer token or a token without the adwords scope fails every
    // target identically, so check once and surface ONE clear message instead of N raw 403s.
    const ready = await this.deps.ads.readiness().catch((e) => ({ ready: false as const, reason: { message: e instanceof Error ? e.message : String(e), remedy: '' } }));
    if (!ready.ready) {
      const reason = (ready as { reason?: { message?: string; remedy?: string } }).reason;
      this.lastError = [reason?.message, reason?.remedy].filter(Boolean).join(' ') || 'Google Ads access is not ready.';
      return [];
    }

    const runs: AdsMonitorRun[] = [];
    let sweepError: string | null = null;
    for (const target of targets) {
      const st = this.stateFor(active.id, target.customerId);
      // configure() can swap this.config while we await the API; persisted per-target fields must be
      // mutated on the LIVE target (re-resolved at write time) or the write lands on an orphan.
      const liveTarget = (): AdsMonitorTarget => this.mine(active.id).find((x) => x.customerId === target.customerId) ?? target;
      try {
        const startedAt = this.now();
        const cid = target.customerId;
        const lg = target.loginCustomerId;
        const range = { days: this.config.days };
        // The same read set as the audit_google_ads_conversion_health chat tool. Audiences are a
        // bonus probe: a permission/version hiccup there must not sink the sweep.
        const [tracking, list, vol, utm, changes, perf, userLists] = await Promise.all([
          this.deps.ads.conversionCustomer(cid, lg),
          this.deps.ads.listConversionActions(cid, lg),
          this.deps.ads.conversionVolume(cid, range, lg),
          this.deps.ads.utmSetup(cid, lg),
          this.deps.ads.changeHistory(cid, {}, lg),
          this.deps.ads.campaignPerformance(cid, range, lg),
          this.deps.ads.listUserLists(cid, lg).catch(() => undefined),
        ]);
        const findings = assembleConversionHealth({
          tracking,
          actions: list.actions,
          volume: vol.volume,
          utmFindings: utm.findings,
          changes: changes.events,
          performance: perf.campaigns,
          ...(userLists ? { userLists } : {}),
        });
        const result = buildAdsMonitorResult(findings);
        const at = this.now();
        st.lastRunAt = at;
        st.lastError = null;

        const newAlerts = result.alerts.filter((a) => !st.seenIds.has(a.id));
        const nowIds = new Set(result.alerts.map((a) => a.id));
        const closedIds = [...st.seenIds].filter((id) => !nowIds.has(id));
        st.seenIds = nowIds;

        // Rolling issue history (persisted, capped): when each alert opened and closed.
        if (newAlerts.length || closedIds.length) {
          const tgt = liveTarget();
          const log = (tgt.issueLog ?? []).slice();
          for (const id of closedIds) for (const e of log) if (e.id === id && !e.closedAt) e.closedAt = at;
          for (const a of newAlerts) if (!log.some((e) => e.id === a.id && !e.closedAt)) log.push({ id: a.id, title: a.title, severity: a.severity, openedAt: at });
          tgt.issueLog = log.slice(-ISSUE_LOG_KEEP);
          if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
        }

        // Slack: only NEW alerts, only when this target has a channel. Info-level alerts never ping.
        let slackSent = 0;
        let slackError: string | null = null;
        const pingable = newAlerts.filter((a) => a.severity !== 'info');
        if (pingable.length) {
          const webhook = this.webhookForTarget(active.id, target.customerId);
          if (webhook) {
            const send = await sendSlackWebhook(webhook, buildAdsSlackPayload(target.label || target.customerId, result, pingable), { fetchImpl: this.deps.slackFetch });
            if (send.ok) { slackSent = 1; st.lastSlackAt = at; }
            else slackError = send.error ?? 'Slack send failed.';
          }
        }

        const durationMs = Math.max(0, this.now() - startedAt);
        const run: AdsMonitorRun = {
          at,
          customerId: target.customerId,
          label: target.label || target.customerId,
          health: result.health,
          summary: result.summary,
          checks: result.checks,
          alerts: result.alerts,
          newAlertIds: newAlerts.map((a) => a.id),
          score: result.score,
          durationMs,
          trigger,
          slackSent,
          slackError,
        };
        st.lastRun = run;
        this.deps.emit(run);
        runs.push(run);

        // Run history (persisted, capped) - the History table + the score trend.
        {
          const tgt = liveTarget();
          tgt.history = [
            ...(tgt.history ?? []),
            {
              at,
              health: result.health,
              score: result.score,
              critical: result.alerts.filter((a) => a.severity === 'critical').length,
              warnings: result.alerts.filter((a) => a.severity === 'warning').length,
              durationMs,
              trigger,
            },
          ].slice(-HISTORY_KEEP);
        }
        if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
      } catch (e) {
        st.lastError = e instanceof Error ? e.message : String(e);
        sweepError = `${target.label || target.customerId}: ${st.lastError}`;
      }
    }
    this.lastError = sweepError;
    return runs;
  }
}
