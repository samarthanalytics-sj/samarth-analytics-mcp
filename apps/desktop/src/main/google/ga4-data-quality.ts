// Pure GA4 data-quality engine. Unlike audit_ga4_property (which checks CONFIG),
// this looks at the actual reporting data over a window and flags problems that
// silently corrupt analytics: traffic landing in the "Unassigned" channel, a
// high share of "(not set)" source/medium, or no data at all. No I/O — the
// data-service fetches the session counts and feeds them in, so the thresholds
// are fully unit-testable.

import type { ScorecardFinding, Severity } from './scorecard';

export interface DataQualityCounts {
  /** Total sessions in the window (sum over channel groups — the true total). */
  totalSessions: number;
  /** sessionDefaultChannelGroup → sessions (complete; channel groups are few). */
  channelGroups: Array<{ name: string; sessions: number }>;
  /** sessionSourceMedium → sessions, top-N by sessions (tail is negligible). */
  sourceMediums: Array<{ name: string; sessions: number }>;
  windowDays: number;
}

export interface Ga4DataQualityResult {
  totalSessions: number;
  windowDays: number;
  findings: ScorecardFinding[];
}

const DQ = 'data_quality';

function share(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

// A share of total sessions → severity. Below 5% isn't worth flagging.
function severityForShare(pct: number): Severity | null {
  if (pct >= 25) return 'high';
  if (pct >= 10) return 'medium';
  if (pct >= 5) return 'low';
  return null;
}

function sumWhere(rows: Array<{ name: string; sessions: number }>, re: RegExp): number {
  return rows.filter((r) => re.test(r.name)).reduce((s, r) => s + r.sessions, 0);
}

export function auditGa4DataQuality(counts: DataQualityCounts): Ga4DataQualityResult {
  const findings: ScorecardFinding[] = [];
  const total = counts.totalSessions;
  const days = counts.windowDays;

  if (total <= 0) {
    findings.push({
      severity: 'high',
      category: DQ,
      message: `No sessions recorded in the last ${days} days — the property may not be collecting data.`,
      recommendation: 'Confirm the GA4 tag fires on the site (Realtime should show traffic) and that the right measurement id is configured.',
    });
    return { totalSessions: total, windowDays: days, findings };
  }

  const unassigned = sumWhere(counts.channelGroups, /unassigned/i);
  const uShare = share(unassigned, total);
  const uSev = severityForShare(uShare);
  if (uSev) {
    findings.push({
      severity: uSev,
      category: DQ,
      message: `${uShare.toFixed(1)}% of sessions are in the "Unassigned" channel (${unassigned}/${total}).`,
      recommendation: 'Unassigned traffic usually means missing/incorrect UTMs or tags firing before consent — check campaign tagging and that the GA4 tag gets referrer/source data.',
    });
  }

  const notSet = sumWhere(counts.sourceMediums, /\(not set\)/i);
  const nShare = share(notSet, total);
  const nSev = severityForShare(nShare);
  if (nSev) {
    findings.push({
      severity: nSev,
      category: DQ,
      message: `${nShare.toFixed(1)}% of sessions have a "(not set)" source/medium (${notSet}/${total}).`,
      recommendation: 'A high "(not set)" source/medium share points to sessions starting without referrer/UTM data — often pre-consent tag fires or redirect loss. Verify Consent Mode and landing-page redirects.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      category: DQ,
      message: `No major data-quality issues in the last ${days} days (${total} sessions): Unassigned ${uShare.toFixed(1)}%, "(not set)" source/medium ${nShare.toFixed(1)}%.`,
    });
  }

  return { totalSessions: total, windowDays: days, findings };
}
