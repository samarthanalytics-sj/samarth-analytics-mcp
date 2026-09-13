import { FileSearch, Info } from "lucide-react";
import type { EvidenceItem } from "@shared/portal-types";

/**
 * Compact, source-scoped evidence rows shared by the full audit and the
 * Consent Mode v2 pages. Each row shows WHICH source the evidence came from and
 * a short label/value — never raw JSON. Renders nothing when there is no
 * evidence so callers can drop it in unconditionally.
 */
export function EvidenceList({
  items,
  className = "mt-2",
}: {
  items?: EvidenceItem[];
  className?: string;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className={className}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
        <FileSearch className="h-3 w-3" aria-hidden="true" />
        Evidence
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li
            key={`${it.label}-${i}`}
            className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11px]"
          >
            <span className="inline-flex items-center rounded bg-sky-500/10 px-1.5 py-0.5 font-medium text-sky-700 dark:text-sky-300 border border-sky-500/30">
              {it.source}
            </span>
            <span className="text-muted-foreground">{it.label}:</span>
            {it.parameter && (
              <span className="font-mono text-foreground break-all">
                {it.parameter}
              </span>
            )}
            {it.value && (
              <span className="font-mono text-muted-foreground break-all">
                {it.value}
              </span>
            )}
            {it.entityPath && (
              <span className="font-mono text-muted-foreground/70 break-all">
                ({it.entityPath})
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Plain-language notes about any accuracy tightening (confidence cap, severity
 * downgrade, forced manual review) the guardrails applied to a finding. Surfaces
 * WHY the displayed severity/confidence may be lower than the raw rule asked for,
 * so a reader is never misled into thinking a number was inflated or arbitrary.
 */
export function AccuracyNotes({
  notes,
  className = "mt-2",
}: {
  notes?: string[];
  className?: string;
}) {
  if (!notes || notes.length === 0) return null;
  return (
    <div
      className={`${className} rounded border border-amber-400/40 bg-amber-500/5 px-2.5 py-1.5`}
    >
      <div className="text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-300 mb-1 flex items-center gap-1">
        <Info className="h-3 w-3" aria-hidden="true" />
        Accuracy adjustment
      </div>
      <ul className="space-y-0.5 list-disc pl-4">
        {notes.map((n, i) => (
          <li key={i} className="text-[11px] text-muted-foreground">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}
