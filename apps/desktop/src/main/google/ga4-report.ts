// Pure GA4 property-audit REPORT builder — turns the config audit + data-quality audit + baseline
// metrics into a templated Markdown document (the GA4 Property Audit Brain layout: header → exec
// summary → area-status table → property baseline + Unicode bars → decision readiness → findings →
// not-verified → summary). No I/O, so it's fully unit-testable; the IPC gathers the data and feeds
// it in. Sections that can't be computed deterministically (per-event parameter coverage, consent)
// are reported as Not Verified — never a silent pass.

import type { Ga4AuditReport, Ga4PropertySnapshot } from './ga4-audit';
import type { Ga4DataQualityResult, DataQualityCounts } from './ga4-data-quality';
import type { Ga4GrowthResult } from './ga4-growth';
import type { Ga4Baseline } from './data-service';

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
}

interface AreaRow {
  area: string;
  statusKey: 'pass' | 'partial' | 'fail' | 'not_verified';
  evidence: string;
}
interface FindingRow {
  severity: string;
  area: string;
  message: string;
  recommendation?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const STATUS_LABEL: Record<string, string> = { pass: 'Pass', partial: 'Partial', fail: 'Fail', not_verified: 'Not Verified' };

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
const retentionLabel = (dr: Ga4PropertySnapshot['dataRetention']): string =>
  dr === null ? 'Not Verified' : dr.eventDataRetention === 'FOURTEEN_MONTHS' ? '14 months' : dr.eventDataRetention === 'TWO_MONTHS' ? '2 months' : dr.eventDataRetention;
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

function areaEvidence(area: string, s: Ga4PropertySnapshot, config: Ga4AuditReport): string {
  switch (area) {
    case 'Data collection':
      return `${s.dataStreams.length} data stream(s)`;
    case 'Data retention':
      return retentionLabel(s.dataRetention);
    case 'Key events':
      return s.keyEvents === null ? 'could not read' : `${s.keyEvents.length} key event(s)`;
    case 'Custom definitions':
      return `${config.counts.customDimensions} dimension(s), ${config.counts.customMetrics} metric(s)`;
    case 'Privacy (PII)':
      return s.customDimensions === null ? 'dimensions unread' : 'no PII patterns in dimension names';
    case 'Integrations':
      return `${s.googleAdsLinks ?? '—'} Google Ads link(s); Signals ${s.googleSignals === 'GOOGLE_SIGNALS_ENABLED' ? 'on' : s.googleSignals === 'GOOGLE_SIGNALS_DISABLED' ? 'off' : '—'}`;
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

// Overall verdict — factors in findings AND coverage. A property is NOT "well-configured" while
// areas remain unverified/partial (the Brain's "never assume a pass" rule applied to the headline).
function execState(allFindings: FindingRow[], areaRows: AreaRow[]): string {
  const sev = (s: string): number => allFindings.filter((f) => f.severity === s).length;
  const high = sev('critical') + sev('high');
  const med = sev('medium');
  const low = sev('low');
  const unverified = areaRows.filter((a) => a.statusKey === 'not_verified').length;
  const partial = areaRows.filter((a) => a.statusKey === 'partial').length;
  const tail = `${unverified} area(s) unverified, ${partial} partially verified — confirm those before sign-off.`;
  if (high > 0) return `${high} high-impact issue(s) need attention${med + low > 0 ? `, plus ${med + low} smaller gap(s)` : ''}; ${tail}`;
  if (med > 0) return `${med} issue(s) to address${low ? ` and ${low} minor gap(s)` : ''}; ${tail}`;
  if (low > 0) return `${low} minor gap(s); ${tail}`;
  return `No critical/high/medium/low issues found, but ${tail} Not a clean bill of health on its own.`;
}

export function buildGa4AuditReport(input: Ga4ReportInput): string {
  const { snapshot: s, config, dataQuality: dq, dqCounts, baseline, growth, attribution, audienceCount } = input;
  const pid = input.property.replace('properties/', '');
  const ecom = hasEcommerce(s);
  const L: string[] = [];

  // ── Single source of truth: combined findings (config + data quality + growth/anomaly) and the
  // area-coverage rows. The exec verdict, Findings table and Summary all derive from these. ──
  const allFindings: FindingRow[] = [
    ...config.findings.map((f) => ({ severity: f.severity, area: 'Config', message: f.message, recommendation: f.recommendation })),
    ...dq.findings.map((f) => ({ severity: f.severity, area: 'Data quality', message: f.message, recommendation: f.recommendation })),
    ...(growth?.findings ?? []).map((f) => ({ severity: f.severity, area: 'Growth', message: f.message, recommendation: f.recommendation })),
  ].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  const areaRows: AreaRow[] = config.areas.map((a) => ({ area: a.area, statusKey: a.status, evidence: areaEvidence(a.area, s, config) }));
  if (attribution) {
    areaRows.push({ area: 'Attribution', statusKey: 'pass', evidence: `${attribution.reportingAttributionModel}; lookback ${attribution.acquisitionConversionEventLookbackWindow}/${attribution.otherConversionEventLookbackWindow}` });
  }
  if (audienceCount !== null) {
    areaRows.push({ area: 'Audiences', statusKey: audienceCount > 0 ? 'pass' : 'partial', evidence: `${audienceCount} audience(s)` });
  }
  // Ecommerce is never a clean Pass: even with purchase/item key events, per-event parameter coverage
  // and duplicate-transaction checks are not computed here → Partial at best.
  areaRows.push({
    area: 'Ecommerce',
    statusKey: ecom ? 'partial' : 'not_verified',
    evidence: ecom ? 'purchase/item key events present; item params & duplicate transactions not verified' : 'no purchase/item key events found',
  });
  areaRows.push({ area: 'Consent', statusKey: 'not_verified', evidence: 'consent mode not retrievable via the Admin API' });

  // ── Header ──
  L.push(`# GA4 Property Audit — ${input.displayName}`);
  L.push('');
  L.push(`**Property:** ${input.displayName} (${pid})  `);
  const windowLabel = dq.dateRange ?? `${dq.windowDays} days`;
  const cmp = baseline ? ` vs prior ${baseline.priorStartDate} – ${baseline.priorEndDate}` : '';
  L.push(`**Data window:** ${windowLabel}${cmp}  `);
  L.push(`**Data retention:** ${retentionLabel(s.dataRetention)}  `);
  L.push(`**Timezone / currency:** ${s.timeZone || '—'} / ${s.currencyCode || '—'}  `);
  L.push(`**Access:** GA4 Admin + Data API (read-only)  `);
  L.push(`**Generated:** ${input.generatedAt}`);
  L.push('');
  const limits = ['per-event parameter coverage not computed', 'Consent Mode not assessed (needs DebugView)'];
  if (!ecom) limits.push('no ecommerce events detected');
  L.push(`*Data limitations: ${limits.join('; ')}.*`);
  L.push('');

  // ── Executive summary ──
  const trendPctText = (p: number | null): string => (p === null ? 'n/a' : `${p >= 0 ? '+' : ''}${p}%`);
  L.push('## Executive summary');
  L.push('');
  L.push(`- **Overall:** ${execState(allFindings, areaRows)}`);
  const fc = config.counts.findings;
  const fd = dq.findings.length;
  const fg = growth?.findings.length ?? 0;
  L.push(`- **Findings:** ${fc + fd + fg} total — ${fc} config, ${fd} data quality, ${fg} growth/anomaly`);
  L.push(`- **Sessions (window):** ${num(baseline ? baseline.sessions : dq.totalSessions)}${trendLabel(baseline)}`);
  if (growth && growth.assessed) {
    L.push(`- **Outcomes vs prior:** key events ${trendPctText(growth.keyEventsTrendPct)}, revenue ${trendPctText(growth.revenueTrendPct)} (sessions ${trendPctText(growth.sessionsTrendPct)})`);
  }
  L.push('');

  // ── Area status ──
  L.push('## Area status');
  L.push('');
  L.push('| Area | Status | Confidence | Evidence |');
  L.push('| --- | --- | --- | --- |');
  for (const a of areaRows) {
    L.push(`| ${a.area} | ${STATUS_LABEL[a.statusKey] ?? a.statusKey} | ${confidenceFor(a.statusKey)} | ${cell(a.evidence)} |`);
  }
  L.push('');

  // ── Property baseline ──
  L.push('## Property baseline');
  L.push('');
  if (baseline) {
    L.push(`- **Sessions:** ${num(baseline.sessions)} (prior period ${num(baseline.priorSessions)}${trendLabel(baseline)})`);
    if (growth && growth.assessed) {
      L.push(`- **Growth signals (vs prior):** sessions ${trendPctText(growth.sessionsTrendPct)} · key events ${trendPctText(growth.keyEventsTrendPct)} · revenue ${trendPctText(growth.revenueTrendPct)}`);
    }
    L.push(`- **Peak day:** ${baseline.peakDay ? `${fmtDay(baseline.peakDay.date)} — ${num(baseline.peakDay.sessions)} sessions` : 'Not Verified'}`);
    L.push(`- **New vs returning:** ${shareLabel(baseline.newVsReturning)}`);
    L.push(`- **Top markets:** ${baseline.topCountries.length ? baseline.topCountries.map((c) => `${c.name || '(not set)'} ${pct(c.sessions, baseline.sessions)}%`).join(', ') : 'Not Verified'}`);
    L.push('');
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

  // ── Decision readiness ──
  L.push('## Decision readiness');
  L.push('');
  L.push('| Business question | Status | Notes |');
  L.push('| --- | --- | --- |');
  for (const r of decisionReadiness(s)) L.push(`| ${cell(r.q)} | ${r.status} | ${cell(r.note)} |`);
  L.push('');

  // ── Findings & fixes (by severity) ──
  L.push('## Findings (by severity)');
  L.push('');
  if (allFindings.length === 0) {
    L.push('No config, data-quality or growth issues found for this window. ✅');
  } else {
    const actNow = allFindings.filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium').length;
    L.push(`${allFindings.length} item(s) — ${actNow} warning(s)/fix(es) to act on, ${allFindings.length - actNow} advisory. Highest severity first.`);
    L.push('');
    L.push('| Severity | Area | Issue | Recommended fix |');
    L.push('| --- | --- | --- | --- |');
    for (const f of allFindings) L.push(`| ${f.severity.toUpperCase()} | ${f.area} | ${cell(f.message)} | ${cell(f.recommendation ?? '—')} |`);
  }
  L.push('');

  // ── Not verified ──
  L.push('## Not verified');
  L.push('');
  const nv = [
    'Per-event parameter coverage — needs per-event Data API analysis',
    'Consent Mode v2 signals — needs GA4 DebugView / a live /collect hit capture',
  ];
  if (!ecom) nv.push('Ecommerce funnel — no purchase/add_to_cart key events detected');
  else nv.push('Ecommerce item parameters & duplicate transactions — needs per-event Data API analysis');
  for (const a of config.areas.filter((x) => x.status === 'not_verified')) nv.push(`${a.area} — config sub-resource could not be read`);
  for (const item of nv) L.push(`- ${item}`);
  L.push('');

  // ── Summary ──
  L.push('## Summary');
  L.push('');
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of allFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  L.push(`Critical: ${counts.critical} · High: ${counts.high} · Medium: ${counts.medium} · Low: ${counts.low} · Info: ${counts.info}`);
  L.push('');
  L.push('*Read-only — GA4 has no auto-fixes; apply each change in the GA4 Admin UI.*');

  return L.join('\n');
}
