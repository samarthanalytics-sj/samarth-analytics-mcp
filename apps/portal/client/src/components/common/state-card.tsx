import type { ComponentType, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StateTone = "neutral" | "primary" | "warning" | "success" | "destructive";

const ICON_WRAP_TONE: Record<StateTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  destructive: "bg-destructive/10 text-destructive",
};

const CARD_TONE: Partial<Record<StateTone, string>> = {
  warning: "border-amber-500/40 bg-amber-500/5",
  destructive: "border-destructive/40",
};

/**
 * A centered, icon-led card for the empty / not-connected / clean / error
 * states that every page in the portal renders. Replaces the hand-rolled
 * `<Card><CardContent className="py-10 text-center">…` blocks that were
 * duplicated across audit, consent, containers and server-side pages.
 *
 * The whole card is a polite live region so screen readers announce the
 * transition into an empty/error state without stealing focus.
 */
export function StateCard({
  icon: Icon,
  title,
  description,
  tone = "neutral",
  role = "status",
  actions,
  children,
  className,
  testId,
}: {
  icon?: ComponentType<{ className?: string }>;
  title?: ReactNode;
  description?: ReactNode;
  tone?: StateTone;
  /** "status" for empty/info states, "alert" for errors. */
  role?: "status" | "alert";
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn(CARD_TONE[tone], className)} data-testid={testId}>
      <CardContent
        className="py-10 px-5 text-center space-y-4"
        role={role}
        aria-live={role === "alert" ? "assertive" : "polite"}
      >
        {Icon && (
          <div
            className={cn(
              "mx-auto h-11 w-11 rounded-full flex items-center justify-center",
              ICON_WRAP_TONE[tone],
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        )}
        {title && <h3 className="text-base font-semibold">{title}</h3>}
        {description && (
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            {description}
          </p>
        )}
        {children}
        {actions && (
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {actions}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A compact, inline empty placeholder (single row of muted text in a card).
 * For "no findings at this layer" / "no clients on this container" style gaps
 * where the full StateCard treatment is too heavy.
 */
export function EmptyRow({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card
      className={cn("p-4 text-center text-xs text-muted-foreground", className)}
      data-testid={testId}
      role="status"
    >
      {children}
    </Card>
  );
}
