import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Tag,
  Zap,
  Variable,
  Search,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  Play,
  PlugZap,
  UserCircle2,
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
import { HealthBadge, SeverityChip } from "@/components/status-chip";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
import type {
  AuditSummary,
  AuditCapabilityFlags,
  AuditCoverageItem,
  AuditFinding,
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

  // Selectors
  const [accountId, setAccountId] = useState<string>("");
  const [containerId, setContainerId] = useState<string>("");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  // GA4 property selection. "" = auto-match (default), "__none__" = config-only,
  // otherwise an explicit GA4 propertyId. Auto-match resolves the GTM
  // measurement ID against each property's data streams.
  const AUTO = "";
  const NONE = "__none__";
  const [ga4Choice, setGa4Choice] = useState<string>(AUTO);
  const [autoMatchedId, setAutoMatchedId] = useState<string>("");
  const [autoMatchNote, setAutoMatchNote] = useState<string>("");

  const accountsQuery = useQuery({
    queryKey: ["/api/gtm/accounts"],
    queryFn: () => portalApi.listGtmAccounts(),
    enabled: oauth.connected,
    retry: false,
  });

  const containersQuery = useQuery({
    queryKey: ["/api/gtm/containers", accountId],
    queryFn: () => portalApi.listGtmContainers(accountId),
    enabled: oauth.connected && Boolean(accountId),
    retry: false,
  });

  const workspacesQuery = useQuery({
    queryKey: ["/api/gtm/workspaces", accountId, containerId],
    queryFn: () => portalApi.listGtmWorkspaces(accountId, containerId),
    enabled: oauth.connected && Boolean(accountId && containerId),
    retry: false,
  });

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

  // Auto-select first available on each tier.
  useEffect(() => {
    const list = accountsQuery.data ?? [];
    if (!accountId && list.length > 0) setAccountId(list[0].accountId);
  }, [accountsQuery.data, accountId]);
  useEffect(() => {
    const list = containersQuery.data ?? [];
    if (containerId && !list.some((c) => c.containerId === containerId)) setContainerId("");
    if (!containerId && list.length > 0) setContainerId(list[0].containerId);
  }, [containersQuery.data, containerId]);
  useEffect(() => {
    const list = workspacesQuery.data ?? [];
    if (workspaceId && !list.some((w) => w.workspaceId === workspaceId)) setWorkspaceId("");
    if (!workspaceId && list.length > 0) setWorkspaceId(list[0].workspaceId);
  }, [workspacesQuery.data, workspaceId]);

  const containerPublicId = useMemo(() => {
    const c = (containersQuery.data ?? []).find((c) => c.containerId === containerId);
    return c?.publicId ?? containerId;
  }, [containersQuery.data, containerId]);

  const [audit, setAudit] = useState<AuditSummary | null>(null);

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
                onChange={(v) => {
                  setAccountId(v);
                  setContainerId("");
                  setWorkspaceId("");
                }}
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
                onChange={(v) => {
                  setContainerId(v);
                  setWorkspaceId("");
                }}
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
              <div className="min-w-0">
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
                    {ga4Properties.map((p) => (
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
              hint="What each finding-domain needs to be fully covered. Items marked Not Covered cannot be claimed clean."
            />
            <CoverageMatrix items={audit.coverageMatrix} />
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

function SelectorBlock({
  label,
  value,
  onChange,
  options,
  placeholder,
  loading,
  error,
  disabled,
  testId,
  onReconnect,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  loading?: boolean;
  error?: (Error & { status?: number }) | null;
  disabled?: boolean;
  testId?: string;
  onReconnect?: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <Select value={value} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger data-testid={testId}>
          <SelectValue placeholder={loading ? "Loading…" : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <div className="mt-1 space-y-1">
          <div className="text-[11px] text-destructive break-words">{error.message}</div>
          {error.status === 401 && onReconnect && (
            <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={onReconnect}>
              Reconnect Google
            </Button>
          )}
        </div>
      )}
      {!error && !loading && options.length === 0 && !disabled && (
        <div className="mt-1 text-[11px] text-muted-foreground">None available.</div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value?: number;
  icon: typeof Tag;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-3.5 md:py-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </div>
        <div className="mt-2 font-mono text-xl tabular-nums">
          {loading ? <Skeleton className="h-6 w-12" /> : value ?? 0}
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

function CapabilityFlagsBar({ flags }: { flags: AuditCapabilityFlags }) {
  const items: { key: keyof AuditCapabilityFlags; label: string }[] = [
    { key: "CONFIG", label: "Config" },
    { key: "RUNTIME", label: "Runtime" },
    { key: "SGTM", label: "sGTM" },
    { key: "GA4_ADMIN", label: "GA4 Admin" },
  ];
  return (
    <div className="pt-1.5 border-t border-border/50">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
        Active sources
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const on = flags[it.key];
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

function CoverageMatrix({ items }: { items: AuditCoverageItem[] }) {
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
                {it.toolNeeded ?? "—"}
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
