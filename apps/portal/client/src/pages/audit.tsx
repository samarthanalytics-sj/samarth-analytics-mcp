import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Tag,
  Zap,
  Variable,
  Search,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  Play,
  PlugZap,
  UserCircle2,
  Upload,
  Server,
  BarChart3,
  X,
  Sparkles,
  Download,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { HealthBadge, SeverityChip } from "@/components/status-chip";
import { SelectorBlock, StatCard } from "@/components/gtm-selectors";
import { useGtmSelection } from "@/hooks/use-gtm-selection";
import { useRuntimeCapture } from "@/hooks/use-runtime-capture";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
// The synthetic sample capture (~6KB) is only needed when the user clicks
// "load/download sample", so it is imported dynamically inside those handlers
// instead of being bundled into the audit page chunk.
import type {
  AuditSummary,
  AuditCapabilityFlags,
  AuditCoverageItem,
  AuditFinding,
  GtmContainerSummary,
  GtmWorkspaceSummary,
} from "@shared/portal-types";

const CATEGORY_LABEL: Record<string, string> = {
  ga4: "GA4",
  consent: "Consent",
  pixels: "Pixels",
  ecommerce: "Ecommerce",
  server_side: "Server-side",
  performance: "Performance",
  naming: "Naming",
  duplication: "Duplication",
  data_layer: "Data layer",
  dead_config: "Dead config",
  data_quality: "Data quality",
  publishing: "Publishing",
  governance: "Governance",
  privacy: "Privacy",
  tool_failure: "Tool failure",
};

const SOURCE_LABEL: Record<string, string> = {
  CONFIG: "Config",
  RUNTIME: "Runtime",
  SGTM: "sGTM",
  GA4_ADMIN: "GA4 Admin",
  DATA_API: "GA4 Data API",
};

const COVERAGE_STYLES: Record<string, string> = {
  covered:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  partial:
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  not_covered:
    "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30",
};

const COVERAGE_LABEL: Record<string, string> = {
  covered: "Covered",
  partial: "Partial",
  not_covered: "Not Covered",
};

export default function AuditPage() {
  const { oauth } = usePortal();

  // Primary account → container → workspace cascade (auto-selects each tier).
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

  // GA4 property selection. "__auto__" = auto-match (default), "__none__" =
  // config-only, otherwise an explicit GA4 propertyId. Auto-match resolves the
  // GTM measurement ID against each property's data streams.
  // Radix <SelectItem> throws on an empty-string value, so the auto sentinel
  // must be a non-empty token.
  const AUTO = "__auto__";
  const NONE = "__none__";
  const [ga4Choice, setGa4Choice] = useState<string>(AUTO);
  const [autoMatchedId, setAutoMatchedId] = useState<string>("");
  const [autoMatchNote, setAutoMatchNote] = useState<string>("");

  // GA4 properties for the optional cross-source selector. Failures (e.g. the
  // analytics.readonly scope was never granted) must not block the audit — the
  // page degrades gracefully to CONFIG-only, so retry:false and errors are
  // swallowed at the boundary (portalApi.listGa4Properties returns []).
  const ga4PropertiesQuery = useQuery({
    queryKey: ["/api/ga4/properties"],
    queryFn: () => portalApi.listGa4Properties(),
    enabled: oauth.connected,
    retry: false,
  });
  const ga4Properties = ga4PropertiesQuery.data ?? [];

  const [audit, setAudit] = useState<AuditSummary | null>(null);

  // Anchors so the "Improve coverage" cards and the coverage-matrix action
  // buttons can scroll the relevant opt-in control into view.
  const crossSourceRef = useRef<HTMLDivElement | null>(null);
  const ga4SelectorRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = (ref: { current: HTMLElement | null }) =>
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  // ── Cross-source inputs (all strictly opt-in) ─────────────────────────────
  // RUNTIME: a pasted/uploaded runtime-worker (or CLI) capture artifact. We do
  // NOT fabricate runtime data — the audit only turns on RUNTIME when a
  // parseable capture is supplied here.
  const runtime = useRuntimeCapture(() => scrollTo(crossSourceRef));
  const runtimeCapture = runtime.runtimeCapture;

  // SGTM: an optional SERVER container/workspace to reconcile against. Off by
  // default; when no server context is chosen, SGTM stays Not Covered.
  const [serverEnabled, setServerEnabled] = useState<boolean>(false);
  const [serverAccountId, setServerAccountId] = useState<string>("");
  const [serverContainerId, setServerContainerId] = useState<string>("");
  const [serverWorkspaceId, setServerWorkspaceId] = useState<string>("");

  const serverContainersQuery = useQuery<GtmContainerSummary[]>({
    queryKey: ["/api/gtm/containers", serverAccountId, "sgtm"],
    queryFn: () => portalApi.listGtmContainers(serverAccountId),
    enabled: oauth.connected && serverEnabled && Boolean(serverAccountId),
    retry: false,
  });
  const serverWorkspacesQuery = useQuery<GtmWorkspaceSummary[]>({
    queryKey: [
      "/api/gtm/workspaces",
      serverAccountId,
      serverContainerId,
      "sgtm",
    ],
    queryFn: () =>
      portalApi.listGtmWorkspaces(serverAccountId, serverContainerId),
    enabled:
      oauth.connected &&
      serverEnabled &&
      Boolean(serverAccountId && serverContainerId),
    retry: false,
  });

  const hasServerContext = Boolean(
    serverEnabled &&
      serverAccountId &&
      serverContainerId &&
      serverWorkspaceId,
  );

  // DATA_API: opt-in GA4 reporting check. Only meaningful when a GA4 property
  // is being reconciled; the engine ignores it without a propertyId.
  const [enableDataApi, setEnableDataApi] = useState<boolean>(false);

  // Default the server account to the primary GTM account when the sGTM panel
  // is first enabled, then auto-select the first server container/workspace.
  useEffect(() => {
    if (serverEnabled && !serverAccountId && accountId) {
      setServerAccountId(accountId);
    }
  }, [serverEnabled, serverAccountId, accountId]);
  useEffect(() => {
    const list = serverContainersQuery.data ?? [];
    if (serverContainerId && !list.some((c) => c.containerId === serverContainerId)) {
      setServerContainerId("");
      setServerWorkspaceId("");
    }
  }, [serverContainersQuery.data, serverContainerId]);
  useEffect(() => {
    const list = serverWorkspacesQuery.data ?? [];
    if (serverWorkspaceId && !list.some((w) => w.workspaceId === serverWorkspaceId)) {
      setServerWorkspaceId("");
    }
    if (!serverWorkspaceId && list.length > 0) {
      setServerWorkspaceId(list[0].workspaceId);
    }
  }, [serverWorkspacesQuery.data, serverWorkspaceId]);

  // Resolve the effective GA4 property to reconcile against:
  // - explicit choice (a propertyId) wins,
  // - NONE → config-only (no GA4 reads),
  // - AUTO → the auto-matched property (resolved from GTM measurement IDs), or
  //   the single property when only one exists.
  const effectiveGa4PropertyId = useMemo(() => {
    if (ga4Choice === NONE) return undefined;
    if (ga4Choice && ga4Choice !== AUTO) return ga4Choice;
    if (autoMatchedId) return autoMatchedId;
    if (ga4Properties.length === 1) return ga4Properties[0].propertyId;
    return undefined;
  }, [ga4Choice, autoMatchedId, ga4Properties]);

  const auditMutation = useMutation({
    mutationFn: () =>
      portalApi.runLiveAudit({
        accountId,
        containerId,
        workspaceId,
        containerPublicId,
        ga4PropertyId: effectiveGa4PropertyId,
        runtimeCapture: runtimeCapture ?? undefined,
        serverContext: hasServerContext
          ? {
              accountId: serverAccountId,
              containerId: serverContainerId,
              workspaceId: serverWorkspaceId,
            }
          : undefined,
        enableDataApi:
          enableDataApi && Boolean(effectiveGa4PropertyId) ? true : undefined,
      }),
    onSuccess: (data) => setAudit(data),
  });

  const auditError = auditMutation.error as
    | (Error & { status?: number; code?: string })
    | null;
  const canRun = Boolean(accountId && containerId && workspaceId);
  const needsReconnect =
    auditError?.status === 401 || auditError?.code === "ga4_scope_missing";

  // Reset stale audit + GA4 auto-match on selection change.
  useEffect(() => {
    setAudit(null);
    setAutoMatchedId("");
    setAutoMatchNote("");
    auditMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, containerId, workspaceId]);

  // Auto-match: after a CONFIG run surfaces the GTM measurement IDs, find the
  // GA4 property whose data streams use one of them. Only runs when the user
  // left the selector on AUTO and more than one property is available (a
  // single property is matched directly in effectiveGa4PropertyId). Failures
  // are non-fatal — the selector simply stays unresolved.
  useEffect(() => {
    if (ga4Choice !== AUTO) return;
    if (autoMatchedId) return;
    if (ga4Properties.length < 2) return;
    const gtmIds = (audit?.gtmMeasurementIds ?? []).map((s) => s.toUpperCase());
    if (gtmIds.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const prop of ga4Properties) {
        if (cancelled) return;
        try {
          const streams = await portalApi.listGa4DataStreams(prop.propertyId);
          const hit = streams.find(
            (s) => s.measurementId && gtmIds.includes(s.measurementId.toUpperCase()),
          );
          if (hit && !cancelled) {
            setAutoMatchedId(prop.propertyId);
            setAutoMatchNote(
              `Auto-matched ${prop.displayName} via ${hit.measurementId}. Re-run to reconcile against GA4.`,
            );
            return;
          }
        } catch {
          // ignore per-property failures; keep scanning
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audit?.gtmMeasurementIds, ga4Properties, ga4Choice, autoMatchedId]);

  if (!oauth.connected) {
    return (
      <>
        <PageHeader
          eyebrow="Audit"
          title="Audit workspace"
          description="Read-only health checks across tags, triggers, and variables."
        />
        <PageBody>
          <Card>
            <CardContent className="py-10 text-center space-y-4">
              <div className="mx-auto h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <PlugZap className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold">Connect Google Tag Manager to run a live audit</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                The audit uses the Google Tag Manager API to read tags, triggers, and variables
                from the workspace you choose. Nothing is modified in GTM.
              </p>
              {oauth.configured === false ? (
                <p className="text-xs text-amber-600 dark:text-amber-400 max-w-md mx-auto">
                  {oauth.message ??
                    "Google OAuth credentials are not configured on this portal. Ask your administrator to set them up."}
                </p>
              ) : (
                <Button
                  size="sm"
                  onClick={() => portalApi.redirectToGoogleOAuth()}
                  data-testid="button-audit-connect-google"
                >
                  Connect Google Tag Manager
                </Button>
              )}
            </CardContent>
          </Card>
        </PageBody>
      </>
    );
  }

  const accounts = accountsQuery.data ?? [];
  const containers = containersQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const isLoading = auditMutation.isPending;

  // Shared actions wired into the "Improve coverage" panel and the coverage
  // matrix action buttons. Each one nudges an opt-in control — none of them
  // fabricate coverage; they only make the missing source easy to connect.
  const ga4ScopeMissing = ga4Properties.length === 0 && !ga4PropertiesQuery.isLoading;
  // Reconnect when the Analytics scope is missing, otherwise focus the GA4
  // selector (flipping it off NONE so a property can resolve). Returns true
  // when a property is already resolved, so callers can proceed.
  const focusGa4Selection = (): boolean => {
    if (effectiveGa4PropertyId) return true;
    if (ga4ScopeMissing) {
      portalApi.redirectToGoogleOAuth();
      return false;
    }
    if (ga4Choice === NONE) setGa4Choice(AUTO);
    scrollTo(ga4SelectorRef);
    return false;
  };
  const coverageActions: CoverageActions = {
    importRuntime: () => scrollTo(crossSourceRef),
    loadSampleRuntime: runtime.loadSample,
    selectGa4: () => {
      if (focusGa4Selection()) scrollTo(ga4SelectorRef);
    },
    enableDataApi: () => {
      if (!focusGa4Selection()) return;
      setEnableDataApi(true);
      scrollTo(crossSourceRef);
    },
    selectServerContainer: () => {
      setServerEnabled(true);
      scrollTo(crossSourceRef);
    },
    rerun: () => {
      if (canRun && !isLoading) auditMutation.mutate();
    },
    ga4ScopeMissing,
  };

  return (
    <>
      <PageHeader
        eyebrow="Audit"
        title="Audit workspace"
        description="Senior analytics auditor mode. Read-only, evidence-based QC across all available sources. Findings are tagged with their source — a clean config-only audit is not a clean audit overall."
        actions={
          <>
            <Button
              asChild
              size="sm"
              variant="outline"
              data-testid="button-audit-profile"
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
              onClick={() => auditMutation.mutate()}
              disabled={!canRun || isLoading}
              data-testid="button-run-audit"
            >
              {isLoading ? (
                <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" />
              )}
              {audit ? "Re-run audit" : "Run QC audit"}
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Selectors */}
        <Card className="mb-5">
          <CardContent className="py-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <SelectorBlock
                label="GTM Account"
                value={accountId}
                onChange={selectAccount}
                loading={accountsQuery.isLoading}
                error={accountsQuery.error as (Error & { status?: number }) | null}
                placeholder="Choose an account"
                options={accounts.map((a) => ({ value: a.accountId, label: a.name }))}
                testId="select-account"
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
                testId="select-container"
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
                testId="select-workspace"
              />
              <div className="min-w-0" ref={ga4SelectorRef}>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  GA4 property{" "}
                  <span className="text-muted-foreground/70 normal-case">(optional)</span>
                </div>
                <Select value={ga4Choice} onValueChange={setGa4Choice}>
                  <SelectTrigger data-testid="select-ga4-property">
                    <SelectValue
                      placeholder={
                        ga4PropertiesQuery.isLoading ? "Loading…" : "Auto-match"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>Auto-match (recommended)</SelectItem>
                    <SelectItem value={NONE}>None — config-only</SelectItem>
                    {ga4Properties
                      .filter((p) => Boolean(p.propertyId))
                      .map((p) => (
                        <SelectItem key={p.propertyId} value={p.propertyId}>
                          {p.displayName} — {p.accountName}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {ga4Choice === AUTO && autoMatchNote && (
                  <div className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                    {autoMatchNote}
                  </div>
                )}
                {ga4Choice === AUTO &&
                  !autoMatchNote &&
                  ga4Properties.length === 0 &&
                  !ga4PropertiesQuery.isLoading && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      No GA4 properties readable. Audit runs config-only. Reconnect
                      Google with the Analytics read-only scope to enable
                      cross-source checks.
                    </div>
                  )}
                {ga4Choice === AUTO &&
                  !autoMatchNote &&
                  ga4Properties.length > 1 &&
                  audit && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      No GA4 property auto-matched the GTM measurement IDs. Pick one
                      manually to reconcile.
                    </div>
                  )}
              </div>
            </div>
            {audit && (
              <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                <Badge variant="outline">{containerPublicId}</Badge>
                <HealthBadge score={audit.healthScore} />
                {audit.containerType && (
                  <Badge variant="outline" className="text-[11px]">
                    {audit.containerType}
                  </Badge>
                )}
                {typeof audit.workspaceCount === "number" && (
                  <Badge variant="outline" className="text-[11px]">
                    {audit.workspaceCount} workspace{audit.workspaceCount === 1 ? "" : "s"}
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  Generated {new Date(audit.generatedAt).toLocaleString()}
                </span>
              </div>
            )}
            {audit?.summary && (
              <div className="text-xs text-muted-foreground" data-testid="audit-summary">
                {audit.summary}
              </div>
            )}
            {audit?.toolFailures && audit.toolFailures.length > 0 && (
              <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded p-2">
                <div className="font-medium mb-1">
                  Some reads failed — the audit may be incomplete:
                </div>
                <ul className="list-disc ml-4 space-y-0.5">
                  {audit.toolFailures.map((tf, i) => (
                    <li key={`${tf.resource}-${i}`}>
                      <span className="font-mono">{tf.resource}</span>: {tf.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {audit?.capabilityFlags && (
              <CapabilityFlagsBar flags={audit.capabilityFlags} />
            )}
          </CardContent>
        </Card>

        {/* Cross-source inputs (opt-in) */}
        <div ref={crossSourceRef} className="scroll-mt-20">
        <CrossSourceInputs
          runtimeText={runtime.runtimeText}
          runtimeError={runtime.runtimeError}
          runtimeReady={runtime.ready}
          onRuntimeText={runtime.applyRuntimeText}
          onRuntimeFile={runtime.onRuntimeFile}
          onClearRuntime={() => runtime.applyRuntimeText("")}
          onLoadSample={runtime.loadSample}
          onDownloadSample={runtime.downloadSample}
          serverEnabled={serverEnabled}
          onToggleServer={setServerEnabled}
          serverAccountId={serverAccountId}
          onServerAccount={(v) => {
            setServerAccountId(v);
            setServerContainerId("");
            setServerWorkspaceId("");
          }}
          serverContainerId={serverContainerId}
          onServerContainer={(v) => {
            setServerContainerId(v);
            setServerWorkspaceId("");
          }}
          serverWorkspaceId={serverWorkspaceId}
          onServerWorkspace={setServerWorkspaceId}
          accounts={accounts}
          serverContainers={serverContainersQuery.data ?? []}
          serverWorkspaces={serverWorkspacesQuery.data ?? []}
          serverContainersLoading={serverContainersQuery.isLoading}
          serverWorkspacesLoading={serverWorkspacesQuery.isLoading}
          enableDataApi={enableDataApi}
          onToggleDataApi={setEnableDataApi}
          ga4Selected={Boolean(effectiveGa4PropertyId)}
        />
        </div>

        {audit?.executiveSummary && (
          <ExecutiveSummaryCard
            summary={audit.executiveSummary}
            audit={audit}
          />
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4">
          <StatCard label="Tags" value={audit?.counts.tags} icon={Tag} loading={isLoading} />
          <StatCard label="Triggers" value={audit?.counts.triggers} icon={Zap} loading={isLoading} />
          <StatCard
            label="Variables"
            value={audit?.counts.variables}
            icon={Variable}
            loading={isLoading}
          />
        </div>

        {/* Error */}
        {auditError && (
          <Card className="mt-5 border-destructive/40">
            <CardContent className="py-4 text-sm text-destructive">
              <div className="font-medium mb-1">Audit failed</div>
              <div className="text-xs">{auditError.message}</div>
              {needsReconnect && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => portalApi.redirectToGoogleOAuth()}
                >
                  Reconnect Google
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Heat map + maturity */}
        {audit?.heatMap && audit.heatMap.length > 0 && (
          <div className="mt-6">
            <SectionTitle title="Risk heat map" />
            <HeatMapTable heatMap={audit.heatMap} maturity={audit.domainMaturity} />
          </div>
        )}

        {/* Coverage matrix */}
        {audit?.coverageMatrix && audit.coverageMatrix.length > 0 && (
          <div className="mt-6">
            <SectionTitle
              title="Coverage matrix"
              hint="What each finding-domain needs to be fully covered. Items marked Not Covered are honest gaps, not software bugs — connect the listed source to close them."
            />
            <ImproveCoveragePanel
              items={audit.coverageMatrix}
              flags={audit.capabilityFlags}
              actions={coverageActions}
              runtimeReady={runtime.ready}
              serverEnabled={serverEnabled}
            />
            <CoverageMatrix items={audit.coverageMatrix} actions={coverageActions} />
          </div>
        )}

        {/* Consent Mode v2 proof */}
        {audit && (
          <div className="mt-6">
            <SectionTitle
              title="Consent Mode v2 proof"
              hint="Live consent behaviour is only claimed when a runtime capture is imported. Without one, this is a config-only inspection."
            />
            <ConsentProofCard
              consentAudit={audit.consentAudit}
              runtimeReady={runtime.ready}
            />
          </div>
        )}

        {/* Roadmap */}
        {audit?.roadmap && audit.roadmap.length > 0 && (
          <div className="mt-6">
            <SectionTitle title="Prioritized roadmap" />
            <div className="space-y-2">
              {audit.roadmap.map((r) => (
                <Card key={r.id}>
                  <CardContent className="py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <Badge
                        variant="outline"
                        className={
                          r.type === "quick_win"
                            ? "text-[10.5px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                            : "text-[10.5px] border-sky-500/40 text-sky-700 dark:text-sky-300"
                        }
                      >
                        {r.type === "quick_win" ? "Quick win" : "Structural"}
                      </Badge>
                      <Badge variant="outline" className="text-[10.5px]">
                        Effort {r.effort}
                      </Badge>
                      <span className="font-medium">{r.title}</span>
                    </div>
                    <div className="text-muted-foreground">{r.rationale}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Findings */}
        <div className="mt-7 flex items-end justify-between mb-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Findings
          </h3>
          {audit && (
            <span className="text-xs text-muted-foreground">
              {audit.findings.length} issue{audit.findings.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : !audit ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Choose an account, container, and workspace, then run the audit.
          </Card>
        ) : audit.findings.length === 0 ? (
          <Card className="p-8 text-center text-sm">
            <CheckCircle2 className="h-6 w-6 mx-auto text-emerald-500 mb-2" />
            Clean audit. No issues detected.
          </Card>
        ) : (
          <div className="space-y-3">
            {audit.findings.map((f) => (
              <FindingCard key={f.id} f={f} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function CrossSourceInputs(props: {
  runtimeText: string;
  runtimeError: string;
  runtimeReady: boolean;
  onRuntimeText: (v: string) => void;
  onRuntimeFile: (f: File | null) => void;
  onClearRuntime: () => void;
  onLoadSample: () => void;
  onDownloadSample: () => void;
  serverEnabled: boolean;
  onToggleServer: (v: boolean) => void;
  serverAccountId: string;
  onServerAccount: (v: string) => void;
  serverContainerId: string;
  onServerContainer: (v: string) => void;
  serverWorkspaceId: string;
  onServerWorkspace: (v: string) => void;
  accounts: { accountId: string; name: string }[];
  serverContainers: GtmContainerSummary[];
  serverWorkspaces: GtmWorkspaceSummary[];
  serverContainersLoading: boolean;
  serverWorkspacesLoading: boolean;
  enableDataApi: boolean;
  onToggleDataApi: (v: boolean) => void;
  ga4Selected: boolean;
}) {
  return (
    <Card className="mb-5">
      <CardContent className="py-4 space-y-4">
        <SectionTitle
          title="Cross-source inputs (optional)"
          hint="Each source is strictly opt-in. Without these, the audit is config-only and never claims runtime, server, or reported-data coverage."
        />

        {/* RUNTIME */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Upload className="h-3.5 w-3.5 text-primary" />
              Runtime capture
              <span className="font-normal text-muted-foreground">
                (RUNTIME source)
              </span>
              {props.runtimeReady && (
                <Badge
                  variant="outline"
                  className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                >
                  Loaded
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="cursor-pointer text-[11px] text-primary underline-offset-2 hover:underline">
                Upload JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  data-testid="input-runtime-file"
                  onChange={(e) =>
                    props.onRuntimeFile(e.target.files?.[0] ?? null)
                  }
                />
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                onClick={props.onLoadSample}
                data-testid="button-runtime-sample"
              >
                <Sparkles className="h-3 w-3" /> Use sample capture
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={props.onDownloadSample}
                data-testid="button-runtime-download-sample"
              >
                <Download className="h-3 w-3" /> Download example
              </button>
              {props.runtimeText && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={props.onClearRuntime}
                  data-testid="button-runtime-clear"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>
          <Textarea
            value={props.runtimeText}
            onChange={(e) => props.onRuntimeText(e.target.value)}
            placeholder='Paste a runtime-worker / CLI capture artifact (schema "samarth.runtime-capture/v2" or v3 multi-state). For Consent Mode v2 proof, capture denied/granted/partial states: `node cli.mjs --url https://example.com --states default_denied,granted,analytics_granted_ads_denied`.'
            className="font-mono text-[11px] min-h-[90px]"
            data-testid="textarea-runtime"
          />
          {props.runtimeError && (
            <div className="text-[11px] text-destructive">
              {props.runtimeError}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground space-y-0.5">
            <div>
              Generate a real single-page capture locally:{" "}
              <code className="font-mono bg-muted px-1 py-0.5 rounded">
                npm run runtime:capture -- --url https://yoursite.com --output capture.json
              </code>
            </div>
            <div>
              Multi-state / multi-page capture (denied vs granted consent) runs
              on the separately-hosted runtime worker (POST{" "}
              <span className="font-mono">/capture</span>). The sample capture is
              synthetic demo data — not real audit evidence.
            </div>
          </div>
        </div>

        {/* SGTM */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Server className="h-3.5 w-3.5 text-primary" />
              Server container
              <span className="font-normal text-muted-foreground">
                (SGTM source)
              </span>
            </div>
            <Switch
              checked={props.serverEnabled}
              onCheckedChange={props.onToggleServer}
              data-testid="switch-sgtm"
            />
          </div>
          {props.serverEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <SelectorBlock
                label="Server account"
                value={props.serverAccountId}
                onChange={props.onServerAccount}
                placeholder="Choose an account"
                options={props.accounts.map((a) => ({
                  value: a.accountId,
                  label: a.name,
                }))}
                testId="select-sgtm-account"
              />
              <SelectorBlock
                label="Server container"
                value={props.serverContainerId}
                onChange={props.onServerContainer}
                loading={props.serverContainersLoading}
                placeholder="Choose a container"
                options={props.serverContainers.map((c) => ({
                  value: c.containerId,
                  label: `${c.name} — ${c.publicId}`,
                }))}
                disabled={!props.serverAccountId}
                testId="select-sgtm-container"
              />
              <SelectorBlock
                label="Server workspace"
                value={props.serverWorkspaceId}
                onChange={props.onServerWorkspace}
                loading={props.serverWorkspacesLoading}
                placeholder="Choose a workspace"
                options={props.serverWorkspaces.map((w) => ({
                  value: w.workspaceId,
                  label: w.name,
                }))}
                disabled={!props.serverContainerId}
                testId="select-sgtm-workspace"
              />
            </div>
          )}
          {props.serverEnabled && (
            <div className="text-[11px] text-muted-foreground">
              Reconciles web GA4 transport against the selected server domain
              and surfaces server clients/transformations. If the chosen
              container is not a server container, SGTM stays Not Covered.
            </div>
          )}
        </div>

        {/* DATA_API */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <BarChart3 className="h-3.5 w-3.5 text-primary" />
              GA4 reported events
              <span className="font-normal text-muted-foreground">
                (DATA_API source)
              </span>
            </div>
            <Switch
              checked={props.enableDataApi}
              onCheckedChange={props.onToggleDataApi}
              disabled={!props.ga4Selected}
              data-testid="switch-data-api"
            />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {props.ga4Selected
              ? "Runs a read-only GA4 Data API report (last 7 days) to flag GTM-configured GA4 events with zero reported activity."
              : "Select a GA4 property above to enable the reported-events check."}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function ConsentProofCard({
  consentAudit,
  runtimeReady,
}: {
  consentAudit?: AuditSummary["consentAudit"];
  runtimeReady: boolean;
}) {
  const coverage = consentAudit?.coverage ?? "config_only";
  const coverageLabel =
    coverage === "reconciled"
      ? "Reconciled (config + runtime)"
      : coverage === "runtime_imported"
        ? "Runtime imported"
        : "Config only";
  const coverageTone =
    coverage === "reconciled"
      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
      : coverage === "runtime_imported"
        ? "border-sky-500/40 text-sky-700 dark:text-sky-300"
        : "border-amber-500/40 text-amber-700 dark:text-amber-300";

  const states = [
    { key: "denied" as const, label: "Denied" },
    { key: "granted" as const, label: "Granted" },
    { key: "partial" as const, label: "Partial" },
  ];
  const sc = consentAudit?.stateCoverage;
  const hasRuntime = coverage !== "config_only";

  return (
    <Card data-testid="card-consent-proof">
      <CardContent className="py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {hasRuntime ? (
            <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
          )}
          <Badge variant="outline" className={`text-[10.5px] ${coverageTone}`}>
            {coverageLabel}
          </Badge>
          {typeof consentAudit?.findingCount === "number" && (
            <span className="text-xs text-muted-foreground">
              {consentAudit.findingCount} consent finding
              {consentAudit.findingCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Consent states proven by capture
          </div>
          <div className="flex flex-wrap gap-1.5">
            {states.map((st) => {
              const on = Boolean(sc?.[st.key]);
              return (
                <span
                  key={st.key}
                  data-testid={`consent-state-${st.key}`}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                    on
                      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                      : "border-border/60 text-muted-foreground"
                  }`}
                >
                  {on ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  {st.label}
                </span>
              );
            })}
          </div>
        </div>

        {consentAudit?.runtimeStates && consentAudit.runtimeStates.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Captured states: {consentAudit.runtimeStates.join(", ")}
          </div>
        )}

        {!hasRuntime && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
            {runtimeReady
              ? "A runtime capture is loaded but it carries no usable consent states yet — re-run the audit to reconcile it."
              : "No runtime capture imported. Consent Mode v2 was checked from GTM configuration only — live tag/cookie behaviour under denied/granted states is NOT verified. Import a capture (runtime-worker POST /capture or `node cli.mjs --states default_denied,granted,analytics_granted_ads_denied`) above to enable runtime proof and reconciliation."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityFlagsBar({ flags }: { flags: AuditCapabilityFlags }) {
  const items: { key: keyof AuditCapabilityFlags; label: string }[] = [
    { key: "CONFIG", label: "Config" },
    { key: "RUNTIME", label: "Runtime" },
    { key: "SGTM", label: "sGTM" },
    { key: "GA4_ADMIN", label: "GA4 Admin" },
    { key: "DATA_API", label: "GA4 Data API" },
  ];
  return (
    <div className="pt-1.5 border-t border-border/50">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
        Active sources
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const on = Boolean(flags[it.key]);
          return (
            <span
              key={it.key}
              data-testid={`capability-${it.key}`}
              className={
                on
                  ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                  : "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium bg-muted text-muted-foreground border border-border"
              }
            >
              <span
                className={
                  on
                    ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                    : "h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                }
              />
              {it.label}
              <span className="opacity-60">{on ? "on" : "off"}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ExecutiveSummaryCard({
  summary,
  audit,
}: {
  summary: NonNullable<AuditSummary["executiveSummary"]>;
  audit: AuditSummary;
}) {
  const tone =
    summary.publishSafe === "yes"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : summary.publishSafe === "caution"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-rose-500/40 bg-rose-500/5";
  const label =
    summary.publishSafe === "yes"
      ? "Publish-safe (config)"
      : summary.publishSafe === "caution"
        ? "Proceed with caution"
        : "Not publish-safe";
  return (
    <Card className={`mt-5 ${tone}`}>
      <CardContent className="py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle title="Executive summary" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
              Overall maturity
            </div>
            <div className="font-mono text-2xl tabular-nums">
              {summary.overallMaturity}
              <span className="text-sm text-muted-foreground">/5</span>
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
              Publish safety
            </div>
            <div className="text-sm font-semibold">{label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {summary.publishSafeReason}
            </div>
          </div>
        </div>
        {summary.singleSourceWarning && (
          <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded p-2">
            {summary.singleSourceWarning}
          </div>
        )}
        {summary.topRisks.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
              Top risks
            </div>
            <ol className="space-y-1 text-xs list-decimal ml-4">
              {summary.topRisks.map((r) => (
                <li key={r.findingId}>
                  <span className="font-medium">{r.title}</span>{" "}
                  <SeverityChip severity={r.severity} />
                </li>
              ))}
            </ol>
          </div>
        )}
        {audit.domainMaturity && audit.domainMaturity.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground select-none">
              Maturity per domain
            </summary>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {audit.domainMaturity.map((d) => (
                <div
                  key={d.domain}
                  className="flex items-center justify-between rounded border border-border/60 px-2 py-1"
                >
                  <span>
                    {d.domain}
                    {d.capConfidence && (
                      <span
                        className="ml-1 text-[10px] text-amber-700 dark:text-amber-300"
                        title="Capped because a required source is not connected"
                      >
                        (capped)
                      </span>
                    )}
                  </span>
                  <span className="font-mono tabular-nums">{d.score}/5</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function HeatMapTable({
  heatMap,
  maturity,
}: {
  heatMap: NonNullable<AuditSummary["heatMap"]>;
  maturity?: AuditSummary["domainMaturity"];
}) {
  const matByDomain = new Map(
    (maturity ?? []).map((m) => [m.domain, m] as const),
  );
  return (
    <div className="overflow-x-auto rounded border border-border/60">
      <table className="min-w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th className="text-left px-2.5 py-1.5 font-medium">Domain</th>
            <th className="text-right px-2 py-1.5 font-medium">Critical</th>
            <th className="text-right px-2 py-1.5 font-medium">High</th>
            <th className="text-right px-2 py-1.5 font-medium">Medium</th>
            <th className="text-right px-2 py-1.5 font-medium">Low</th>
            <th className="text-right px-2.5 py-1.5 font-medium">Maturity</th>
          </tr>
        </thead>
        <tbody>
          {heatMap.map((row) => {
            const m = matByDomain.get(row.domain);
            return (
              <tr key={row.domain} className="border-t border-border/40">
                <td className="px-2.5 py-1.5">{row.domain}</td>
                <SevCell n={row.critical} tone="critical" />
                <SevCell n={row.high} tone="high" />
                <SevCell n={row.medium} tone="medium" />
                <SevCell n={row.low} tone="low" />
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                  {m ? `${m.score}/5` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SevCell({
  n,
  tone,
}: {
  n: number;
  tone: "critical" | "high" | "medium" | "low";
}) {
  const cls = !n
    ? "text-muted-foreground/50"
    : tone === "critical"
      ? "text-rose-700 dark:text-rose-300 font-semibold"
      : tone === "high"
        ? "text-orange-700 dark:text-orange-300 font-semibold"
        : tone === "medium"
          ? "text-amber-700 dark:text-amber-300"
          : "text-sky-700 dark:text-sky-300";
  return (
    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${cls}`}>
      {n || 0}
    </td>
  );
}

interface CoverageActions {
  importRuntime: () => void;
  loadSampleRuntime: () => void;
  selectGa4: () => void;
  enableDataApi: () => void;
  selectServerContainer: () => void;
  rerun: () => void;
  ga4ScopeMissing: boolean;
}

/**
 * A coverage-row id maps to one concrete next step. The action button on a
 * Not-Covered / Partial row triggers the matching opt-in control — it never
 * fabricates evidence, it just removes the friction of finding the right input.
 * `manual` rows (Meta Events Manager) have no in-portal action.
 */
type CoverageActionKind =
  | "runtime"
  | "ga4"
  | "data_api"
  | "sgtm"
  | "manual"
  | "config"
  | "none";

function coverageActionKind(it: AuditCoverageItem): CoverageActionKind {
  switch (it.id) {
    case "tag-firing-order":
    case "datalayer-pushes":
    case "consent-runtime":
    case "ecommerce-runtime":
      return "runtime";
    case "pixel-capi-dedup":
      return "manual";
    case "sgtm-clients":
      return "sgtm";
    case "ga4-admin-dimensions":
    case "ga4-admin-filters":
      return "ga4";
    case "ga4-data-api-events":
      return "data_api";
    case "cross-source-recon":
      // Multi-source row — route to whichever single source is missing first.
      if (!it.requires.includes("RUNTIME")) return "runtime";
      if (!it.requires.includes("SGTM")) return "sgtm";
      if (!it.requires.includes("GA4_ADMIN")) return "ga4";
      if (!it.requires.includes("DATA_API")) return "data_api";
      return "none";
    case "config-inventory":
    case "sgtm-server-config":
    case "sgtm-config-server-only":
      return "config";
    default:
      return "none";
  }
}

function CoverageActionButton({
  it,
  actions,
}: {
  it: AuditCoverageItem;
  actions: CoverageActions;
}) {
  if (it.status === "covered") return null;
  const kind = coverageActionKind(it);

  const btn = (label: string, onClick: () => void, testId: string) => (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-[11px] mt-1"
      onClick={onClick}
      data-testid={testId}
    >
      {label}
      <ArrowRight className="ml-1 h-3 w-3" />
    </Button>
  );

  switch (kind) {
    case "runtime":
      return btn(
        "Import runtime capture",
        actions.importRuntime,
        `coverage-action-${it.id}`,
      );
    case "ga4":
      return btn(
        actions.ga4ScopeMissing ? "Reconnect Google (Analytics)" : "Select GA4 property",
        actions.selectGa4,
        `coverage-action-${it.id}`,
      );
    case "data_api":
      return btn(
        "Enable GA4 Data API check",
        actions.enableDataApi,
        `coverage-action-${it.id}`,
      );
    case "sgtm":
      return (
        <div className="flex flex-wrap gap-1.5">
          {btn(
            "Select server container",
            actions.selectServerContainer,
            `coverage-action-${it.id}`,
          )}
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-7 text-[11px] mt-1"
          >
            <Link href="/server-side">
              Open Server-side
              <ExternalLink className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      );
    case "manual":
      return (
        <Badge
          variant="outline"
          className="mt-1 text-[10.5px] border-amber-500/40 text-amber-700 dark:text-amber-300"
        >
          Manual: Meta Events Manager required for final proof
        </Badge>
      );
    default:
      return null;
  }
}

function ImproveCoveragePanel({
  items,
  flags,
  actions,
  runtimeReady,
  serverEnabled,
}: {
  items: AuditCoverageItem[];
  flags?: AuditCapabilityFlags;
  actions: CoverageActions;
  runtimeReady: boolean;
  serverEnabled: boolean;
}) {
  const gapCount = items.filter((it) => it.status !== "covered").length;
  if (gapCount === 0) return null;

  const cards = [
    {
      key: "runtime",
      icon: Upload,
      title: "Runtime proof",
      on: Boolean(flags?.RUNTIME) || runtimeReady,
      body: "Import a runtime capture to prove live tag firing, dataLayer pushes, consent states and ecommerce shape.",
      primary: { label: "Import capture", onClick: actions.importRuntime },
      secondary: { label: "Use sample", onClick: actions.loadSampleRuntime },
      testId: "improve-runtime",
    },
    {
      key: "ga4",
      icon: BarChart3,
      title: "GA4 Admin / Data",
      on: Boolean(flags?.GA4_ADMIN),
      body: actions.ga4ScopeMissing
        ? "Reconnect Google with the Analytics read-only scope to read custom dimensions, filters and streams."
        : "Select a GA4 property to reconcile custom dimensions, data filters, retention and data streams.",
      primary: {
        label: actions.ga4ScopeMissing ? "Reconnect Google" : "Select property",
        onClick: actions.selectGa4,
      },
      secondary: { label: "Enable Data API", onClick: actions.enableDataApi },
      testId: "improve-ga4",
    },
    {
      key: "sgtm",
      icon: Server,
      title: "sGTM server context",
      on: Boolean(flags?.SGTM) || serverEnabled,
      body: "Select a server container/workspace to fold in clients, transformations and routing for reconciliation.",
      primary: {
        label: "Select server container",
        onClick: actions.selectServerContainer,
      },
      secondary: null,
      testId: "improve-sgtm",
    },
    {
      key: "meta",
      icon: ShieldAlert,
      title: "Meta Pixel ↔ CAPI",
      on: false,
      body: "Final Pixel/CAPI dedup proof is manual — confirm eventID dedup in Meta Events Manager (Test events).",
      primary: null,
      secondary: null,
      testId: "improve-meta",
    },
  ];

  return (
    <Card className="mb-3 border-primary/20 bg-primary/[0.02]">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-semibold">Improve coverage</div>
            <div className="text-[11px] text-muted-foreground">
              {gapCount} capabilit{gapCount === 1 ? "y is" : "ies are"} not yet
              fully covered. Connect the sources below — each step is read-only.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {cards.map((c) => (
            <div
              key={c.key}
              data-testid={c.testId}
              className="rounded-md border border-border/60 bg-background p-3 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2 text-xs font-medium">
                <c.icon className="h-3.5 w-3.5 text-primary" />
                {c.title}
                {c.on && (
                  <Badge
                    variant="outline"
                    className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                  >
                    Connected
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground flex-1">{c.body}</p>
              <div className="flex flex-wrap gap-1.5">
                {c.primary && (
                  <Button
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={c.primary.onClick}
                    data-testid={`${c.testId}-primary`}
                  >
                    {c.primary.label}
                  </Button>
                )}
                {c.secondary && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={c.secondary.onClick}
                    data-testid={`${c.testId}-secondary`}
                  >
                    {c.secondary.label}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground rounded-md bg-muted/40 border border-border/50 px-3 py-2">
          A config-only audit cannot be declared clean until runtime, sGTM and
          GA4 Admin/Data sources are connected or imported. That is expected —
          connect a source above and re-run to turn red rows amber/green.{" "}
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={actions.rerun}
            data-testid="improve-rerun"
          >
            Re-run audit
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function CoverageMatrix({
  items,
  actions,
}: {
  items: AuditCoverageItem[];
  actions: CoverageActions;
}) {
  return (
    <div className="overflow-x-auto rounded border border-border/60">
      <table className="min-w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th className="text-left px-2.5 py-1.5 font-medium">Capability</th>
            <th className="text-left px-2 py-1.5 font-medium">Requires</th>
            <th className="text-left px-2 py-1.5 font-medium">Status</th>
            <th className="text-left px-2.5 py-1.5 font-medium">Tool needed</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-t border-border/40 align-top">
              <td className="px-2.5 py-1.5">{it.capability}</td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap gap-1">
                  {it.requires.map((r) => (
                    <Badge key={r} variant="outline" className="text-[10.5px]">
                      {SOURCE_LABEL[r] ?? r}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="px-2 py-1.5">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${COVERAGE_STYLES[it.status]}`}
                >
                  {COVERAGE_LABEL[it.status]}
                </span>
              </td>
              <td className="px-2.5 py-1.5 text-muted-foreground">
                <div>{it.toolNeeded ?? "—"}</div>
                <CoverageActionButton it={it} actions={actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingCard({ f }: { f: AuditFinding }) {
  const headline = f.finding ?? f.title;
  const why = f.whyItMatters ?? f.description;
  const fix = f.suggestedFix ?? f.recommendation;
  const affected = (f.affected ?? f.affects) ?? [];
  const sources = f.sources ?? ["CONFIG"];
  const entity = f.entity;
  return (
    <Card data-testid={`card-finding-${f.id}`}>
      <CardContent className="py-4">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={f.severity} />
              <Badge variant="outline" className="text-[11px]">
                {CATEGORY_LABEL[f.category] ?? f.category}
              </Badge>
              {sources.map((s) => (
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
            <h4 className="mt-1.5 text-sm font-semibold leading-snug">{headline}</h4>
            {entity && (entity.name || entity.id) && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Entity:{" "}
                <span className="font-mono">
                  {entity.name ?? "(unnamed)"}
                  {entity.id ? ` · ${entity.id}` : ""}
                  {entity.path ? ` · ${entity.path}` : ""}
                </span>
              </div>
            )}
            {f.parameter && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Parameter: <span className="font-mono">{f.parameter}</span>
              </div>
            )}
            {why && (
              <div className="mt-1.5 text-xs">
                <span className="font-medium">Why it matters: </span>
                <span className="text-muted-foreground">{why}</span>
              </div>
            )}
            {f.businessImpact && (
              <div className="mt-1 text-xs">
                <span className="font-medium">Business impact: </span>
                <span className="text-muted-foreground">{f.businessImpact}</span>
              </div>
            )}
            {affected.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  Affected
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {affected.map((a, i) => (
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
            {fix && (
              <div className="mt-2.5 flex items-start gap-1.5 text-xs">
                <Search className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">Suggested fix: </span>
                  <span className="text-muted-foreground">{fix}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
