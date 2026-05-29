import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Tag,
  Zap,
  Variable,
  Search,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
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

function useQueryParam(name: string): [string | null, (v: string) => void] {
  const [location, setLocation] = useLocation();
  const params = new URLSearchParams(location.split("?")[1] ?? "");
  const value = params.get(name);
  const set = (v: string) => {
    const sp = new URLSearchParams(location.split("?")[1] ?? "");
    sp.set(name, v);
    const base = location.split("?")[0];
    setLocation(`${base}?${sp.toString()}`);
  };
  return [value, set];
}

export default function AuditPage() {
  const { data: containers } = useQuery({
    queryKey: ["/api/containers"],
    queryFn: () => portalApi.listContainers(),
  });

  const [containerParam, setContainerParam] = useQueryParam("c");
  const [selected, setSelected] = useState<string>(containerParam ?? "GTM-N4VBT9C");

  useEffect(() => {
    if (containerParam && containerParam !== selected) setSelected(containerParam);
  }, [containerParam]);

  const { data: audit, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["/api/audit", selected],
    queryFn: () => portalApi.runAudit(selected),
    enabled: Boolean(selected),
  });

  const container = useMemo(
    () => containers?.find((c) => c.containerId === selected),
    [containers, selected],
  );

  return (
    <>
      <PageHeader
        eyebrow="Audit"
        title="Audit workspace"
        description="Health checks across tags, triggers, and variables. Findings are read-only — no GTM writes happen here."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-rerun-audit"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Re-run audit
          </Button>
        }
      />
      <PageBody>
        {/* Container picker + summary */}
        <Card className="mb-5">
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  Container
                </div>
                <Select
                  value={selected}
                  onValueChange={(v) => {
                    setSelected(v);
                    setContainerParam(v);
                  }}
                >
                  <SelectTrigger data-testid="select-container">
                    <SelectValue placeholder="Choose a container" />
                  </SelectTrigger>
                  <SelectContent>
                    {(containers ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.containerId}>
                        {c.client} — {c.containerId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {container && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">{container.industry}</Badge>
                  <Badge variant="outline" className="capitalize">{container.platform}</Badge>
                  <HealthBadge score={audit?.healthScore ?? container.healthScore} />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4">
          <StatCard
            label="Tags"
            value={audit?.counts.tags}
            icon={Tag}
            loading={isLoading}
          />
          <StatCard
            label="Triggers"
            value={audit?.counts.triggers}
            icon={Zap}
            loading={isLoading}
          />
          <StatCard
            label="Variables"
            value={audit?.counts.variables}
            icon={Variable}
            loading={isLoading}
          />
        </div>

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
        ) : audit && audit.findings.length === 0 ? (
          <Card className="p-8 text-center text-sm">
            <CheckCircle2 className="h-6 w-6 mx-auto text-emerald-500 mb-2" />
            Clean audit. No critical issues detected.
          </Card>
        ) : (
          <div className="space-y-3">
            {audit?.findings.map((f) => (
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
                      <h4 className="mt-1.5 text-sm font-semibold leading-snug">
                        {f.title}
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1">{f.description}</p>
                      {f.affects && f.affects.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {f.affects.map((a) => (
                            <span
                              key={a}
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
