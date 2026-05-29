import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApprovalStatus, AuditSeverity } from "@shared/portal-types";

const APPROVAL_STYLES: Record<ApprovalStatus, string> = {
  draft: "bg-muted text-muted-foreground border border-border",
  pending_review:
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  rejected: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30",
  published: "bg-primary/10 text-primary border border-primary/30",
};

const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
};

export function ApprovalStatusChip({ status }: { status: ApprovalStatus }) {
  return (
    <span
      data-testid={`chip-status-${status}`}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        APPROVAL_STYLES[status],
      )}
    >
      {APPROVAL_LABEL[status]}
    </span>
  );
}

const SEVERITY_STYLES: Record<AuditSeverity, string> = {
  info: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/30",
  low: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/30",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  high: "bg-orange-500/10 text-orange-700 dark:text-orange-300 border border-orange-500/30",
  critical: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30",
};

export function SeverityChip({ severity }: { severity: AuditSeverity }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide",
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </span>
  );
}

export function HealthBadge({ score }: { score: number }) {
  const tone =
    score >= 80
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : score >= 60
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30"
      : "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30";
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px] tabular-nums", tone)}>
      {score}/100
    </Badge>
  );
}
