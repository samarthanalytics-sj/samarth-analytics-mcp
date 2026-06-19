// Pure analytics health scorecard. Combines severity-tagged findings from any
// number of audit sections (GTM container, GA4 property — and later consent)
// into a single 0–100 score with a letter grade, per-section breakdown, and a
// ranked top-issues list. No I/O — fully unit-testable. Generic over findings so
// new audit sources compose without touching the engine.

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface ScorecardFinding {
  severity: Severity;
  category: string;
  message: string;
  recommendation?: string;
}
export interface ScorecardSection {
  key: string;
  label: string;
  findings: ScorecardFinding[];
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  info: number;
}
export interface ScorecardSectionResult {
  key: string;
  label: string;
  score: number;
  grade: string;
  counts: SeverityCounts;
}
export interface ScorecardIssue {
  section: string;
  severity: Severity;
  category: string;
  message: string;
  recommendation?: string;
}
export interface Scorecard {
  score: number;
  grade: string;
  summary: SeverityCounts;
  sections: ScorecardSectionResult[];
  topIssues: ScorecardIssue[];
}

// Points deducted per finding. info is informational only (never lowers the
// score). Mirrors the web-audit scorer's high/medium/low weighting.
const WEIGHT: Record<Severity, number> = { high: 15, medium: 7, low: 3, info: 0 };
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

function tally(findings: ScorecardFinding[]): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function scoreOf(findings: ScorecardFinding[]): number {
  let score = 100;
  for (const f of findings) score -= WEIGHT[f.severity];
  return Math.max(0, Math.min(100, score));
}

export function gradeOf(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function buildScorecard(sections: ScorecardSection[]): Scorecard {
  const sectionResults: ScorecardSectionResult[] = sections.map((sec) => {
    const score = scoreOf(sec.findings);
    return { key: sec.key, label: sec.label, score, grade: gradeOf(score), counts: tally(sec.findings) };
  });

  const all = sections.flatMap((s) => s.findings);
  const score = scoreOf(all);

  const topIssues: ScorecardIssue[] = sections
    .flatMap((s) =>
      s.findings.map((f) => ({
        section: s.label,
        severity: f.severity,
        category: f.category,
        message: f.message,
        ...(f.recommendation ? { recommendation: f.recommendation } : {}),
      }))
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 10);

  return {
    score,
    grade: gradeOf(score),
    summary: tally(all),
    sections: sectionResults,
    topIssues,
  };
}
