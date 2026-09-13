import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  ClipboardCheck,
  Sparkles,
  GitPullRequest,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandLogo } from "@/components/brand-logo";
import { ApprovalStatusChip, HealthBadge } from "@/components/status-chip";
import { PageBody } from "@/components/page-header";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
import { useToast } from "@/hooks/use-toast";

const STEPS = [
  {
    icon: ShieldCheck,
    title: "Connect Google Tag Manager",
    body: "Sign in with Google. Samarth hosts the OAuth flow so customers never deal with credentials.",
  },
  {
    icon: ClipboardCheck,
    title: "Audit tracking",
    body: "Run a health audit across tags, triggers, variables. Surface duplicates, missing consent, broken events.",
  },
  {
    icon: Sparkles,
    title: "Build an implementation plan",
    body: "Pick a goal — GA4 ecommerce, Consent Mode, Meta CAPI — and generate a draft change plan.",
  },
  {
    icon: GitPullRequest,
    title: "Submit for Samarth approval",
    body: "Nothing publishes until Samarth reviews. Status chips track draft → review → approved → published.",
  },
];

export default function OverviewPage() {
  const { oauth, setOAuth, approvals } = usePortal();
  const { toast } = useToast();

  const { data: containers, isLoading } = useQuery({
    queryKey: ["/api/containers"],
    queryFn: () => portalApi.listContainers(),
  });

  const containerCount = containers?.length ?? 0;
  const avgHealth = containers && containers.length > 0
    ? Math.round(
        containers.reduce((sum, c) => sum + c.healthScore, 0) / containers.length,
      )
    : 0;
  const pendingCount = approvals.filter((a) => a.status === "pending_review").length;
  const issuesCount = (containers ?? []).filter((c) => c.healthScore < 60).length;

  return (
    <PageBody>
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/5 via-background to-background p-6 md:p-10">
        <div className="absolute -right-24 -top-24 w-72 h-72 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -left-24 -bottom-24 w-72 h-72 bg-amber-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-3xl">
          <Badge variant="outline" className="mb-4 gap-1.5 border-primary/30 text-primary">
            <BrandLogo size={14} showWordmark={false} />
            White-label GTM Portal
          </Badge>
          <h2 className="text-xl md:text-xl font-semibold tracking-tight leading-tight">
            A safer way to operate Google Tag Manager.
          </h2>
          <p className="mt-3 text-sm md:text-base text-muted-foreground max-w-2xl">
            Audit tracking, prepare clean change requests, and route every publish through expert
            review — with 15 years of Samarth Analytics craft built in.
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            {oauth.connected ? (
              <Button asChild size="sm" data-testid="button-go-containers">
                <Link href="/containers">
                  Go to containers <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="button-connect-google"
                disabled={oauth.configured === false}
                onClick={() => {
                  if (oauth.configured === false) {
                    toast({
                      title: "OAuth not configured",
                      description:
                        oauth.message ??
                        "The portal administrator must configure Google OAuth credentials before sign-in is available.",
                      variant: "destructive",
                    });
                    return;
                  }
                  portalApi.redirectToGoogleOAuth();
                }}
              >
                {oauth.configured === false
                  ? "OAuth not configured"
                  : "Connect Google Tag Manager"}
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href="/audit">See sample audit</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* KPIs */}
      <section className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KPI label="Containers tracked" icon={Boxes}>
          {isLoading ? <Skeleton className="h-6 w-12" /> : (
            <span className="font-mono text-xl tabular-nums" data-testid="kpi-containers">
              {containerCount}
            </span>
          )}
        </KPI>
        <KPI label="Avg health score" icon={Activity}>
          {isLoading ? (
            <Skeleton className="h-6 w-16" />
          ) : (
            <HealthBadge score={avgHealth} />
          )}
        </KPI>
        <KPI label="Containers under 60" icon={AlertTriangle} tone="warn">
          {isLoading ? <Skeleton className="h-6 w-12" /> : (
            <span className="font-mono text-xl tabular-nums text-amber-600 dark:text-amber-400">
              {issuesCount}
            </span>
          )}
        </KPI>
        <KPI label="Pending reviews" icon={GitPullRequest}>
          <span className="font-mono text-xl tabular-nums" data-testid="kpi-pending">
            {pendingCount}
          </span>
        </KPI>
      </section>

      {/* Onboarding */}
      <section className="mt-8">
        <div className="flex items-end justify-between mb-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            How the portal works
          </h3>
          <Link href="/recommend" className="text-xs text-primary hover:underline">
            Start a plan →
          </Link>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <Card key={step.title} className="hover-elevate">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground">
                      0{i + 1}
                    </span>
                  </div>
                  <CardTitle className="text-sm font-semibold leading-snug mt-2">
                    {step.title}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground leading-relaxed">{step.body}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Recent activity */}
      <section className="mt-8">
        <div className="flex items-end justify-between mb-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Latest in approvals
          </h3>
          <Link href="/approvals" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </div>
        <Card>
          <div className="divide-y divide-border">
            {approvals.slice(0, 4).map((a) => (
              <div
                key={a.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{a.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {a.client} · {a.containerId}
                  </div>
                </div>
                <ApprovalStatusChip status={a.status} />
              </div>
            ))}
          </div>
        </Card>
      </section>
    </PageBody>
  );
}

function KPI({
  label,
  icon: Icon,
  children,
  tone,
}: {
  label: string;
  icon: typeof Boxes;
  children: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <Card>
      <CardContent className="py-3.5 md:py-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Icon
            className={
              tone === "warn"
                ? "h-3.5 w-3.5 text-amber-500"
                : "h-3.5 w-3.5 text-primary"
            }
          />
          {label}
        </div>
        <div className="mt-2">{children}</div>
      </CardContent>
    </Card>
  );
}
