import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { auditChanges } from '../google/audit-runner';
import type { GoogleDataService } from '../google/data-service';
import type { AuditHistoryStore } from '../storage/audit-history';
import type { AccountView, MonitorAlert, MonitorConfig, MonitorStatus } from '../../shared/ipc';

/** Minimum auto-audit interval — never hammer the GTM API. */
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_CONFIG: MonitorConfig = { enabled: false, intervalMinutes: 60 };

interface RegistryLike {
  getActiveView(): AccountView | null;
}

export interface MonitorDeps {
  registry: RegistryLike;
  data: GoogleDataService;
  history: AuditHistoryStore;
  /** Push an alert to the renderer (broadcast to windows in main). */
  emit: (alert: MonitorAlert) => void;
  /** Injectable clock (defaults to Date.now) — kept out of the timer for tests. */
  now?: () => number;
  /** Optional persistence for the config (monitor-config.json). */
  configPath?: string;
}

/**
 * Background continuous-monitoring scheduler. On a timer it re-audits the
 * ACTIVE account's remembered container/workspace and, when NEW issues appear
 * since the last run, emits an alert. The audit+diff logic is shared with the
 * chat tool (audit-runner.auditChanges) so on-demand and scheduled monitoring
 * behave identically. Read-only: it only reads GTM and writes local history.
 */
export class MonitorService {
  private config: MonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private lastAlert: MonitorAlert | null = null;
  // Serialises overlapping runs (a timer tick, the boot run, and a manual "Audit
  // now" can otherwise race on the same baseline and double-emit).
  private inFlight: Promise<MonitorAlert | null> | null = null;

  constructor(private readonly deps: MonitorDeps) {
    const loaded = deps.configPath
      ? readJsonFile<MonitorConfig>(deps.configPath, DEFAULT_CONFIG)
      : DEFAULT_CONFIG;
    this.config = this.normalize(loaded);
    if (this.config.enabled) this.start(true); // boot baseline
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private normalize(c: Partial<MonitorConfig> | null): MonitorConfig {
    return {
      enabled: Boolean(c?.enabled),
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(c?.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes)),
    };
  }

  status(): MonitorStatus {
    return {
      ...this.config,
      running: this.timer !== null,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastAlert: this.lastAlert,
    };
  }

  /** Update config (enable/disable, interval), persist, and (re)start the timer.
   *  An immediate audit runs ONLY on a fresh disabled→enabled transition — a
   *  pure interval change just reschedules, so editing the interval never
   *  hammers the GTM API. */
  configure(patch: Partial<MonitorConfig>): MonitorStatus {
    const wasEnabled = this.config.enabled;
    this.config = this.normalize({ ...this.config, ...patch });
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    this.stop();
    if (this.config.enabled) this.start(!wasEnabled);
    return this.status();
  }

  start(runNow = false): void {
    if (this.timer) return;
    const ms = this.config.intervalMinutes * 60_000;
    this.timer = setInterval(() => void this.runOnce(), ms);
    if (typeof this.timer.unref === 'function') this.timer.unref(); // don't keep the app alive
    if (runNow) void this.runOnce(); // establish the baseline (won't alert on first run)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one audit cycle against the active account's remembered container.
   * Returns the alert it emitted, or null (no active/selected container, the
   * first baseline run, no new findings, or an error — recorded in status).
   * Reentrancy-guarded: a call while one is in flight joins the same run.
   */
  runOnce(): Promise<MonitorAlert | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnceInner().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceInner(): Promise<MonitorAlert | null> {
    const active = this.deps.registry.getActiveView();
    const ctx = active?.gtmContext;
    if (!active || !active.hasGoogleToken || !ctx?.accountId || !ctx.containerId || !ctx.workspaceId) {
      return null; // nothing to monitor yet
    }
    try {
      const res = await auditChanges(
        this.deps.data,
        this.deps.history,
        { accountId: ctx.accountId, containerId: ctx.containerId, workspaceId: ctx.workspaceId },
        this.now()
      );
      this.lastRunAt = this.now();
      this.lastError = null;
      if (res.firstRun || res.drift.newFindings.length === 0) return null; // baseline / no regressions
      const alert: MonitorAlert = {
        at: this.lastRunAt,
        accountId: ctx.accountId,
        containerId: ctx.containerId,
        containerName: ctx.containerName,
        workspaceId: ctx.workspaceId,
        resolvedCount: res.drift.resolvedFindings.length,
        newFindings: res.drift.newFindings.map((f) => ({
          severity: f.severity,
          category: f.category,
          message: f.message,
        })),
      };
      this.lastAlert = alert;
      this.deps.emit(alert);
      return alert;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}
