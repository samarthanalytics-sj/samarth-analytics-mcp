import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, Filter, Upload, ExternalLink } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HealthBadge } from "@/components/status-chip";
import { portalApi } from "@/lib/portal-api";
import { SOURCE_LABELS } from "@shared/portal-types";
import type { ContainerRecord } from "@shared/portal-types";

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  amp: "AMP",
  server: "Server",
};

function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ContainersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/containers"],
    queryFn: () => portalApi.listContainers(),
  });

  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const filtered = useMemo<ContainerRecord[]>(() => {
    const list = data ?? [];
    return list.filter((c) => {
      const matchesQ =
        !query ||
        [c.client, c.containerId, c.industry, c.accountName, c.notes ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase());
      const matchesSource = sourceFilter === "all" || c.source === sourceFilter;
      return matchesQ && matchesSource;
    });
  }, [data, query, sourceFilter]);

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Containers"
        description="Mixed-source GTM container records pulled from Google, spreadsheets, CSV imports, and manual entry."
        actions={
          <Button variant="outline" size="sm" data-testid="button-import">
            <Upload className="mr-1.5 h-4 w-4" /> Import
          </Button>
        }
      />
      <PageBody>
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              data-testid="input-search"
              type="search"
              placeholder="Search client, industry, container ID…"
              className="pl-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="sm:w-56" data-testid="select-source">
              <Filter className="mr-1.5 h-4 w-4 text-muted-foreground" />
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Desktop table */}
        <Card className="hidden md:block overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Client</th>
                  <th className="text-left font-medium px-4 py-2.5">Container</th>
                  <th className="text-left font-medium px-4 py-2.5">Platform</th>
                  <th className="text-left font-medium px-4 py-2.5">Source</th>
                  <th className="text-left font-medium px-4 py-2.5">Health</th>
                  <th className="text-left font-medium px-4 py-2.5">Last audit</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        <td className="px-4 py-3" colSpan={7}>
                          <Skeleton className="h-5 w-full" />
                        </td>
                      </tr>
                    ))
                  : filtered.map((c) => (
                      <tr key={c.id} data-testid={`row-container-${c.id}`} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <div className="font-medium leading-tight">{c.client}</div>
                          <div className="text-xs text-muted-foreground">{c.industry}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[12.5px] tabular-nums">
                          {c.containerId}
                          <div className="text-[11px] text-muted-foreground font-sans">
                            {c.accountName}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="text-[11px]">
                            {PLATFORM_LABEL[c.platform] ?? c.platform}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {SOURCE_LABELS[c.source]}
                        </td>
                        <td className="px-4 py-3">
                          <HealthBadge score={c.healthScore} />
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatDate(c.lastAuditAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            data-testid={`button-audit-${c.id}`}
                          >
                            <Link href={`/audit?c=${encodeURIComponent(c.containerId)}`}>
                              Audit <ExternalLink className="ml-1 h-3 w-3" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))
            : filtered.map((c) => (
                <Card key={c.id} data-testid={`card-container-${c.id}`}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{c.client}</div>
                        <div className="text-xs text-muted-foreground">{c.industry}</div>
                        <div className="font-mono text-xs mt-1.5">{c.containerId}</div>
                      </div>
                      <HealthBadge score={c.healthScore} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Badge variant="outline">{PLATFORM_LABEL[c.platform] ?? c.platform}</Badge>
                      <Badge variant="outline">{SOURCE_LABELS[c.source]}</Badge>
                      <span className="text-muted-foreground ml-1">
                        Audit: {formatDate(c.lastAuditAt)}
                      </span>
                    </div>
                    <div className="mt-3">
                      <Button asChild size="sm" variant="outline" className="w-full">
                        <Link href={`/audit?c=${encodeURIComponent(c.containerId)}`}>
                          Open audit
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>

        {!isLoading && filtered.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No containers match the current filters.
          </Card>
        )}
      </PageBody>
    </>
  );
}
