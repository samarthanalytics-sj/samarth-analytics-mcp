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
import type { AuditSummary } from "@shared/portal-types";

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
};

export default function AuditPage() {
  const { oauth } = usePortal();

  // Selectors
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

  const auditMutation = useMutation({
    mutationFn: () =>
      portalApi.runLiveAudit({
        accountId,
        containerId,
        workspaceId,
        containerPublicId,
      }),
    onSuccess: (data) => setAudit(data),
  });

  const auditError = auditMutation.error as (Error & { status?: number }) | null;
  const canRun = Boolean(accountId && containerId && workspaceId);

  // Reset stale audit on selection change
  useEffect(() => {
    setAudit(null);
    auditMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, containerId, workspaceId]);

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
        description="Live read-only health checks via the GTM API. Findings are diagnostic — no writes ever happen here."
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
            </div>
            {audit && (
              <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                <Badge variant="outline">{containerPublicId}</Badge>
                <HealthBadge score={audit.healthScore} />
                <span className="text-muted-foreground">
                  Generated {new Date(audit.generatedAt).toLocaleString()}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

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
              {auditError.status === 401 && (
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
              <Card key={f.id} data-testid={`card-finding-${f.id}`}>
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
                      </div>
                      <h4 className="mt-1.5 text-sm font-semibold leading-snug">{f.title}</h4>
                      <p className="text-xs text-muted-foreground mt-1">{f.description}</p>
                      {f.affects && f.affects.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {f.affects.map((a, i) => (
                            <span
                              key={`${a}-${i}`}
                              className="font-mono text-[11px] px-2 py-0.5 rounded bg-muted text-muted-foreground"
                            >
                              {a}
                            </span>
                          ))}
                        </div>
                      )}
                      {f.recommendation && (
                        <div className="mt-2.5 flex items-start gap-1.5 text-xs">
                          <Search className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                          <span>
                            <span className="font-medium">Recommendation: </span>
                            <span className="text-muted-foreground">{f.recommendation}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
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
