// Pure client-ready report builder: turns audit sections (GTM container, GA4
// property) into one shareable Markdown report — overall score + grade, a
// per-section summary table, a ranked top-issues table, and full per-section
// findings tables. No I/O — fully unit-testable. Reuses buildScorecard for the
// scoring/grading so the report and the scorecard never disagree.

import { buildScorecard, type ScorecardSection } from './scorecard';

export interface ReportOptions {
  title?: string;
  /** ISO timestamp, injected so the builder stays pure/deterministic. */
  generatedAt?: string;
}

// Markdown table cells can't contain a raw pipe or line break. Escape
// backslashes BEFORE pipes (else a pre-existing backslash turns `\|` into
// `\\|`, freeing the pipe as a live delimiter), and flatten every line-break
// form (incl. a bare \r).
function cell(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim();
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function buildReport(sections: ScorecardSection[], opts: ReportOptions = {}): string {
  const card = buildScorecard(sections);
  const title = opts.title ?? 'Analytics Health Report';
  const lines: string[] = [];

  lines.push(`# ${title}`);
  const meta = `**Overall: ${card.score}/100 (${card.grade})**`;
  lines.push(opts.generatedAt ? `${meta}  ·  generated ${opts.generatedAt}` : meta);
  lines.push('');

  // Per-section summary.
  lines.push('## Summary');
  lines.push('| Section | Score | Grade | High | Medium | Low | Info |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of card.sections) {
    lines.push(
      `| ${cell(s.label)} | ${s.score} | ${s.grade} | ${s.counts.high} | ${s.counts.medium} | ${s.counts.low} | ${s.counts.info} |`
    );
  }
  lines.push('');

  // Top issues (ranked, capped by the scorecard).
  if (card.topIssues.length > 0) {
    lines.push('## Top issues');
    lines.push('| # | Severity | Section | Issue | Recommended fix |');
    lines.push('|---|---|---|---|---|');
    card.topIssues.forEach((f, i) => {
      lines.push(
        `| ${i + 1} | ${f.severity} | ${cell(f.section)} | ${cell(f.message)} | ${cell(f.recommendation ?? '')} |`
      );
    });
    lines.push('');
  }

  // Full findings per section.
  for (const s of sections) {
    lines.push(`## ${s.label} — findings`);
    if (s.findings.length === 0) {
      lines.push('No issues found. ✅');
      lines.push('');
      continue;
    }
    lines.push('| Severity | Category | Issue | Recommended fix |');
    lines.push('|---|---|---|---|');
    [...s.findings]
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
      .forEach((f) => {
        lines.push(`| ${f.severity} | ${cell(f.category)} | ${cell(f.message)} | ${cell(f.recommendation ?? '')} |`);
      });
    lines.push('');
  }

  // Only when there are genuinely NO findings — info findings score 0 points,
  // so a 100 score can still have info findings listed above; don't contradict them.
  if (sections.every((s) => s.findings.length === 0)) {
    lines.push('_No issues detected across the audited sections._');
  }

  return lines.join('\n').trimEnd() + '\n';
}
