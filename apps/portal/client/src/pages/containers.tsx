import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Search,
  ExternalLink,
  PlugZap,
  RefreshCw,
  Boxes,
  Globe,
  Server,
  UserCircle2,
  AlertTriangle,
} from "lucide-react";
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
import { usePortal } from "@/lib/portal-store";
import { SOURCE_LABELS } from "@shared/portal-types";
import type {
  ContainerRecord,
  GtmAccountSummary,
  GtmContainerSummary,
} from "@shared/portal-types";

const USAGE_LABEL: Record<string, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  amp: "AMP",
  server: "Server",
};

function usageLabel(ctx?: string[]): string {
  if (!ctx || ctx.length === 0) return "—";
  return ctx.map((c) => USAGE_LABEL[c.toLowerCase()] ?? c).join(", ");
}

function isServer(ctx?: string[]): boolean {
  return (ctx ?? []).some((c) => c.toLowerCase() === "server");
}

function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ContainersPage() {
  const { oauth } = usePortal();

  const accountsQuery = useQuery({
    queryKey: ["/api/gtm/accounts"],
    queryFn: () => portalApi.listGtmAccounts(),
    enabled: oauth.connected,
    retry: false,
  });

  const accounts = accountsQuery.data ?? [];

  const containersQuery = useQuery({
    queryKey: ["/api/gtm/all-containers", accounts.map((a) => a.accountId).join(",")],
    queryFn: () => portalApi.listAllGtmContainers(accounts),
    enabled: oauth.connected && accounts.length > 0,
    retry: false,
  });

  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const accountById = useMemo(() => {
    const m = new Map<string, GtmAccountSummary>();
    for (const a of accounts) m.set(a.accountId, a);
    return m;
  }, [accounts]);

  const allContainers = containersQuery.data?.containers ?? [];
  const containerErrors = containersQuery.data?.errors ?? [];

  const filtered = useMemo<GtmContainerSummary[]>(() => {
    return allContainers.filter((c) => {
      const matchesAccount =
        accountFilter === "all" || c.accountId === accountFilter;
      if (!matchesAccount) return false;
      if (!query) return true;
      const acct = accountById.get(c.accountId);
      const haystack = [
        c.name,
        c.publicId,
        c.containerId,
        acct?.name ?? "",
        acct?.accountId ?? "",
        ...(c.domainName ?? []),
        ...(c.usageContext ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query.toLowerCase());
    });
  }, [allContainers, accountFilter, query, accountById]);

  // ── Not connected ───────────────────────────────────────────────────────
  if (!oauth.connected) {
    return (
      <>
        <PageHeader
          eyebrow="Inventory"
          title="Containers"
          description="Live Google Tag Manager containers from your connected Google account."
        />
        <PageBody>
          <Card>
            <CardContent className="py-10 px-5 text-center space-y-4">
              <div className="mx-auto h-11 w-11 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <PlugZap className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold">
                Connect Google Tag Manager to see your containers
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
                The portal reads your GTM accounts and containers using the
                Google Tag Manager API. We need your permission to list them —
                nothing is ever modified or published in GTM.
              </p>
              {oauth.configured === false ? (
                <p className="text-xs text-amber-600 dark:text-amber-400 max-w-md mx-auto">
                  {oauth.message ??
                    "Google OAuth credentials are not configured on this portal. Ask your administrator to set them up."}
                </p>
              ) : (
                <Button
                  size="lg"
                  className="min-h-11"
                  asChild
                  data-testid="button-containers-connect-google"
                >
                  <a href="/api/oauth/start">Connect Google Tag Manager</a>
                </Button>
              )}
            </CardContent>
          </Card>

          <SamarthRecordsSection />
        </PageBody>
      </>
    );
  }

  const accountsError = accountsQuery.error as
    | (Error & { status?: number })
    | null;
  const isLoading = accountsQuery.isLoading || containersQuery.isLoading;
  const noAccounts =
    !accountsQuery.isLoading && !accountsError && accounts.length === 0;

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Containers"
        description="Live Google Tag Manager containers from your connected Google account. Read-only."
        actions={
          <>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="min-h-9"
              data-testid="button-containers-profile"
              title={oauth.email ?? "Manage Google account"}
            >
              <Link href="/profile">
                <UserCircle2 className="mr-1.5 h-4 w-4" />
                <span className="max-w-[8rem] truncate">
                  {oauth.userName ?? oauth.email ?? "Account"}
                </span>
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-9"
              onClick={() => {
                accountsQuery.refetch();
                containersQuery.refetch();
              }}
              disabled={isLoading}
              data-testid="button-containers-refresh"
            >
              <RefreshCw
                className={`mr-1.5 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Live data banner */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="gap-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live Google GTM
          </Badge>
          {oauth.email && (
            <span className="text-xs text-muted-foreground truncate">
              {oauth.email}
            </span>
          )}
        </div>

        {/* Accounts error (session/permission) */}
        {accountsError && (
          <Card className="mb-4 border-destructive/40">
            <CardContent className="py-4 px-4 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-destructive">
                    Couldn’t load your GTM accounts
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 break-words">
                    {accountsError.message}
                  </div>
                  {(accountsError.status === 401 ||
                    accountsError.status === 403) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 min-h-9"
                      asChild
                    >
                      <a href="/api/oauth/start">Reconnect Google</a>
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty: connected but no GTM accounts */}
        {noAccounts && (
          <Card>
            <CardContent className="py-10 px-5 text-center space-y-3">
              <div className="mx-auto h-11 w-11 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
                <Boxes className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold">No GTM accounts found</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
                Your Google account is connected, but it doesn’t have access to
                any Google Tag Manager accounts. Ask an admin to grant your
                Google account access, then refresh.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Filters + content (only when we have accounts) */}
        {!accountsError && !noAccounts && (
          <>
            <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="input-search"
                  type="search"
                  inputMode="search"
                  placeholder="Search name, public ID, domain…"
                  className="pl-9 min-h-11 sm:min-h-10"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {accounts.length > 1 && (
                <Select value={accountFilter} onValueChange={setAccountFilter}>
                  <SelectTrigger
                    className="min-h-11 sm:min-h-10 sm:w-64"
                    data-testid="select-account"
                  >
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All accounts</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.accountId} value={a.accountId}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Per-account read errors (partial failures) */}
            {containerErrors.length > 0 && (
              <Card className="mb-4 border-amber-500/40">
                <CardContent className="py-3 px-4 text-xs">
                  <div className="font-medium text-amber-700 dark:text-amber-400 mb-1">
                    Some accounts couldn’t be read:
                  </div>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {containerErrors.map((e) => (
                      <li key={e.accountId}>
                        <span className="font-mono">
                          {accountById.get(e.accountId)?.name ?? e.accountId}
                        </span>
                        : {e.message}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Result count */}
            {!isLoading && (
              <div className="mb-3 text-xs text-muted-foreground">
                {filtered.length} container{filtered.length === 1 ? "" : "s"}
                {accounts.length > 0 && (
                  <>
                    {" "}
                    across {accounts.length} account
                    {accounts.length === 1 ? "" : "s"}
                  </>
                )}
              </div>
            )}

            {/* Desktop / wide-tablet table */}
            <Card className="hidden lg:block overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5">
                        Container
                      </th>
                      <th className="text-left font-medium px-4 py-2.5">
                        Account
                      </th>
                      <th className="text-left font-medium px-4 py-2.5">Type</th>
                      <th className="text-left font-medium px-4 py-2.5">
                        Domains
                      </th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {isLoading
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <tr key={i}>
                            <td className="px-4 py-3" colSpan={5}>
                              <Skeleton className="h-5 w-full" />
                            </td>
                          </tr>
                        ))
                      : filtered.map((c) => {
                          const acct = accountById.get(c.accountId);
                          return (
                            <tr
                              key={`${c.accountId}-${c.containerId}`}
                              data-testid={`row-container-${c.containerId}`}
                              className="hover:bg-muted/20"
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  {isServer(c.usageContext) ? (
                                    <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  ) : (
                                    <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  )}
                                  <div className="min-w-0">
                                    <div className="font-medium leading-tight truncate">
                                      {c.name}
                                    </div>
                                    <div className="font-mono text-[12px] text-muted-foreground tabular-nums">
                                      {c.publicId}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="leading-tight truncate max-w-[14rem]">
                                  {acct?.name ?? c.accountId}
                                </div>
                                <div className="text-[11px] text-muted-foreground font-mono">
                                  {c.accountId}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant="outline" className="text-[11px]">
                                  {usageLabel(c.usageContext)}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-xs text-muted-foreground max-w-[16rem] truncate">
                                {c.domainName && c.domainName.length > 0
                                  ? c.domainName.join(", ")
                                  : "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  asChild
                                  variant="ghost"
                                  size="sm"
                                  data-testid={`button-audit-${c.containerId}`}
                                >
                                  <Link
                                    href={`/audit?c=${encodeURIComponent(c.publicId)}`}
                                  >
                                    Audit{" "}
                                    <ExternalLink className="ml-1 h-3 w-3" />
                                  </Link>
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile + tablet cards (1 col mobile, 2 col tablet) */}
            <div className="lg:hidden grid grid-cols-1 sm:grid-cols-2 gap-3">
              {isLoading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-36 w-full rounded-lg" />
                  ))
                : filtered.map((c) => {
                    const acct = accountById.get(c.accountId);
                    return (
                      <Card
                        key={`${c.accountId}-${c.containerId}`}
                        data-testid={`card-container-${c.containerId}`}
                      >
                        <CardContent className="py-4 px-4">
                          <div className="flex items-start gap-2.5">
                            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                              {isServer(c.usageContext) ? (
                                <Server className="h-4 w-4" />
                              ) : (
                                <Globe className="h-4 w-4" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="font-medium leading-tight truncate">
                                {c.name}
                              </div>
                              <div className="font-mono text-xs text-muted-foreground tabular-nums mt-0.5">
                                {c.publicId}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 space-y-1 text-xs">
                            <div className="flex gap-1.5">
                              <span className="text-muted-foreground shrink-0">
                                Account:
                              </span>
                              <span className="truncate">
                                {acct?.name ?? c.accountId}
                              </span>
                            </div>
                            {c.domainName && c.domainName.length > 0 && (
                              <div className="flex gap-1.5">
                                <span className="text-muted-foreground shrink-0">
                                  Domains:
                                </span>
                                <span className="truncate">
                                  {c.domainName.join(", ")}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-[11px]">
                              {usageLabel(c.usageContext)}
                            </Badge>
                          </div>
                          <div className="mt-3">
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              className="w-full min-h-10"
                            >
                              <Link
                                href={`/audit?c=${encodeURIComponent(c.publicId)}`}
                              >
                                Open audit
                              </Link>
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
            </div>

            {!isLoading && filtered.length === 0 && (
              <Card className="p-8 text-center text-sm text-muted-foreground">
                {allContainers.length === 0
                  ? "No containers found in your GTM accounts."
                  : "No containers match the current filters."}
              </Card>
            )}
          </>
        )}

        <SamarthRecordsSection />
      </PageBody>
    </>
  );
}

// ── Optional reference section: non-live, sample/template inventory ─────────
function SamarthRecordsSection() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["/api/containers"],
    queryFn: () => portalApi.listContainers(),
    enabled: open,
  });

  const records = (data ?? []) as ContainerRecord[];

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        data-testid="button-toggle-samarth-records"
      >
        <Badge variant="outline" className="text-[10.5px] font-normal">
          Sample
        </Badge>
        Samarth records {open ? "▾" : "▸"}
      </button>
      <p className="text-xs text-muted-foreground mt-1.5 max-w-2xl">
        Template / sample inventory used for demos — not your live Google GTM
        containers above.
      </p>

      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full rounded-lg" />
              ))
            : records.map((c) => (
                <Card key={c.id} data-testid={`card-samarth-${c.id}`}>
                  <CardContent className="py-4 px-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{c.client}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.industry}
                        </div>
                        <div className="font-mono text-xs mt-1.5">
                          {c.containerId}
                        </div>
                      </div>
                      <HealthBadge score={c.healthScore} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Badge variant="outline">{SOURCE_LABELS[c.source]}</Badge>
                      <span className="text-muted-foreground ml-1">
                        Audit: {formatDate(c.lastAuditAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>
      )}
    </div>
  );
}
