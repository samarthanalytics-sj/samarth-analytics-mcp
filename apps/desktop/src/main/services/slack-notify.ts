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

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Build the Slack message for a monitor run. `alerts` is the set to announce (usually only the NEW
 *  ones the scheduler hasn't sent yet); pass `result.alerts` for an on-demand full report.
 *
 *  Format (user-specified template):
 *    \u{1F6A8} GA4 Monitoring Alert
 *    Severity / Property / Property ID
 *    per alert: Issue -> Summary (structured metric lines when the engine provides them, else the
 *    prose detail) -> Impact (when known) -> Recommended Actions as bullets. */
export function buildSlackPayload(propertyLabel: string, result: Ga4MonitorResult, alerts: Ga4MonitorAlert[]): SlackPayload {
  const label = propertyLabel || 'your GA4 property';
  const propertyId = result.property.replace(/^properties\//, '');
  const worst = alerts.reduce<string | null>((w, a) => (w == null || (SEV_ORDER[a.severity] ?? 9) < (SEV_ORDER[w] ?? 9) ? a.severity : w), null);
  const headEmoji = worst === 'critical' || worst === 'high' ? '\u{1F6A8}' : worst ? '\u26A0\uFE0F' : '\u2705';

  const text = alerts.length
    ? `${headEmoji} GA4 Monitoring Alert - ${label}: ${alerts.map((a) => a.title).join('; ')}`
    : `\u2705 GA4 monitoring - ${label}: all checks healthy`;

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(`${headEmoji} GA4 Monitoring Alert`, 150), emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [`*Severity:* ${worst ? cap(worst) : 'None'}`, `*Property:* ${truncate(label, 200)}`, `*Property ID:* ${propertyId}`].join('\n'),
      },
    },
  ];
  if (!alerts.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: ${truncate(result.summary, 280)}` } });
  }

  for (const a of alerts.slice(0, 10)) {
    blocks.push({ type: 'divider' });
    const seg: string[] = [];
    // With several alerts in one message the per-alert severity is shown beside its Issue.
    seg.push(`*Issue*${alerts.length > 1 ? ` ${SEV_EMOJI[a.severity] ?? ''} _(${cap(a.severity)})_` : ''}\n${truncate(a.title, 200)}`);
    seg.push(`*Summary*\n${a.summaryLines?.length ? a.summaryLines.map((l) => truncate(l, 200)).join('\n') : truncate(a.detail, 700)}`);
    if (a.impact) seg.push(`*Impact*\n${truncate(a.impact, 300)}`);
    const actions = a.actions?.length ? a.actions : a.recommendation ? [a.recommendation] : [];
    if (actions.length) seg.push(`*Recommended Actions*\n${actions.map((x) => `\u2022 ${truncate(x, 300)}`).join('\n')}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: seg.join('\n\n') } });
  }
  if (alerts.length > 10) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${alerts.length - 10} more issue(s).` }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Property \`${result.property}\` · sent by Samarth Analytics GA4 monitoring` }] });

  return { text: truncate(text, 3000), blocks };
}

/** A confirmation message for the "Send test" button — it lands in whatever channel the webhook is
 *  bound to, so the user can SEE which channel/workspace they connected. */
export function buildSlackTestPayload(propertyLabel: string): SlackPayload {
  const label = propertyLabel || 'your GA4 property';
  return {
    text: `:white_check_mark: GA4 monitoring is connected — alerts for ${label} will appear in this channel.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *GA4 monitoring is connected to this channel.*\nHealth alerts for *${truncate(label, 200)}* (no data, key events stopping, sudden spikes/drops, consent drift, revenue integrity) will post here.` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'This is a test message from Samarth Analytics GA4 monitoring.' }] },
    ],
  };
}

/** The weekly health digest: posted even when everything is healthy, so a quiet channel reads as
 *  "monitored and fine" instead of "is this thing on?". One message per property, to its own channel. */
export function buildSlackDigestPayload(
  propertyLabel: string,
  result: Ga4MonitorResult,
  meta: { checksPass: number; checksWarn: number; checksFail: number; openAlerts: number; intervalMinutes: number },
): SlackPayload {
  const label = propertyLabel || 'your GA4 property';
  const text = `${HEALTH_EMOJI[result.health]} Weekly health digest — ${label}: ${result.summary}`;
  const cadence = meta.intervalMinutes >= 60 ? `${Math.round(meta.intervalMinutes / 60)} hr` : `${meta.intervalMinutes} min`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: truncate(`Weekly health digest: ${label}`, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `${HEALTH_EMOJI[result.health]} *${result.health.toUpperCase()}* — ${truncate(result.summary, 280)}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Checks:* ${meta.checksPass} pass · ${meta.checksWarn} warn · ${meta.checksFail} issue(s)` },
          { type: 'mrkdwn', text: `*Open alerts:* ${meta.openAlerts}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Checked every ${cadence} · next digest in 7 days · Samarth Analytics GA4 monitoring` }] },
    ],
  };
}

/** Weekly scheduled-audit summary: the executive verdict a client would pay to see, one message per
 *  property to its own channel. Kept to exec-level facts (setup completeness, reliability + cap,
 *  biggest risk, highest-impact fix) - the full report lives in the app. */
export function buildSlackAuditPayload(
  propertyLabel: string,
  exec: { verdict: string; composite: number | null; grade: string; reliabilityPct: number; reliabilityCappedBy: string[]; biggestRisk: string; highestImpactFix: string; dateRange: string },
): SlackPayload {
  const label = propertyLabel || 'your GA4 property';
  const capped = exec.reliabilityCappedBy.length ? ` (capped by ${exec.reliabilityCappedBy.join(', ')})` : '';
  const text = `Weekly GA4 audit - ${label}: reliability ${exec.reliabilityPct}%${capped}; ${exec.verdict}`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: truncate(`Weekly GA4 audit: ${label}`, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Reporting reliability:* ${exec.reliabilityPct}%${capped}
*Setup completeness:* ${exec.composite === null ? 'n/a' : `${exec.composite}/100`} (grade ${exec.grade})
*Window:* ${truncate(exec.dateRange, 80)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Verdict:* ${truncate(exec.verdict, 400)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Biggest risk:* ${truncate(exec.biggestRisk, 400)}
*Highest-impact fix:* ${truncate(exec.highestImpactFix, 400)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Full report in the app (GA4 Tools > GA4 Audit) · next audit in 7 days · Samarth Analytics' }] },
    ],
  };
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
