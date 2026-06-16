/**
 * Tests for the web-audit report parser (shared/web-audit-report.ts).
 * Run: tsx apps/portal/shared/__tests__/web-audit-report.node.test.ts
 */

import { parseWebAuditReport } from "../web-audit-report";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const goodReport = {
  site: "https://example.com",
  auditedAt: "2026-06-15T10:00:00.000Z",
  score: 72,
  verdict: "needs_attention",
  summary: {
    pagesCrawled: 4,
    pagesCaptured: 3,
    scenariosRun: ["ignore", "reject", "accept"],
    cmp: { detected: true, vendor: "OneTrust", rejectOnFirstLayer: false },
    formsFound: 2,
    consentCoverage: "reconciled",
    findingCounts: { critical: 1, high: 0, medium: 2, low: 0, info: 1 },
  },
  notes: ["GTM container ignored: ..."],
  captures: [
    {
      scenario: "ignore",
      url: "https://example.com/",
      httpStatus: 200,
      trackerHits: 7,
      firingHits: 3,
      consentEvents: 0,
      interactionClicked: null,
      notes: [],
    },
  ],
  findings: [
    {
      id: "banner_preconsent_fire_home",
      domain: "banner",
      severity: "critical",
      confidence: "high",
      finding: "Tracker fired before consent.",
      whyItMatters: "Consent must come first.",
      suggestedFix: "Gate tags behind consent.",
      evidence: ["[ga4] t+480ms https://..."],
      page: "https://example.com/",
    },
  ],
};

// ── happy path ──────────────────────────────────────────────────────────────
const r1 = parseWebAuditReport(goodReport);
check("object input parses", r1.ok);
if (r1.ok) {
  check("site preserved", r1.report.site === "https://example.com");
  check("score preserved", r1.report.score === 72);
  check("verdict preserved", r1.report.verdict === "needs_attention");
  check("coverage preserved", r1.report.summary.consentCoverage === "reconciled");
  check("cmp vendor preserved", r1.report.summary.cmp.vendor === "OneTrust");
  check("counts preserved", r1.report.summary.findingCounts.critical === 1 && r1.report.summary.findingCounts.info === 1);
  check("finding mapped", r1.report.findings.length === 1 && r1.report.findings[0].domain === "banner");
  check("finding evidence + page kept", Boolean(r1.report.findings[0].evidence?.length) && r1.report.findings[0].page === "https://example.com/");
  check("capture mapped", r1.report.captures.length === 1 && r1.report.captures[0].firingHits === 3);
  check("notes preserved", r1.report.notes.length === 1);
}

// ── JSON string input ───────────────────────────────────────────────────────
const r2 = parseWebAuditReport(JSON.stringify(goodReport));
check("json string input parses", r2.ok && r2.report.score === 72);

// ── MCP tool envelope ───────────────────────────────────────────────────────
const envelope = { content: [{ type: "text", text: JSON.stringify(goodReport) }] };
const r3 = parseWebAuditReport(envelope);
check("mcp envelope unwrapped", r3.ok && r3.report.site === "https://example.com");

// ── derives counts when absent ──────────────────────────────────────────────
const noCounts = {
  ...goodReport,
  summary: { ...goodReport.summary, findingCounts: undefined },
  findings: [
    goodReport.findings[0],
    { ...goodReport.findings[0], id: "x2", severity: "medium" },
  ],
};
const r4 = parseWebAuditReport(noCounts);
check("counts derived from findings", r4.ok && r4.report.summary.findingCounts.critical === 1 && r4.report.summary.findingCounts.medium === 1);

// ── drops malformed findings, coerces unknown enums ─────────────────────────
const messy = {
  site: "https://x.test",
  score: 999,
  findings: [
    { id: "a", domain: "weird", severity: "nope", confidence: "??", finding: "Real finding." },
    { id: "b", finding: "" }, // dropped (no text)
    "not an object", // dropped
  ],
};
const r5 = parseWebAuditReport(messy);
check("messy input parses", r5.ok);
if (r5.ok) {
  check("score clamped to 100", r5.report.score === 100);
  check("malformed findings dropped", r5.report.findings.length === 1);
  check("unknown domain → consent", r5.report.findings[0].domain === "consent");
  check("unknown severity → info", r5.report.findings[0].severity === "info");
  check("missing summary tolerated", r5.report.summary.consentCoverage === "runtime_only");
}

// ── rejections ──────────────────────────────────────────────────────────────
check("empty string rejected", !parseWebAuditReport("").ok);
check("invalid json rejected", !parseWebAuditReport("{ not json").ok);
check("number rejected", !parseWebAuditReport(42).ok);
check("unrelated object rejected", !parseWebAuditReport({ hello: "world" }).ok);
check("null rejected", !parseWebAuditReport(null).ok);

// ── report with only findings array (no summary) still accepted ─────────────
const r6 = parseWebAuditReport({ findings: [goodReport.findings[0]] });
check("findings-only accepted", r6.ok && r6.report.findings.length === 1);

console.log(`web-audit-report tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (passed < 25) {
  console.error(`expected at least 25 checks, got ${passed}`);
  process.exit(1);
}
