import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  Play,
  PlugZap,
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
import { Textarea } from "@/components/ui/textarea";
import { SeverityChip } from "@/components/status-chip";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
import { SAMPLE_RUNTIME_CAPTURE_JSON } from "@/lib/sample-runtime-capture";
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

  const [accountId, setAccountId] = useState<string>("");
  const [containerId, setContainerId] = useState<string>("");
  const [workspaceId, setWorkspaceId] = useState<string>("");

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

  // Auto-select the first available option at each tier.
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

  const [result, setResult] = useState<ConsentAuditResponse | null>(null);

  // Optional runtime proof import (RUNTIME source). Never fabricated — runtime
  // and reconciliation checks only activate when a parseable capture is loaded.
  const runtimeRef = useRef<HTMLDivElement | null>(null);
  const [runtimeText, setRuntimeText] = useState<string>("");
  const [runtimeCapture, setRuntimeCapture] = useState<unknown>(null);
  const [runtimeError, setRuntimeError] = useState<string>("");

  const applyRuntimeText = (text: string) => {
    setRuntimeText(text);
    setRuntimeError("");
    const trimmed = text.trim();
    if (!trimmed) {
      setRuntimeCapture(null);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") throw new Error("Not a JSON object");
      setRuntimeCapture(parsed);
    } catch (e) {
      setRuntimeCapture(null);
      setRuntimeError(e instanceof Error ? `Invalid JSON: ${e.message}` : "Invalid JSON");
    }
  };
  const onRuntimeFile = async (file: File | null) => {
    if (!file) return;
    try {
      applyRuntimeText(await file.text());
    } catch {
      setRuntimeError("Could not read that file.");
    }
  };
  const loadSampleRuntime = () => {
    applyRuntimeText(SAMPLE_RUNTIME_CAPTURE_JSON);
    runtimeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const downloadSampleRuntime = () => {
    if (typeof window === "undefined") return;
    const blob = new Blob([SAMPLE_RUNTIME_CAPTURE_JSON], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sample-runtime-capture.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const consentMutation = useMutation({
    mutationFn: () =>
      portalApi.runConsentAudit({
        accountId,
        containerId,
        workspaceId,
        containerPublicId,
        runtimeCapture: runtimeCapture ?? undefined,
      }),
    onSuccess: (data) => setResult(data),
  });

  const consentError = consentMutation.error as
    | (Error & { status?: number; code?: string })
    | null;
  const canRun = Boolean(accountId && containerId && workspaceId);
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
          <Card>
            <CardContent className="py-10 text-center space-y-4">
              <div className="mx-auto h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <PlugZap className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold">
                Connect Google Tag Manager to verify Consent Mode v2
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                This uses the Google Tag Manager API (read-only) to inspect the
                tags, triggers, and variables in the workspace you choose for
                Consent Mode v2 signals. Nothing is modified in GTM.
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
                  data-testid="button-consent-connect-google"
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

  const byLayer = (layer: ConsentAuditLayer): ConsentAuditResponseFinding[] =>
    (result?.findings ?? []).filter((f) => f.layer === layer);

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
                onChange={(v) => {
                  setAccountId(v);
                  setContainerId("");
                  setWorkspaceId("");
                }}
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
            {result?.toolFailures && result.toolFailures.length > 0 && (
              <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded p-2">
                <div className="font-medium mb-1">Some reads failed — coverage may be incomplete:</div>
                <ul className="list-disc ml-4 space-y-0.5">
                  {result.toolFailures.map((tf, i) => (
                    <li key={`${tf.resource}-${i}`}>
                      <span className="font-mono">{tf.resource}</span>: {tf.message}
                    </li>
                  ))}
                </ul>
              </div>
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
                {runtimeCapture ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                  >
                    Loaded
                  </Badge>
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
                    onChange={(e) => onRuntimeFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                  onClick={loadSampleRuntime}
                  data-testid="button-consent-runtime-sample"
                >
                  <Sparkles className="h-3 w-3" /> Use sample capture
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={downloadSampleRuntime}
                  data-testid="button-consent-runtime-download"
                >
                  <Download className="h-3 w-3" /> Download example
                </button>
                {runtimeText ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => applyRuntimeText("")}
                    data-testid="button-consent-runtime-clear"
                  >
                    <X className="h-3 w-3" /> Clear
                  </button>
                ) : null}
              </div>
            </div>
            <Textarea
              value={runtimeText}
              onChange={(e) => applyRuntimeText(e.target.value)}
              placeholder='Paste a runtime capture artifact to prove Consent Mode v2 behaviour. Capture denied/granted/partial states, e.g. `node cli.mjs --url https://example.com --states default_denied,granted,analytics_granted_ads_denied`.'
              className="font-mono text-[11px] min-h-[80px]"
              data-testid="textarea-consent-runtime"
            />
            {runtimeError ? (
              <div className="text-[11px] text-destructive">{runtimeError}</div>
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
        {result && <ConsentSummary result={result} runtimeReady={Boolean(runtimeCapture)} />}

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mt-5">
          <StatCard label="Tags" value={result?.counts.tags} icon={Tag} loading={isLoading} />
          <StatCard label="Triggers" value={result?.counts.triggers} icon={Zap} loading={isLoading} />
          <StatCard label="Variables" value={result?.counts.variables} icon={Variable} loading={isLoading} />
        </div>

        {/* Error */}
        {consentError && (
          <Card className="mt-5 border-destructive/40">
            <CardContent className="py-4 text-sm text-destructive">
              <div className="font-medium mb-1">Consent audit failed</div>
              <div className="text-xs">{consentError.message}</div>
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

        {/* Findings by layer */}
        {isLoading ? (
          <div className="space-y-3 mt-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : !result ? (
          <Card className="p-8 text-center text-sm text-muted-foreground mt-6">
            {canRun
              ? 'Ready to audit the selected workspace — press "Run consent audit" above.'
              : "Choose an account, container, and workspace, then run the consent audit."}
          </Card>
        ) : result.findings.length === 0 ? (
          <Card className="p-8 text-center text-sm mt-6">
            <CheckCircle2 className="h-6 w-6 mx-auto text-emerald-500 mb-2" />
            No Consent Mode v2 findings for the available sources.
          </Card>
        ) : (
          <div className="mt-6 space-y-6">
            {(["config", "runtime", "reconcile"] as ConsentAuditLayer[]).map((layer) => (
              <LayerSection key={layer} layer={layer} findings={byLayer(layer)} runtimeReady={Boolean(runtimeCapture)} />
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
  const states = [
    { key: "denied" as const, label: "Denied" },
    { key: "granted" as const, label: "Granted" },
    { key: "partial" as const, label: "Partial" },
  ];
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
                  {on ? <CheckCircle2 className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {st.label}
                </span>
              );
            })}
          </div>
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
  const Icon = meta.icon;
  const isRuntimeLayer = layer === "runtime" || layer === "reconcile";
  return (
    <div data-testid={`consent-layer-${layer}`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary shrink-0" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {meta.label}
        </h3>
        <Badge variant="outline" className="text-[10.5px] tabular-nums">
          {findings.length}
        </Badge>
      </div>
      <div className="text-[11px] text-muted-foreground mb-2">{meta.hint}</div>
      {findings.length === 0 ? (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          {isRuntimeLayer && !runtimeReady
            ? "Not covered — import a runtime capture above to run these checks."
            : "No findings at this layer."}
        </Card>
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
          {/* Radix <SelectItem> throws on an empty-string value; drop any
              option whose id is missing so a malformed API row can't crash
              the page. */}
          {options
            .filter((o) => Boolean(o.value))
            .map((o) => (
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
