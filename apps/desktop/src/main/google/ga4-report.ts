// Pure GA4 property-audit REPORT builder — turns the config audit + data-quality audit + baseline
// metrics into a templated Markdown document in the verdict-first Audit Brain layout:
//   1 Verdict → 2 What is wrong → 3 Outcomes vs traffic → 4 All findings → 5 Area status →
//   6 Property baseline → 7 Decision readiness → 8 Not verified → 9 Scope & metadata.
// No I/O, so it's fully unit-testable; the IPC gathers the data and feeds it in. Sections that can't
// be computed deterministically (per-event parameter coverage, consent) are Not Verified — never a
// silent pass — and findings are graded to the worst unverified branch.

import type { Ga4AuditReport, Ga4PropertySnapshot } from './ga4-audit';
import type { Ga4DataQualityResult, DataQualityCounts } from './ga4-data-quality';
import type { Ga4GrowthResult, Ga4GrowthFinding } from './ga4-growth';
import type { Ga4CampaignReport } from './ga4-campaigns';
import type { Ga4Baseline } from './data-service';
import { buildGa4Scorecard } from './ga4-scorecard';
import { analyzeGa4Trend } from './ga4-trend';
import { deriveGa4Insights } from './ga4-insights';
import { antiLieFindings, maskPii } from './ga4-anti-lie';
import type { Ga4ExecSummaryView, Ga4VisualsView, Ga4SectionsView } from '../../shared/ipc';

export interface Ga4ReportInput {
  property: string; // "properties/123456"
  displayName: string;
  generatedAt: string; // ISO timestamp (injected for determinism)
  snapshot: Ga4PropertySnapshot;
  config: Ga4AuditReport;
  dataQuality: Ga4DataQualityResult;
  dqCounts: DataQualityCounts; // for channel-mix bars
  baseline: Ga4Baseline | null; // null = couldn't pull → baseline marked Not Verified
  growth: Ga4GrowthResult | null; // null = no baseline → growth not assessed
  attribution: { reportingAttributionModel: string; acquisitionConversionEventLookbackWindow: string; otherConversionEventLookbackWindow: string } | null;
  audienceCount: number | null;
  /** Ranked marketing-campaign performance (tagged utm_campaign traffic + untagged share), or null when
   *  the campaign query couldn't run — callers that don't pass it get null. */
  campaigns: Ga4CampaignReport | null;
  /** Weekly-retention cohort headline (Week 1 / Week 4), or null when there isn't enough reliable data. */
  retentionSummary?: string | null;
  /** Ecommerce transaction verification (Data API pass over transaction_ids): how many ids were
   *  checked, how many were duplicated, and the share of purchases with NO id. null/undefined = the
   *  pass did not run (non-ecommerce property, query failed, or an older caller) — the Ecommerce area
   *  then stays Partial and Revenue stays gated, exactly as before. */
  ecomVerification?: EcomVerification | null;
}

/** Result of the ecommerce transaction-integrity pass (duplicate + missing transaction_ids). */
export interface EcomVerification {
  transactionsChecked: number;
  duplicateIds: number;
  notSetSharePct: number;
}

interface AreaRow {
  area: string;
  statusKey: 'pass' | 'partial' | 'fail' | 'not_verified';
  evidence: string;
}
/** Verification state, orthogonal to severity. `confirmed` = deterministically measured this run;
 *  `unconfirmed` = observed, but the conclusion leans on a metric the audit could not verify (e.g. a
 *  growth read graded to its worst branch pending DebugView); `blocked` = the check itself could not
 *  run, so nothing was measured (consent, per-event parameters, duplicate transactions). */
export type FindingState = 'confirmed' | 'unconfirmed' | 'blocked';

interface FindingRow {
  severity: string;
  category: string;
  area: string;
  message: string;
  recommendation?: string;
  /** confirmed (default) | unconfirmed | blocked — see FindingState. */
  state?: FindingState;
  // Optional structured fields (populated by the growth engine) for the expanded "What is wrong" block.
  evidence?: string;
  whyItMatters?: string;
  ifUnconfirmed?: string;
  businessRisk?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const STATUS_LABEL: Record<string, string> = { pass: 'Pass', partial: 'Partial', fail: 'Fail', not_verified: 'Not Verified' };
// Colour the status at a glance (the GFM table renderer can't colour cells, so use dots).
const STATUS_DOT: Record<string, string> = { pass: '🟢', partial: '🟡', fail: '🔴', not_verified: '⚪' };
// Per-category business-risk fallback for findings that don't carry their own (config + data quality).
const RISK_BY_CATEGORY: Record<string, string> = {
  growth: 'Revenue/ROAS and growth claims unreliable until confirmed',
  data_quality: 'Channel/source attribution is unreliable for the affected sessions',
  collection: 'Collected data may be incomplete or double-counted',
  conversions: 'Conversion outcomes are not being measured',
  measurement: 'Auto-collected interactions are missing',
  retention: 'Historical analysis window is limited',
  privacy: 'GA4 ToS / privacy exposure',
  customdef: "Reports/explorations can't segment by your event or user parameters",
  integrations: 'Cross-product features (Ads, Signals) unavailable',
  benchmarking: 'Industry benchmarks unavailable',
  integrity: 'Event/revenue data may be corrupted (broken tag or double-counted purchases)',
  hygiene: 'Reports split across event-name variants; GA4 standard reports and integrations miss the traffic',
};

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);
/** Unicode bar (Audit Brain rule): filled = round(value/5) of 20, then the number. Clamped to
 *  0..100 so a share computed against a slightly different report total never prints e.g. 120%. */
const bar = (p: number): string => {
  const v = Math.max(0, Math.min(100, Math.round(p)));
  const filled = Math.round(v / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled) + ` ${v}%`;
};
/** Escape a value for a Markdown table cell (pipes + newlines). */
const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();
const num = (n: number): string => n.toLocaleString('en-US');
/** GA4 "date" dimension is YYYYMMDD → "Jun 15, 2026". */
const fmtDay = (ymd: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}, ${m[1]}` : ymd || '—';
};
const RETENTION_LABELS: Record<string, string> = {
  TWO_MONTHS: '2 months', FOURTEEN_MONTHS: '14 months', TWENTY_SIX_MONTHS: '26 months', THIRTY_EIGHT_MONTHS: '38 months', FIFTY_MONTHS: '50 months',
};
const retentionLabel = (dr: Ga4PropertySnapshot['dataRetention']): string =>
  dr === null ? 'Not Verified' : RETENTION_LABELS[dr.eventDataRetention] ?? dr.eventDataRetention;
const hasEcommerce = (s: Ga4PropertySnapshot): boolean =>
  (s.keyEvents ?? []).some((k) => /purchase|add_to_cart|begin_checkout|view_item|add_payment_info|add_shipping_info/i.test(k.eventName));
const hasKeyEvent = (s: Ga4PropertySnapshot, re: RegExp): boolean => (s.keyEvents ?? []).some((k) => re.test(k.eventName));
const trendLabel = (b: Ga4Baseline | null): string =>
  b && b.trendPct !== null ? `, ${b.trendPct >= 0 ? '+' : ''}${b.trendPct}% vs prior period` : '';

function shareLabel(pairs: Array<{ name: string; sessions: number }>): string {
  const total = pairs.reduce((acc, p) => acc + p.sessions, 0);
  if (!pairs.length || total === 0) return 'Not Verified';
  return pairs.map((p) => `${p.name || '(not set)'} ${pct(p.sessions, total)}%`).join(', ');
}

function fmtSeconds(s: number): string {
  const sec = Math.max(0, Math.round(s));
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`;
}

// Engagement (attention) one-liner for the baseline block: average engagement time per session (the
// honest attention figure — excludes idle time, unlike session duration), the engaged-session rate, and
// engaged sessions per active user. null when there is no session data to derive it from.
function engagementLabel(baseline: Ga4Baseline): string | null {
  // No sessions, or no engagement signal at all (the engagement query is best-effort and degrades to 0
  // on failure) → omit the line rather than show a misleading "0s · 0.0%".
  if (baseline.sessions <= 0 || (baseline.avgEngagementSec <= 0 && baseline.engagementRate <= 0)) return null;
  const parts = [`${fmtSeconds(baseline.avgEngagementSec)} avg engagement time/session`, `${(baseline.engagementRate * 100).toFixed(1)}% engaged-session rate`];
  if (baseline.engagedSessionsPerUser > 0) parts.push(`${baseline.engagedSessionsPerUser.toFixed(1)} engaged sessions/user`);
  return parts.join(' · ');
}

// Per-channel PERFORMANCE rows (conversion rate + revenue per channel, not just session share) —
// formatted ONCE here so the markdown table and the structured/HTML view read identically. Top 10 by
// sessions; revenue prefixed with the property currency; rates as percentages.
function channelPerfRows(baseline: Ga4Baseline | null, currency: string): Array<{ channel: string; sessions: string; convRate: string; revenue: string; engagement: string }> {
  const cur = currency ? `${currency} ` : '';
  return (baseline?.channelPerformance ?? []).slice(0, 10).map((c) => ({
    channel: c.channel || '(not set)',
    sessions: num(c.sessions),
    convRate: `${(c.convRate * 100).toFixed(1)}%`,
    revenue: c.revenue > 0 ? `${cur}${num(Math.round(c.revenue))}` : '—',
    engagement: `${Math.round(c.engagementRate * 100)}%`,
  }));
}

// Top LANDING-PAGE rows (entry-page conversion rate + revenue) — same shape and formatting as the
// channel table so both surfaces render identically. Top 10 entry pages by sessions; long paths are
// left intact (the markdown cell escapes pipes; the HTML cell scrolls/wraps).
function landingPageRows(baseline: Ga4Baseline | null, currency: string): Array<{ page: string; sessions: string; convRate: string; revenue: string; engagement: string }> {
  const cur = currency ? `${currency} ` : '';
  return (baseline?.landingPages ?? []).slice(0, 10).map((p) => ({
    // The report must never reproduce PII a broken site flow put in a URL - mask it here so EVERY
    // surface (table, PDF, Word) shows the redacted path; the PII finding flags it separately.
    page: maskPii(p.page || '(not set)'),
    sessions: num(p.sessions),
    convRate: `${(p.convRate * 100).toFixed(1)}%`,
    revenue: p.revenue > 0 ? `${cur}${num(Math.round(p.revenue))}` : '—',
    engagement: `${Math.round(p.engagementRate * 100)}%`,
  }));
}

// Per-DEVICE performance rows (how each device type converts and spends) — same shape/formatting as the
// channel + landing tables so all breakdowns render identically.
function devicePerfRows(baseline: Ga4Baseline | null, currency: string): Array<{ device: string; sessions: string; convRate: string; revenue: string; engagement: string }> {
  const cur = currency ? `${currency} ` : '';
  return (baseline?.devicePerformance ?? []).slice(0, 10).map((d) => ({
    device: d.device || '(not set)',
    sessions: num(d.sessions),
    convRate: `${(d.convRate * 100).toFixed(1)}%`,
    revenue: d.revenue > 0 ? `${cur}${num(Math.round(d.revenue))}` : '—',
    engagement: `${Math.round(d.engagementRate * 100)}%`,
  }));
}

// Top-MARKET performance rows (which geographies convert and spend) — same shape/formatting again. Top
// 10 markets by sessions.
function geoPerfRows(baseline: Ga4Baseline | null, currency: string): Array<{ country: string; sessions: string; convRate: string; revenue: string; engagement: string }> {
  const cur = currency ? `${currency} ` : '';
  return (baseline?.geoPerformance ?? []).slice(0, 10).map((g) => ({
    country: g.country || '(not set)',
    sessions: num(g.sessions),
    convRate: `${(g.convRate * 100).toFixed(1)}%`,
    revenue: g.revenue > 0 ? `${cur}${num(Math.round(g.revenue))}` : '—',
    engagement: `${Math.round(g.engagementRate * 100)}%`,
  }));
}

// Per-AI/LLM-source referral rows — which AI assistants send traffic that converts and earns. Same
// shape/formatting as the other breakdown tables (first column is the source host). Shows ALL matched
// sources (the AI-host list is small and the query caps at 20), so the rows always reconcile with the
// aggregate share in the caption — unlike the top-10 tables, this table must be exhaustive.
function llmTrafficRows(baseline: Ga4Baseline | null, currency: string): Array<{ source: string; sessions: string; convRate: string; revenue: string; engagement: string }> {
  const cur = currency ? `${currency} ` : '';
  return (baseline?.llmTraffic ?? []).slice(0, 20).map((c) => ({
    source: c.source || '(not set)',
    sessions: num(c.sessions),
    convRate: `${(c.convRate * 100).toFixed(1)}%`,
    revenue: c.revenue > 0 ? `${cur}${num(Math.round(c.revenue))}` : '—',
    engagement: `${Math.round(c.engagementRate * 100)}%`,
  }));
}

// The LLM-traffic block: rows + an aggregate materiality line (AI sessions and their share of all
// sessions). null when the site has no AI-referral traffic in the window.
function llmTrafficView(baseline: Ga4Baseline | null, currency: string): { rows: ReturnType<typeof llmTrafficRows>; share: string } | null {
  const rows = llmTrafficRows(baseline, currency);
  if (!rows.length) return null;
  // Sum the SAME sources the table shows (slice matches llmTrafficRows), so the share never claims more
  // than the rows account for.
  const raw = (baseline?.llmTraffic ?? []).slice(0, 20);
  const aiSessions = raw.reduce((a, c) => a + c.sessions, 0);
  const total = baseline?.sessions ?? 0;
  const pct = total > 0 ? (aiSessions / total) * 100 : 0;
  const pctText = pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1);
  return { rows, share: `${num(aiSessions)} sessions, ${pctText}% of all` };
}

// Marketing-campaign PERFORMANCE view — the tagged (utm_campaign) campaigns ranked by the campaign engine,
// formatted with the same helpers the other breakdown tables use so all surfaces read identically. Returns
// null when there are no tagged campaigns (the markdown/HTML then print the "no campaign tagging" note),
// so the caller never renders an empty table. Top 10 by the engine's ranking; revenue prefixed with the
// property currency the engine echoed back.
function campaignPerfView(
  campaigns: Ga4CampaignReport | null,
): { rows: Array<{ campaign: string; sessions: string; conversions: string; purchases: string; revenue: string; engagement: string }>; best: string | null; untaggedShare: string; caveat: string } | null {
  if (!campaigns || campaigns.taggedCampaigns.length === 0) return null;
  const cur = campaigns.currencyCode ? `${campaigns.currencyCode} ` : '';
  const rows = campaigns.taggedCampaigns.slice(0, 10).map((c) => ({
    campaign: c.campaign || '(not set)',
    sessions: num(c.sessions),
    conversions: num(c.keyEvents),
    purchases: typeof c.purchases === 'number' ? num(c.purchases) : '—',
    revenue: c.revenue > 0 ? `${cur}${num(Math.round(c.revenue))}` : '—',
    engagement: `${Math.round(c.engagementRate * 100)}%`,
  }));
  const bc = campaigns.bestCampaign;
  const best = bc ? `${bc.campaign} (${num(bc.keyEvents)} key events${typeof bc.purchases === 'number' ? `, ${num(bc.purchases)} purchases` : ''}${bc.revenue > 0 ? `, ${cur}${num(Math.round(bc.revenue))}` : ''})` : null;
  // The guardrail the other tables already carry, worded for THIS table's two traps: key-event counts
  // read as sales, and campaign-attributed revenue read as reconcilable with the channel table.
  const caveat =
    '"Key events" counts every configured key event (product views, add-to-carts, sign-ups, ...), NOT sales - Purchases is the real transaction count. Revenue here is campaign-attributed and will not match the channel table 1:1.';
  return { rows, best, untaggedShare: `${campaigns.untaggedSharePct.toFixed(1)}%`, caveat };
}

const FUNNEL_LABELS: Record<string, string> = { view_item: 'View item', add_to_cart: 'Add to cart', begin_checkout: 'Begin checkout', purchase: 'Purchase' };

// Ecommerce funnel view — distinct users reaching each step, with step-to-step conversion and depth vs
// the entry step. IMPORTANT: this is an event-COVERAGE approximation (GA4's true sequential funnel is
// UI/v1alpha-only), so a later step can legitimately exceed an earlier one; we render the real ratio
// (never clamp — a >100% step is itself a tracking-gap signal) and guard divide-by-zero. Returns null
// (table omitted) when there is no view_item reach to anchor the funnel.
function funnelView(baseline: Ga4Baseline | null): { steps: Array<{ label: string; users: string; pctEntry: string; stepConv: string }>; overall: string } | null {
  const raw = baseline?.funnelSteps ?? [];
  const entry = raw[0]?.users ?? 0;
  if (raw.length < 2 || entry <= 0) return null;
  const steps = raw.map((s, i) => {
    const prev = i > 0 ? raw[i - 1].users : 0;
    return {
      label: FUNNEL_LABELS[s.event] ?? s.event,
      users: num(s.users),
      pctEntry: `${Math.round((s.users / entry) * 100)}%`,
      stepConv: i === 0 ? '—' : prev > 0 ? `${Math.round((s.users / prev) * 100)}%` : '—',
    };
  });
  const last = raw[raw.length - 1]?.users ?? 0;
  return { steps, overall: `${((last / entry) * 100).toFixed(1)}%` };
}

function areaEvidence(area: string, s: Ga4PropertySnapshot, config: Ga4AuditReport): string {
  switch (area) {
    case 'Data collection':
      return `${s.dataStreams.length} data stream(s)`;
    case 'Data retention':
      return retentionLabel(s.dataRetention);
    case 'Key events':
      return s.keyEvents === null ? 'could not read' : `${s.keyEvents.length} key event(s)`;
    case 'Enhanced measurement': {
      const web = s.dataStreams.filter((d) => d.type === 'WEB_DATA_STREAM');
      if (web.length === 0) return 'no web stream';
      if (web.some((d) => d.enhancedMeasurementEnabled === false)) return 'off on a web stream';
      const em = web.find((d) => d.enhancedMeasurement)?.enhancedMeasurement;
      const off = em ? [em.siteSearchEnabled ? '' : 'site search', em.pageChangesEnabled ? '' : 'SPA page changes', em.formInteractionsEnabled ? '' : 'form interactions'].filter(Boolean) : [];
      return off.length ? `on; off: ${off.join(', ')}` : 'on';
    }
    case 'Custom definitions':
      return `${config.counts.customDimensions} dimension(s), ${config.counts.customMetrics} metric(s)`;
    case 'Attribution':
      return s.attribution
        ? `${s.attribution.reportingAttributionModel}; lookback ${s.attribution.acquisitionLookback || '—'}/${s.attribution.otherLookback || '—'}`
        : 'attribution settings unread';
    case 'Privacy (PII)':
      return s.customDimensions === null ? 'dimensions unread' : 'no PII patterns in dimension names';
    case 'Integrations':
      return `${s.googleAdsLinks ?? '—'} Google Ads link(s); Signals ${s.googleSignals === 'GOOGLE_SIGNALS_ENABLED' ? 'on' : s.googleSignals === 'GOOGLE_SIGNALS_DISABLED' ? 'off' : '—'}; BigQuery ${Array.isArray(s.bigQueryLinks) ? (s.bigQueryLinks.length ? 'linked' : 'none') : '—'}; ${typeof s.audiences === 'number' ? `${s.audiences} audience(s)` : '— audiences'}`;
    case 'Benchmarking':
      return s.industryCategory && s.industryCategory !== 'INDUSTRY_CATEGORY_UNSPECIFIED' ? s.industryCategory : 'industry not set';
    default:
      return '';
  }
}

/** A decision can only be "Answerable" when the wiring exists AND the figures it leans on are safe
 *  to quote. `trust` carries the Data Trust Matrix verdicts for conversion counts and revenue; when a
 *  decision depends on an unverified/do-not-quote metric it is capped at "Partial" (feature present,
 *  but blocked by a trust gate) rather than claimed as answerable. Omitting `trust` treats both as
 *  safe, so callers that don't compute the matrix are unchanged. */
function decisionReadiness(
  s: Ga4PropertySnapshot,
  trust?: { convSafe: boolean; revSafe: boolean },
): Array<{ q: string; status: string; note: string }> {
  const ads = (s.googleAdsLinks ?? 0) > 0;
  const signals = s.googleSignals === 'GOOGLE_SIGNALS_ENABLED';
  const ecom = hasEcommerce(s);
  const lead = hasKeyEvent(s, /lead|sign_up|contact|submit/i);
  const refund = hasKeyEvent(s, /refund|return/i);
  const convSafe = trust?.convSafe ?? true;
  const revSafe = trust?.revSafe ?? true;
  // Event-level export (BigQuery) is what makes a true LTV computable; Google Signals gives a
  // cross-device approximation. Mirror the conditional grading of the other rows instead of a
  // hardcoded "Not answerable" (which stayed red even when BigQuery export was on).
  const bq = (s.bigQueryLinks ?? []).some((l) => l.dailyExportEnabled || l.streamingExportEnabled);
  const clvStatus = bq ? 'Answerable' : signals ? 'Partial' : 'Not answerable';
  const clvNote = bq
    ? 'BigQuery export enabled - compute true LTV from event-level data'
    : signals
      ? 'Google Signals on for cross-device stitching; enable BigQuery export or User-ID for true LTV'
      : 'needs User-ID and/or server-side/BigQuery data';
  return [
    {
      q: 'Which campaigns generate revenue?',
      status: ads ? (revSafe ? 'Answerable' : 'Partial') : 'Partial',
      note: !ads
        ? 'link Google Ads to attribute revenue to campaigns'
        : revSafe
          ? 'Google Ads linked + conversions'
          : 'Google Ads linked, but revenue is unverified - confirm conversion/revenue tracking before quoting',
    },
    {
      q: 'Abandonment by product/page?',
      status: ecom ? (convSafe ? 'Answerable' : 'Partial') : 'Not answerable',
      note: !ecom
        ? 'no ecommerce/funnel events'
        : convSafe
          ? 'ecommerce events present'
          : 'ecommerce events present, but item-parameter coverage and funnel integrity are unverified',
    },
    {
      q: 'CAC by channel',
      status: ads ? (convSafe ? 'Answerable' : 'Partial') : 'Partial',
      note: !ads
        ? 'needs ad cost (Google Ads link)'
        : convSafe
          ? 'sessions + cost via Google Ads link'
          : 'Ads cost available, but CAC depends on trustworthy conversions - conversion tracking is unverified',
    },
    { q: 'Lead quality', status: lead ? 'Partial' : 'Not answerable', note: lead ? 'lead events exist; CRM import needed for true quality' : 'no lead/sign-up key events; no CRM import' },
    { q: 'Customer lifetime value', status: clvStatus, note: clvNote },
    {
      q: 'Refund/return rate',
      status: refund ? (convSafe ? 'Answerable' : 'Partial') : 'Not answerable',
      note: !refund
        ? 'no refund/return events'
        : convSafe
          ? 'refund events present'
          : 'refund events present, but conversion tracking is unverified',
    },
    {
      q: 'Repeat/churn within 90 days',
      status: signals ? 'Partial' : 'Not answerable',
      note: signals
        ? 'Google Signals gives cross-device repeat rate; User-ID or BigQuery needed for robust retention/identity'
        : 'enable Google Signals or User-ID for reliable repeat rate',
    },
  ];
}

const confidenceFor = (k: AreaRow['statusKey']): string =>
  k === 'not_verified' ? 'Guessing' : k === 'partial' ? 'Likely' : 'Certain';
/** Short label for a finding's verification state (Section-4 "State" column). */
const stateLabel = (st: FindingState | undefined): string =>
  st === 'unconfirmed' ? 'Observed' : st === 'blocked' ? 'Blocked' : 'Confirmed';
const trendPctText = (p: number | null): string => (p === null ? 'n/a' : `${p >= 0 ? '+' : ''}${p}%`);
const firstSentence = (t: string): string => {
  const m = /^(.*?[.!?])(\s|$)/.exec(t.trim());
  return (m ? m[1] : t).trim();
};
// Info findings are advisories/all-clears, not problems — never attach a business risk to them.
const riskFor = (f: FindingRow): string => (f.severity === 'info' ? '—' : f.businessRisk ?? RISK_BY_CATEGORY[f.category] ?? '—');

// One-line overall verdict for the Executive Summary, by rule from the worst finding and the data
// trust. We only call the data "safe to quote" when it was actually verified — i.e. the growth/anomaly
// comparison ran (growthAssessed) AND trust is high. On a thin/new property where the comparison did
// not run, the Data Trust Matrix itself says "quote with caution", so we stay conservative here too.
function overallVerdict(allFindings: FindingRow[], nNotVerified: number, reliabilityPct: number, growthAssessed: boolean): string {
  const has = (s: string): boolean => allFindings.some((f) => f.severity === s);
  if (has('critical') || has('high')) return 'Action required — one or more foundational checks need remediation before the data can be fully trusted.';
  if (has('medium')) return 'Some gaps to address before the data is fully trustworthy.';
  if (has('low')) return `Largely sound; minor gaps remain and ${nNotVerified} area(s) are unverified.`;
  // Threshold calibrated to the pass-gated scale's reachable range (the Admin API caps Data
  // collection at Partial and cannot read consent mode, so a clean property tops out near ~45).
  // The wording never claims blanket "safe to quote" — quotability is per-metric in the trust matrix.
  if (growthAssessed && reliabilityPct >= 45) return `Trustworthy within the verified scope — the figures the data trust matrix marks safe or caution are quotable (${reliabilityPct}% reporting reliability)${nNotVerified > 0 ? `; ${nNotVerified} area(s) remain unverified — confirm those before quoting them` : ''}.`;
  return `No blocking issues found; the data is broadly usable, but ${nNotVerified} area(s) are unverified — confirm before full sign-off.`;
}

// The selected audit window for the Executive Summary: the human date range plus the day count when
// both are known (e.g. "Apr 1 – Jun 29, 2026 (90 days)"). Uses the same dq fields shown in section 9.
function auditWindowLabel(dq: Ga4DataQualityResult): string {
  const range = dq.dateRange;
  const days = dq.windowDays;
  if (range && days > 0) return `${range} (${days} days)`;
  if (range) return range;
  if (days > 0) return `last ${days} days`;
  return 'window not specified';
}

// The section-3 "Read" line for a growth finding, shared by the markdown report and the structured
// sections view so the two surfaces never word it differently. LOW findings carry TWO different
// stories (spike dilution vs drop-with-revenue-held), so the read is picked by the SESSION DIRECTION
// too — a -45% window must never be described as "conversions grew with the traffic".
const growthReadLine = (gf: { category: string; severity: string } | undefined, sessionsPct: number | null): string =>
  !gf || gf.category !== 'growth'
    ? 'Sessions are within normal variation vs the prior period.'
    : gf.severity === 'info'
      ? 'Outcomes tracked the traffic — consistent with real growth.'
      : gf.severity === 'medium'
        ? "Sessions moved sharply, but there isn't enough conversion signal to confirm what's behind it."
        : gf.severity === 'low'
          ? (sessionsPct !== null && sessionsPct < 0
              ? 'Revenue held while sessions fell — the lost sessions were low-value traffic washing out of the window (often an earlier one-off spike leaving the comparison), not a tracking break or a business decline.'
              : 'Conversions grew with the traffic but slower than sessions — the conversion rate diluted (typical of a lower-converting channel mix), not a tracking break.')
          : 'Outcomes did NOT keep pace with traffic — the spike is unconfirmed and revenue/ROAS may be wrong right now.';

// Combined findings (config + data quality + growth + campaigns) — the single source of truth for the
// report. Campaign findings ("no campaigns tagged" / high-untagged-share advisories, plus the top-campaign
// info line) are deterministically measured this run, so they carry the Confirmed state.
// The deterministic anti-lie detectors (concentration, revenue reconciliation, self-referrals,
// invalid traffic, PII, gateway leakage, thresholding) live in ga4-anti-lie.ts so the MONITOR runs
// the exact same code on a schedule - the two surfaces can never disagree about the same property.

function buildAllFindings(config: Ga4AuditReport, dq: Ga4DataQualityResult, growth: Ga4GrowthResult | null, campaigns: Ga4CampaignReport | null, baseline?: Ga4Baseline | null, dqCounts?: DataQualityCounts | null, snapshot?: Ga4PropertySnapshot | null): FindingRow[] {
  return [
    ...config.findings.map((f): FindingRow => ({ severity: f.severity, category: f.category, area: 'Config', message: f.message, recommendation: f.recommendation, state: 'confirmed' })),
    ...dq.findings.map((f): FindingRow => ({ severity: f.severity, category: f.category, area: 'Data quality', message: f.message, recommendation: f.recommendation, state: 'confirmed' })),
    ...(campaigns?.findings ?? []).map((f): FindingRow => ({ severity: f.severity, category: f.category, area: 'Campaigns', message: f.message, recommendation: f.recommendation, state: 'confirmed' })),
    ...antiLieFindings(baseline ?? null, dqCounts ?? null, campaigns, snapshot),
    ...(growth?.findings ?? []).map((f: Ga4GrowthFinding): FindingRow => ({
      severity: f.severity,
      category: f.category,
      area: 'Growth',
      message: f.message,
      recommendation: f.recommendation,
      // Growth reads are graded to their worst branch pending DebugView, so they are OBSERVED but not
      // yet confirmed; a finding that carries an "if unconfirmed" branch is inherently unconfirmed.
      state: f.ifUnconfirmed ? 'unconfirmed' : 'confirmed',
      evidence: f.evidence,
      whyItMatters: f.whyItMatters,
      ifUnconfirmed: f.ifUnconfirmed,
      businessRisk: f.businessRisk,
    })),
  ].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
}

/** First-class "Blocked by verification" items for Section 4 — checks the audit could not run this
 *  window, so any related conclusion is unmeasured (not a clean pass). Kept SEPARATE from
 *  buildAllFindings so they never perturb the severity counts or the rule-based scorecard; they are
 *  the actionable half of the Section-8 honesty layer, surfaced up where a reader will see them. */
function verificationBlocks(config: Ga4AuditReport, ecom: boolean, ecomVerified: boolean): Array<{ area: string; message: string; recommendation: string }> {
  const out = [
    { area: 'Measurement', message: 'Per-event parameter coverage was not computed, so it is unknown whether events carry the parameters reports and funnels rely on.', recommendation: 'Run a per-event Data API pass (or DebugView) to confirm parameter coverage.' },
    { area: 'Consent', message: 'Consent Mode v2 signals were not assessed, so consent-gated loss inflating "(not set)"/Unassigned cannot be ruled out.', recommendation: 'Verify Consent Mode in GA4 DebugView / tag setup.' },
  ];
  if (ecom && !ecomVerified) out.push({ area: 'Ecommerce', message: 'Ecommerce item parameters and duplicate transactions were not verified, so revenue and abandonment figures cannot be confirmed.', recommendation: 'Audit item-scoped parameters and check for duplicate transaction_ids.' });
  for (const a of config.areas.filter((x) => x.status === 'not_verified')) out.push({ area: a.area, message: `${a.area} config sub-resource could not be read, so the ${a.area} checks did not run.`, recommendation: `Re-run with access to the ${a.area} configuration.` });
  return out;
}

/** Data-collection CONTINUITY: verified when sessions arrived on EVERY day of the audit window
 *  (GA4 omits zero days from dailySessions, so full coverage == full continuity). This is the
 *  Data-API verification the Admin API cannot provide - it upgrades the Data collection area from
 *  its Admin-only Partial ceiling to a real Pass. A single gap day (or a thin/new property) fails
 *  the bar: an unproven stream must not read as verified. Windows longer than the daily series can
 *  ever cover (custom ranges > ~366 days) are never claimed. */
function collectionContinuity(baseline: Ga4Baseline | null, windowDays: number): { days: number } | null {
  if (!baseline || windowDays <= 0 || windowDays > 366) return null;
  const nonZeroDays = new Set(baseline.dailySessions.filter((d) => d.sessions > 0).map((d) => d.date));
  return nonZeroDays.size >= windowDays ? { days: windowDays } : null;
}

// Area-coverage rows = config areas + the report-level Attribution/Audiences/Ecommerce/Consent.
// The Ecommerce row is GRADED when the transaction-integrity pass ran: clean (no duplicate ids,
// <5% missing ids) earns a real Pass — which is what upgrades the Revenue trust gate and lifts the
// reliability cap; duplicates are a Fail (revenue is double-counted, do not quote); a high missing-id
// share stays Partial. An unrun pass stays Partial with the old wording — verification, not vibes.
function buildAreaRows(
  s: Ga4PropertySnapshot,
  config: Ga4AuditReport,
  audienceCount: number | null,
  ecom: boolean,
  ecomV?: EcomVerification | null,
  continuity?: { days: number } | null,
): AreaRow[] {
  // Attribution is now a GRADED config area (auditGa4) with its own evidence, so it is not re-added
  // here as a passive "pass" row.
  const rows: AreaRow[] = config.areas.map((a) => {
    // Continuity verification upgrades the Admin-only Partial to a real Pass (never a Fail - a
    // failing config grade stays failing regardless of traffic).
    if (a.area === 'Data collection' && a.status === 'partial' && continuity) {
      return { area: a.area, statusKey: 'pass' as const, evidence: `verified: sessions arrived on every day of the ${continuity.days}-day window (${areaEvidence(a.area, s, config)})` };
    }
    return { area: a.area, statusKey: a.status, evidence: areaEvidence(a.area, s, config) };
  });
  if (audienceCount !== null) {
    rows.push({ area: 'Audiences', statusKey: audienceCount > 0 ? 'pass' : 'partial', evidence: `${audienceCount} audience(s)` });
  }
  if (ecom && ecomV) {
    const pct = ecomV.notSetSharePct.toFixed(1);
    rows.push(
      ecomV.duplicateIds > 0
        ? { area: 'Ecommerce', statusKey: 'fail', evidence: `verified: ${ecomV.duplicateIds} duplicate transaction_id(s) among ${ecomV.transactionsChecked} checked - revenue is double-counted` }
        : ecomV.notSetSharePct >= 5
          ? { area: 'Ecommerce', statusKey: 'partial', evidence: `verified: no duplicate transaction_ids (${ecomV.transactionsChecked} checked), but ${pct}% of purchases have no id - those cannot be deduplicated` }
          : { area: 'Ecommerce', statusKey: 'pass', evidence: `verified: ${ecomV.transactionsChecked} transaction_id(s) checked - no duplicates, ${pct}% missing ids` },
    );
  } else {
    rows.push({
      area: 'Ecommerce',
      statusKey: ecom ? 'partial' : 'not_verified',
      evidence: ecom ? 'purchase/item key events present; item params & duplicate transactions not verified' : 'no purchase/item key events found',
    });
  }
  rows.push({ area: 'Consent', statusKey: 'not_verified', evidence: 'consent mode not retrievable via the Admin API' });
  return rows;
}

/** Structured Executive Summary (section 1) — drives the markdown report, the on-screen card panel
 *  and the styled PDF/Word export from one rule-based computation. */
export function buildGa4ExecSummary(input: Ga4ReportInput): Ga4ExecSummaryView {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount, campaigns } = input;
  const pid = input.property.replace('properties/', '');
  const ecom = hasEcommerce(s);
  const allFindings = buildAllFindings(config, dq, growth, campaigns, baseline, dqCounts, s);
  const top = allFindings.filter((f) => f.severity !== 'info')[0];
  const areaRows = buildAreaRows(s, config, audienceCount, ecom, input.ecomVerification, collectionContinuity(baseline, dqCounts.windowDays));
  const nPartial = areaRows.filter((a) => a.statusKey === 'partial').length;
  const nNotVerified = areaRows.filter((a) => a.statusKey === 'not_verified').length;
  const scoreModel = buildGa4Scorecard({
    areas: areaRows.map((a) => ({ area: a.area, statusKey: a.statusKey })),
    findings: allFindings.map((f) => ({ severity: f.severity, category: f.category })),
    growthAssessed: Boolean(growth?.assessed),
  });
  return {
    propertyName: input.displayName,
    propertyId: pid,
    auditId: `GA4-${pid}-${(dq.endDate ?? '').replace(/-/g, '') || 'na'}`,
    dateRange: auditWindowLabel(dq),
    composite: scoreModel.composite,
    grade: scoreModel.grade,
    reliabilityPct: scoreModel.reliabilityPct,
    reliabilityConfidence: scoreModel.reliabilityConfidence,
    reliabilityCappedBy: scoreModel.reliabilityCappedBy,
    reliabilityWhy: scoreModel.reliabilityWhy,
    verdict: overallVerdict(allFindings, nNotVerified, scoreModel.reliabilityPct, Boolean(growth?.assessed)),
    biggestRisk: top ? firstSentence(top.whyItMatters ?? top.message) : 'No high-severity risk; the ceiling on trust is coverage.',
    highestImpactFix: top ? firstSentence(top.recommendation ?? 'Confirm the unverified areas.') : 'Confirm the unverified areas (consent, ecommerce parameters) before sign-off.',
    coverage: { checked: areaRows.length, partial: nPartial, notVerified: nNotVerified },
    categories: scoreModel.categories.map((c) => ({ name: c.name, subscore: c.subscore, weight: c.weight, effectiveWeight: c.effectiveWeight, contribution: c.contribution, status: c.status })),
    trust: scoreModel.trust.map((t) => ({ metric: t.metric, verdict: t.verdict, safe: t.safe, reason: t.reason })),
  };
}

/** Structured visualisations payload (daily trend line + colour-coded device/channel bars) for the
 *  panel + PDF charts. */
export function buildGa4Visuals(input: Ga4ReportInput): Ga4VisualsView {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount, campaigns } = input;
  const daily = baseline?.dailySessions ?? [];
  const trend = analyzeGa4Trend({ dailySessions: daily, peakDayChannels: baseline?.peakDayChannels ?? null, windowChannels: dqCounts.channelGroups, todayYmd: dqCounts.todayYmd });
  // Channel-attribution trust comes from the same Data Trust Matrix the Executive Summary uses.
  const allFindings = buildAllFindings(config, dq, growth, campaigns, baseline, dqCounts, s);
  const areaRows = buildAreaRows(s, config, audienceCount, hasEcommerce(s), input.ecomVerification, collectionContinuity(baseline, dqCounts.windowDays));
  const score = buildGa4Scorecard({
    areas: areaRows.map((a) => ({ area: a.area, statusKey: a.statusKey })),
    findings: allFindings.map((f) => ({ severity: f.severity, category: f.category })),
    growthAssessed: Boolean(growth?.assessed),
  });
  return {
    daily,
    peakIndex: trend.peakIndex,
    trendLabel: trend.patternLabel,
    trendSummary: trend.summary,
    channelDaily: baseline?.channelDaily ?? [],
    devices: baseline?.devices ?? [],
    channels: [...dqCounts.channelGroups].sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    drivingChannel: trend.drivingChannel,
    ...(() => {
      const v = score.trust.find((t) => t.metric === 'Channel attribution')?.verdict ?? 'safe';
      // A FAILED gate asserts measured source-data loss; an UNVERIFIED one must NOT — the split is
      // simply unverified (e.g. attribution settings unreadable), and the wording says exactly that.
      const channelCaveat =
        v === 'do_not_quote'
          ? 'A material share of sessions lack source data, so the channel split is not safe to quote (see the Data Trust Matrix).'
          : v === 'unverified'
            ? 'Channel attribution could not be verified this run, so the channel split is unverified — confirm before quoting (see the Data Trust Matrix).'
            : null;
      return { channelTrusted: v === 'safe' || v === 'caution', channelCaveat };
    })(),
  };
}

/** Structured body sections (2-4) for the designed card panel + styled export. Computed from the same
 *  pure builders the markdown report uses, so the two surfaces can't drift. */
export function buildGa4Sections(input: Ga4ReportInput): Ga4SectionsView {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount, campaigns } = input;
  const ecom = hasEcommerce(s);
  const allFindings = buildAllFindings(config, dq, growth, campaigns, baseline, dqCounts, s);
  const actionable = allFindings.filter((f) => f.severity !== 'info');
  const top = actionable[0];
  const dqAttrib = allFindings.find((f) => f.category === 'data_quality' && f.severity !== 'info' && /source data|Unassigned|\(not set\)/.test(f.message));
  const areaRows = buildAreaRows(s, config, audienceCount, ecom, input.ecomVerification, collectionContinuity(baseline, dqCounts.windowDays));
  const nNotVerified = areaRows.filter((a) => a.statusKey === 'not_verified').length;
  const score = buildGa4Scorecard({
    areas: areaRows.map((a) => ({ area: a.area, statusKey: a.statusKey })),
    findings: allFindings.map((f) => ({ severity: f.severity, category: f.category })),
    growthAssessed: Boolean(growth?.assessed),
  });
  const verdictOfM = (metric: string): 'safe' | 'caution' | 'unverified' | 'do_not_quote' =>
    score.trust.find((t) => t.metric === metric)?.verdict ?? 'safe';
  const keV = verdictOfM('Conversion counts');
  const revV = verdictOfM('Revenue / AOV / ROAS');
  const keSafe = keV === 'safe' || keV === 'caution';
  const revSafe = revV === 'safe' || revV === 'caution';
  const sesSafe = verdictOfM('Sessions, users, engagement rate') !== 'do_not_quote' && verdictOfM('Sessions, users, engagement rate') !== 'unverified';
  // Verdict-aware caveat: a FAILED gate reads "not safe to quote"; an UNVERIFIED one must say
  // "confirm before quoting" instead of asserting untrustworthiness (matches the trust matrix).
  const quoteNote =
    keV === 'do_not_quote' || revV === 'do_not_quote'
      ? `* Directional only — the key-event/revenue movement is not safe to quote to stakeholders until conversion tracking is confirmed${sesSafe ? '; sessions are safe to quote' : ''}.`
      : keV === 'unverified' || revV === 'unverified'
        ? '* Directional only — key events/revenue could not be fully verified; confirm before quoting to stakeholders (see the data trust matrix).'
        : null;

  const topFinding = top
    ? {
        severity: top.severity,
        area: top.area,
        message: firstSentence(top.message),
        evidence: top.evidence ?? top.message,
        whyItMatters: top.whyItMatters,
        ifUnconfirmed: top.ifUnconfirmed ?? 'Graded at face value — no worse unverified branch.',
        recommendation: top.recommendation ?? '—', // always show a Fix row, matching the markdown's "Fix: —"
        related: dqAttrib && top.category === 'growth' ? `${dqAttrib.message} (likely the same sessions behind the spike)` : undefined,
      }
    : null;
  const noIssueNote = top ? null : `No high-severity issue. The ceiling on trust is coverage — ${nNotVerified} area(s) are unverified; see Not verified.`;

  let trendPattern: string | null = null;
  if (baseline && baseline.dailySessions.length >= 5) {
    const trend = analyzeGa4Trend({ dailySessions: baseline.dailySessions, peakDayChannels: baseline.peakDayChannels, windowChannels: dqCounts.channelGroups, todayYmd: dqCounts.todayYmd });
    trendPattern = `${trend.patternLabel}. ${trend.summary}`;
  }
  const oCur = s.currencyCode ? `${s.currencyCode} ` : '';
  const oMoney = (x: number): string => `${oCur}${num(Math.round(x))}`;
  const outcomes =
    growth && growth.assessed && baseline
      ? {
          assessed: true, sessionsPct: growth.sessionsTrendPct, keyEventsPct: growth.keyEventsTrendPct, revenuePct: growth.revenueTrendPct,
          sessionsFrom: num(baseline.priorSessions), sessionsTo: num(baseline.sessions),
          keyEventsFrom: num(baseline.priorKeyEvents), keyEventsTo: num(baseline.keyEvents),
          revenueFrom: oMoney(baseline.priorRevenue), revenueTo: oMoney(baseline.revenue),
          keSafe, revSafe, sesSafe, quoteNote, read: growthReadLine(growth.findings[0], growth.sessionsTrendPct), trendPattern,
        }
      : {
          assessed: false, sessionsPct: null, keyEventsPct: null, revenuePct: null,
          sessionsFrom: null, sessionsTo: null, keyEventsFrom: null, keyEventsTo: null, revenueFrom: null, revenueTo: null,
          keSafe, revSafe, sesSafe, quoteNote, read: 'Not enough prior traffic to assess growth for this window.', trendPattern,
        };

  const findings = allFindings.map((f) => ({ severity: f.severity, area: f.area, message: f.message, businessRisk: riskFor(f), recommendation: f.recommendation ?? '—', state: f.state ?? 'confirmed' }));
  const blocked = verificationBlocks(config, ecom, Boolean(input.ecomVerification));

  // ── Section 5 · Area status ──
  const areas = areaRows.map((a) => ({ area: a.area, statusKey: a.statusKey, confidence: confidenceFor(a.statusKey), evidence: a.evidence }));

  // ── Section 6 · Property baseline ──
  const baselineView = baseline
    ? {
        sessions: num(baseline.sessions),
        priorSessions: num(baseline.priorSessions),
        trend: trendLabel(baseline),
        growth: growth && growth.assessed ? { sessionsPct: growth.sessionsTrendPct, keyEventsPct: growth.keyEventsTrendPct, revenuePct: growth.revenueTrendPct, keSafe, revSafe } : null,
        peakDay: baseline.peakDay ? `${fmtDay(baseline.peakDay.date)} — ${num(baseline.peakDay.sessions)} sessions` : null,
        newVsReturning: shareLabel(baseline.newVsReturning),
        topMarkets: baseline.topCountries.length ? baseline.topCountries.map((c) => `${c.name || '(not set)'} ${pct(c.sessions, baseline.sessions)}%`).join(', ') : null,
        engagement: engagementLabel(baseline),
        retention: input.retentionSummary ?? null,
      }
    : null;

  // ── Section 7 · Decision readiness ──
  const decisions = decisionReadiness(s, { convSafe: keSafe, revSafe });

  // ── Section 8 · Not verified ──
  const nv: Array<{ item: string; blocks: string }> = [
    { item: 'Per-event parameter coverage', blocks: 'whether events carry the parameters reports & funnels rely on' },
    { item: 'Consent Mode v2 signals', blocks: 'whether consent-gated loss is inflating "(not set)"/Unassigned' },
  ];
  if (ecom && !input.ecomVerification) nv.push({ item: 'Ecommerce item parameters & duplicate transactions', blocks: 'whether revenue and abandonment figures are accurate' });
  else if (!ecom) nv.push({ item: 'Ecommerce funnel (no purchase/add_to_cart key events)', blocks: 'product/checkout funnel analysis' });
  for (const a of config.areas.filter((x) => x.status === 'not_verified')) nv.push({ item: `${a.area} (config sub-resource unreadable)`, blocks: `the ${a.area} checks` });
  const gate =
    top && (top.severity === 'critical' || top.severity === 'high') && top.category === 'growth'
      ? 'whether conversion tracking actually fires for the new traffic — needs GA4 DebugView + a per-event Data API pass'
      : nv[0].blocks;

  // ── Section 9 · Scope & metadata ──
  const pid = input.property.replace('properties/', '');
  const auditId = `GA4-${pid}-${(dq.endDate ?? '').replace(/-/g, '') || 'na'}`;
  const cmp = baseline ? ` vs prior ${baseline.priorStartDate} – ${baseline.priorEndDate}` : '';
  const limits = ['per-event parameter coverage not computed', 'Consent Mode not assessed (needs DebugView)'];
  if (!ecom) limits.push('no ecommerce events detected');
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of allFindings) counts[f.severity as keyof typeof counts] = (counts[f.severity as keyof typeof counts] ?? 0) + 1;
  const scope = {
    auditId,
    composite: score.composite,
    grade: score.grade,
    reliabilityPct: score.reliabilityPct,
    window: `${auditWindowLabel(dq)}${cmp}`,
    retention: retentionLabel(s.dataRetention),
    timezone: s.timeZone || '—',
    currency: s.currencyCode || '—',
    generated: input.generatedAt,
    property: `${input.displayName} (${pid})`,
    limitations: `${limits.join('; ')}.`,
    findings: counts,
    footer: 'Read-only — GA4 has no auto-fixes; apply each change in the GA4 Admin UI.',
  };

  return { topFinding, noIssueNote, outcomes, findings, blocked, actionableCount: actionable.length, areas, baseline: baselineView, channelPerformance: channelPerfRows(baseline, s.currencyCode), landingPages: landingPageRows(baseline, s.currencyCode), devicePerformance: devicePerfRows(baseline, s.currencyCode), geoPerformance: geoPerfRows(baseline, s.currencyCode), campaignPerformance: campaignPerfView(campaigns), llmTraffic: llmTrafficView(baseline, s.currencyCode), funnel: funnelView(baseline), insights: deriveGa4Insights(baseline, s.currencyCode, { convSafe: keSafe, revSafe }), perfProvisional: !keSafe || !revSafe, decisions, notVerified: { gate, items: nv }, scope };
}

export function buildGa4AuditReport(input: Ga4ReportInput): string {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount, campaigns } = input;
  const pid = input.property.replace('properties/', '');
  const ecom = hasEcommerce(s);
  const L: string[] = [];

  // ── Single source of truth: combined findings (config + data quality + growth/anomaly + campaigns)
  // and the area-coverage rows. The verdict, All-findings table and counts all derive from these. ──
  const allFindings = buildAllFindings(config, dq, growth, campaigns, baseline, dqCounts, s);
  // The "top finding" that drives the Verdict + "What is wrong" is the worst ACTIONABLE one. An
  // info-only result (e.g. the data-quality "no major issues" advisory on a clean property) has no
  // top finding, so those sections take their clean-property fallbacks instead of mislabelling an
  // all-clear as a problem.
  const actionable = allFindings.filter((f) => f.severity !== 'info');
  const top = actionable[0];
  const areaRows = buildAreaRows(s, config, audienceCount, ecom, input.ecomVerification, collectionContinuity(baseline, dqCounts.windowDays));
  const campaignPerf = campaignPerfView(campaigns);

  const windowLabel = auditWindowLabel(dq); // same label as section 1 + the styled section 9 card
  const cmp = baseline ? ` vs prior ${baseline.priorStartDate} – ${baseline.priorEndDate}` : '';
  const nPartial = areaRows.filter((a) => a.statusKey === 'partial').length;
  const nNotVerified = areaRows.filter((a) => a.statusKey === 'not_verified').length;
  const dqAttrib = allFindings.find((f) => f.category === 'data_quality' && f.severity !== 'info' && /source data|Unassigned|\(not set\)/.test(f.message));

  // Rule-based scoring brain: weighted composite + grade and the data-trust reliability %.
  const score = buildGa4Scorecard({
    areas: areaRows.map((a) => ({ area: a.area, statusKey: a.statusKey })),
    findings: allFindings.map((f) => ({ severity: f.severity, category: f.category })),
    growthAssessed: Boolean(growth?.assessed),
  });
  const auditId = `GA4-${pid}-${(dq.endDate ?? '').replace(/-/g, '') || 'na'}`;
  // Foreground only trusted figures: tag the outcome metrics whose PASS-GATED verdict is
  // do-not-quote or unverified (the numbers stay, but are clearly tagged so they aren't read as
  // fact). A caution verdict keeps the figure untagged here — the trust matrix carries the caveat.
  const safeOf = (metric: string): boolean => {
    const v = score.trust.find((t) => t.metric === metric)?.verdict ?? 'safe';
    return v === 'safe' || v === 'caution';
  };
  const verdictOf = (metric: string): 'safe' | 'caution' | 'unverified' | 'do_not_quote' =>
    score.trust.find((t) => t.metric === metric)?.verdict ?? 'safe';
  const keV = verdictOf('Conversion counts');
  const revV = verdictOf('Revenue / AOV / ROAS');
  const sesSafe = safeOf('Sessions, users, engagement rate');
  // Verdict-aware figure tag: a failed gate reads "not safe to quote"; an unverified gate is tagged
  // as unverified (never silently treated as fine); caution figures stay untagged here — the trust
  // matrix carries the caveat.
  const quoteTag = (v: 'safe' | 'caution' | 'unverified' | 'do_not_quote'): string =>
    v === 'do_not_quote' ? ' (not safe to quote)' : v === 'unverified' ? ' (unverified — confirm before quoting)' : '';

  // ── 1 · Executive summary (read-first) ──
  L.push(`# GA4 Property Audit — ${input.displayName} (${pid})`);
  L.push('');
  L.push('## 1 · Executive summary');
  L.push('');
  L.push('A consolidated read of the property’s measurement posture across configuration, event tracking, conversions, data quality, attribution and consent.');
  L.push('');
  L.push(`**Audit window:** ${auditWindowLabel(dq)}  `);
  L.push(`**Setup completeness:** ${score.composite ?? '—'}/100 (Grade ${score.grade})  `);
  L.push(`**Reporting reliability:** ${score.reliabilityPct}% — ${score.reliabilityConfidence} (how much of this property’s data is safe to quote downstream today)${score.reliabilityCappedBy.length ? ` - capped by ${score.reliabilityCappedBy.join(', ')}` : ''}  `);
  // The receipt: attribute every missing point to a NAMED gate + its fix, so the number is never
  // read as the audit's opinion — it is the property's verification state, line by line.
  if (score.reliabilityWhy.length) {
    L.push('');
    L.push(`**Why not higher** — the score reflects this property's verification state, not the audit; every missing point is a named check with a fix:`);
    for (const w of score.reliabilityWhy) L.push(`- **${w.metric}** (-${w.lostPts} pts of its ${w.weightPct}): ${w.cause}. Fix: ${w.fix}`);
  }
  L.push(`*These measure different things: the score rates how the property is configured, while reporting reliability rates how much of its data is safe to quote. A well-configured property can still have low reporting reliability when conversion, revenue, or consent checks are unverified.*  `);
  L.push(`**Overall verdict:** ${overallVerdict(allFindings, nNotVerified, score.reliabilityPct, Boolean(growth?.assessed))}  `);
  L.push(`**Biggest risk:** ${top ? firstSentence(top.whyItMatters ?? top.message) : 'No high-severity risk; the ceiling on trust is coverage.'}  `);
  L.push(`**Highest-impact fix:** ${top ? firstSentence(top.recommendation ?? 'Confirm the unverified areas.') : 'Confirm the unverified areas (consent, ecommerce parameters) before sign-off.'}  `);
  L.push(`**Coverage:** ${areaRows.length} areas checked · ${nPartial} partial · ${nNotVerified} not verified`);
  L.push('');
  L.push('**Per-category scorecard**');
  L.push('');
  L.push('| Category | Subscore | Weight | Eff. weight | Contribution |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const c of score.categories) {
    const sub = c.subscore === null ? 'Not Verified' : `${c.subscore}/100`;
    const contrib = c.subscore === null ? '—' : `+${c.contribution.toFixed(1)}`;
    const effW = c.subscore === null ? 'excluded' : `${(c.effectiveWeight * 100).toFixed(0)}%`;
    L.push(`| ${c.name} | ${sub} | ${c.weight}% | ${effW} | ${contrib} |`);
  }
  L.push(`| **Composite** | **${score.composite ?? '—'}/100** | **100%** | **100%** | **${score.composite ?? '—'}** |`);
  L.push('');
  L.push('*Contribution = subscore × weight, renormalised over verified categories; Not-Verified categories are excluded and their weight redistributed. The number is computed by rule, never judged.*');
  L.push('');
  L.push('**Data trust matrix — what to quote from this audit**');
  L.push('');
  L.push('| Metric | Quote? | Why |');
  L.push('| --- | --- | --- |');
  for (const t of score.trust) {
    const label =
      t.verdict === 'safe' ? '✅ Safe to quote'
      : t.verdict === 'caution' ? '🟡 Quote with caution'
      : t.verdict === 'unverified' ? '⚪ Unverified — do not assume safe'
      : '⛔ Do not quote';
    L.push(`| ${t.metric} | ${label} | ${cell(t.reason)} |`);
  }
  L.push('');

  // ── 2 · What is wrong (top finding, expanded) ──
  L.push('## 2 · What is wrong');
  L.push('');
  if (top) {
    L.push(`**[${top.severity.toUpperCase()}] ${top.area} — ${firstSentence(top.message)}**`);
    L.push('');
    L.push(`- **Evidence:** ${top.evidence ?? top.message}`);
    if (top.whyItMatters) L.push(`- **Why it matters:** ${top.whyItMatters}`);
    L.push(`- **If unconfirmed:** ${top.ifUnconfirmed ?? 'Graded at face value — no worse unverified branch.'}`);
    L.push(`- **Fix:** ${top.recommendation ?? '—'}`);
    if (dqAttrib && top.category === 'growth') L.push(`- **Related:** ${dqAttrib.message} (likely the same sessions behind the spike)`);
    L.push('');
  } else {
    L.push(`No high-severity issue. The ceiling on trust is coverage — ${nNotVerified} area(s) are unverified; see section 8.`);
    L.push('');
  }

  // ── 3 · Outcomes vs traffic (the growth check) ──
  L.push('## 3 · Outcomes vs traffic');
  L.push('');
  if (growth && growth.assessed) {
    L.push('```');
    L.push(`Sessions    ${trendPctText(growth.sessionsTrendPct)}`);
    L.push(`Key events  ${trendPctText(growth.keyEventsTrendPct)}`);
    L.push(`Revenue     ${trendPctText(growth.revenueTrendPct)}`);
    L.push('```');
    L.push(`**Read:** ${growthReadLine(growth.findings[0], growth.sessionsTrendPct)}`);
    // Verdict-aware caveat: a FAILED gate says "not safe to quote"; an UNVERIFIED one says
    // "confirm before quoting" — never asserting untrustworthiness the matrix doesn't claim.
    if (keV === 'do_not_quote' || revV === 'do_not_quote') {
      L.push('');
      L.push(`*Per the data trust matrix, the key-event and revenue figures above are NOT safe to quote until conversion tracking is confirmed${sesSafe ? '; sessions are safe to quote' : ''}.*`);
    } else if (keV === 'unverified' || revV === 'unverified') {
      L.push('');
      L.push('*The key-event/revenue figures above could not be fully verified (see the data trust matrix) — confirm before quoting.*');
    }
  } else {
    L.push('Not enough prior traffic to assess growth for this window.');
  }
  // Trend pattern: is the change a one-day spike or a sustained trend, and which platform drove it?
  if (baseline && baseline.dailySessions.length >= 5) {
    const trend = analyzeGa4Trend({ dailySessions: baseline.dailySessions, peakDayChannels: baseline.peakDayChannels, windowChannels: dqCounts.channelGroups, todayYmd: dqCounts.todayYmd });
    L.push('');
    L.push(`**Trend pattern:** ${trend.patternLabel}. ${trend.summary}`);
  }
  L.push('');

  // ── 4 · All findings (severity high → low) ──
  L.push('## 4 · All findings');
  L.push('');
  if (allFindings.length === 0) {
    L.push('No config, data-quality or growth issues found for this window. ✅');
  } else {
    const actNow = actionable.length;
    L.push(`${allFindings.length} item(s) — ${actNow} to act on, ${allFindings.length - actNow} advisory. Highest severity first.`);
    L.push('');
    L.push('| Severity | Area | Issue | Business risk | Fix | State |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of allFindings) L.push(`| ${f.severity.toUpperCase()} | ${f.area} | ${cell(f.message)} | ${cell(riskFor(f))} | ${cell(f.recommendation ?? '—')} | ${stateLabel(f.state)} |`);
  }
  // "Blocked by verification": checks that could not run this window, promoted here as first-class
  // items (they also appear in Section 8) so a reader sees the unmeasured gaps alongside the findings.
  const blocked = verificationBlocks(config, ecom, Boolean(input.ecomVerification));
  if (blocked.length) {
    L.push('');
    L.push('**Blocked by verification** (checks that could not run this window, so any related conclusion is unconfirmed - not a clean pass):');
    L.push('');
    for (const b of blocked) L.push(`- **${b.area}:** ${cell(b.message)} _Fix:_ ${cell(b.recommendation)}`);
  }
  L.push('');

  // ── 5 · Area status (evidence layer; coloured dot per status) ──
  L.push('## 5 · Area status');
  L.push('');
  L.push('| Area | Status | Confidence | Evidence |');
  L.push('| --- | --- | --- | --- |');
  for (const a of areaRows) {
    L.push(`| ${a.area} | ${STATUS_DOT[a.statusKey] ?? ''} ${STATUS_LABEL[a.statusKey] ?? a.statusKey} | ${confidenceFor(a.statusKey)} | ${cell(a.evidence)} |`);
  }
  L.push('');

  // ── 6 · Property baseline (context) ──
  L.push('## 6 · Property baseline');
  L.push('');
  if (baseline) {
    L.push(`- **Sessions:** ${num(baseline.sessions)} (prior period ${num(baseline.priorSessions)}${trendLabel(baseline)})`);
    if (growth && growth.assessed) {
      L.push(`- **Growth signals (vs prior):** sessions ${trendPctText(growth.sessionsTrendPct)} · key events ${trendPctText(growth.keyEventsTrendPct)}${quoteTag(keV)} · revenue ${trendPctText(growth.revenueTrendPct)}${quoteTag(revV)}`);
    }
    L.push(`- **Peak day:** ${baseline.peakDay ? `${fmtDay(baseline.peakDay.date)} — ${num(baseline.peakDay.sessions)} sessions` : 'Not Verified'}`);
    L.push(`- **New vs returning:** ${shareLabel(baseline.newVsReturning)}`);
    L.push(`- **Top markets:** ${baseline.topCountries.length ? baseline.topCountries.map((c) => `${c.name || '(not set)'} ${pct(c.sessions, baseline.sessions)}%`).join(', ') : 'Not Verified'}`);
    const engLine = engagementLabel(baseline);
    if (engLine) L.push(`- **Engagement:** ${engLine}`);
    if (input.retentionSummary) L.push(`- **Retention (cohorts):** ${input.retentionSummary}`);
    L.push('');
    const convSafe = safeOf('Conversion counts');
    const revSafe = safeOf('Revenue / AOV / ROAS');
    const insights = deriveGa4Insights(baseline, s.currencyCode, { convSafe, revSafe });
    if (insights.length) {
      L.push('**Key insights**');
      L.push('');
      for (const ins of insights) L.push(`- ${ins}`);
      L.push('');
    }
    // The performance tables below show conversion rate and revenue per row. When the Data Trust
    // Matrix hasn't confirmed those metrics, flag the columns as provisional so a reader doesn't act
    // on "converts best" style comparisons as if they were verified.
    const perfNote =
      !convSafe && !revSafe
        ? '_Conversion-rate and revenue columns below are provisional - both are unverified (see the Data Trust Matrix)._'
        : !convSafe
          ? '_Conversion-rate columns below are provisional - conversion tracking is unverified (see the Data Trust Matrix)._'
          : !revSafe
            ? '_Revenue columns below are provisional - revenue is unverified (see the Data Trust Matrix)._'
            : null;
    const cperf = channelPerfRows(baseline, s.currencyCode);
    if (cperf.length) {
      if (perfNote) {
        L.push(perfNote);
        L.push('');
      }
      L.push('**Channel performance** (which channels convert and earn, not just their traffic share)');
      L.push('');
      L.push('| Channel | Sessions | Conv. rate | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|');
      for (const c of cperf) L.push(`| ${cell(c.channel)} | ${c.sessions} | ${c.convRate} | ${c.revenue} | ${c.engagement} |`);
      L.push('');
    }
    const lpRows = landingPageRows(baseline, s.currencyCode);
    if (lpRows.length) {
      L.push('**Landing pages** (top entry pages — which pages convert and which leak)');
      L.push('');
      L.push('| Landing page | Sessions | Conv. rate | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|');
      for (const p of lpRows) L.push(`| ${cell(p.page)} | ${p.sessions} | ${p.convRate} | ${p.revenue} | ${p.engagement} |`);
      L.push('');
    }
    const dpRows = devicePerfRows(baseline, s.currencyCode);
    if (dpRows.length) {
      L.push('**Device performance** (how each device type converts and spends)');
      L.push('');
      L.push('| Device | Sessions | Conv. rate | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|');
      for (const d of dpRows) L.push(`| ${cell(d.device)} | ${d.sessions} | ${d.convRate} | ${d.revenue} | ${d.engagement} |`);
      L.push('');
    }
    const gpRows = geoPerfRows(baseline, s.currencyCode);
    if (gpRows.length) {
      L.push('**Market performance** (which geographies convert and spend, top 10 by sessions)');
      L.push('');
      L.push('| Market | Sessions | Conv. rate | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|');
      for (const g of gpRows) L.push(`| ${cell(g.country)} | ${g.sessions} | ${g.convRate} | ${g.revenue} | ${g.engagement} |`);
      L.push('');
    }
    // Campaign performance — the tagged utm_campaign traffic ranked by the campaign engine. When there
    // is no tagged campaign traffic, print a one-line advisory instead of an empty table (the "no
    // campaigns tagged" finding also lands in section 4).
    if (campaignPerf) {
      L.push(`**Campaign performance** (which marketing campaigns convert and earn — top campaign: ${campaignPerf.best ?? 'n/a'}; untagged traffic ${campaignPerf.untaggedShare})`);
      L.push('');
      L.push('| Campaign | Sessions | Key events | Purchases | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|--:|');
      for (const c of campaignPerf.rows) L.push(`| ${cell(c.campaign)} | ${c.sessions} | ${c.conversions} | ${c.purchases} | ${c.revenue} | ${c.engagement} |`);
      L.push('');
      // The one table that used to ship without a guardrail: key-event counts must never read as sales,
      // and it carries the same provisional flag as the other performance tables when trust is unproven.
      L.push(`_${campaignPerf.caveat}${!convSafe || !revSafe ? ' Key-event and revenue figures are provisional - unverified in the Data Trust Matrix.' : ''}_`);
      L.push('');
    } else if (campaigns) {
      L.push(`**Campaign performance:** No utm_campaign-tagged traffic in this window (${campaigns.untaggedSharePct.toFixed(1)}% untagged) — add utm_campaign/utm_source/utm_medium to your marketing links so campaign ROI is measurable.`);
      L.push('');
    }
    const llm = llmTrafficView(baseline, s.currencyCode);
    if (llm) {
      L.push(`**AI assistant traffic** (which AI referrers convert and earn — ${llm.share})`);
      L.push('');
      L.push('| AI source | Sessions | Conv. rate | Revenue | Engagement |');
      L.push('|---|--:|--:|--:|--:|');
      for (const c of llm.rows) L.push(`| ${cell(c.source)} | ${c.sessions} | ${c.convRate} | ${c.revenue} | ${c.engagement} |`);
      L.push('');
      L.push('_AI-referral traffic is a systematic undercount — visits from AI mobile/in-app browsers and copied links arrive with no referrer and land in Direct._');
      L.push('');
    }
    const fun = funnelView(baseline);
    if (fun) {
      L.push(`**Ecommerce funnel** (distinct users per step; overall view-to-purchase ${fun.overall})`);
      L.push('');
      L.push('| Step | Users | % of entry | Step conversion |');
      L.push('|---|--:|--:|--:|');
      for (const st of fun.steps) L.push(`| ${cell(st.label)} | ${st.users} | ${st.pctEntry} | ${st.stepConv} |`);
      L.push('');
      L.push('_Event-coverage approximation, not a strict sequential path — a later step can exceed an earlier one (saved carts, express checkout, or a missing step tag)._');
      L.push('');
    }
    if (baseline.devices.length) {
      // Divide by the device report's OWN total (not the date-report total) so the shares sum to ~100%.
      const devTotal = baseline.devices.reduce((acc, d) => acc + d.sessions, 0) || 1;
      L.push('**Device split**');
      L.push('');
      L.push('```');
      for (const d of baseline.devices) L.push(`${(d.name || '(not set)').padEnd(12)} ${bar(pct(d.sessions, devTotal))}`);
      L.push('```');
      L.push('');
    }
  } else {
    L.push('- Baseline traffic metrics could not be retrieved — **Not Verified**.');
    L.push('');
  }
  // Channel-mix bars divide by the channel report's OWN sum (not the headline total, which comes
  // from a separate no-dimension query) so the shares are internally consistent and sum to ~100%.
  const channelTotal = dqCounts.channelGroups.reduce((acc, c) => acc + c.sessions, 0) || 1;
  const channels = [...dqCounts.channelGroups].sort((a, b) => b.sessions - a.sessions).slice(0, 8);
  if (channels.length) {
    L.push('**Channel mix (sessions)**');
    L.push('');
    L.push('```');
    for (const ch of channels) L.push(`${(ch.name || '(not set)').padEnd(20)} ${bar(pct(ch.sessions, channelTotal))}`);
    L.push('```');
    L.push('');
  }

  // ── 7 · Decision readiness ──
  L.push('## 7 · Decision readiness');
  L.push('');
  L.push('| Business question | Status | Missing input |');
  L.push('| --- | --- | --- |');
  for (const r of decisionReadiness(s, { convSafe: safeOf('Conversion counts'), revSafe: safeOf('Revenue / AOV / ROAS') })) L.push(`| ${cell(r.q)} | ${r.status} | ${cell(r.note)} |`);
  L.push('');

  // ── 8 · Not verified (honesty layer) ──
  L.push('## 8 · Not verified');
  L.push('');
  const nv: Array<{ item: string; blocks: string }> = [
    { item: 'Per-event parameter coverage', blocks: 'whether events carry the parameters reports & funnels rely on' },
    { item: 'Consent Mode v2 signals', blocks: 'whether consent-gated loss is inflating "(not set)"/Unassigned' },
  ];
  if (ecom && !input.ecomVerification) nv.push({ item: 'Ecommerce item parameters & duplicate transactions', blocks: 'whether revenue and abandonment figures are accurate' });
  else if (!ecom) nv.push({ item: 'Ecommerce funnel (no purchase/add_to_cart key events)', blocks: 'product/checkout funnel analysis' });
  for (const a of config.areas.filter((x) => x.status === 'not_verified')) nv.push({ item: `${a.area} (config sub-resource unreadable)`, blocks: `the ${a.area} checks` });
  const gate =
    top && (top.severity === 'critical' || top.severity === 'high') && top.category === 'growth'
      ? 'whether conversion tracking actually fires for the new traffic — needs GA4 DebugView + a per-event Data API pass'
      : nv[0].blocks;
  L.push(`**Gates sign-off:** ${gate}.`);
  L.push('');
  for (const x of nv) L.push(`- ${x.item} → blocks: ${x.blocks}`);
  L.push('');

  // ── 9 · Scope & metadata (appendix) ──
  L.push('## 9 · Scope & metadata');
  L.push('');
  L.push(`**Audit ID:** ${auditId}  `);
  L.push(`**Setup completeness:** ${score.composite ?? '—'}/100 (Grade ${score.grade}) · **Reporting reliability:** ${score.reliabilityPct}%  `);
  L.push(`**Window:** ${windowLabel}${cmp}  `);
  L.push(`**Retention:** ${retentionLabel(s.dataRetention)}  `);
  L.push(`**Timezone / currency:** ${s.timeZone || '—'} / ${s.currencyCode || '—'}  `);
  L.push(`**Access:** GA4 Admin + Data API (read-only)  `);
  L.push(`**Generated:** ${input.generatedAt}  `);
  L.push(`**Property:** ${input.displayName} (${pid})  `);
  const limits = ['per-event parameter coverage not computed', 'Consent Mode not assessed (needs DebugView)'];
  if (!ecom) limits.push('no ecommerce events detected');
  L.push(`**Limitations:** ${limits.join('; ')}.  `);
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of allFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  L.push(`**Findings:** Critical ${counts.critical} · High ${counts.high} · Medium ${counts.medium} · Low ${counts.low} · Info ${counts.info}`);
  L.push('');
  L.push('*Read-only — GA4 has no auto-fixes; apply each change in the GA4 Admin UI.*');

  // House style: no em dashes in the report output. Replace any with a spaced hyphen (em dashes are
  // written " — " in the source strings, so this yields " - "); en-dash date ranges are left as-is.
  return L.join('\n').replace(/—/g, '-');
}
