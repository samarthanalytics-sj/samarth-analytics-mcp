// Pure GA4 campaign-performance ranker. Given per-campaign session/conversion/revenue rows from the Data
// API, it splits real (tagged) marketing campaigns from the untagged buckets GA4 uses when there is no
// utm_campaign, ranks the tagged ones by the most meaningful available metric, and flags two problems:
// no campaign attribution at all, and a large share of traffic still arriving untagged. No I/O — the
// data-service fetches the rows and feeds them in, so ranking + thresholds are fully unit-testable.

import type { ScorecardFinding } from './scorecard';
import { formatDateRange } from './ga4-data-quality';

export interface CampaignRow {
  campaign: string;
  sessions: number;
  keyEvents: number;
  revenue: number;
  engagementRate: number;
}

export interface Ga4CampaignInput {
  rows: CampaignRow[];
  totalSessions: number;
  windowDays: number;
  startDate?: string;
  endDate?: string;
  /** The property's revenue currency (ISO code, e.g. "USD", "INR") from the Data API report metadata, so
   *  revenue is labelled correctly instead of assuming '$'. Undefined when unknown → bare numbers. */
  currencyCode?: string;
}

export interface Ga4CampaignReport {
  windowDays: number;
  dateRange: string | null;
  totalSessions: number;
  /** The metric campaigns were ranked by — the most meaningful one the data actually supports. */
  primaryMetric: 'conversions' | 'revenue' | 'sessions';
  /** Tagged campaigns, ranked desc by primaryMetric (tiebreak revenue, then sessions). */
  taggedCampaigns: CampaignRow[];
  bestCampaign: CampaignRow | null;
  untaggedSessions: number;
  untaggedSharePct: number;
  /** The revenue currency (ISO code) echoed from the input, when known. */
  currencyCode?: string;
  summary: string;
  findings: ScorecardFinding[];
}

const ATTR = 'attribution';

// Case-insensitive campaign names GA4 uses when there is no real utm_campaign — these are NOT marketing
// campaigns, so they never get ranked and their sessions count as "untagged".
const UNTAGGED_NAMES = new Set([
  '(not set)',
  '(organic)',
  '(direct)',
  '(referral)',
  '(data not available)',
  '(data deleted)',
  '',
]);

function isUntagged(name: string): boolean {
  return UNTAGGED_NAMES.has((name ?? '').trim().toLowerCase());
}

function share(part: number, total: number): number {
  return total > 0 ? Math.min(100, (part / total) * 100) : 0;
}

/** Format a revenue amount without a trailing ".00", prefixed with the property's currency code when known
 *  (e.g. "INR 1250", "USD 4000.50"); with no currency it returns a bare number rather than assuming '$'. */
function money(n: number, currency?: string): string {
  const rounded = Math.round(n * 100) / 100;
  const amount = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return currency ? `${currency} ${amount}` : amount;
}

export function rankGa4Campaigns(input: Ga4CampaignInput): Ga4CampaignReport {
  const dateRange = formatDateRange(input.startDate, input.endDate);
  const tagged: CampaignRow[] = [];
  let untaggedSessions = 0;
  for (const r of input.rows) {
    if (isUntagged(r.campaign)) untaggedSessions += r.sessions;
    else tagged.push(r);
  }

  // Rank by the most meaningful metric the data supports: conversions if any tagged campaign has them,
  // else revenue if any has it, else fall back to sessions.
  const primaryMetric: Ga4CampaignReport['primaryMetric'] = tagged.some((r) => r.keyEvents > 0)
    ? 'conversions'
    : tagged.some((r) => r.revenue > 0)
      ? 'revenue'
      : 'sessions';
  const metricOf = (r: CampaignRow): number =>
    primaryMetric === 'conversions' ? r.keyEvents : primaryMetric === 'revenue' ? r.revenue : r.sessions;

  const taggedCampaigns = tagged.slice().sort((a, b) => {
    const byMetric = metricOf(b) - metricOf(a);
    if (byMetric !== 0) return byMetric;
    const byRevenue = b.revenue - a.revenue;
    if (byRevenue !== 0) return byRevenue;
    return b.sessions - a.sessions;
  });
  const bestCampaign = taggedCampaigns[0] ?? null;

  const untaggedSharePct = share(untaggedSessions, input.totalSessions);

  const findings: ScorecardFinding[] = [];
  if (taggedCampaigns.length === 0) {
    findings.push({
      severity: 'medium',
      category: ATTR,
      message: `No sessions are attributed to a marketing campaign — ${untaggedSharePct.toFixed(1)}% of traffic (${Math.min(untaggedSessions, input.totalSessions)}/${input.totalSessions}) is untagged, so campaign ROI cannot be measured.`,
      recommendation:
        'Add utm_campaign/utm_source/utm_medium to your marketing links (ads, email, social, paid partners) so campaign performance and ROI are measurable in GA4.',
    });
  } else {
    findings.push({
      severity: 'info',
      category: ATTR,
      message: `Top campaign by ${primaryMetric}: "${bestCampaign!.campaign}" (${bestCampaign!.keyEvents} conversions, ${money(bestCampaign!.revenue, input.currencyCode)}, ${bestCampaign!.sessions} sessions).`,
    });
    if (untaggedSharePct >= 40) {
      findings.push({
        severity: 'low',
        category: ATTR,
        message: `${untaggedSharePct.toFixed(1)}% of traffic (${Math.min(untaggedSessions, input.totalSessions)}/${input.totalSessions}) is still untagged (no utm_campaign), so a large share of results can't be tied back to a campaign.`,
        recommendation:
          'Tag more of your inbound links with utm_campaign/utm_source/utm_medium so a smaller share of sessions lands in the untagged buckets and campaign ROI covers more of your traffic.',
      });
    }
  }

  const summary =
    taggedCampaigns.length === 0
      ? `No tagged marketing campaigns over the last ${input.windowDays} days; ${untaggedSharePct.toFixed(1)}% of ${input.totalSessions} sessions is untagged.`
      : `Ranked ${taggedCampaigns.length} campaign(s) by ${primaryMetric} over the last ${input.windowDays} days; top is "${bestCampaign!.campaign}". ${untaggedSharePct.toFixed(1)}% of ${input.totalSessions} sessions is untagged.`;

  return {
    windowDays: input.windowDays,
    dateRange,
    totalSessions: input.totalSessions,
    primaryMetric,
    taggedCampaigns,
    bestCampaign,
    untaggedSessions,
    untaggedSharePct,
    currencyCode: input.currencyCode,
    summary,
    findings,
  };
}
