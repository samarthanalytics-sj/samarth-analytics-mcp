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
import { antiLieFindings } from './ga4-anti-lie';
import type { Ga4CampaignReport } from './ga4-campaigns';
import type { Ga4PropertySnapshot } from './ga4-audit';

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
  /** Unattributed-session share (Unassigned / "(not set)", 0-100) for the PRIOR equal window, so a
   *  RISE vs the current window can flag consent-mode / attribution drift. null = not fetched. */
  priorNoSourceShare: number | null;
  /** The FIRST underlying error message when queries failed (expired session, lost access, quota).
   *  When EVERY check ends up skipped, the engine surfaces this instead of reporting "healthy". */
  fetchError?: string | null;
  /** Ranked campaign performance (same engine as the audit) — feeds the revenue-reconciliation and
   *  untagged-share checks. null = query failed/not fetched → those checks skip. */
  campaigns?: Ga4CampaignReport | null;
  /** Property snapshot (own domains for self-referrals, Signals for thresholding). */
  snapshot?: Ga4PropertySnapshot | null;
  /** PRIOR-window channel groups (name+sessions) for the channel-mix-shift check. */
  priorChannelGroups?: Array<{ name: string; sessions: number }> | null;
}

/** Tunable thresholds for a monitor run. Omitted fields use the defaults below. `minSeverity` filters
 *  which findings become alerts (and get Slacked) — raise it to cut noise; lower it to catch more. */
export interface Ga4MonitorOptions {
  /** Alert on findings at this severity and worse (default 'medium'). */
  minSeverity?: Severity;
  /** Percentage-point rise in the unattributed share (vs prior window) that flags consent drift (default 12). */
  consentDriftPp?: number;
  /** The current unattributed share must be at least this % for a drift to matter (default 15). */
  consentMinSharePct?: number;
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
/** A slug safe for a stable alert id (used to dedup ongoing issues across runs). */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** GA4 "date" (YYYYMMDD) → a readable "Jul 3, 2026"; passes through anything that isn't a plain date. */
const fmtDate = (ymd: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}, ${m[1]}` : ymd || '';
};
const n = (x: number): string => x.toLocaleString('en-US');
/** "1 session" / "2 sessions" — avoids the clunky "session(s)". */
const plural = (x: number, one: string, many: string): string => `${n(x)} ${x === 1 ? one : many}`;
/** House style: no em/en dashes in surfaced copy. The audit strips these on render; the monitor emits
 *  raw, so clean the shared-engine messages it reuses here. */
const clean = (s?: string): string | undefined => (s == null ? s : s.replace(/\s*[—–]\s*/g, ' - '));

/** Current unattributed-session share (%): the larger of the Unassigned channel share and the
 *  "(not set)" source/medium share, over total sessions — the same signal the audit uses. Exported so
 *  the data layer can compute the PRIOR-window share to feed consent-drift detection. */
export function noSourceSharePct(dq: DataQualityCounts): number | null {
  const total = dq.totalSessions || 0;
  if (total <= 0) return null;
  const unassigned = dq.channelGroups.filter((c) => /unassigned/i.test(c.name)).reduce((a, c) => a + c.sessions, 0);
  const notSet = dq.sourceMediums.filter((c) => /\(not set\)/i.test(c.name)).reduce((a, c) => a + c.sessions, 0);
  return Math.min(100, (Math.max(unassigned, notSet) / total) * 100);
}

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

export function monitorGa4(input: Ga4MonitorInput, opts: Ga4MonitorOptions = {}): Ga4MonitorResult {
  const minRank = SEV_RANK[opts.minSeverity ?? 'medium'];
  const consentDriftPp = opts.consentDriftPp ?? 12;
  const consentMinShare = opts.consentMinSharePct ?? 15;
  const checks: Ga4MonitorCheck[] = [];
  const alerts: Ga4MonitorAlert[] = [];
  // A finding becomes an alert (and gets Slacked) only at/above the configured minimum severity.
  const pushAlert = (a: Ga4MonitorAlert): void => {
    if (SEV_RANK[a.severity] <= minRank) alerts.push(a);
  };
  // Map a pure-engine finding to an alert with a stable id derived from its kind + a key.
  const fromFinding = (kind: string, key: string, f: ScorecardFinding, title: string): Ga4MonitorAlert => ({
    id: `${kind}:${slug(key)}`,
    kind,
    severity: f.severity,
    title,
    detail: clean(f.message) ?? f.message,
    recommendation: clean(f.recommendation),
  });

  const b = input.baseline;
  const dq = input.dqCounts;

  // ── 1 · Data flow: is GA4 still receiving anything? ──
  const rt = input.realtimeActiveUsers;
  const latest = b ? latestCompleteDaySessions(b, dq?.todayYmd) : null;
  const priorHadTraffic = b ? b.priorSessions > 0 || b.sessions > 0 : false;
  if (rt == null && latest == null) {
    checks.push({ id: 'data_flow', label: 'Data collection', status: 'skip', detail: 'Could not read real-time or daily sessions on this run.' });
  } else if ((rt ?? 0) === 0 && latest != null && latest.sessions === 0 && priorHadTraffic) {
    // Nothing live AND the last complete day is empty on a property that normally has traffic → outage.
    const a: Ga4MonitorAlert = {
      id: 'no_data',
      kind: 'no_data',
      severity: 'critical',
      title: 'GA4 has stopped receiving data',
      detail: `No active users right now, and no sessions were recorded on the last full day (${fmtDate(latest.date)}), on a property that normally has traffic. Data collection has most likely stopped - a removed or broken tag, or a disabled data stream.`,
      recommendation: 'Confirm the GA4 tag is firing (GA4 Realtime and DebugView), and check whether a recent website or tag release removed or broke it.',
    };
    pushAlert(a);
    checks.push({ id: 'data_flow', label: 'Data collection', status: 'fail', detail: a.detail });
  } else if (latest != null && latest.sessions === 0 && priorHadTraffic) {
    // Yesterday empty but something may be live now — still a collection gap worth flagging.
    const a: Ga4MonitorAlert = {
      id: 'no_data_day',
      kind: 'no_data',
      severity: 'high',
      title: 'No data recorded for the last full day',
      detail: `No sessions were recorded on ${fmtDate(latest.date)}, on a property that normally has traffic${rt != null ? ` (${plural(rt, 'active user', 'active users')} right now)` : ''}. This points to a collection gap or a tag that broke that day.`,
      recommendation: 'Check that the GA4 tag fired on that date (Realtime and DebugView) and rule out a release that broke tracking.',
    };
    pushAlert(a);
    checks.push({ id: 'data_flow', label: 'Data collection', status: 'fail', detail: a.detail });
  } else {
    const parts: string[] = [];
    if (rt != null) parts.push(`${plural(rt, 'active user', 'active users')} right now`);
    if (latest != null) parts.push(`${plural(latest.sessions, 'session', 'sessions')} on ${fmtDate(latest.date)}`);
    checks.push({ id: 'data_flow', label: 'Data collection', status: 'pass', detail: parts.join(' · ') || 'Data is being collected.' });
  }

  // ── 2 · Key events still firing? (per-event drop-to-zero / plunge) ──
  if (input.eventDeltas && input.eventDeltas.events.length) {
    const findings = auditGa4EventDeltas({ events: input.eventDeltas.events, keyEventNames: input.keyEventNames });
    if (!findings.length) {
      checks.push({ id: 'events', label: 'Conversion events firing', status: 'pass', detail: `${plural(input.eventDeltas.events.length, 'event', 'events')} checked; none stopped or dropped sharply.` });
    } else {
      for (const f of findings) {
        const nameMatch = /"([^"]+)"/.exec(f.message);
        const kind = /stopped firing/.test(f.message) ? 'event_stopped' : 'event_drop';
        pushAlert(fromFinding(kind, nameMatch?.[1] ?? f.message, f, kind === 'event_stopped' ? 'A tracked event has stopped firing' : 'A tracked event dropped sharply'));
      }
      const worst: MonitorCheckStatus = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'events', label: 'Conversion events firing', status: worst, detail: `${plural(findings.length, 'event issue', 'event issues')} detected.` });
    }
  } else {
    checks.push({ id: 'events', label: 'Conversion events firing', status: 'skip', detail: 'No per-event data available on this run.' });
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
        title: 'Unusual spike in traffic',
        detail: clean(trend.summary) ?? trend.summary,
        recommendation: 'Confirm the spike has a real cause (a launch or campaign) before trusting the lift - a sudden jump can also be bot traffic or a double-firing tag.',
      });
      checks.push({ id: 'trend', label: 'Traffic trend', status: 'warn', detail: clean(trend.summary) ?? trend.summary });
    } else if (trend.pattern === 'downtrend') {
      pushAlert({
        id: 'drop:downtrend',
        kind: 'drop',
        severity: 'medium',
        title: 'Traffic is trending down',
        detail: clean(trend.summary) ?? trend.summary,
        recommendation: 'Check whether this is a real drop in demand or a tracking problem (a broken tag or a consent change reducing what is collected).',
      });
      checks.push({ id: 'trend', label: 'Traffic trend', status: 'warn', detail: clean(trend.summary) ?? trend.summary });
    } else {
      checks.push({ id: 'trend', label: 'Traffic trend', status: 'pass', detail: clean(trend.summary) ?? trend.summary });
    }
  } else {
    checks.push({ id: 'trend', label: 'Traffic trend', status: 'skip', detail: 'Not enough daily data yet to read the traffic trend.' });
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
      checks.push({ id: 'growth', label: 'Conversions vs traffic', status: 'skip', detail: 'The prior period had too little traffic to compare growth against.' });
    } else if (!actionable.length) {
      checks.push({ id: 'growth', label: 'Conversions vs traffic', status: 'pass', detail: 'Conversions and revenue moved in step with sessions.' });
    } else {
      for (const f of actionable) pushAlert(fromFinding('conversion_break', f.category + ':' + f.message.slice(0, 24), f, 'Traffic changed but conversions did not keep pace'));
      const worst: MonitorCheckStatus = actionable.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'growth', label: 'Conversions vs traffic', status: worst, detail: clean(actionable[0].message) ?? actionable[0].message });
    }
  } else {
    checks.push({ id: 'growth', label: 'Conversions vs traffic', status: 'skip', detail: 'No traffic data available on this run.' });
  }

  // ── 5 · Attribution / data-quality health (Unassigned, "(not set)", no-data) ──
  if (dq) {
    const res = auditGa4DataQuality(dq);
    const actionable = res.findings.filter((f) => f.severity !== 'info');
    if (!actionable.length) {
      checks.push({ id: 'data_quality', label: 'Traffic source attribution', status: 'pass', detail: `${plural(dq.totalSessions, 'session', 'sessions')}; traffic sources are being attributed normally.` });
    } else {
      for (const f of actionable) pushAlert(fromFinding('data_quality', f.category + ':' + f.message.slice(0, 24), f, 'Traffic sources are not being attributed'));
      const worst: MonitorCheckStatus = actionable.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'data_quality', label: 'Traffic source attribution', status: worst, detail: clean(actionable[0].message) ?? actionable[0].message });
    }
  } else {
    checks.push({ id: 'data_quality', label: 'Traffic source attribution', status: 'skip', detail: 'No traffic-source data available on this run.' });
  }

  // ── 5b · Consent-mode / attribution drift ──
  // A consent-mode regression (a banner change, a Consent Mode v2 mis-tag, gtag update) shows up as a
  // sudden RISE in unattributed sessions — traffic that lost its source when consent was denied/missing.
  // We can't read the consent config via the Admin API, so we watch its footprint: the unattributed
  // share vs the prior equal window. A material rise is flagged (distinct from the static high-share
  // check above, which fires even when nothing changed).
  const curShare = dq ? noSourceSharePct(dq) : null;
  if (curShare != null && input.priorNoSourceShare != null) {
    const drift = curShare - input.priorNoSourceShare;
    if (curShare >= consentMinShare && drift >= consentDriftPp) {
      pushAlert({
        id: 'consent_drift',
        kind: 'consent_drift',
        severity: drift >= consentDriftPp * 2 ? 'high' : 'medium',
        title: 'More visits are losing their traffic source',
        detail: `The share of sessions with no traffic source rose from ${input.priorNoSourceShare.toFixed(1)}% to ${curShare.toFixed(1)}% since the prior period (up ${drift.toFixed(1)} points). This is the usual sign of a consent-banner or Consent Mode change: when consent is denied or missing, GA4 drops the source and the visit lands in "(not set)" or Unassigned.`,
        recommendation: 'Check for a recent cookie-banner, consent-mode, or gtag change, and confirm the consent signals fire correctly in DebugView before relying on channel reports.',
      });
      checks.push({ id: 'consent_drift', label: 'Consent & attribution stability', status: 'warn', detail: `Sessions with no source rose to ${curShare.toFixed(1)}% (was ${input.priorNoSourceShare.toFixed(1)}%, up ${drift.toFixed(1)} points).` });
    } else {
      checks.push({ id: 'consent_drift', label: 'Consent & attribution stability', status: 'pass', detail: `Sessions with no source are steady (${curShare.toFixed(1)}% now vs ${input.priorNoSourceShare.toFixed(1)}% before).` });
    }
  } else {
    checks.push({ id: 'consent_drift', label: 'Consent & attribution stability', status: 'skip', detail: 'Need both the current and prior period to detect a change.' });
  }

  // ── 6 · Ecommerce revenue integrity (duplicate / unlabelled transactions) ──
  if (input.hasEcommerce && input.transactions) {
    const findings = auditGa4Transactions({ hasEcommerce: true, transactions: input.transactions.transactions, notSetShare: input.transactions.notSetShare });
    if (!findings.length) {
      checks.push({ id: 'transactions', label: 'Revenue integrity', status: 'pass', detail: 'No duplicated or unlabelled purchases detected.' });
    } else {
      for (const f of findings) pushAlert(fromFinding('duplicate_tx', f.message.slice(0, 32), f, 'Purchases may be duplicated or unlabelled'));
      const worst: MonitorCheckStatus = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'fail' : 'warn';
      checks.push({ id: 'transactions', label: 'Revenue integrity', status: worst, detail: clean(findings[0].message) ?? findings[0].message });
    }
  } else if (input.hasEcommerce) {
    checks.push({ id: 'transactions', label: 'Revenue integrity', status: 'skip', detail: 'No purchase data available on this run.' });
  }

  // ── 6 · Data CORRECTNESS — the SAME anti-lie detectors the audit runs, on a schedule. The monitor
  // must never read "all healthy" on a property the audit grades broken: shared code (ga4-anti-lie)
  // makes disagreement structurally impossible — same inputs, same detectors, same verdict.
  {
    const anti = antiLieFindings(b ?? null, dq ?? null, input.campaigns ?? null, input.snapshot ?? null);
    const firstOf = (cat: string) => anti.find((f) => f.category === cat);
    const raise = (kind: string, title: string, f: { severity: string; message: string; recommendation?: string } | undefined): boolean => {
      if (!f) return false;
      pushAlert({ id: kind, kind, severity: f.severity as Severity, title, detail: clean(f.message) ?? f.message, recommendation: clean(f.recommendation) });
      return true;
    };

    // Campaign vs channel revenue reconciliation — the audit's HIGH finding, weekly-scale value.
    if (input.campaigns && b?.channelPerformance?.length) {
      const hit = firstOf('attribution_mismatch');
      const fired = raise('attribution_mismatch', 'Campaign and channel revenue do not reconcile', hit);
      checks.push({ id: 'reconciliation', label: 'Revenue reconciliation', status: fired ? 'fail' : 'pass', detail: fired ? clean(hit!.message) ?? hit!.message : 'Paid-campaign revenue reconciles with the paid channels.' });
    } else {
      checks.push({ id: 'reconciliation', label: 'Revenue reconciliation', status: 'skip', detail: 'No campaign/channel revenue data on this run.' });
    }

    // Traffic concentration — the Direct-spike detector (same series/grouping as the audit chart).
    if (b?.channelDaily?.length) {
      const hit = firstOf('concentration');
      const fired = raise('concentration', 'Traffic concentration: one burst dominates a channel', hit);
      checks.push({ id: 'concentration', label: 'Traffic concentration', status: fired ? 'fail' : 'pass', detail: fired ? clean(hit!.message) ?? hit!.message : 'No single day/week/month dominates any channel.' });
    } else {
      checks.push({ id: 'concentration', label: 'Traffic concentration', status: 'skip', detail: 'No per-channel daily series on this run.' });
    }

    // Untagged-traffic share — rising untagged traffic breaks attribution silently.
    if (input.campaigns) {
      const share = input.campaigns.untaggedSharePct;
      if (share >= 40) {
        pushAlert({
          id: 'untagged_share',
          kind: 'untagged_share',
          severity: share >= 60 ? 'high' : 'medium',
          title: 'Untagged traffic is breaking attribution',
          detail: `${share.toFixed(1)}% of sessions carry no utm_campaign (${input.campaigns.untaggedSessions.toLocaleString('en-US')} of ${input.campaigns.totalSessions.toLocaleString('en-US')}) - that share of results cannot be tied to any campaign, and untagged paid traffic lands mislabeled in Direct/organic buckets.`,
          recommendation: 'Add utm_campaign/utm_source/utm_medium to marketing links (ads, email, social) and verify Google Ads auto-tagging so paid sessions leave the untagged buckets.',
        });
        checks.push({ id: 'untagged', label: 'Untagged traffic share', status: 'warn', detail: `${share.toFixed(1)}% of sessions are untagged (threshold 40%).` });
      } else {
        checks.push({ id: 'untagged', label: 'Untagged traffic share', status: 'pass', detail: `${share.toFixed(1)}% of sessions are untagged - below the 40% threshold.` });
      }
    } else {
      checks.push({ id: 'untagged', label: 'Untagged traffic share', status: 'skip', detail: 'No campaign data on this run.' });
    }

    // Invalid-traffic signature — engagement bimodality across markets (Vietnam-pattern).
    if (b?.geoPerformance && b.geoPerformance.length >= 4) {
      const hit = firstOf('invalid_traffic');
      const fired = raise('invalid_traffic', 'Suspected invalid traffic in low-engagement markets', hit);
      checks.push({ id: 'invalid_traffic', label: 'Invalid-traffic signature', status: fired ? 'fail' : 'pass', detail: fired ? clean(hit!.message) ?? hit!.message : 'Market engagement forms one population - no bot-like low cluster.' });
    } else {
      checks.push({ id: 'invalid_traffic', label: 'Invalid-traffic signature', status: 'skip', detail: 'Not enough market data on this run.' });
    }

    // Referral hygiene — self-referrals (broken cross-domain) + payment-gateway leakage.
    if (dq?.sourceMediums?.length && input.snapshot) {
      const selfRef = firstOf('self_referral');
      const gateway = firstOf('referral_leakage');
      const f1 = raise('self_referral', 'Your own site appears as a referral source', selfRef);
      const f2 = raise('referral_leakage', 'Payment-gateway referral leakage', gateway);
      checks.push({
        id: 'referral_hygiene',
        label: 'Referral hygiene',
        status: f1 || f2 ? 'fail' : 'pass',
        detail: f1 || f2 ? [selfRef?.message, gateway?.message].filter(Boolean).map((m) => clean(m as string) ?? m).join(' ') : 'No self-referrals or payment-gateway referrals.',
      });
    } else {
      checks.push({ id: 'referral_hygiene', label: 'Referral hygiene', status: 'skip', detail: 'No source/medium data on this run.' });
    }

    // PII in page URLs (masked by the shared detector; the alert never re-leaks the value).
    if (b?.landingPages?.length) {
      const hit = firstOf('pii');
      const fired = raise('pii', 'PII is being sent to GA4 in page URLs', hit);
      checks.push({ id: 'pii', label: 'PII in URLs', status: fired ? 'fail' : 'pass', detail: fired ? clean(hit!.message) ?? hit!.message : 'No emails or personal-data query params in the top landing pages.' });
    }

    // Channel-mix shift — a channel's session share jumping >= 15 points week-over-window is usually
    // a tagging regression (deterministic, current vs prior channel groups).
    if (dq?.channelGroups?.length && input.priorChannelGroups?.length) {
      const total = dq.channelGroups.reduce((sum, c) => sum + c.sessions, 0);
      const priorTotal = input.priorChannelGroups.reduce((sum, c) => sum + c.sessions, 0);
      let worst: { name: string; from: number; to: number } | null = null;
      if (total > 0 && priorTotal > 0) {
        const priorShare = new Map(input.priorChannelGroups.map((c) => [c.name, (c.sessions / priorTotal) * 100]));
        for (const c of dq.channelGroups) {
          const now = (c.sessions / total) * 100;
          const before = priorShare.get(c.name) ?? 0;
          if (Math.abs(now - before) >= 15 && Math.max(now, before) >= 10 && (!worst || Math.abs(now - before) > Math.abs(worst.to - worst.from))) {
            worst = { name: c.name, from: before, to: now };
          }
        }
      }
      if (worst) {
        pushAlert({
          id: `channel_shift:${slug(worst.name)}`,
          kind: 'channel_shift',
          severity: 'medium',
          title: `Channel mix shifted: ${worst.name}`,
          detail: `${worst.name} moved from ${worst.from.toFixed(1)}% to ${worst.to.toFixed(1)}% of sessions vs the prior window (${Math.abs(worst.to - worst.from).toFixed(1)} points) - a jump this size is usually a tagging regression or an untagged burst, not organic drift.`,
          recommendation: `Check what changed for ${worst.name}: recent site/tag deploys, UTM changes, or an untagged campaign landing there.`,
        });
        checks.push({ id: 'channel_shift', label: 'Channel-mix stability', status: 'warn', detail: `${worst.name}: ${worst.from.toFixed(1)}% -> ${worst.to.toFixed(1)}% of sessions vs the prior window.` });
      } else {
        checks.push({ id: 'channel_shift', label: 'Channel-mix stability', status: 'pass', detail: 'No channel moved more than 15 share points vs the prior window.' });
      }
    } else {
      checks.push({ id: 'channel_shift', label: 'Channel-mix stability', status: 'skip', detail: 'Need both current and prior channel mix on this run.' });
    }
  }

  // ── Access guard: when EVERY check skipped, the property is not "healthy" — it is UNREADABLE.
  // Reporting healthy here is false assurance (the exact state a broken token or lost property
  // access produces), so surface the real underlying error as a failed check + a high alert. The
  // stable id means it Slacks once when access breaks and clears when reading works again.
  if (checks.length > 0 && checks.every((c) => c.status === 'skip')) {
    const cause = input.fetchError ? clean(input.fetchError) ?? input.fetchError : null;
    checks.unshift({
      id: 'access',
      label: 'Data access',
      status: 'fail',
      detail: cause ? `Every GA4 query failed on this run - ${cause}` : 'Every GA4 query failed on this run (no data could be read).',
    });
    pushAlert({
      id: 'no_access',
      kind: 'no_data',
      severity: 'high',
      title: 'Could not read this property',
      detail: `${cause ? `GA4 returned an error: ${cause}. ` : ''}Every query failed, so no check could run. Usual causes: the Google session expired, this account lost access to the property, or the API quota is exhausted.`,
      recommendation: 'Re-connect the Google account (sidebar), confirm it still has access to this GA4 property (GA4 Admin > Property access management), then click Run check again.',
    });
  }

  // Sort alerts worst-first (stable for equal severity → deterministic output and Slack ordering).
  alerts.sort((a, z) => SEV_RANK[a.severity] - SEV_RANK[z.severity]);

  const hasCrit = alerts.some((a) => a.severity === 'critical' || a.severity === 'high');
  const hasWarn = alerts.some((a) => a.severity === 'medium' || a.severity === 'low');
  const health: MonitorHealth = hasCrit ? 'critical' : hasWarn ? 'warning' : 'healthy';
  const serious = alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length;
  const summary =
    health === 'critical'
      ? `${plural(alerts.length, 'issue needs', 'issues need')} attention (${serious} serious).`
      : health === 'warning'
        ? `${plural(alerts.length, 'issue', 'issues')} to keep an eye on.`
        : 'Everything looks healthy.';

  return { property: input.property, health, summary, checks, alerts };
}
