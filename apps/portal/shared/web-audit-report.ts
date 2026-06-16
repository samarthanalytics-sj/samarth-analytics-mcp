/**
 * Web-audit report shapes + a defensive parser.
 *
 * The `samarth-web-audit-mcp` server's `consent_compliance_audit` tool returns a
 * ComplianceReport. This module mirrors that shape (so the portal can render it
 * without importing across the app boundary) and validates untrusted pasted
 * JSON into it. Pure and framework-free: imported by the React client and
 * exercised by a node test.
 */

import type { AuditSeverity, AuditConfidence } from "./portal-types";

export type WebAuditDomain = "consent" | "banner" | "forms";
export type WebAuditCoverage = "runtime_only" | "runtime_imported" | "reconciled";
export type WebAuditScenario = "ignore" | "accept" | "reject";
export type WebAuditVerdict =
  | "compliant_looking"
  | "needs_attention"
  | "poor"
  | "non_compliant";

export interface WebAuditFinding {
  id: string;
  domain: WebAuditDomain;
  severity: AuditSeverity;
  confidence: AuditConfidence;
  finding: string;
  whyItMatters: string;
  suggestedFix: string;
  evidence?: string[];
  page?: string;
}

export interface WebAuditCaptureSummary {
  scenario: WebAuditScenario;
  url: string;
  httpStatus: number | null;
  trackerHits: number;
  firingHits: number;
  consentEvents: number;
  interactionClicked: boolean | null;
  notes: string[];
}

export interface WebAuditReport {
  site: string;
  auditedAt: string;
  score: number;
  verdict: WebAuditVerdict;
  summary: {
    pagesCrawled: number;
    pagesCaptured: number;
    scenariosRun: WebAuditScenario[];
    cmp: { detected: boolean; vendor?: string; rejectOnFirstLayer?: boolean };
    formsFound: number;
    consentCoverage: WebAuditCoverage;
    findingCounts: Record<AuditSeverity, number>;
  };
  notes: string[];
  captures: WebAuditCaptureSummary[];
  findings: WebAuditFinding[];
}

export type ParseResult =
  | { ok: true; report: WebAuditReport }
  | { ok: false; error: string };

const SEVERITIES: AuditSeverity[] = ["info", "low", "medium", "high", "critical"];
const CONFIDENCES: AuditConfidence[] = ["high", "medium", "low"];
const DOMAINS: WebAuditDomain[] = ["consent", "banner", "forms"];
const SCENARIOS: WebAuditScenario[] = ["ignore", "accept", "reject"];
const COVERAGES: WebAuditCoverage[] = ["runtime_only", "runtime_imported", "reconciled"];
const VERDICTS: WebAuditVerdict[] = [
  "compliant_looking",
  "needs_attention",
  "poor",
  "non_compliant",
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}
function num(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function oneOf<T extends string>(v: unknown, allowed: T[], dflt: T): T {
  return typeof v === "string" && (allowed as string[]).includes(v) ? (v as T) : dflt;
}

function normalizeFinding(raw: unknown, index: number): WebAuditFinding | null {
  if (!isObj(raw)) return null;
  const finding = str(raw.finding);
  if (!finding) return null; // a finding with no text is noise
  return {
    id: str(raw.id) || `finding_${index}`,
    domain: oneOf(raw.domain, DOMAINS, "consent"),
    severity: oneOf(raw.severity, SEVERITIES, "info"),
    confidence: oneOf(raw.confidence, CONFIDENCES, "medium"),
    finding,
    whyItMatters: str(raw.whyItMatters),
    suggestedFix: str(raw.suggestedFix),
    ...(Array.isArray(raw.evidence) && raw.evidence.length > 0
      ? { evidence: strArray(raw.evidence) }
      : {}),
    ...(typeof raw.page === "string" && raw.page ? { page: raw.page } : {}),
  };
}

function normalizeCapture(raw: unknown): WebAuditCaptureSummary | null {
  if (!isObj(raw)) return null;
  return {
    scenario: oneOf(raw.scenario, SCENARIOS, "ignore"),
    url: str(raw.url),
    httpStatus: typeof raw.httpStatus === "number" ? raw.httpStatus : null,
    trackerHits: num(raw.trackerHits),
    firingHits: num(raw.firingHits),
    consentEvents: num(raw.consentEvents),
    interactionClicked:
      typeof raw.interactionClicked === "boolean" ? raw.interactionClicked : null,
    notes: strArray(raw.notes),
  };
}

function emptyCounts(): Record<AuditSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

/**
 * Parse pasted/uploaded JSON into a WebAuditReport. Accepts a raw object, a JSON
 * string, or the full MCP tool envelope ({ content: [{ text }] }). Defensive:
 * coerces missing/optional fields and drops malformed findings rather than
 * throwing, but rejects input that plainly isn't a report.
 */
export function parseWebAuditReport(input: unknown): ParseResult {
  let value: unknown = input;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: "Paste a report to render." };
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: "That isn't valid JSON. Paste the full report output." };
    }
  }

  // Unwrap an MCP tool-result envelope: { content: [{ type:'text', text:'<json>' }] }
  if (isObj(value) && Array.isArray(value.content)) {
    const textPart = (value.content as unknown[]).find(
      (p) => isObj(p) && typeof p.text === "string",
    ) as { text: string } | undefined;
    if (textPart) {
      try {
        value = JSON.parse(textPart.text);
      } catch {
        return { ok: false, error: "The tool response did not contain a JSON report." };
      }
    }
  }

  if (!isObj(value)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  if (!Array.isArray(value.findings) && !isObj(value.summary)) {
    return {
      ok: false,
      error:
        "This doesn't look like a consent_compliance_audit report — expected fields like site, score, summary and findings.",
    };
  }

  const summaryRaw = isObj(value.summary) ? value.summary : {};
  const cmpRaw = isObj(summaryRaw.cmp) ? summaryRaw.cmp : {};
  const countsRaw = isObj(summaryRaw.findingCounts) ? summaryRaw.findingCounts : {};

  const findings = (Array.isArray(value.findings) ? value.findings : [])
    .map((f, i) => normalizeFinding(f, i))
    .filter((f): f is WebAuditFinding => f !== null);

  const captures = (Array.isArray(value.captures) ? value.captures : [])
    .map(normalizeCapture)
    .filter((c): c is WebAuditCaptureSummary => c !== null);

  // Prefer the report's own counts; fall back to counting findings.
  const findingCounts = emptyCounts();
  let countsProvided = false;
  for (const s of SEVERITIES) {
    if (typeof countsRaw[s] === "number") {
      findingCounts[s] = countsRaw[s] as number;
      countsProvided = true;
    }
  }
  if (!countsProvided) {
    for (const f of findings) findingCounts[f.severity] += 1;
  }

  const report: WebAuditReport = {
    site: str(value.site) || str(summaryRaw.site) || "(unknown site)",
    auditedAt: str(value.auditedAt),
    score: Math.max(0, Math.min(100, num(value.score, 0))),
    verdict: oneOf(value.verdict, VERDICTS, "needs_attention"),
    summary: {
      pagesCrawled: num(summaryRaw.pagesCrawled),
      pagesCaptured: num(summaryRaw.pagesCaptured),
      scenariosRun: Array.isArray(summaryRaw.scenariosRun)
        ? (summaryRaw.scenariosRun as unknown[])
            .map((s) => oneOf(s, SCENARIOS, "ignore"))
            .filter((s, i, a) => a.indexOf(s) === i)
        : [],
      cmp: {
        detected: cmpRaw.detected === true,
        ...(typeof cmpRaw.vendor === "string" ? { vendor: cmpRaw.vendor } : {}),
        ...(typeof cmpRaw.rejectOnFirstLayer === "boolean"
          ? { rejectOnFirstLayer: cmpRaw.rejectOnFirstLayer }
          : {}),
      },
      formsFound: num(summaryRaw.formsFound),
      consentCoverage: oneOf(summaryRaw.consentCoverage, COVERAGES, "runtime_only"),
      findingCounts,
    },
    notes: strArray(value.notes),
    captures,
    findings,
  };

  return { ok: true, report };
}
