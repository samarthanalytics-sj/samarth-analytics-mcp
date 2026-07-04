// Pure GA4 MONITORING engine. Where the audit is a point-in-time posture read, the monitor answers
// "is the data healthy RIGHT NOW?": is data still flowing, did a key event stop firing, did traffic
// suddenly spike or collapse, is revenue being double-counted, is attribution degrading. It does NOT
// re-implement detection — it orchestrates the same pure engines the audit uses (growth, trend,
// event-delta, transaction, data-quality) over freshly-fetched data and folds their findings into a
// flat list of dedupable ALERTS with stable ids, so a scheduler can Slack only what's NEW.
//
// No I/O: the data layer fetches, this classifies. Fully unit-testable.

import type { Severity, ScorecardFinding } from './scorecard';
import type { Ga4Baseline, Ga4ReportResult } from './data-service';
import type { DataQualityCounts } from './ga4-data-quality';
import type { Ga4EventDeltaInput, Ga4TransactionInput } from './ga4-integrity';
import { auditGa4EventDeltas, auditGa4Transactions } from './ga4-integrity';
import { auditGa4Growth } from './ga4-growth';
import { analyzeGa4Trend } from './ga4-trend';
import { auditGa4DataQuality } from './ga4-data-quality';

/** Everything the monitor needs, fetched best-effort by the data layer. Any field may be null when its
 *  query failed or isn't applicable — the engine degrades a missing input to a "skipped" check, never a
 *  false alarm. */
export interface Ga4MonitorInput {
  property: string;
  /** Active users in the last 30 min (realtime). null = the realtime query failed (unknown, not zero). */
  realtimeActiveUsers: number | null;
  baseline: Ga4Baseline | null;
  dqCounts: DataQualityCounts | null;
  eventDeltas: Ga4EventDeltaInput | null;
  transactions: Omit<Ga4TransactionInput, 'hasEcommerce'> | null;
  /** The property's key-event names (a key event going silent is more serious than a generic one). */
  keyEventNames: string[];
  hasEcommerce: boolean;
}

export type MonitorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type MonitorHealth = 'healthy' | 'warning' | 'critical';

/** One actionable issue. `id` is STABLE across runs for the same ongoing problem so the scheduler can
 *  suppress repeat Slack pings and only notify on new/cleared alerts. */
export interface Ga4MonitorAlert {
  id: string;
  /** Coarse machine kind for grouping/routing: no_data | event_stopped | event_drop | spike | drop |
   *  conversion_break | data_quality | duplicate_tx. */
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  recommendation?: string;
}

export interface Ga4MonitorCheck {
  id: string;
  label: string;
  status: MonitorCheckStatus;
  detail: string;
}

export interface Ga4MonitorResult {
  property: string;
  /** Overall health, worst-wins across the alerts. */
  health: MonitorHealth;
  summary: string;
  /** Every check the monitor ran, incl. the ones that passed or were skipped (so the UI shows coverage). */
  checks: Ga4MonitorCheck[];
  /** Only the issues worth surfacing (medium+). Highest severity first, stable order for equal severity. */
  alerts: Ga4MonitorAlert[];
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const norm = (d?: string): string => (d ?? '').replace(/-/g, '');
/** A finding is severe enough to alert (and to Slack) at medium and above; low/info stay as checks only. */
const isAlertWorthy = (sev: Severity): boolean => SEV_RANK[sev] <= SEV_RANK.medium;
/** A slug safe for a stable alert id (used to dedup ongoing issues across runs). */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

/** The most recent COMPLETE day's sessions from the baseline series (the trailing in-progress day is
 *  excluded so a partial "today" isn't misread as a data outage). null when there is no usable series. */
function latestCompleteDaySessions(baseline: Ga4Baseline, todayYmd?: string): { date: string; sessions: number } | null {
  const days = baseline.dailySessions ?? [];
  if (!days.length) return null;
  const last = days[days.length - 1];
  const lastIsPartial = todayYmd != null && norm(last.date) === norm(todayYmd) && days.length > 1;
  const day = lastIsPartial ? days[days.length - 2] : last;
  return day ? { date: day.date, sessions: day.sessions } : null;
}

/** Read a single scalar metric out of a realtime/report result (first row, first metric). null if absent. */
export function firstMetric(res: Ga4ReportResult | null): number | null {
  const raw = res?.rows?.[0]?.metrics?.[0];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function monitorGa4(input: Ga4MonitorInput): Ga4MonitorResult {
  const checks: Ga4MonitorCheck[] = [];
  const alerts: Ga4MonitorAlert[] = [];
  const pushAlert = (a: Ga4MonitorAlert): void => {
    if (isAlertWorthy(a.severity)) alerts.push(a);
  };
  // Map a pure-engine finding to an alert with a stable id derived from its kind + a key.
  const fromFinding = (kind: string, key: string, f: ScorecardFinding, title: string): Ga4MonitorAlert => ({
    id: `${kind}:${slug(key)}`,
    kind,
    severity: f.severity,
    title,
    detail: f.message,
    recommendation: f.recommendation,
  });

  const b = input.baseline;
  const dq = input.dqCounts;

  // ── 1 · Data flow: is GA4 still receiving anything? ──
  const rt = input.realtimeActiveUsers;
  const latest = b ? latestCompleteDaySessions(b, dq?.todayYmd) : null;
  const priorHadTraffic = b ? b.priorSessions > 0 || b.sessions > 0 : false;
  if (rt == null && latest == null) {
    checks.push({ id: 'data_flow', label: 'Data flow', status: 'skip', detail: 'Could not read realtime or daily sessions this run.' });
  } else if ((rt ?? 0) === 0 && latest != null && latest.sessions === 0 && priorHadTraffic) {
    // Nothing live AND the last complete day is empty on a property that normally has traffic → outage.
    const a: Ga4MonitorAlert = {
      id: 'no_data',
      kind: 'no_data',
      severity: 'critical',
      title: 'No data is being received',
      detail: `0 active users right now and 0 sessions on the last complete day (${latest.date}), on a property that normally records traffic. Collection has likely stopped (tag removed, gtag/GTM broken, or the stream disabled).`,
      recommendation: 'Check the GA4 tag/stream is firing (Realtime + DebugView) and that a recent site/tag release did not remove it.',
    };
    pushAlert(a);
    checks.push({ id: 'data_flow', label: 'Data flow', status: 'fail', detail: a.detail });
  } else if (latest != null && latest.sessions === 0 && priorHadTraffic) {
    // Yesterday empty but something may be live now — still a collection gap worth flagging.
    const a: Ga4MonitorAlert = {
      id: 'no_data_day',
      kind: 'no_data',
      severity: 'high',
      title: 'No data on the last complete day',
      detail: `0 sessions on ${latest.date} for a property that normally records traffic${rt != null ? ` (${rt} active users right now)` : ''}. A collection gap or a broken/removed tag that day.`,
      recommendation: 'Confirm the tag fired on that date (DebugView/Realtime) and rule out a release that broke tracking.',
    };
    pushAlert(a);
    checks.push({ id: 'data_flow', label: 'Data flow', status: 'fail', detail: a.detail });
  } else {
    const parts: string[] = [];
    if (rt != null) parts.push(`${rt} active user(s) now`);
    if (latest != null) parts.push(`${latest.sessions.toLocaleString('en-US')} sessions on ${latest.date}`);
    checks.push({ id: 'data_flow', label: 'Data flow', status: 'pass', detail: parts.join(' · ') || 'Data is flowing.' });
  }

  // ── 2 · Key events still firing? (per-event drop-to-zero / plunge) ──
  if (input.eventDeltas && input.eventDeltas.events.length) {
    const findings = auditGa4EventDeltas({ events: input.eventDeltas.events, keyEventNames: input.keyEventNames });
    if (!findings.length) {
      checks.push({ id: 'events', label: 'Key events firing', status: 'pass', detail: `${input.eventDeltas.events.length} event(s) checked; none stopped or plunged.` });
    } else {
      for (const f of findings) {
        const nameMatch = /"([^"]+)"/.exec(f.message);
        const kind = /stopped firing/.test(f.message) ? 'event_stopped' : 'event_drop';
        pushAlert(fromFinding(kind, nameMatch?.[1] ?? f.message, f, kind === 'event_stopped' ? 'A tracked event stopped firing' : 'A tracked event dropped sharply'));
      }
      const worst: MonitorCheckStatus = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'events', label: 'Key events firing', status: worst, detail: `${findings.length} event issue(s) detected.` });
    }
  } else {
    checks.push({ id: 'events', label: 'Key events firing', status: 'skip', detail: 'No per-event deltas available this run.' });
  }

  // ── 3 · Sudden spike / drop in traffic (shape) ──
  if (b && b.dailySessions.length >= 5) {
    const trend = analyzeGa4Trend({
      dailySessions: b.dailySessions,
      peakDayChannels: b.peakDayChannels,
      windowChannels: dq?.channelGroups ?? [],
      todayYmd: dq?.todayYmd,
    });
    if (trend.pattern === 'one_day_spike' || trend.pattern === 'multi_day_spike') {
      pushAlert({
        id: `spike:${slug(trend.pattern)}`,
        kind: 'spike',
        severity: 'medium',
        title: 'Sudden traffic spike',
        detail: trend.summary,
        recommendation: 'Correlate the spike to a real cause (launch/campaign) vs bots or double-tagging before trusting the lift.',
      });
      checks.push({ id: 'trend', label: 'Traffic shape', status: 'warn', detail: trend.summary });
    } else if (trend.pattern === 'downtrend') {
      pushAlert({
        id: 'drop:downtrend',
        kind: 'drop',
        severity: 'medium',
        title: 'Sustained traffic drop',
        detail: trend.summary,
        recommendation: 'Check for a tracking regression (broken tag/consent) vs a genuine demand drop.',
      });
      checks.push({ id: 'trend', label: 'Traffic shape', status: 'warn', detail: trend.summary });
    } else {
      checks.push({ id: 'trend', label: 'Traffic shape', status: 'pass', detail: trend.summary });
    }
  } else {
    checks.push({ id: 'trend', label: 'Traffic shape', status: 'skip', detail: 'Not enough daily data to characterise the trend.' });
  }

  // ── 4 · Outcomes moving with traffic? (growth / conversion-tracking integrity) ──
  if (b) {
    const growth = auditGa4Growth({
      sessions: b.sessions,
      priorSessions: b.priorSessions,
      keyEvents: b.keyEvents,
      priorKeyEvents: b.priorKeyEvents,
      revenue: b.revenue,
      priorRevenue: b.priorRevenue,
      topChannel: b.channelPerformance?.[0]?.channel ?? null,
    });
    const actionable = growth.findings.filter((f) => f.severity !== 'info');
    if (!growth.assessed) {
      checks.push({ id: 'growth', label: 'Outcomes vs traffic', status: 'skip', detail: 'Prior period had too little traffic to judge a spike/drop.' });
    } else if (!actionable.length) {
      checks.push({ id: 'growth', label: 'Outcomes vs traffic', status: 'pass', detail: 'Key events and revenue moved with sessions.' });
    } else {
      for (const f of actionable) pushAlert(fromFinding('conversion_break', f.category + ':' + f.message.slice(0, 24), f, 'Outcomes did not move with traffic'));
      const worst: MonitorCheckStatus = actionable.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'growth', label: 'Outcomes vs traffic', status: worst, detail: actionable[0].message });
    }
  } else {
    checks.push({ id: 'growth', label: 'Outcomes vs traffic', status: 'skip', detail: 'No baseline available this run.' });
  }

  // ── 5 · Attribution / data-quality health (Unassigned, "(not set)", no-data) ──
  if (dq) {
    const res = auditGa4DataQuality(dq);
    const actionable = res.findings.filter((f) => f.severity !== 'info');
    if (!actionable.length) {
      checks.push({ id: 'data_quality', label: 'Attribution quality', status: 'pass', detail: `${dq.totalSessions.toLocaleString('en-US')} sessions; channel/source attribution within range.` });
    } else {
      for (const f of actionable) pushAlert(fromFinding('data_quality', f.category + ':' + f.message.slice(0, 24), f, 'Attribution quality issue'));
      const worst: MonitorCheckStatus = actionable.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'data_quality', label: 'Attribution quality', status: worst, detail: actionable[0].message });
    }
  } else {
    checks.push({ id: 'data_quality', label: 'Attribution quality', status: 'skip', detail: 'No data-quality counts available this run.' });
  }

  // ── 6 · Ecommerce revenue integrity (duplicate / unlabelled transactions) ──
  if (input.hasEcommerce && input.transactions) {
    const findings = auditGa4Transactions({ hasEcommerce: true, transactions: input.transactions.transactions, notSetShare: input.transactions.notSetShare });
    if (!findings.length) {
      checks.push({ id: 'transactions', label: 'Revenue integrity', status: 'pass', detail: 'No duplicate or unlabelled transactions detected.' });
    } else {
      for (const f of findings) pushAlert(fromFinding('duplicate_tx', f.message.slice(0, 32), f, 'Revenue integrity issue'));
      const worst: MonitorCheckStatus = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'transactions', label: 'Revenue integrity', status: worst, detail: findings[0].message });
    }
  } else if (input.hasEcommerce) {
    checks.push({ id: 'transactions', label: 'Revenue integrity', status: 'skip', detail: 'Transaction data unavailable this run.' });
  }

  // Sort alerts worst-first (stable for equal severity → deterministic output and Slack ordering).
  alerts.sort((a, z) => SEV_RANK[a.severity] - SEV_RANK[z.severity]);

  const hasCrit = alerts.some((a) => a.severity === 'critical' || a.severity === 'high');
  const hasWarn = alerts.some((a) => a.severity === 'medium' || a.severity === 'low');
  const health: MonitorHealth = hasCrit ? 'critical' : hasWarn ? 'warning' : 'healthy';
  const summary =
    health === 'critical'
      ? `${alerts.length} issue(s) need attention — ${alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length} critical.`
      : health === 'warning'
        ? `${alerts.length} issue(s) to watch.`
        : 'All monitored checks are healthy.';

  return { property: input.property, health, summary, checks, alerts };
}
