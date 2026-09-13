import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A consistent section heading: optional leading icon, an uppercase muted
 * title, an optional count badge and an optional hint line below. Unifies the
 * `SectionTitle` (audit), inline layer headers (consent) and `Section`
 * (server-side) variants that had drifted apart.
 *
 * Renders a real <h3> so the page keeps a sensible heading outline for
 * screen-reader and keyboard navigation.
 */
export function SectionHeader({
  title,
  hint,
  icon: Icon,
  count,
  right,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  count?: number;
  /** Trailing content aligned to the end of the header row (e.g. a counter). */
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-2", className)}>
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-4 w-4 text-primary shrink-0" />}
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          {typeof count === "number" && (
            <span className="text-xs text-muted-foreground tabular-nums">
              ({count})
            </span>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {hint && (
        <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>
      )}
    </div>
  );
}
