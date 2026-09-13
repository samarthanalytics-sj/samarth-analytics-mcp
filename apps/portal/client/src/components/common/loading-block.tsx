import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A vertical stack of skeleton rows used as the loading placeholder for
 * findings lists, server-overview sections, etc. Replaces the repeated
 * `Array.from({ length: n }).map(() => <Skeleton/>)` blocks.
 *
 * Wrapped in an aria-busy region with an off-screen label so assistive tech
 * announces that content is loading rather than reading an empty container.
 */
export function LoadingBlock({
  rows = 3,
  rowClassName = "h-24 w-full",
  className,
  label = "Loading…",
  testId,
}: {
  rows?: number;
  /** Tailwind sizing for each skeleton row. */
  rowClassName?: string;
  className?: string;
  label?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("space-y-3", className)}
      role="status"
      aria-busy="true"
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={rowClassName} aria-hidden="true" />
      ))}
    </div>
  );
}

/**
 * A responsive grid of skeleton cards for card-grid loading states
 * (containers list, sample records).
 */
export function SkeletonGrid({
  count = 4,
  cardClassName = "h-36 w-full rounded-lg",
  className = "grid grid-cols-1 sm:grid-cols-2 gap-3",
  label = "Loading…",
}: {
  count?: number;
  cardClassName?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div className={className} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cardClassName} aria-hidden="true" />
      ))}
    </div>
  );
}
