import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  Play,
  UserCircle2,
  Upload,
  Sparkles,
  Download,
  X,
  Search,
  Tag,
  Zap,
  Variable,
  Layers,
  Activity,
  GitCompareArrows,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { SeverityChip } from "@/components/status-chip";
import { SelectorBlock, StatCard } from "@/components/gtm-selectors";
import {
  StateCard,
  EmptyRow,
  NotConnectedState,
  LoadingBlock,
  ErrorState,
  ToolFailureList,
  SectionHeader,
  StatusBadge,
  ConsentStatePills,
} from "@/components/common";
import { useGtmSelection } from "@/hooks/use-gtm-selection";
import { useRuntimeCapture } from "@/hooks/use-runtime-capture";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
// The synthetic sample capture (~6KB) is only needed when the user clicks
// "load/download sample", so it is imported dynamically inside those handlers
// instead of being bundled into the consent-v2 page chunk.
import type {
  ConsentAuditResponse,
  ConsentAuditResponseFinding,
  ConsentAuditLayer,
} from "@shared/portal-types";

const COVERAGE_LABEL: Record<ConsentAuditResponse["coverage"], string> = {
  config_only: "Config only",
  runtime_imported: "Runtime proof imported",
  reconciled: "Reconciled (config + runtime)",
};

const COVERAGE_TONE: Record<ConsentAuditResponse["coverage"], string> = {
  config_only: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  runtime_imported: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  reconciled: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
};

const LAYER_META: Record<
  ConsentAuditLayer,
  { label: string; hint: string; icon: typeof Layers }
> = {
  config: {
    label: "Config checks",
    hint: "Read from GTM configuration only (CONFIG source). Confirms consent intent is declared, not that it fires live.",
    icon: Layers,
  },
  runtime: {
    label: "Runtime checks",
    hint: "Observed in the imported runtime capture (RUNTIME source): live tag firing, dataLayer consent events and cookies under each declared state.",
    icon: Activity,
  },
  reconcile: {
    label: "Config + Runtime reconciliation",
    hint: "Configured consent intent reconciled against observed runtime behaviour. The strongest evidence level.",
    icon: GitCompareArrows,
  },
};

export default function ConsentV2Page() {
  const { oauth } = usePortal();

  const selection = useGtmSelection({ enabled: oauth.connected });
  const {
    accountId,
    containerId,
    workspaceId,
    setWorkspaceId,
    selectAccount,
    selectContainer,
    accountsQuery,
    containersQuery,
    workspacesQuery,
    containerPublicId,
  } = selection;

  const [result, setResult] = useState<ConsentAuditResponse | null>(null);

  // Group findings by layer once per result change instead of re-filtering the
  // full findings array three times on every render (config/runtime/reconcile).
  const findingsByLayer = useMemo(() => {
    const groups: Record<ConsentAuditLayer, ConsentAuditResponseFinding[]> = {
      config: [],
      runtime: [],
      reconcile: [],
    };
    for (const f of result?.findings ?? []) {
      (groups[f.layer] ??= []).push(f);
    }
    return groups;
  }, [result]);

  // Optional runtime proof import (RUNTIME source). Never fabricated — runtime
  // and reconciliation checks only activate when a parseable capture is loaded.
  const runtimeRef = useRef<HTMLDivElement | null>(null);
  const runtime = useRuntimeCapture(() =>
    runtimeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );

  const consentMutation = useMutation({
    mutationFn: () =>
      portalApi.runConsentAudit({
        accountId,
        containerId,
        workspaceId,
        containerPublicId,
        runtimeCapture: runtime.runtimeCapture ?? undefined,
      }),
    onSuccess: (data) => setResult(data),
  });

  const consentError = consentMutation.error as
    | (Error & { status?: number; code?: string })
    | null;
  const canRun = selection.canRun;
  const isLoading = consentMutation.isPending;
  const needsReconnect = consentError?.status === 401;

  // Reset a stale result when the selection changes.
  useEffect(() => {
    setResult(null);
    consentMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, containerId, workspaceId]);

  if (!oauth.connected) {
    return (
      <>
        <PageHeader
          eyebrow="Consent v2"
          title="Consent Mode v2 audit"
          description="Read-only verification of Google Consent Mode v2 — nothing else."
        />
        <PageBody>
          <NotConnectedState
            oauth={oauth}
            title="Connect Google Tag Manager to verify Consent Mode v2"
            description="This uses the Google Tag Manager API (read-only) to inspect the tags, triggers, and variables in the workspace you choose for Consent Mode v2 signals. Nothing is modified in GTM."
            testId="button-consent-connect-google"
          />
        </PageBody>
      </>
    );
  }

  const { accounts, containers, workspaces } = selection;

  const byLayer = (layer: ConsentAuditLayer): ConsentAuditResponseFinding[] =>
    findingsByLayer[layer] ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Consent v2"
        title="Consent Mode v2 audit"
        description="A focused, read-only check of Google Consent Mode v2 only. Config-only by default; import a runtime capture to prove live behaviour under denied / granted / partial states."
        actions={
          <>
            <Button
              asChild
              size="sm"
              variant="outline"
              data-testid="button-consent-profile"
              title={oauth.email ?? "Manage Google account"}
            >
              <Link href="/profile">
                <UserCircle2 className="mr-1.5 h-4 w-4" />
                <span className="max-w-[10rem] truncate">
                  {oauth.userName ?? oauth.email ?? "Account"}
                </span>
              </Link>
            </Button>
            <Button
              size="sm"
              onClick={() => consentMutation.mutate()}
              disabled={!canRun || isLoading}
              data-testid="button-run-consent"
            >
              {isLoading ? (
                <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" />
              )}
              {result ? "Re-run consent audit" : "Run consent audit"}
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Scope note: this section is consent-only. */}
        <div className="mb-5 flex items-start gap-2 rounded-md border border-primary/20 bg-primary/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            This section verifies <strong>Consent Mode v2 only</strong>. For the
            full GTM / GA4 / sGTM / naming audit, use the{" "}
            <Link
              href="/audit"
              className="text-primary underline-offset-2 hover:underline"
            >
              Audit
            </Link>{" "}
            page.
          </div>
        </div>

        {/* Selectors */}
        <Card className="mb-5">
          <CardContent className="py-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <SelectorBlock
                label="GTM Account"
                value={accountId}
                onChange={selectAccount}
                loading={accountsQuery.isLoading}
                error={accountsQuery.error as (Error & { status?: number }) | null}
                placeholder="Choose an account"
                options={accounts.map((a) => ({ value: a.accountId, label: a.name }))}
                testId="select-consent-account"
                onReconnect={() => portalApi.redirectToGoogleOAuth()}
              />
              <SelectorBlock
                label="Container"
                value={containerId}
                onChange={selectContainer}
                loading={containersQuery.isLoading}
                error={containersQuery.error as Error | null}
                placeholder="Choose a container"
                options={containers.map((c) => ({
                  value: c.containerId,
                  label: `${c.name} — ${c.publicId}`,
                }))}
                disabled={!accountId}
                testId="select-consent-container"
              />
              <SelectorBlock
                label="Workspace"
                value={workspaceId}
                onChange={setWorkspaceId}
                loading={workspacesQuery.isLoading}
                error={workspacesQuery.error as Error | null}
                placeholder="Choose a workspace"
                options={workspaces.map((w) => ({ value: w.workspaceId, label: w.name }))}
                disabled={!containerId}
                testId="select-consent-workspace"
              />
            </div>
            {result && (
              <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                <Badge variant="outline">{result.containerPublicId ?? containerPublicId}</Badge>
                <Badge variant="outline" className={`text-[10.5px] ${COVERAGE_TONE[result.coverage]}`}>
                  {COVERAGE_LABEL[result.coverage]}
                </Badge>
                {result.containerType && (
                  <Badge variant="outline" className="text-[11px]">
                    {result.containerType}
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  Generated {new Date(result.generatedAt).toLocaleString()}
                </span>
              </div>
            )}
            {result?.toolFailures && (
              <ToolFailureList
                title="Some reads failed — coverage may be incomplete:"
                failures={result.toolFailures}
              />
            )}
          </CardContent>
        </Card>

        {/* Runtime proof import (optional) */}
        <Card className="mb-5" ref={runtimeRef}>
          <CardContent className="py-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Upload className="h-3.5 w-3.5 text-primary" />
                Runtime proof
                <span className="font-normal text-muted-foreground">(RUNTIME source — optional)</span>
                {runtime.ready ? (
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
                    data-testid="input-consent-runtime-file"
                    onChange={(e) => runtime.onRuntimeFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                  onClick={runtime.loadSample}
                  data-testid="button-consent-runtime-sample"
                >
                  <Sparkles className="h-3 w-3" /> Use sample capture
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={runtime.downloadSample}
                  data-testid="button-consent-runtime-download"
                >
                  <Download className="h-3 w-3" /> Download example
                </button>
                {runtime.runtimeText ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => runtime.applyRuntimeText("")}
                    data-testid="button-consent-runtime-clear"
                  >
                    <X className="h-3 w-3" /> Clear
                  </button>
                ) : null}
              </div>
            </div>
            <Textarea
              value={runtime.runtimeText}
              onChange={(e) => runtime.applyRuntimeText(e.target.value)}
              placeholder='Paste a runtime capture artifact to prove Consent Mode v2 behaviour. Capture denied/granted/partial states, e.g. `node cli.mjs --url https://example.com --states default_denied,granted,analytics_granted_ads_denied`.'
              className="font-mono text-[11px] min-h-[80px]"
              data-testid="textarea-consent-runtime"
            />
            {runtime.runtimeError ? (
              <div className="text-[11px] text-destructive">{runtime.runtimeError}</div>
            ) : null}
            <div className="text-[11px] text-muted-foreground">
              Without a capture this audit is config-only — live tag/cookie
              behaviour under denied/granted states is <strong>not</strong>{" "}
              verified. The sample capture is synthetic demo data, not real audit
              evidence. Re-run after loading a capture to reconcile.
            </div>
          </CardContent>
        </Card>

        {/* Coverage + state summary */}
        {result && <ConsentSummary result={result} runtimeReady={runtime.ready} />}

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mt-5">
          <StatCard label="Tags" value={result?.counts.tags} icon={Tag} loading={isLoading} />
          <StatCard label="Triggers" value={result?.counts.triggers} icon={Zap} loading={isLoading} />
          <StatCard label="Variables" value={result?.counts.variables} icon={Variable} loading={isLoading} />
        </div>

        {/* Error */}
        {consentError && (
          <ErrorState
            title="Consent audit failed"
            message={consentError.message}
            showReconnect={needsReconnect}
          />
        )}

        {/* Findings by layer */}
        {isLoading ? (
          <LoadingBlock rows={3} className="mt-6" label="Running consent audit…" />
        ) : !result ? (
          <StateCard
            className="mt-6"
            description={
              canRun
                ? 'Ready to audit the selected workspace — press "Run consent audit" above.'
                : "Choose an account, container, and workspace, then run the consent audit."
            }
          />
        ) : result.findings.length === 0 ? (
          <StateCard
            className="mt-6"
            icon={CheckCircle2}
            tone="success"
            title="No Consent Mode v2 findings for the available sources."
          />
        ) : (
          <div className="mt-6 space-y-6">
            {(["config", "runtime", "reconcile"] as ConsentAuditLayer[]).map((layer) => (
              <LayerSection key={layer} layer={layer} findings={byLayer(layer)} runtimeReady={runtime.ready} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function ConsentSummary({
  result,
  runtimeReady,
}: {
  result: ConsentAuditResponse;
  runtimeReady: boolean;
}) {
  const hasRuntime = result.coverage !== "config_only";
  const sc = result.stateCoverage;
  const sev = result.severityCounts;
  return (
    <Card data-testid="card-consent-summary">
      <CardContent className="py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {hasRuntime ? (
            <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
          )}
          <Badge variant="outline" className={`text-[10.5px] ${COVERAGE_TONE[result.coverage]}`}>
            {COVERAGE_LABEL[result.coverage]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {result.findingCount} consent finding{result.findingCount === 1 ? "" : "s"}
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

        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Consent states proven by capture
          </div>
          <ConsentStatePills coverage={sc} />
        </div>

        {result.runtimeStates.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Captured states: {result.runtimeStates.join(", ")}
          </div>
        )}

        {!hasRuntime && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
            {runtimeReady
              ? "A runtime capture is loaded but it carries no usable consent states yet — re-run the audit to reconcile it."
              : "No runtime capture imported. Consent Mode v2 was checked from GTM configuration only — live behaviour under denied/granted states is NOT verified. Import a capture above to enable runtime proof and reconciliation."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LayerSection({
  layer,
  findings,
  runtimeReady,
}: {
  layer: ConsentAuditLayer;
  findings: ConsentAuditResponseFinding[];
  runtimeReady: boolean;
}) {
  const meta = LAYER_META[layer];
  const isRuntimeLayer = layer === "runtime" || layer === "reconcile";
  return (
    <div data-testid={`consent-layer-${layer}`}>
      <SectionHeader
        title={meta.label}
        hint={meta.hint}
        icon={meta.icon}
        count={findings.length}
      />
      {findings.length === 0 ? (
        <EmptyRow>
          {isRuntimeLayer && !runtimeReady
            ? "Not covered — import a runtime capture above to run these checks."
            : "No findings at this layer."}
        </EmptyRow>
      ) : (
        <div className="space-y-3">
          {findings.map((f) => (
            <ConsentFindingCard key={f.id} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConsentFindingCard({ f }: { f: ConsentAuditResponseFinding }) {
  const SOURCE_LABEL: Record<string, string> = { CONFIG: "Config", RUNTIME: "Runtime" };
  return (
    <Card data-testid={`card-consent-finding-${f.id}`}>
      <CardContent className="py-4">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={f.severity} />
              {f.sources.map((s) => (
                <Badge
                  key={s}
                  variant="outline"
                  className="text-[10.5px] border-sky-500/40 text-sky-700 dark:text-sky-300"
                  title={`Source: ${SOURCE_LABEL[s] ?? s}`}
                >
                  {SOURCE_LABEL[s] ?? s}
                </Badge>
              ))}
              {f.confidence && (
                <Badge variant="outline" className="text-[10.5px]">
                  Confidence: {f.confidence}
                </Badge>
              )}
              {f.effort && (
                <Badge variant="outline" className="text-[10.5px]">
                  Effort {f.effort}
                </Badge>
              )}
              {f.needsManualReview && (
                <Badge
                  variant="outline"
                  className="text-[11px] border-amber-400 text-amber-700 dark:text-amber-300"
                >
                  Needs manual review
                </Badge>
              )}
            </div>
            <h4 className="mt-1.5 text-sm font-semibold leading-snug">{f.finding}</h4>
            {f.entity && (f.entity.name || f.entity.id) && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Entity:{" "}
                <span className="font-mono">
                  {f.entity.name ?? "(unnamed)"}
                  {f.entity.id ? ` · ${f.entity.id}` : ""}
                  {f.entity.path ? ` · ${f.entity.path}` : ""}
                </span>
              </div>
            )}
            {f.parameter && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Parameter: <span className="font-mono">{f.parameter}</span>
              </div>
            )}
            {f.whyItMatters && (
              <div className="mt-1.5 text-xs">
                <span className="font-medium">Why it matters: </span>
                <span className="text-muted-foreground">{f.whyItMatters}</span>
              </div>
            )}
            {f.businessImpact && (
              <div className="mt-1 text-xs">
                <span className="font-medium">Business impact: </span>
                <span className="text-muted-foreground">{f.businessImpact}</span>
              </div>
            )}
            {f.affected && f.affected.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  Affected
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {f.affected.map((a, i) => (
                    <span
                      key={`${a}-${i}`}
                      className="font-mono text-[11px] px-2 py-0.5 rounded bg-muted text-muted-foreground"
                    >
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {f.evidence && f.evidence.length > 0 && (
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
            )}
            {f.suggestedFix && (
              <div className="mt-2.5 flex items-start gap-1.5 text-xs">
                <Search className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">Suggested fix: </span>
                  <span className="text-muted-foreground">{f.suggestedFix}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

