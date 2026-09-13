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
  /** Container-only boundary statement, rendered up top (Audit Brain §3). */
  boundary?: string;
  /** Checks needing live verification, listed at the end so none are assumed passed. */
  runtimeRequired?: string[];
}

// Markdown table cells can't contain a raw pipe or line break. Escape
// backslashes BEFORE pipes (else a pre-existing backslash turns `\|` into
// `\\|`, freeing the pipe as a live delimiter), and flatten every line-break
// form (incl. a bare \r).
function cell(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim();
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function buildReport(sections: ScorecardSection[], opts: ReportOptions = {}): string {
  const card = buildScorecard(sections);
  const title = opts.title ?? 'Analytics Health Report';
  const lines: string[] = [];

  lines.push(`# ${title}`);
  const meta = `**Overall: ${card.score}/100 (${card.grade})**`;
  lines.push(opts.generatedAt ? `${meta}  ·  generated ${opts.generatedAt}` : meta);
  lines.push('');

  // Container-only boundary statement (Audit Brain §3) — what this proves and what it doesn't.
  if (opts.boundary) {
    lines.push(`> ${cell(opts.boundary)}`);
    lines.push('');
  }

  // Per-section summary.
  lines.push('## Summary');
  lines.push('| Section | Score | Grade | Critical | High | Medium | Low | Info |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of card.sections) {
    lines.push(
      `| ${cell(s.label)} | ${s.score} | ${s.grade} | ${s.counts.critical} | ${s.counts.high} | ${s.counts.medium} | ${s.counts.low} | ${s.counts.info} |`
    );
  }
  lines.push('');

  // Top issues (ranked, capped by the scorecard).
  if (card.topIssues.length > 0) {
    lines.push('## Top issues');
    lines.push('| # | Severity | Confidence | Section | Issue | Recommended fix |');
    lines.push('|---|---|---|---|---|---|');
    card.topIssues.forEach((f, i) => {
      lines.push(
        `| ${i + 1} | ${f.severity} | ${f.confidence ?? '—'} | ${cell(f.section)} | ${cell(f.message)} | ${cell(f.recommendation ?? '')} |`
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
    lines.push('| Severity | Confidence | Category | Issue | Recommended fix |');
    lines.push('|---|---|---|---|---|');
    [...s.findings]
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
      .forEach((f) => {
        lines.push(`| ${f.severity} | ${f.confidence ?? '—'} | ${cell(f.category)} | ${cell(f.message)} | ${cell(f.recommendation ?? '')} |`);
      });
    lines.push('');
  }

  // Runtime-required checks (Audit Brain §8) — explicit so none are assumed to have passed.
  if (opts.runtimeRequired && opts.runtimeRequired.length > 0) {
    lines.push('## Runtime-required checks (not verified by this audit)');
    for (const r of opts.runtimeRequired) lines.push(`- ${r}`);
    lines.push('');
  }

  // Only when there are genuinely NO findings — info findings score 0 points,
  // so a 100 score can still have info findings listed above; don't contradict them.
  if (sections.every((s) => s.findings.length === 0)) {
    lines.push('_No issues detected across the audited sections._');
  }

  return lines.join('\n').trimEnd() + '\n';
}
