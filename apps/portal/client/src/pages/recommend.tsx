import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Sparkles,
  Target,
  GitPullRequest,
  CheckCircle2,
  AlertTriangle,
  ListChecks,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { portalApi } from "@/lib/portal-api";
import { GOAL_LABELS } from "@shared/portal-types";
import type { ChangePlan, RecommendationGoal } from "@shared/portal-types";
import { usePortal } from "@/lib/portal-store";
import { useToast } from "@/hooks/use-toast";

const GOAL_CARDS: { goal: RecommendationGoal; tagline: string }[] = [
  { goal: "ga4_ecommerce", tagline: "view_item → purchase, full schema" },
  { goal: "consent_mode_v2", tagline: "Defaults + update from CMP" },
  { goal: "meta_capi", tagline: "Server-side relay with hashed PII" },
  { goal: "lead_tracking", tagline: "Form + chat conversions" },
  { goal: "server_side_tagging", tagline: "First-party GA4 transport" },
  { goal: "cross_domain", tagline: "Link owned domains" },
];

const STEP_TYPE_LABEL: Record<string, string> = {
  create_tag: "Create tag",
  create_trigger: "Create trigger",
  create_variable: "Create variable",
  update_tag: "Update tag",
  update_dl: "Update dataLayer",
  publish: "Publish",
};

export default function RecommendPage() {
  const { data: containers } = useQuery({
    queryKey: ["/api/containers"],
    queryFn: () => portalApi.listContainers(),
  });
  const { addApproval } = usePortal();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [containerId, setContainerId] = useState<string>("");
  const [goal, setGoal] = useState<RecommendationGoal | null>(null);
  const [plan, setPlan] = useState<ChangePlan | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedContainer = containers?.find((c) => c.containerId === containerId);

  async function generate(g: RecommendationGoal) {
    if (!containerId) {
      toast({
        title: "Choose a container first",
        description: "Pick which container this plan targets.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    setGoal(g);
    const built = await portalApi.buildPlan(g, containerId);
    setPlan(built);
    setBusy(false);
  }

  async function submit() {
    if (!plan || !selectedContainer) return;
    const item = await portalApi.submitForReview(plan, selectedContainer.client);
    addApproval(item);
    toast({
      title: "Submitted for Samarth review",
      description: "Your draft is now in the approval queue.",
    });
    setLocation("/approvals");
  }

  return (
    <>
      <PageHeader
        eyebrow="Recommendations"
        title="Recommendation builder"
        description="Pick a goal. The portal drafts a clean change plan. Nothing publishes until Samarth approves."
      />
      <PageBody>
        {/* Container picker */}
        <Card className="mb-5">
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                  Target container
                </div>
                <Select value={containerId} onValueChange={setContainerId}>
                  <SelectTrigger data-testid="select-target-container">
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
              {selectedContainer && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">{selectedContainer.industry}</Badge>
                  <Badge variant="outline" className="capitalize">{selectedContainer.platform}</Badge>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Goal cards */}
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Choose a goal
        </h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {GOAL_CARDS.map(({ goal: g, tagline }) => {
            const active = goal === g && plan;
            return (
              <Card
                key={g}
                className={`cursor-pointer hover-elevate ${active ? "ring-1 ring-primary" : ""}`}
                onClick={() => generate(g)}
                data-testid={`card-goal-${g}`}
              >
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Target className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{GOAL_LABELS[g]}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{tagline}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Plan preview */}
        <div className="mt-8">
          {busy ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              <Sparkles className="h-5 w-5 mx-auto text-primary mb-2 animate-pulse" />
              Drafting plan…
            </Card>
          ) : plan ? (
            <Card>
              <CardContent className="py-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-primary mb-1">
                      Draft change plan
                    </div>
                    <h3 className="text-base font-semibold leading-snug">{plan.title}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{plan.summary}</p>
                  </div>
                  <Button onClick={submit} data-testid="button-submit-review">
                    <GitPullRequest className="mr-1.5 h-4 w-4" />
                    Submit for review
                  </Button>
                </div>

                <div className="mt-5 border-t border-border pt-4">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <ListChecks className="h-3.5 w-3.5" /> Steps
                  </div>
                  <ol className="space-y-2.5">
                    {plan.steps.map((step, i) => (
                      <li
                        key={step.id}
                        className="flex gap-3 items-start rounded-md border border-border bg-card-foreground/[0.02] p-3"
                      >
                        <div className="h-6 w-6 shrink-0 rounded-full bg-primary/10 text-primary font-mono text-xs flex items-center justify-center">
                          {i + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{step.title}</span>
                            <Badge variant="outline" className="text-[10.5px]">
                              {STEP_TYPE_LABEL[step.type]}
                            </Badge>
                            {step.risk === "high" && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-300">
                                <AlertTriangle className="h-3 w-3" />
                                High risk
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{step.description}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="mt-5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 px-3 py-2.5 text-xs flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  Submitting routes this plan to the Samarth review queue. No GTM writes happen
                  until a reviewer approves and publishes.
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-8 text-center text-sm text-muted-foreground border-dashed">
              Select a goal above to generate a draft change plan.
            </Card>
          )}
        </div>
      </PageBody>
    </>
  );
}
