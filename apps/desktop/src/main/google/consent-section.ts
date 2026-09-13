// Bridge a web-audit `consent_compliance_audit` report (run by the separate
// web-audit MCP, which CAN capture a live site) into a scorecard/report section,
// so the desktop's GTM+GA4 scorecard can include a Consent Mode v2 dimension it
// can't measure on its own. Pure + tolerant — accepts the ComplianceReport
// object, the MCP envelope wrapping it, or a bare { findings } — and returns
// null when there's nothing consent-related to score.

import type { ScorecardFinding, ScorecardSection, Severity } from './scorecard';

// Fields are `unknown` because consentReport is untrusted user-pasted JSON —
// a value typed as a string in a well-formed report may be anything here.
interface RawFinding {
  domain?: unknown;
  severity?: unknown;
  finding?: unknown;
  message?: unknown;
  suggestedFix?: unknown;
}

function findingsOf(raw: unknown): RawFinding[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.findings)) return o.findings as RawFinding[];
  // Tolerate a wrapper: { report: { findings } }.
  const report = o.report;
  if (report && typeof report === 'object' && Array.isArray((report as { findings?: unknown }).findings)) {
    return (report as { findings: RawFinding[] }).findings;
  }
  return [];
}

// web-audit severities include 'critical', which the scorecard doesn't model.
function toSeverity(s: unknown): Severity {
  if (s === 'critical' || s === 'high') return 'high';
  if (s === 'medium' || s === 'low' || s === 'info') return s;
  return 'medium';
}

/**
 * Build a "Consent Mode v2" section from a web-audit report. Includes the
 * consent-engine findings and the banner-behaviour findings (both are consent /
 * CMP concerns). Returns null if the input carries no such findings.
 */
export function consentReportToSection(raw: unknown): ScorecardSection | null {
  const relevant = findingsOf(raw).filter(
    (f) => f && typeof f === 'object' && (f.domain === 'consent' || f.domain === 'banner')
  );
  if (relevant.length === 0) return null;

  const findings: ScorecardFinding[] = relevant.map((f) => {
    const message =
      typeof f.finding === 'string' ? f.finding : typeof f.message === 'string' ? f.message : '(unnamed finding)';
    return {
      severity: toSeverity(f.severity),
      category: f.domain === 'banner' ? 'banner' : 'consent', // the filter admits only these two
      message,
      ...(typeof f.suggestedFix === 'string' && f.suggestedFix ? { recommendation: f.suggestedFix } : {}),
    };
  });
  return { key: 'consent', label: 'Consent Mode v2', findings };
}
