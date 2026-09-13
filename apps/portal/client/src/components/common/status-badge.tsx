import type { ReactNode } from "react";
import { CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

const TONE_STYLES: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
  success:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warning:
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  danger: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  accent: "bg-primary/10 text-primary border-primary/30",
};

/**
 * A small pill with a consistent tonal color system. Replaces the many
 * hand-written `bg-emerald-500/10 text-emerald-700 …` spans used for coverage
 * status, "Loaded"/"Connected" markers and similar across the portal.
 */
export function StatusBadge({
  tone = "neutral",
  pill = true,
  icon,
  children,
  className,
  title,
  testId,
}: {
  tone?: StatusTone;
  /** Fully-rounded (pill) vs slightly-rounded (chip). */
  pill?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 border px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap",
        pill ? "rounded-full" : "rounded-md",
        TONE_STYLES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * The "consent states proven by capture" row of denied/granted/partial pills,
 * which was duplicated verbatim in both the audit page's ConsentProofCard and
 * the consent-v2 page's ConsentSummary. Each state shows a check when proven
 * and a cross when not, with an accessible label.
 */
export function ConsentStatePills({
  coverage,
}: {
  coverage?: { denied?: boolean; granted?: boolean; partial?: boolean };
}) {
  const states = [
    { key: "denied" as const, label: "Denied" },
    { key: "granted" as const, label: "Granted" },
    { key: "partial" as const, label: "Partial" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {states.map((st) => {
        const on = Boolean(coverage?.[st.key]);
        return (
          <span
            key={st.key}
            data-testid={`consent-state-${st.key}`}
            aria-label={`${st.label} state ${on ? "proven" : "not proven"} by capture`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
              on
                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                : "border-border/60 text-muted-foreground",
            )}
          >
            {on ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            ) : (
              <X className="h-3 w-3" aria-hidden="true" />
            )}
            {st.label}
          </span>
        );
      })}
    </div>
  );
}
