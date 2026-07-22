// Tag Watch service: schedules periodic scans of watched gtag configs (public gtag.js - no account
// needed), folds each into the target's timeline via the pure core, and posts Slack on real changes.
// Persistence is a single JSON file; the fold logic + Slack decision live in tag-watch-core, so this
// class is just wiring (fetch + timer + disk + broadcast). Targets are NOT account-scoped because the
// data is public - a competitor's measurement id has no owner.

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file';
import { parseGtagSnapshot } from '../google/gtag-spy';
import { applyScan, shouldAlert, type TagWatchTarget, type TagWatchEvent, type ScanOutcome } from '../google/tag-watch-core';
import { sendSlackWebhook, isValidSlackWebhook, type SlackPayload } from './slack-notify';

export interface TagWatchConfig {
  enabled: boolean;
  /** Scan cadence in hours (min 1, default 24). */
  intervalHours: number;
  /** Optional Slack Incoming Webhook for change alerts. */
  slackWebhook?: string;
  targets: TagWatchTarget[];
}

const DEFAULT_CONFIG: TagWatchConfig = { enabled: false, intervalHours: 24, targets: [] };
const MIN_INTERVAL_HOURS = 1;
const MAX_TARGETS = 25;

export interface TagWatchDeps {
  fetchGtagJs: (measurementId: string) => Promise<string>;
  configPath?: string;
  /** Broadcast a config/state update to the renderer after a sweep or mutation. */
  emit?: (config: TagWatchConfig) => void;
  now?: () => number;
  /** Injectable Slack sender (tests). */
  sendSlack?: (webhook: string, payload: SlackPayload) => Promise<{ ok: boolean; error?: string }>;
}

/** Slack message for a tag-watch alert (kept here - it's tag-watch-specific, not a GA4 monitor run). */
export function buildTagWatchSlack(target: TagWatchTarget, event: TagWatchEvent): SlackPayload {
  const name = target.label ? `${target.label} (${target.measurementId})` : target.measurementId;
  if (event.kind === 'unparsed_now') {
    const t = `:warning: Tag watch: ${name} - the gtag config stopped parsing (Google may have changed the format). Comparison paused until it parses again.`;
    return { text: t, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: t } }] };
  }
  const lines = event.changes.map((c) => `• *${c.field}*: ${c.before} → ${c.after}`).join('\n');
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
    this.config = this.normalize(deps.configPath ? readJsonFile<TagWatchConfig>(deps.configPath, DEFAULT_CONFIG) : DEFAULT_CONFIG);
    if (this.config.enabled && this.config.targets.length) this.start();
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
    return { enabled: Boolean(c?.enabled), intervalHours: Math.max(MIN_INTERVAL_HOURS, Number(c?.intervalHours) || 24), slackWebhook: c?.slackWebhook, targets: deduped };
  }

  private persist(): void {
    if (this.deps.configPath) writeJsonFileAtomic(this.deps.configPath, this.config);
    this.deps.emit?.(this.getConfig());
  }

  private start(): void {
    this.stop();
    this.timer = setInterval(() => void this.runOnce(), Math.max(MIN_INTERVAL_HOURS, this.config.intervalHours) * 3600_000);
    if (this.timer.unref) this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getConfig(): TagWatchConfig {
    return JSON.parse(JSON.stringify(this.config)) as TagWatchConfig;
  }

  /** Add a target (idempotent by measurement id) + optionally scan it immediately. */
  async addTarget(measurementId: string, label?: string): Promise<TagWatchConfig> {
    const id = measurementId.trim().toUpperCase();
    if (!/^(G|GT|AW|DC)-[A-Z0-9]+$/.test(id)) throw new Error(`"${measurementId}" is not a measurement/tag id (expected e.g. G-ABC123).`);
    if (this.config.targets.length >= MAX_TARGETS) throw new Error(`Tag watch is limited to ${MAX_TARGETS} targets.`);
    if (!this.config.targets.some((t) => t.measurementId === id)) {
      this.config.targets.push({ measurementId: id, label: label?.trim() || undefined, lastSnapshot: null, timeline: [], lastScanAt: null, lastParsed: false });
      this.persist();
      await this.scanTarget(id); // capture the baseline right away
    }
    return this.getConfig();
  }

  removeTarget(measurementId: string): TagWatchConfig {
    this.config.targets = this.config.targets.filter((t) => t.measurementId !== measurementId.toUpperCase());
    if (!this.config.targets.length) this.stop();
    this.persist();
    return this.getConfig();
  }

  setEnabled(enabled: boolean): TagWatchConfig {
    this.config.enabled = enabled;
    if (enabled && this.config.targets.length) this.start();
    else this.stop();
    this.persist();
    return this.getConfig();
  }

  setInterval(intervalHours: number): TagWatchConfig {
    const n = Math.round(intervalHours);
    this.config.intervalHours = Number.isFinite(n) ? Math.max(MIN_INTERVAL_HOURS, n) : 24;
    if (this.timer) this.start(); // restart with the new cadence
    this.persist();
    return this.getConfig();
  }

  setSlackWebhook(webhook: string): TagWatchConfig {
    const w = webhook.trim();
    if (w && !isValidSlackWebhook(w)) throw new Error('Not a valid Slack Incoming Webhook URL.');
    this.config.slackWebhook = w || undefined;
    this.persist();
    return this.getConfig();
  }

  /** Scan a single target now: fetch → parse → fold → persist → alert. Returns the folded event. */
  private async scanTarget(measurementId: string): Promise<TagWatchEvent | null> {
    const idx = this.config.targets.findIndex((t) => t.measurementId === measurementId);
    if (idx < 0) return null;
    let outcome: ScanOutcome;
    try {
      const js = await this.deps.fetchGtagJs(measurementId);
      outcome = { snapshot: parseGtagSnapshot(measurementId, js) };
    } catch (e) {
      outcome = { snapshot: null, error: e instanceof Error ? e.message : String(e) };
    }
    const { target, event } = applyScan(this.config.targets[idx], outcome, this.now());
    this.config.targets[idx] = target;
    this.persist();
    if (shouldAlert(event) && this.config.slackWebhook) {
      const send = this.deps.sendSlack ?? ((w: string, p: SlackPayload) => sendSlackWebhook(w, p));
      await send(this.config.slackWebhook, buildTagWatchSlack(target, event)).catch(() => undefined);
    }
    return event;
  }

  /** A full sweep of every target (the scheduled path + manual "scan all"). Serial to be gentle. */
  async runOnce(): Promise<TagWatchConfig> {
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
