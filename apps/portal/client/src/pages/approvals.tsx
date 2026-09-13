import { useMemo, useState } from "react";
import { Check, X, Send, Rocket, History } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ApprovalStatusChip } from "@/components/status-chip";
import { usePortal } from "@/lib/portal-store";
import { GOAL_LABELS } from "@shared/portal-types";
import type { ApprovalItem, ApprovalStatus } from "@shared/portal-types";
import { useToast } from "@/hooks/use-toast";

const TABS: { value: ApprovalStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "published", label: "Published" },
];

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ApprovalsPage() {
  const { approvals, updateApproval } = usePortal();
  const [tab, setTab] = useState<ApprovalStatus | "all">("all");
  const { toast } = useToast();

  const filtered = useMemo<ApprovalItem[]>(() => {
    if (tab === "all") return approvals;
    return approvals.filter((a) => a.status === tab);
  }, [approvals, tab]);

  function transition(item: ApprovalItem, next: ApprovalStatus, note?: string) {
    updateApproval(item.id, {
      status: next,
      reviewer: "Samarth Reviewer (demo)",
      reviewedAt: new Date().toISOString(),
      reviewNote: note ?? item.reviewNote,
    });
    toast({
      title: `Marked ${next.replace("_", " ")}`,
      description: item.title,
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Approvals"
        title="Approval queue"
        description="Every change request lives here until a Samarth reviewer approves and publishes. Demo lets you transition state — production wires this to MCP publish guardrails."
      />
      <PageBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as ApprovalStatus | "all")}>
          <div className="overflow-x-auto -mx-1 px-1">
            <TabsList className="w-max">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  data-testid={`tab-${t.value}`}
                  className="whitespace-nowrap"
                >
                  {t.label}
                  <Badge
                    variant="secondary"
                    className="ml-1.5 px-1.5 py-0 text-[10.5px] tabular-nums"
                  >
                    {t.value === "all"
                      ? approvals.length
                      : approvals.filter((a) => a.status === t.value).length}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value={tab} className="mt-5">
            {filtered.length === 0 ? (
              <Card className="p-8 text-center text-sm text-muted-foreground border-dashed">
                Nothing in this view yet.
              </Card>
            ) : (
              <div className="space-y-3">
                {filtered.map((a) => (
                  <Card key={a.id} data-testid={`card-approval-${a.id}`}>
                    <CardContent className="py-4">
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold truncate">{a.title}</h4>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {a.client} · <span className="font-mono">{a.containerId}</span> ·{" "}
                              {GOAL_LABELS[a.goal]}
                            </div>
                          </div>
                          <ApprovalStatusChip status={a.status} />
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            <span className="font-medium text-foreground">{a.stepsCount}</span> steps
                          </span>
                          <RiskPill risk={a.riskLevel} />
                          <span>Submitted by {a.submittedBy}</span>
                          <span className="flex items-center gap-1">
                            <History className="h-3 w-3" />
                            {fmt(a.submittedAt)}
                          </span>
                        </div>

                        {a.reviewNote && (
                          <div className="text-xs rounded-md bg-muted px-3 py-2 text-muted-foreground border border-border">
                            <span className="font-medium text-foreground">
                              {a.reviewer ?? "Reviewer"}:
                            </span>{" "}
                            {a.reviewNote}
                          </div>
                        )}

                        {/* Actions per state */}
                        <div className="flex flex-wrap gap-2 pt-1">
                          {a.status === "draft" && (
                            <Button
                              size="sm"
                              onClick={() => transition(a, "pending_review")}
                              data-testid={`button-submit-${a.id}`}
                            >
                              <Send className="mr-1 h-3.5 w-3.5" />
                              Submit for review
                            </Button>
                          )}
                          {a.status === "pending_review" && (
                            <>
                              <Button
                                size="sm"
                                onClick={() =>
                                  transition(a, "approved", "Approved via portal demo.")
                                }
                                data-testid={`button-approve-${a.id}`}
                              >
                                <Check className="mr-1 h-3.5 w-3.5" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  transition(a, "rejected", "Rejected via portal demo.")
                                }
                                data-testid={`button-reject-${a.id}`}
                              >
                                <X className="mr-1 h-3.5 w-3.5" />
                                Reject
                              </Button>
                            </>
                          )}
                          {a.status === "approved" && (
                            <Button
                              size="sm"
                              onClick={() => transition(a, "published")}
                              data-testid={`button-publish-${a.id}`}
                            >
                              <Rocket className="mr-1 h-3.5 w-3.5" />
                              Publish via MCP
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

function RiskPill({ risk }: { risk: "low" | "medium" | "high" }) {
  const tone =
    risk === "high"
      ? "text-rose-600 dark:text-rose-300"
      : risk === "medium"
      ? "text-amber-600 dark:text-amber-300"
      : "text-emerald-600 dark:text-emerald-300";
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {risk} risk
    </span>
  );
}
