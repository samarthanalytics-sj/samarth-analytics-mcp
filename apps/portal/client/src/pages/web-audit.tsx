import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Globe,
  ShieldAlert,
  ShieldCheck,
  BadgeCheck,
  FileText,
  Upload,
  Sparkles,
  X,
  Search,
  CheckCircle2,
  Layers,
  FileSearch,
  MousePointerClick,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { SeverityChip, HealthBadge } from "@/components/status-chip";
import { StatCard } from "@/components/gtm-selectors";
import { StateCard, SectionHeader, StatusBadge, EmptyRow } from "@/components/common";
import {
  parseWebAuditReport,
  type WebAuditReport,
  type WebAuditFinding,
  type WebAuditDomain,
  type WebAuditCoverage,
  type WebAuditVerdict,
} from "@shared/web-audit-report";

const COVERAGE_LABEL: Record<WebAuditCoverage, string> = {
  runtime_only: "Runtime only",
  runtime_imported: "Runtime imported (no config intent)",
  reconciled: "Reconciled (config + runtime)",
};
const COVERAGE_TONE: Record<WebAuditCoverage, string> = {
  runtime_only: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  runtime_imported: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  reconciled: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
};

const VERDICT_META: Record<WebAuditVerdict, { label: string; tone: string }> = {
  compliant_looking: {
    label: "Compliant-looking",
    tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  },
  needs_attention: {
    label: "Needs attention",
    tone: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  },
  poor: { label: "Poor", tone: "border-orange-500/40 text-orange-700 dark:text-orange-300" },
  non_compliant: {
    label: "Non-compliant",
    tone: "border-rose-500/40 text-rose-700 dark:text-rose-300",
  },
};

const DOMAIN_META: Record<
  WebAuditDomain,
  { label: string; hint: string; icon: typeof Layers }
> = {
  banner: {
    label: "Consent banner behaviour",
    hint: "How the cookie/consent banner (CMP) actually behaves: tags firing before a choice, tags firing after Reject, tracking cookies set pre-consent, missing first-layer Reject.",
    icon: ShieldAlert,
  },
  consent: {
    label: "Consent Mode v2 engine",
    hint: "Findings from the shared Consent Mode v2 engine over the live capture — and reconciled against the GTM container when one was supplied.",
    icon: BadgeCheck,
  },
  forms: {
    label: "Forms & data collection",
    hint: "Form inventory privacy issues: pre-ticked marketing opt-ins, personal data collected without a notice, forms posting to third-party or insecure endpoints.",
    icon: FileText,
  },
};

const DOMAIN_ORDER: WebAuditDomain[] = ["banner", "consent", "forms"];

export default function WebAuditPage() {
  const [text, setText] = useState("");
  const [report, setReport] = useState<WebAuditReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  function apply(value: string) {
    setText(value);
    if (!value.trim()) {
      setReport(null);
      setParseError(null);
      return;
    }
    const res = parseWebAuditReport(value);
    if (res.ok) {
      setReport(res.report);
      setParseError(null);
    } else {
      setReport(null);
      setParseError(res.error);
    }
  }

  function onFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => apply(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  async function loadSample() {
    const { WEB_AUDIT_SAMPLE } = await import("@/lib/web-audit-sample");
    apply(JSON.stringify(WEB_AUDIT_SAMPLE, null, 2));
  }

  const findingsByDomain = useMemo(() => {
    const groups: Record<WebAuditDomain, WebAuditFinding[]> = {
      banner: [],
      consent: [],
      forms: [],
    };
    for (const f of report?.findings ?? []) (groups[f.domain] ??= []).push(f);
    return groups;
  }, [report]);

  return (
    <>
      <PageHeader
        eyebrow="Web Audit"
        title="Site & consent compliance"
        description="Render a consent_compliance_audit report from the web-audit MCP server: a site crawl, form inventory, consent-banner interaction and Consent Mode v2 compliance, scored 0–100."
        actions={
          text ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => apply("")}
              data-testid="button-web-audit-clear"
            >
              <X className="mr-1.5 h-4 w-4" />
              Clear
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {/* Scope note */}
        <div className="mb-5 flex items-start gap-2 rounded-md border border-primary/20 bg-primary/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
          <Globe className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            This renders a report produced by the{" "}
            <span className="font-mono">samarth-web-audit-mcp</span> server (which
            drives a real browser — it cannot run inside the portal). Generate one
            with the <span className="font-mono">consent_compliance_audit</span>{" "}
            tool, then paste or upload its JSON below. For a GTM-config audit, use
            the{" "}
            <Link
              href="/audit"
              className="text-primary underline-offset-2 hover:underline"
            >
              Audit
            </Link>{" "}
            page.
          </div>
        </div>

        {/* Report input */}
        <Card className="mb-5">
          <CardContent className="py-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Upload className="h-3.5 w-3.5 text-primary" />
                Audit report (JSON)
                {report ? (
                  <StatusBadge tone="success" pill={false}>
                    Loaded
                  </StatusBadge>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="cursor-pointer text-[11px] text-primary underline-offset-2 hover:underline">
                  Upload JSON
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    data-testid="input-web-audit-file"
                    onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                  onClick={loadSample}
                  data-testid="button-web-audit-sample"
                >
                  <Sparkles className="h-3 w-3" /> Use sample
                </button>
                {text ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => apply("")}
                    data-testid="button-web-audit-textclear"
                  >
                    <X className="h-3 w-3" /> Clear
                  </button>
                ) : null}
              </div>
            </div>
            <Textarea
              value={text}
              onChange={(e) => apply(e.target.value)}
              placeholder='Paste the JSON output of consent_compliance_audit, e.g. { "site": "https://example.com", "score": 72, "summary": { … }, "findings": [ … ] }. The full MCP tool envelope is accepted too.'
              className="font-mono text-[11px] min-h-[96px]"
              data-testid="textarea-web-audit"
            />
            {parseError ? (
              <div className="text-[11px] text-destructive" data-testid="text-web-audit-error">
                {parseError}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                Nothing is sent anywhere — the report is parsed and rendered
                locally in your browser.
              </div>
            )}
          </CardContent>
        </Card>

        {report ? (
          <WebAuditResult report={report} findingsByDomain={findingsByDomain} />
        ) : (
          <StateCard
            icon={FileSearch}
            description="Paste or upload a consent_compliance_audit report above to see the score, banner behaviour, form issues and Consent Mode v2 findings rendered here."
          />
        )}
      </PageBody>
    </>
  );
}

function WebAuditResult({
  report,
  findingsByDomain,
}: {
  report: WebAuditReport;
  findingsByDomain: Record<WebAuditDomain, WebAuditFinding[]>;
}) {
  const sev = report.summary.findingCounts;
  const verdict = VERDICT_META[report.verdict];
  const cmp = report.summary.cmp;
  const totalFindings = report.findings.length;

  return (
    <div className="space-y-5">
      {/* Summary header */}
      <Card data-testid="card-web-audit-summary">
        <CardContent className="py-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Globe className="h-4 w-4 text-primary shrink-0" />
              <span className="font-mono text-sm truncate" title={report.site}>
                {report.site}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <HealthBadge score={report.score} />
              <Badge variant="outline" className={`text-[10.5px] ${verdict.tone}`}>
                {verdict.label}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={`text-[10.5px] ${COVERAGE_TONE[report.summary.consentCoverage]}`}
              title="Reconciled coverage requires a GTM container export to be supplied to the audit."
            >
              {COVERAGE_LABEL[report.summary.consentCoverage]}
            </Badge>
            {cmp.detected ? (
              <StatusBadge tone="success" pill={false} icon={<ShieldCheck className="h-3 w-3" />}>
                CMP: {cmp.vendor ?? "detected"}
                {cmp.rejectOnFirstLayer === false ? " · no first-layer reject" : ""}
              </StatusBadge>
            ) : (
              <StatusBadge tone="warning" pill={false} icon={<ShieldAlert className="h-3 w-3" />}>
                No consent banner detected
              </StatusBadge>
            )}
            <span className="text-xs text-muted-foreground">
              {totalFindings} finding{totalFindings === 1 ? "" : "s"}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {(["critical", "high", "medium", "low", "info"] as const)
                .filter((s) => sev[s] > 0)
                .map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 text-[11px]">
                    <SeverityChip severity={s} />
                    <span className="tabular-nums text-muted-foreground">{sev[s]}</span>
                  </span>
                ))}
            </div>
          </div>

          {report.auditedAt ? (
            <div className="text-[11px] text-muted-foreground">
              Audited {new Date(report.auditedAt).toLocaleString()}
            </div>
          ) : null}

          {report.notes.length > 0 ? (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
              {report.notes.map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
        <StatCard label="Pages crawled" value={report.summary.pagesCrawled} icon={Globe} />
        <StatCard label="Pages captured" value={report.summary.pagesCaptured} icon={Layers} />
        <StatCard label="Forms found" value={report.summary.formsFound} icon={FileText} />
        <StatCard label="Findings" value={totalFindings} icon={Search} />
      </div>

      {/* Scenario captures */}
      {report.captures.length > 0 ? <ScenarioTable report={report} /> : null}

      {/* Findings by domain */}
      {totalFindings === 0 ? (
        <StateCard
          icon={CheckCircle2}
          tone="success"
          title="No compliance findings in this report."
        />
      ) : (
        <div className="space-y-6">
          {DOMAIN_ORDER.map((domain) => (
            <DomainSection key={domain} domain={domain} findings={findingsByDomain[domain] ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioTable({ report }: { report: WebAuditReport }) {
  return (
    <Card>
      <CardContent className="py-4">
        <SectionHeader
          title="Scenario captures"
          hint="Each page was loaded in an isolated browser context under a consent scenario; firing hits are measurement/marketing requests (script loads excluded)."
          icon={MousePointerClick}
          count={report.captures.length}
        />
        <div className="space-y-1.5">
          {report.captures.map((c, i) => (
            <div
              key={`${c.scenario}-${c.url}-${i}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-[11px]"
            >
              <Badge variant="outline" className="text-[10.5px] uppercase tracking-wide">
                {c.scenario}
              </Badge>
              <span className="font-mono text-muted-foreground truncate max-w-[16rem]" title={c.url}>
                {c.url}
              </span>
              {c.httpStatus !== null ? (
                <span className="text-muted-foreground">HTTP {c.httpStatus}</span>
              ) : null}
              <span className="text-muted-foreground tabular-nums">
                {c.firingHits} firing / {c.trackerHits} hits
              </span>
              <span className="text-muted-foreground tabular-nums">
                {c.consentEvents} consent event{c.consentEvents === 1 ? "" : "s"}
              </span>
              {c.interactionClicked === true ? (
                <StatusBadge tone="info" pill={false}>
                  banner clicked
                </StatusBadge>
              ) : c.interactionClicked === false ? (
                <StatusBadge tone="warning" pill={false}>
                  click failed
                </StatusBadge>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DomainSection({
  domain,
  findings,
}: {
  domain: WebAuditDomain;
  findings: WebAuditFinding[];
}) {
  const meta = DOMAIN_META[domain];
  return (
    <div data-testid={`web-audit-domain-${domain}`}>
      <SectionHeader title={meta.label} hint={meta.hint} icon={meta.icon} count={findings.length} />
      {findings.length === 0 ? (
        <EmptyRow>No findings in this area.</EmptyRow>
      ) : (
        <div className="space-y-3">
          {findings.map((f) => (
            <WebAuditFindingCard key={f.id} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function WebAuditFindingCard({ f }: { f: WebAuditFinding }) {
  return (
    <Card data-testid={`card-web-audit-finding-${f.id}`}>
      <CardContent className="py-4">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={f.severity} />
              <Badge variant="outline" className="text-[10.5px]">
                {DOMAIN_META[f.domain].label}
              </Badge>
              <Badge variant="outline" className="text-[10.5px]">
                Confidence: {f.confidence}
              </Badge>
            </div>
            <h4 className="mt-1.5 text-sm font-semibold leading-snug">{f.finding}</h4>
            {f.page ? (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Page: <span className="font-mono break-all">{f.page}</span>
              </div>
            ) : null}
            {f.whyItMatters ? (
              <div className="mt-1.5 text-xs">
                <span className="font-medium">Why it matters: </span>
                <span className="text-muted-foreground">{f.whyItMatters}</span>
              </div>
            ) : null}
            {f.evidence && f.evidence.length > 0 ? (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  Evidence
                </div>
                <ul className="space-y-0.5">
                  {f.evidence.map((e, i) => (
                    <li
                      key={`${e}-${i}`}
                      className="font-mono text-[11px] text-muted-foreground break-all"
                    >
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {f.suggestedFix ? (
              <div className="mt-2.5 flex items-start gap-1.5 text-xs">
                <Search className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">Suggested fix: </span>
                  <span className="text-muted-foreground">{f.suggestedFix}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
