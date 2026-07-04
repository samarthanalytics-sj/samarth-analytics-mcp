// Slack Incoming Webhook notifier for GA4 monitoring alerts. Two halves, both testable:
//   1. buildSlackPayload() — PURE: turns a monitor result + the set of NEW alerts into a Slack
//      Block Kit message. No I/O.
//   2. sendSlackWebhook() — POSTs the payload to a Slack Incoming Webhook URL. fetch is injectable so
//      the POST is unit-testable and the caller controls timeouts/retries.
//
// The webhook URL is a secret (grants post access to a channel); it is stored encrypted in the OS
// keychain (secret-store) and only decrypted in the main process at send time — never logged.

import type { Ga4MonitorAlert, Ga4MonitorResult, MonitorHealth } from '../google/ga4-monitor';

const SEV_EMOJI: Record<string, string> = { critical: ':rotating_light:', high: ':red_circle:', medium: ':large_orange_circle:', low: ':large_yellow_circle:', info: ':white_circle:' };
const HEALTH_EMOJI: Record<MonitorHealth, string> = { critical: ':rotating_light:', warning: ':warning:', healthy: ':white_check_mark:' };

export interface SlackPayload {
  text: string; // fallback / notification text
  blocks: unknown[];
}

/** A Slack Incoming Webhook URL. Anything else is rejected before we attempt a POST. */
export function isValidSlackWebhook(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]+$/.test(url.trim());
}

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

/** Build the Slack message for a monitor run. `alerts` is the set to announce (usually only the NEW
 *  ones the scheduler hasn't sent yet); pass `result.alerts` for an on-demand full report. */
export function buildSlackPayload(propertyLabel: string, result: Ga4MonitorResult, alerts: Ga4MonitorAlert[]): SlackPayload {
  const headline = `${HEALTH_EMOJI[result.health]} GA4 monitoring — ${propertyLabel}`;
  const text = alerts.length
    ? `${headline}: ${alerts.length} issue(s) — ${alerts.map((a) => a.title).join('; ')}`
    : `${headline}: all checks healthy`;

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(`GA4 monitoring: ${propertyLabel}`, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `${HEALTH_EMOJI[result.health]} *${result.health.toUpperCase()}* — ${truncate(result.summary, 280)}` } },
  ];

  for (const a of alerts.slice(0, 10)) {
    const lines = [`${SEV_EMOJI[a.severity] ?? ''} *${a.title}* _(${a.severity})_`, truncate(a.detail, 700)];
    if (a.recommendation) lines.push(`*Fix:* ${truncate(a.recommendation, 400)}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }
  if (alerts.length > 10) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${alerts.length - 10} more issue(s).` }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Property \`${result.property}\` · sent by Samarth Analytics GA4 monitoring` }] });

  return { text: truncate(text, 3000), blocks };
}

export interface SendResult {
  ok: boolean;
  status: number;
  error?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** POST a payload to a Slack Incoming Webhook. Returns a structured result instead of throwing so the
 *  scheduler can log a failed send without crashing the monitor loop. `fetchImpl` defaults to the
 *  global fetch (present in Electron's main process); `timeoutMs` guards a hung webhook. */
export async function sendSlackWebhook(
  webhookUrl: string,
  payload: SlackPayload,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<SendResult> {
  if (!isValidSlackWebhook(webhookUrl)) return { ok: false, status: 0, error: 'Not a valid Slack Incoming Webhook URL.' };
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  if (!doFetch) return { ok: false, status: 0, error: 'No fetch implementation available.' };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = res.ok ? '' : await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `Slack responded ${res.status}${bodyText ? `: ${bodyText}` : ''}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).name === 'AbortError' ? `Slack webhook timed out after ${timeoutMs}ms.` : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
