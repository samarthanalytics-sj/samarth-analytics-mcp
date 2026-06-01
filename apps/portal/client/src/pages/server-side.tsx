import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ServerCog,
  RefreshCw,
  Play,
  PlugZap,
  UserCircle2,
  Boxes,
  Shuffle,
  LayoutGrid,
  Puzzle,
  Globe,
  Info,
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
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
import type { SgtmOverview } from "@shared/portal-types";

export default function ServerSidePage() {
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

  // Auto-select first available at each tier, preferring a server container.
  useEffect(() => {
    const list = accountsQuery.data ?? [];
    if (!accountId && list.length > 0) setAccountId(list[0].accountId);
  }, [accountsQuery.data, accountId]);
  useEffect(() => {
    const list = containersQuery.data ?? [];
    if (containerId && !list.some((c) => c.containerId === containerId)) {
      setContainerId("");
    }
    if (!containerId && list.length > 0) {
      const server = list.find((c) =>
        (c.usageContext ?? []).some((u) => u.toLowerCase() === "server"),
      );
      setContainerId((server ?? list[0]).containerId);
    }
  }, [containersQuery.data, containerId]);
  useEffect(() => {
    const list = workspacesQuery.data ?? [];
    if (workspaceId && !list.some((w) => w.workspaceId === workspaceId)) {
      setWorkspaceId("");
    }
    if (!workspaceId && list.length > 0) setWorkspaceId(list[0].workspaceId);
  }, [workspacesQuery.data, workspaceId]);

  const selectedContainer = useMemo(
    () => (containersQuery.data ?? []).find((c) => c.containerId === containerId),
    [containersQuery.data, containerId],
  );
  const selectedIsServer = useMemo(
    () =>
      (selectedContainer?.usageContext ?? []).some(
        (u) => u.toLowerCase() === "server",
      ),
    [selectedContainer],
  );

  const [overview, setOverview] = useState<SgtmOverview | null>(null);

  const overviewMutation = useMutation({
    mutationFn: () =>
      portalApi.getServerSideOverview({ accountId, containerId, workspaceId }),
    onSuccess: (data) => setOverview(data),
  });

  const overviewError = overviewMutation.error as
    | (Error & { status?: number; code?: string })
    | null;
  const canRun = Boolean(accountId && containerId && workspaceId);
  const needsReconnect = overviewError?.status === 401;

  // Reset stale results on selection change.
  useEffect(() => {
    setOverview(null);
    overviewMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, containerId, workspaceId]);

  if (!oauth.connected) {
    return (
      <>
        <PageHeader
          eyebrow="Server-side"
          title="Server-side GTM visibility"
          description="Read-only view of a server container's clients, transformations, and routing."
        />
        <PageBody>
          <Card>
            <CardContent className="py-10 text-center space-y-4">
              <div className="mx-auto h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <PlugZap className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold">
                Connect Google Tag Manager to inspect a server container
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Server-side visibility reads the clients, transformations, zones,
                templates and destinations of a GTM server container. Nothing is
                modified in GTM.
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
                  data-testid="button-sgtm-connect-google"
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
  const isLoading = overviewMutation.isPending;

  return (
    <>
      <PageHeader
        eyebrow="Server-side"
        title="Server-side GTM visibility"
        description="Read-only inspection of a GTM server container — clients with their claim paths, transformations, zones, templates, gtag config and linked destinations. Nothing is ever mutated."
        actions={
          <>
            <Button
              asChild
              size="sm"
              variant="outline"
              data-testid="button-sgtm-profile"
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
              onClick={() => overviewMutation.mutate()}
              disabled={!canRun || isLoading}
              data-testid="button-run-sgtm"
            >
              {isLoading ? (
                <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" />
              )}
              {overview ? "Refresh" : "Read server container"}
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
                testId="select-sgtm-account"
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
                  label: `${c.name} — ${c.publicId}${
                    (c.usageContext ?? []).some((u) => u.toLowerCase() === "server")
                      ? " (server)"
                      : ""
                  }`,
                }))}
                disabled={!accountId}
                testId="select-sgtm-container"
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
                testId="select-sgtm-workspace"
              />
            </div>
            {selectedContainer && (
              <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                <Badge variant="outline">{selectedContainer.publicId}</Badge>
                {(selectedContainer.usageContext ?? []).map((u) => (
                  <Badge
                    key={u}
                    variant="outline"
                    className={
                      u.toLowerCase() === "server"
                        ? "text-[11px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                        : "text-[11px]"
                    }
                  >
                    {u}
                  </Badge>
                ))}
                {!selectedIsServer && (
                  <span className="text-amber-600 dark:text-amber-400">
                    Not a server container
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Web/none explanation — shown before a run when selection is not server. */}
        {!isLoading && !overview && selectedContainer && !selectedIsServer && (
          <NotServerNotice />
        )}

        {/* Error */}
        {overviewError && (
          <Card className="mb-5 border-destructive/40">
            <CardContent className="py-4 text-sm text-destructive">
              <div className="font-medium mb-1">Could not read server container</div>
              <div className="text-xs">{overviewError.message}</div>
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

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : !overview ? (
          selectedIsServer || !selectedContainer ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Choose a server account, container, and workspace, then read the
              server container.
            </Card>
          ) : null
        ) : overview.isServer === false ? (
          <NotServerNotice message={overview.message} />
        ) : (
          <ServerOverview overview={overview} />
        )}
      </PageBody>
    </>
  );
}

function NotServerNotice({ message }: { message?: string }) {
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardContent className="py-6 space-y-3">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
            <Globe className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              This is not a server-side container
            </h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
              {message ??
                "Server-side (sGTM) visibility requires selecting a GTM server container and one of its workspaces. The selected container is a web/app container, which has no clients, transformations, or routing to inspect here."}
            </p>
            <p className="text-xs text-muted-foreground mt-2 max-w-2xl">
              Pick a container whose usage context includes{" "}
              <span className="font-mono">server</span> from the selector above,
              or run the standard{" "}
              <Link href="/audit" className="text-primary underline">
                Audit
              </Link>{" "}
              for web/app containers.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ServerOverview({ overview }: { overview: SgtmOverview }) {
  const clients = overview.clients ?? [];
  const transformations = overview.transformations ?? [];
  const zones = overview.zones ?? [];
  const templates = overview.templates ?? [];
  const gtagConfig = overview.gtagConfig ?? [];
  const destinations = overview.destinations ?? [];
  const failures = overview.failures ?? [];

  return (
    <div className="space-y-5">
      {/* Honest gaps banner. */}
      {failures.length > 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded p-2">
          <div className="font-medium mb-1 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5" />
            Some server reads failed — this view may be incomplete:
          </div>
          <ul className="list-disc ml-4 space-y-0.5">
            {failures.map((tf, i) => (
              <li key={`${tf.resource}-${i}`}>
                <span className="font-mono">{tf.resource}</span>: {tf.message}
                {typeof tf.status === "number" ? ` (${tf.status})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Counts */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Clients" value={clients.length} icon={Boxes} />
        <StatCard label="Transforms" value={transformations.length} icon={Shuffle} />
        <StatCard label="Zones" value={zones.length} icon={LayoutGrid} />
        <StatCard label="Templates" value={templates.length} icon={Puzzle} />
        <StatCard label="gtag config" value={gtagConfig.length} icon={ServerCog} />
        <StatCard label="Destinations" value={destinations.length} icon={Globe} />
      </div>

      {/* Clients with claims */}
      <Section title="Clients" count={clients.length} icon={Boxes}>
        {clients.length === 0 ? (
          <EmptyRow text="No clients readable on this server container." />
        ) : (
          <div className="space-y-2">
            {clients.map((c) => (
              <Card key={c.clientId ?? c.name} data-testid={`sgtm-client-${c.clientId}`}>
                <CardContent className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{c.name}</span>
                    {c.type && (
                      <Badge variant="outline" className="text-[10.5px]">
                        {c.type}
                      </Badge>
                    )}
                    {typeof c.priority === "number" && (
                      <Badge variant="outline" className="text-[10.5px]">
                        priority {c.priority}
                      </Badge>
                    )}
                    {c.clientId && (
                      <span className="text-[11px] text-muted-foreground font-mono">
                        #{c.clientId}
                      </span>
                    )}
                  </div>
                  {c.claims.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                        Claim paths / criteria
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {c.claims.map((cl, i) => (
                          <div
                            key={`${cl.key}-${i}`}
                            className="flex items-baseline gap-1.5 rounded border border-border/60 px-2 py-1 text-[11px]"
                          >
                            <span className="font-medium text-muted-foreground">
                              {cl.key}
                            </span>
                            <span className="font-mono break-all">{cl.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      {/* Transformations */}
      <Section title="Transformations" count={transformations.length} icon={Shuffle}>
        {transformations.length === 0 ? (
          <EmptyRow text="No transformations on this server container." />
        ) : (
          <SimpleTable
            rows={transformations.map((t) => ({
              id: t.transformationId,
              name: t.name,
              meta: t.type,
            }))}
          />
        )}
      </Section>

      {/* Zones */}
      {zones.length > 0 && (
        <Section title="Zones" count={zones.length} icon={LayoutGrid}>
          <SimpleTable rows={zones.map((z) => ({ id: z.zoneId, name: z.name }))} />
        </Section>
      )}

      {/* Templates */}
      {templates.length > 0 && (
        <Section title="Templates" count={templates.length} icon={Puzzle}>
          <SimpleTable
            rows={templates.map((t) => ({
              id: t.templateId,
              name: t.name,
              meta: t.gallery,
            }))}
          />
        </Section>
      )}

      {/* gtag config */}
      {gtagConfig.length > 0 && (
        <Section title="gtag config" count={gtagConfig.length} icon={ServerCog}>
          <SimpleTable
            rows={gtagConfig.map((g) => ({
              id: g.gtagConfigId,
              name: g.tagId ?? g.type ?? "(config)",
              meta: g.type,
            }))}
          />
        </Section>
      )}

      {/* Destinations */}
      {destinations.length > 0 && (
        <Section title="Destinations" count={destinations.length} icon={Globe}>
          <SimpleTable
            rows={destinations.map((d) => ({ id: d.destinationId, name: d.name ?? d.destinationId }))}
          />
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  icon: Icon,
  children,
}: {
  title: string;
  count: number;
  icon: typeof Boxes;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        <span className="text-xs text-muted-foreground">({count})</span>
      </div>
      {children}
    </div>
  );
}

function SimpleTable({
  rows,
}: {
  rows: { id?: string; name?: string; meta?: string }[];
}) {
  return (
    <div className="overflow-x-auto rounded border border-border/60">
      <table className="min-w-full text-xs">
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.id ?? r.name}-${i}`} className="border-t border-border/40 first:border-t-0">
              <td className="px-2.5 py-1.5">{r.name ?? "(unnamed)"}</td>
              {r.meta ? (
                <td className="px-2 py-1.5 text-muted-foreground">{r.meta}</td>
              ) : (
                <td className="px-2 py-1.5" />
              )}
              <td className="px-2.5 py-1.5 text-right font-mono text-muted-foreground">
                {r.id ? `#${r.id}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <Card className="p-4 text-center text-xs text-muted-foreground">{text}</Card>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Boxes;
}) {
  return (
    <Card>
      <CardContent className="py-3.5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </div>
        <div className="mt-2 font-mono text-xl tabular-nums">{value}</div>
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
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
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
