// Tag Watch service: schedules periodic scans of watched gtag configs (public gtag.js - no account
// needed), folds each into the target's timeline via the pure core, and posts Slack on real changes.
// Persistence is a single JSON file; the fold logic + Slack decision live in tag-watch-core, so this
// class is just wiring (fetch + timer + disk + broadcast). Targets are NOT account-scoped because the
// data is public - a competitor's measurement id has no owner.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { MAX_INTERVAL_HOURS, assertTimerMs } from './timer-limits';
import { parseGtagSnapshot } from '../google/gtag-spy';
import { applyScan, shouldAlert, type TagWatchTarget, type TagWatchEvent, type ScanOutcome } from '../google/tag-watch-core';
import { sendSlackWebhook, isValidSlackWebhook, type SlackPayload } from './slack-notify';
import { log } from '../logger';

/** The persisted config (tag-watch-config.json). The Slack webhook is NOT in it: the URL is a bearer
 *  secret, so it lives encrypted in the OS keychain (secret store) like the GA4 and Ads monitors'. */
export interface TagWatchConfig {
  enabled: boolean;
  /** Scan cadence in hours (min 1, default 24). */
  intervalHours: number;
  targets: TagWatchTarget[];
}

/** What leaves the service for the renderer: the config plus whether a Slack webhook is connected.
 *  Never the URL itself. */
export interface TagWatchState extends TagWatchConfig {
  hasSlackWebhook: boolean;
}

/** Secret-store ref of the (single, app-level) Tag Watch Slack webhook. */
export const TAG_WATCH_WEBHOOK_REF = 'tagwatch-slack-webhook';

const DEFAULT_CONFIG: TagWatchConfig = { enabled: false, intervalHours: 24, targets: [] };
const MIN_INTERVAL_HOURS = 1;
const MAX_TARGETS = 25;

interface SecretsLike {
  get(ref: string): string | null;
  has(ref: string): boolean;
  set(ref: string, value: string): void;
  delete(ref: string): void;
  available(): boolean;
}

export interface TagWatchDeps {
  fetchGtagJs: (measurementId: string) => Promise<string>;
  /** Encrypted store for the Slack webhook (the OS keychain in the app). */
  secrets: SecretsLike;
  configPath?: string;
  /** Broadcast a config/state update to the renderer after a sweep or mutation. */
  emit?: (state: TagWatchState) => void;
  now?: () => number;
  /** Injectable Slack sender (tests). */
  sendSlack?: (webhook: string, payload: SlackPayload) => Promise<{ ok: boolean; error?: string }>;
}

/** Slack mrkdwn treats &, < and > as control characters (<!channel>, <url|text> links). The changed
 *  values come from a watched property's own public gtag.js - possibly a competitor's - so they are
 *  escaped (and clipped) before they reach the operator's channel. */
const SLACK_VALUE_MAX = 300;
const slackText = (s: string, max = SLACK_VALUE_MAX): string => {
  const clipped = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return clipped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

/** Slack message for a tag-watch alert (kept here - it's tag-watch-specific, not a GA4 monitor run). */
export function buildTagWatchSlack(target: TagWatchTarget, event: TagWatchEvent): SlackPayload {
  const name = slackText(target.label ? `${target.label} (${target.measurementId})` : target.measurementId);
  if (event.kind === 'unparsed_now') {
    const t = `:warning: Tag watch: ${name} - the gtag config stopped parsing (Google may have changed the format). Comparison paused until it parses again.`;
    return { text: t, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: t } }] };
  }
  const lines = event.changes.map((c) => `• *${slackText(c.field)}*: ${slackText(c.before)} → ${slackText(c.after)}`).join('\n');
  return {
    text: `:mag: Tag watch: ${event.changes.length} change(s) on ${name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Tag watch* - ${event.changes.length} config change(s) detected on *${name}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines || '_no field detail_' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Read from the public gtag.js - config-level, not runtime. Confirm intent with whoever owns this property.' }] },
    ],
  };
}

export class TagWatchService {
  private config: TagWatchConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(private readonly deps: TagWatchDeps) {
    const loaded = deps.configPath ? readJsonFile<TagWatchConfig & { slackWebhook?: unknown }>(deps.configPath, DEFAULT_CONFIG) : DEFAULT_CONFIG;
    this.config = this.normalize(loaded);
    this.migrateLegacyWebhook(loaded);
    if (this.config.enabled && this.config.targets.length) this.start();
  }

  /** Configs written before the webhook moved to the secret store held the URL in PLAINTEXT in this
   *  file. Move it into the encrypted store, then rewrite the file without it. Without OS encryption it
   *  cannot be kept securely, so it is dropped (fail closed, the same rule the GA4 and Ads monitors
   *  apply) and has to be re-entered once encryption works. */
  private migrateLegacyWebhook(loaded: Partial<TagWatchConfig> & { slackWebhook?: unknown }): void {
    if (!loaded || !Object.prototype.hasOwnProperty.call(loaded, 'slackWebhook')) return;
    const legacy = typeof loaded.slackWebhook === 'string' ? loaded.slackWebhook.trim() : '';
    if (legacy && isValidSlackWebhook(legacy) && !this.deps.secrets.has(TAG_WATCH_WEBHOOK_REF)) {
      try {
        if (!this.deps.secrets.available()) throw new Error('OS secret encryption is unavailable');
        this.deps.secrets.set(TAG_WATCH_WEBHOOK_REF, legacy);
      } catch (e) {
        log.warn('Tag watch: the saved Slack webhook could not be moved to encrypted storage and was removed', e instanceof Error ? e.message : String(e), 'Re-enter it in the Tag watch panel once OS encryption is available.');
      }
    }
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
  }

  /** The webhook, decrypted only here in the main process at send time. */
  private slackWebhook(): string | null {
    try {
      return this.deps.secrets.has(TAG_WATCH_WEBHOOK_REF) ? this.deps.secrets.get(TAG_WATCH_WEBHOOK_REF) : null;
    } catch {
      return null; // OS encryption unavailable right now: skip the alert rather than fail the scan
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private normalize(c: Partial<TagWatchConfig> | null): TagWatchConfig {
    const targets = (Array.isArray(c?.targets) ? c!.targets : [])
      .filter((t): t is TagWatchTarget => Boolean(t && typeof t.measurementId === 'string'))
      .slice(0, MAX_TARGETS)
      .map((t) => ({ measurementId: t.measurementId.toUpperCase(), label: t.label, lastSnapshot: t.lastSnapshot ?? null, timeline: Array.isArray(t.timeline) ? t.timeline : [], lastScanAt: t.lastScanAt ?? null, lastParsed: t.lastParsed ?? false }));
    // Dedupe by measurement id (keep the first).
    const seen = new Set<string>();
    const deduped = targets.filter((t) => (seen.has(t.measurementId) ? false : (seen.add(t.measurementId), true)));
    // Ceiling too: an interval past setInterval's limit (or Infinity) would fire every 1 ms.
    return { enabled: Boolean(c?.enabled), intervalHours: Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Number(c?.intervalHours) || 24)), targets: deduped };
  }

  private persist(): void {
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    this.deps.emit?.(this.getConfig());
  }

  private start(): void {
    this.stop();
    // A failed sweep (e.g. a disk write) must not become an unhandled rejection from the timer.
    this.timer = setInterval(() => { this.runOnce().catch(() => undefined); }, assertTimerMs(Math.max(MIN_INTERVAL_HOURS, this.config.intervalHours) * 3600_000));
    if (this.timer.unref) this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getConfig(): TagWatchState {
    return { ...(JSON.parse(JSON.stringify(this.config)) as TagWatchConfig), hasSlackWebhook: this.deps.secrets.has(TAG_WATCH_WEBHOOK_REF) };
  }

  /** Add a target (idempotent by measurement id) + optionally scan it immediately. */
  async addTarget(measurementId: string, label?: string): Promise<TagWatchState> {
    const id = measurementId.trim().toUpperCase();
    if (!/^(G|GT|AW|DC)-[A-Z0-9]+$/.test(id)) throw new Error(`"${measurementId}" is not a measurement/tag id (expected e.g. G-ABC123).`);
    if (this.config.targets.length >= MAX_TARGETS) throw new Error(`Tag watch is limited to ${MAX_TARGETS} targets.`);
    if (!this.config.targets.some((t) => t.measurementId === id)) {
      this.config.targets.push({ measurementId: id, label: label?.trim() || undefined, lastSnapshot: null, timeline: [], lastScanAt: null, lastParsed: false });
      // Scheduled scans may have been switched on while the list was empty (or emptied by removes,
      // which stop the timer): this first target is what arms them, not the next app launch.
      if (this.config.enabled && !this.timer) this.start();
      this.persist();
      await this.scanTarget(id); // capture the baseline right away
    }
    return this.getConfig();
  }

  removeTarget(measurementId: string): TagWatchState {
    this.config.targets = this.config.targets.filter((t) => t.measurementId !== measurementId.toUpperCase());
    if (!this.config.targets.length) this.stop();
    this.persist();
    return this.getConfig();
  }

  setEnabled(enabled: boolean): TagWatchState {
    this.config.enabled = enabled;
    if (enabled && this.config.targets.length) this.start();
    else this.stop();
    this.persist();
    return this.getConfig();
  }

  setInterval(intervalHours: number): TagWatchState {
    const n = Math.round(intervalHours);
    this.config.intervalHours = Number.isFinite(n) ? Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, n)) : 24;
    if (this.timer) this.start(); // restart with the new cadence
    this.persist();
    return this.getConfig();
  }

  /** Store (or, with an empty value, remove) the Slack webhook - encrypted in the secret store, never in
   *  the config file and never echoed back to the renderer. */
  setSlackWebhook(webhook: string): TagWatchState {
    const w = webhook.trim();
    if (!w) {
      this.deps.secrets.delete(TAG_WATCH_WEBHOOK_REF);
    } else {
      if (!isValidSlackWebhook(w)) throw new Error('Not a valid Slack Incoming Webhook URL.');
      if (!this.deps.secrets.available()) throw new Error('OS secret encryption is unavailable, so the webhook cannot be stored securely.');
      this.deps.secrets.set(TAG_WATCH_WEBHOOK_REF, w);
    }
    this.persist();
    return this.getConfig();
  }

  /** Scan a single target now: fetch → parse → fold → persist → alert. Returns the folded event. */
  private async scanTarget(measurementId: string): Promise<TagWatchEvent | null> {
    if (!this.config.targets.some((t) => t.measurementId === measurementId)) return null;
    let outcome: ScanOutcome;
    try {
      const js = await this.deps.fetchGtagJs(measurementId);
      outcome = { snapshot: parseGtagSnapshot(measurementId, js) };
    } catch (e) {
      outcome = { snapshot: null, error: e instanceof Error ? e.message : String(e) };
    }
    // Re-resolve by id AFTER the fetch: a remove during it shifts the indices (an index taken before the
    // await folded this tag's snapshot into ANOTHER target, a false change alert) or empties the slot.
    const idx = this.config.targets.findIndex((t) => t.measurementId === measurementId);
    if (idx < 0) return null; // removed while the fetch was in flight
    const { target, event } = applyScan(this.config.targets[idx], outcome, this.now());
    this.config.targets[idx] = target;
    this.persist();
    const webhook = shouldAlert(event) ? this.slackWebhook() : null;
    if (webhook) {
      const send = this.deps.sendSlack ?? ((w: string, p: SlackPayload) => sendSlackWebhook(w, p));
      await send(webhook, buildTagWatchSlack(target, event)).catch(() => undefined);
    }
    return event;
  }

  /** A full sweep of every target (the scheduled path + manual "scan all"). Serial to be gentle. */
  async runOnce(): Promise<TagWatchState> {
    if (this.inFlight) return this.getConfig();
    this.inFlight = true;
    try {
      for (const t of [...this.config.targets]) await this.scanTarget(t.measurementId);
    } finally {
      this.inFlight = false;
    }
    return this.getConfig();
  }

  /** Manual re-scan of one target (the "scan now" button). */
  scanNow(measurementId: string): Promise<TagWatchEvent | null> {
    return this.scanTarget(measurementId.toUpperCase());
  }
}
