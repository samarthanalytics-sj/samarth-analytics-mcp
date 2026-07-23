// Was a GA4 report cut off by its row limit, and what may be concluded when it was.
//
// The Data API returns `rowCount` (how many rows MATCHED) alongside `rows` (how many it sent, capped
// by `limit`). The two are different numbers and only the first tells you whether you are looking at
// the whole picture. Discarding rowCount makes a truncated report indistinguishable from a complete
// one, which is how "this event is missing from the report" silently becomes "this event stopped
// firing".
//
// PURE + framework-free.

export interface ReportCompleteness {
  /** Rows actually returned. */
  returned: number;
  /** Rows that matched the query, per the API. null when it did not say. */
  matched: number | null;
  /** True when rows were left behind. */
  truncated: boolean;
}

/**
 * Compare what came back with what matched.
 *
 * An API that reports no rowCount is treated as NOT truncated: inventing truncation would suppress
 * real findings, and rowCount is a documented field the API does send. The dangerous direction here
 * is claiming completeness we do not have, and that only happens if matched > returned goes unnoticed.
 */
export function reportCompleteness(returnedRows: number, rowCount: unknown): ReportCompleteness {
  const matched = typeof rowCount === 'number' && Number.isFinite(rowCount) && rowCount >= 0
    ? Math.round(rowCount)
    : typeof rowCount === 'string' && /^\d+$/.test(rowCount)
      ? Number(rowCount)
      : null;
  const returned = Math.max(0, returnedRows);
  return { returned, matched, truncated: matched !== null && matched > returned };
}

/**
 * Whether an entity's ABSENCE from a report means it genuinely has no data.
 *
 * On a complete report, absent means zero, and that is a real and important signal (an event that
 * stopped firing). On a TRUNCATED report, absent means "not in the top N", which is a different
 * statement entirely and cannot support the same conclusion. Ranking below a cut-off is not the same
 * as not existing, and reporting it as zero is how a healthy event becomes a critical alert.
 */
export const absenceMeansZero = (c: ReportCompleteness): boolean => !c.truncated;

/** One line for a result that could not be fully compared, so the gap is stated rather than hidden. */
export function truncationNote(c: ReportCompleteness, what: string): string | null {
  if (!c.truncated) return null;
  const matched = c.matched ?? 0;
  return (
    `Only the top ${c.returned.toLocaleString('en-US')} of ${matched.toLocaleString('en-US')} ${what} were read, ` +
    'so anything below that cut-off could not be compared. A missing entry here means "not in the top ' +
    'rows", not "no data".'
  );
}
