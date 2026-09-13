// Pure Google Ads monitoring engine: turns the conversion-health findings (assembleConversionHealth,
// the same composite the audit_google_ads_conversion_health chat tool runs) into the monitor's
// dashboard shape - per-area checks, alerts with STABLE ids for open/close dedup, a derived 0-100
// score, and the Slack payloads. No I/O, no Date.now, fully unit-tested; the scheduler in
// ads-monitoring-service.ts owns timers, persistence and the network.
//
// Everything here is CONFIG-PLANE: findings are provable from the account's configuration and
// recorded data. Whether tags actually fire on the site is runtime evidence (the GTM tab's tag
// verification) and is never claimed - the Slack context line says so on every message.

import type { HealthFinding } from './ads-map';

export interface AdsMonitorAlert {
  /** Stable across sweeps while the underlying issue persists (numbers in the text are ignored). */
  id: string;
  area: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
}

export interface AdsMonitorCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface AdsMonitorResult {
  health: 'healthy' | 'warning' | 'critical';
  /** Derived 0-100 from THIS run's findings - a comparison device, not a Google-measured metric. */
  score: number;
  summary: string;
  checks: AdsMonitorCheck[];
  alerts: AdsMonitorAlert[];
}

/** The dashboard's check areas, in display order. `changes` is deliberately absent: "someone edited
 *  conversion measurement" is an ALERT when it happens, not a pass/fail state of the account. */
const CHECK_AREAS: ReadonlyArray<{ area: string; label: string }> = [
  { area: 'tagging', label: 'Click tagging (GCLID / UTM)' },
  { area: 'config', label: 'Conversion action config' },
  { area: 'volume', label: 'Conversion volume' },
  { area: 'audience', label: 'Audience lists' },
];

/** Stable alert id: the area plus the finding text with every number collapsed, so "3 open lists"
 *  growing to "4 open lists" stays the SAME ongoing issue instead of re-alerting every sweep. */
export function adsAlertId(f: HealthFinding): string {
  const normalized = f.finding
    .toLowerCase()
    .replace(/[\d][\d,.]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return `${f.severity}:${f.area}:${normalized}`;
}

const SEV_RANK: Record<AdsMonitorAlert['severity'], number> = { critical: 0, warning: 1, info: 2 };

/** Fold health findings into the monitor result. PURE. */
export function buildAdsMonitorResult(findings: HealthFinding[]): AdsMonitorResult {
  // The composite's clean-account all-clear (area 'summary', naming the runtime boundary) is a
  // STATEMENT, not an issue - it must not become a perpetual open alert.
  const real = findings.filter((f) => f.area !== 'summary');

  const alerts: AdsMonitorAlert[] = real
    .map((f) => ({ id: adsAlertId(f), area: f.area, severity: f.severity, title: f.finding }))
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  // One alert per stable id: the composite can word two overlapping findings identically.
  const seen = new Set<string>();
  const deduped = alerts.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));

  const checks: AdsMonitorCheck[] = CHECK_AREAS.map(({ area, label }) => {
    const inArea = real.filter((f) => f.area === area);
    const worst = inArea.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
    const status: AdsMonitorCheck['status'] = !worst || worst.severity === 'info' ? 'pass' : worst.severity === 'critical' ? 'fail' : 'warn';
    return {
      id: area,
      label,
      status,
      detail: worst ? worst.finding : 'No issues detected in this area.',
    };
  });

  const critical = deduped.filter((a) => a.severity === 'critical').length;
  const warning = deduped.filter((a) => a.severity === 'warning').length;
  const info = deduped.length - critical - warning;
  const score = Math.max(0, Math.min(100, 100 - 30 * critical - 12 * warning - 2 * info));
  const health: AdsMonitorResult['health'] = critical ? 'critical' : warning ? 'warning' : 'healthy';

  const areasHit = [...new Set(deduped.filter((a) => a.severity !== 'info').map((a) => a.area))];
  const summary =
    health === 'healthy'
      ? 'No issues found - conversion measurement configuration looks healthy (config-plane view; firing on the site is not covered).'
      : `${critical ? `${critical} critical` : ''}${critical && warning ? ', ' : ''}${warning ? `${warning} warning` : ''} issue${critical + warning === 1 ? '' : 's'} across ${areasHit.join(', ')}.`;

  return { health, score, summary, checks, alerts: deduped };
}

// ── Slack payloads ──────────────────────────────────────────────────────────────────────────────

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}
export interface AdsSlackPayload {
  text: string;
  blocks: SlackBlock[];
}

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s);
const SEV_EMOJI: Record<AdsMonitorAlert['severity'], string> = { critical: ':red_circle:', warning: ':large_yellow_circle:', info: ':information_source:' };
const MAX_SLACK_ALERTS = 8;

/** The alert message: only the NEW alerts of a sweep (the scheduler dedups), worst first, capped. */
export function buildAdsSlackPayload(label: string, result: AdsMonitorResult, newAlerts: AdsMonitorAlert[]): AdsSlackPayload {
  const shown = newAlerts.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).slice(0, MAX_SLACK_ALERTS);
  const extra = newAlerts.length - shown.length;
  const name = trunc(label || 'Google Ads account', 120);
  return {
    text: `Google Ads monitor: ${newAlerts.length} new issue${newAlerts.length === 1 ? '' : 's'} for ${name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Google Ads monitoring - ${name}*\n${trunc(result.summary, 400)}` } },
      ...shown.map((a) => ({
        type: 'section' as const,
        text: { type: 'mrkdwn', text: `${SEV_EMOJI[a.severity]} *[${a.area}]* ${trunc(a.title, 1200)}` },
      })),
      ...(extra > 0 ? [{ type: 'section' as const, text: { type: 'mrkdwn', text: `...and ${extra} more in the desktop app's Ads Monitoring tab.` } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Config-plane checks on the Google Ads account itself. Whether tags fire on the site needs the GTM tab\'s tag verification.' }] },
    ],
  };
}

/** Connection test: posted so the user can SEE which channel/workspace the webhook lands in. */
export function buildAdsSlackTestPayload(label: string): AdsSlackPayload {
  const name = trunc(label || 'your Google Ads account', 200);
  return {
    text: `:white_check_mark: Google Ads monitoring is connected - alerts for ${name} will appear in this channel.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Google Ads monitoring is connected to this channel.*\nConversion-health alerts for *${name}* (tagging breaks, double counting, silent conversion actions, spend without conversions, dead audience lists, conversion-setting edits) will post here.` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'This is a test message from Samarth Analytics Google Ads monitoring.' }] },
    ],
  };
}
