/**
 * Pure formatters for the "Download" option on the Container audit panel - turn an
 * AuditReportView into a CSV (a findings spreadsheet) or a Markdown report (shareable).
 * No React / DOM here so they are unit-testable with tsx.
 */
import type { AuditReportView, AuditFindingView } from '../../shared/ipc';

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Sort findings worst-severity first (stable within a severity). */
export function sortFindings(findings: AuditFindingView[]): AuditFindingView[] {
  return [...findings].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
}

/** RFC-4180 CSV cell: quote when it contains a comma, quote or newline; double internal quotes. */
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = ['Severity', 'Confidence', 'Category', 'Resource kind', 'Resource name', 'Resource type', 'Issue', 'Recommendation', 'Auto-fixable'] as const;

/** The container audit findings as a CSV (one row per finding, worst-severity first). */
export function auditToCsv(report: AuditReportView): string {
  const rows = sortFindings(report.findings).map((f) => [
    f.severity,
    f.confidence ?? '',
    f.category,
    f.resource?.kind ?? '',
    f.resource?.name ?? '',
    f.resource?.type ?? '',
    f.message,
    f.recommendation,
    f.autoFixable ? 'yes' : 'no',
  ]);
  return [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Escape a Markdown table cell (pipes + newlines break the row). */
function mdCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export interface AuditExportMeta {
  container?: string;
  workspace?: string;
  account?: string;
  /** ISO/human timestamp - passed in (the renderer stamps it; keeps this pure). */
  generatedAt?: string;
}

/** The container audit as a shareable Markdown report: header, counts + severity summary,
 *  then a findings table sorted worst-first. */
export function auditToMarkdown(report: AuditReportView, meta: AuditExportMeta = {}): string {
  const s = report.summary;
  const c = report.counts;
  const L: string[] = [];
  L.push('# GTM Container Audit');
  L.push('');
  const scope = [meta.account, meta.container, meta.workspace].filter(Boolean).join(' › ');
  if (scope) L.push(`**Container:** ${scope}  `);
  if (meta.generatedAt) L.push(`**Generated:** ${meta.generatedAt}  `);
  L.push(`**Scope:** ${c.tags} tags · ${c.triggers} triggers · ${c.variables} variables  `);
  L.push(`**Findings:** ${c.findings} - ${s.critical} critical · ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.info} info`);
  L.push('');
  L.push('> Container-only audit: proves CONFIGURATION, not firing behaviour, dataLayer reality, PII in hits, or consent timing - those need runtime verification.');
  L.push('');
  if (report.findings.length === 0) {
    L.push('No issues found. The container is configurationally clean.');
    return L.join('\n');
  }
  L.push('| # | Severity | Confidence | Category | Resource | Issue | Recommendation | Auto-fix |');
  L.push('|---|---|---|---|---|---|---|---|');
  sortFindings(report.findings).forEach((f, i) => {
    const res = f.resource ? `${f.resource.name}${f.resource.type ? ` (${f.resource.type})` : ''}` : '';
    L.push(
      `| ${i + 1} | ${f.severity} | ${f.confidence ?? ''} | ${mdCell(f.category)} | ${mdCell(res)} | ${mdCell(f.message)} | ${mdCell(f.recommendation)} | ${f.autoFixable ? 'yes' : 'no'} |`
    );
  });
  return L.join('\n');
}
