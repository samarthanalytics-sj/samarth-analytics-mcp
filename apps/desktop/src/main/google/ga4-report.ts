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
import type { Ga4Baseline } from './data-service';
import { buildGa4Scorecard } from './ga4-scorecard';
import { analyzeGa4Trend } from './ga4-trend';
import { deriveGa4Insights } from './ga4-insights';
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
  /** Weekly-retention cohort headline (Week 1 / Week 4), or null when there isn't enough reliable data. */
  retentionSummary?: string | null;
}

interface AreaRow {
  area: string;
  statusKey: 'pass' | 'partial' | 'fail' | 'not_verified';
  evidence: string;
}
interface FindingRow {
  severity: string;
  category: string;
  area: string;
  message: string;
  recommendation?: string;
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
  if (baseline.sessions <= 0) return null;
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
    page: p.page || '(not set)',
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

function decisionReadiness(s: Ga4PropertySnapshot): Array<{ q: string; status: string; note: string }> {
  const ads = (s.googleAdsLinks ?? 0) > 0;
  const signals = s.googleSignals === 'GOOGLE_SIGNALS_ENABLED';
  const ecom = hasEcommerce(s);
  const lead = hasKeyEvent(s, /lead|sign_up|contact|submit/i);
  const refund = hasKeyEvent(s, /refund|return/i);
  return [
    { q: 'Which campaigns generate revenue?', status: ads ? 'Answerable' : 'Partial', note: ads ? 'Google Ads linked + conversions' : 'link Google Ads to attribute revenue to campaigns' },
    { q: 'Abandonment by product/page?', status: ecom ? 'Answerable' : 'Not answerable', note: ecom ? 'ecommerce events present' : 'no ecommerce/funnel events' },
    { q: 'CAC by channel', status: ads ? 'Answerable' : 'Partial', note: ads ? 'sessions + cost via Google Ads link' : 'needs ad cost (Google Ads link)' },
    { q: 'Lead quality', status: lead ? 'Partial' : 'Not answerable', note: lead ? 'lead events exist; CRM import needed for true quality' : 'no lead/sign-up key events; no CRM import' },
    { q: 'Customer lifetime value', status: 'Not answerable', note: 'needs User-ID and/or server-side/BigQuery data' },
    { q: 'Refund/return rate', status: refund ? 'Answerable' : 'Not answerable', note: refund ? 'refund events present' : 'no refund/return events' },
    { q: 'Repeat/churn within 90 days', status: signals ? 'Answerable' : 'Partial', note: signals ? 'Google Signals → cross-device repeat rate' : 'enable Google Signals or User-ID for reliable repeat rate' },
  ];
}

const confidenceFor = (k: AreaRow['statusKey']): string =>
  k === 'not_verified' ? 'Guessing' : k === 'partial' ? 'Likely' : 'Certain';
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
// sections view so the two surfaces never word it differently.
const growthReadLine = (gf: { category: string; severity: string } | undefined): string =>
  !gf || gf.category !== 'growth'
    ? 'Sessions are within normal variation vs the prior period.'
    : gf.severity === 'info'
      ? 'Outcomes tracked the traffic — consistent with real growth.'
      : gf.severity === 'medium'
        ? "Sessions moved sharply, but there isn't enough conversion signal to confirm what's behind it."
        : gf.severity === 'low'
          ? 'Conversions grew with the traffic but slower than sessions — the conversion rate diluted (typical of a lower-converting channel mix), not a tracking break.'
          : 'Outcomes did NOT keep pace with traffic — the spike is unconfirmed and revenue/ROAS may be wrong right now.';

// Combined findings (config + data quality + growth) — the single source of truth for the report.
function buildAllFindings(config: Ga4AuditReport, dq: Ga4DataQualityResult, growth: Ga4GrowthResult | null): FindingRow[] {
  return [
    ...config.findings.map((f) => ({ severity: f.severity, category: f.category, area: 'Config', message: f.message, recommendation: f.recommendation })),
    ...dq.findings.map((f) => ({ severity: f.severity, category: f.category, area: 'Data quality', message: f.message, recommendation: f.recommendation })),
    ...(growth?.findings ?? []).map((f: Ga4GrowthFinding) => ({
      severity: f.severity,
      category: f.category,
      area: 'Growth',
      message: f.message,
      recommendation: f.recommendation,
      evidence: f.evidence,
      whyItMatters: f.whyItMatters,
      ifUnconfirmed: f.ifUnconfirmed,
      businessRisk: f.businessRisk,
    })),
  ].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
}

// Area-coverage rows = config areas + the report-level Attribution/Audiences/Ecommerce/Consent.
function buildAreaRows(
  s: Ga4PropertySnapshot,
  config: Ga4AuditReport,
  audienceCount: number | null,
  ecom: boolean,
): AreaRow[] {
  // Attribution is now a GRADED config area (auditGa4) with its own evidence, so it is not re-added
  // here as a passive "pass" row.
  const rows: AreaRow[] = config.areas.map((a) => ({ area: a.area, statusKey: a.status, evidence: areaEvidence(a.area, s, config) }));
  if (audienceCount !== null) {
    rows.push({ area: 'Audiences', statusKey: audienceCount > 0 ? 'pass' : 'partial', evidence: `${audienceCount} audience(s)` });
  }
  rows.push({
    area: 'Ecommerce',
    statusKey: ecom ? 'partial' : 'not_verified',
    evidence: ecom ? 'purchase/item key events present; item params & duplicate transactions not verified' : 'no purchase/item key events found',
  });
  rows.push({ area: 'Consent', statusKey: 'not_verified', evidence: 'consent mode not retrievable via the Admin API' });
  return rows;
}

/** Structured Executive Summary (section 1) — drives the markdown report, the on-screen card panel
 *  and the styled PDF/Word export from one rule-based computation. */
export function buildGa4ExecSummary(input: Ga4ReportInput): Ga4ExecSummaryView {
  const { snapshot: s, config, dataQuality: dq, growth, audienceCount } = input;
  const pid = input.property.replace('properties/', '');
  const ecom = hasEcommerce(s);
  const allFindings = buildAllFindings(config, dq, growth);
  const top = allFindings.filter((f) => f.severity !== 'info')[0];
  const areaRows = buildAreaRows(s, config, audienceCount, ecom);
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
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount } = input;
  const daily = baseline?.dailySessions ?? [];
  const trend = analyzeGa4Trend({ dailySessions: daily, peakDayChannels: baseline?.peakDayChannels ?? null, windowChannels: dqCounts.channelGroups, todayYmd: dqCounts.todayYmd });
  // Channel-attribution trust comes from the same Data Trust Matrix the Executive Summary uses.
  const allFindings = buildAllFindings(config, dq, growth);
  const areaRows = buildAreaRows(s, config, audienceCount, hasEcommerce(s));
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
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount } = input;
  const ecom = hasEcommerce(s);
  const allFindings = buildAllFindings(config, dq, growth);
  const actionable = allFindings.filter((f) => f.severity !== 'info');
  const top = actionable[0];
  const dqAttrib = allFindings.find((f) => f.category === 'data_quality' && f.severity !== 'info' && /source data|Unassigned|\(not set\)/.test(f.message));
  const areaRows = buildAreaRows(s, config, audienceCount, ecom);
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
      ? `* Not safe to quote until conversion tracking is confirmed${sesSafe ? '; sessions are safe to quote' : ''}.`
      : keV === 'unverified' || revV === 'unverified'
        ? '* Could not be fully verified — confirm before quoting (see the data trust matrix).'
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
          keSafe, revSafe, sesSafe, quoteNote, read: growthReadLine(growth.findings[0]), trendPattern,
        }
      : {
          assessed: false, sessionsPct: null, keyEventsPct: null, revenuePct: null,
          sessionsFrom: null, sessionsTo: null, keyEventsFrom: null, keyEventsTo: null, revenueFrom: null, revenueTo: null,
          keSafe, revSafe, sesSafe, quoteNote, read: 'Not enough prior traffic to assess growth for this window.', trendPattern,
        };

  const findings = allFindings.map((f) => ({ severity: f.severity, area: f.area, message: f.message, businessRisk: riskFor(f), recommendation: f.recommendation ?? '—' }));

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
  const decisions = decisionReadiness(s);

  // ── Section 8 · Not verified ──
  const nv: Array<{ item: string; blocks: string }> = [
    { item: 'Per-event parameter coverage', blocks: 'whether events carry the parameters reports & funnels rely on' },
    { item: 'Consent Mode v2 signals', blocks: 'whether consent-gated loss is inflating "(not set)"/Unassigned' },
  ];
  if (ecom) nv.push({ item: 'Ecommerce item parameters & duplicate transactions', blocks: 'whether revenue and abandonment figures are accurate' });
  else nv.push({ item: 'Ecommerce funnel (no purchase/add_to_cart key events)', blocks: 'product/checkout funnel analysis' });
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

  return { topFinding, noIssueNote, outcomes, findings, actionableCount: actionable.length, areas, baseline: baselineView, channelPerformance: channelPerfRows(baseline, s.currencyCode), landingPages: landingPageRows(baseline, s.currencyCode), devicePerformance: devicePerfRows(baseline, s.currencyCode), geoPerformance: geoPerfRows(baseline, s.currencyCode), llmTraffic: llmTrafficView(baseline, s.currencyCode), funnel: funnelView(baseline), insights: deriveGa4Insights(baseline, s.currencyCode), decisions, notVerified: { gate, items: nv }, scope };
}

export function buildGa4AuditReport(input: Ga4ReportInput): string {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, audienceCount } = input;
  const pid = input.property.replace('properties/', '');
  const ecom = hasEcommerce(s);
  const L: string[] = [];

  // ── Single source of truth: combined findings (config + data quality + growth/anomaly) and the
  // area-coverage rows. The verdict, All-findings table and counts all derive from these. ──
  const allFindings = buildAllFindings(config, dq, growth);
  // The "top finding" that drives the Verdict + "What is wrong" is the worst ACTIONABLE one. An
  // info-only result (e.g. the data-quality "no major issues" advisory on a clean property) has no
  // top finding, so those sections take their clean-property fallbacks instead of mislabelling an
  // all-clear as a problem.
  const actionable = allFindings.filter((f) => f.severity !== 'info');
  const top = actionable[0];
  const areaRows = buildAreaRows(s, config, audienceCount, ecom);

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
  L.push(`**Reliability score:** ${score.composite ?? '—'}/100 (Grade ${score.grade})  `);
  L.push(`**Reporting reliability:** ${score.reliabilityPct}% — ${score.reliabilityConfidence} (how much of this property’s data is safe to quote downstream today)  `);
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
    L.push(`**Read:** ${growthReadLine(growth.findings[0])}`);
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
    L.push('| Severity | Area | Issue | Business risk | Fix |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const f of allFindings) L.push(`| ${f.severity.toUpperCase()} | ${f.area} | ${cell(f.message)} | ${cell(riskFor(f))} | ${cell(f.recommendation ?? '—')} |`);
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
    const insights = deriveGa4Insights(baseline, s.currencyCode);
    if (insights.length) {
      L.push('**Key insights**');
      L.push('');
      for (const ins of insights) L.push(`- ${ins}`);
      L.push('');
    }
    const cperf = channelPerfRows(baseline, s.currencyCode);
    if (cperf.length) {
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
  for (const r of decisionReadiness(s)) L.push(`| ${cell(r.q)} | ${r.status} | ${cell(r.note)} |`);
  L.push('');

  // ── 8 · Not verified (honesty layer) ──
  L.push('## 8 · Not verified');
  L.push('');
  const nv: Array<{ item: string; blocks: string }> = [
    { item: 'Per-event parameter coverage', blocks: 'whether events carry the parameters reports & funnels rely on' },
    { item: 'Consent Mode v2 signals', blocks: 'whether consent-gated loss is inflating "(not set)"/Unassigned' },
  ];
  if (ecom) nv.push({ item: 'Ecommerce item parameters & duplicate transactions', blocks: 'whether revenue and abandonment figures are accurate' });
  else nv.push({ item: 'Ecommerce funnel (no purchase/add_to_cart key events)', blocks: 'product/checkout funnel analysis' });
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
  L.push(`**Reliability score:** ${score.composite ?? '—'}/100 (Grade ${score.grade}) · **Reporting reliability:** ${score.reliabilityPct}%  `);
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
