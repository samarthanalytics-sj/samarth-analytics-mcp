// ONE severity per GA4 check, for the checks that appear on more than one surface.
//
// The GA4 tab shows the same property fact twice: once as an audit FINDING and once as a SETUP PLAN
// item you can tick and apply. Both were grading independently, and three of the four overlapping
// checks disagreed - retention at 2 months was HIGH in the plan and Medium in the findings, on the
// same screen, about the same property. A user reasonably reads that as two different problems.
//
// PURE + framework-free, and deliberately tiny: it covers only the overlap. Findings with no plan
// counterpart keep their severity inline in ga4-audit.ts, so this is not a mass refactor of a
// working engine - it is a single source of truth for the facts that are stated twice.

export type Ga4Severity = 'high' | 'medium' | 'low' | 'info';

/**
 * Keyed by the audit's checkId, which is already the stable id the fix guide uses.
 *
 * The AUDIT's grading wins wherever the two disagreed. It applies one scale across every check and
 * feeds the summary counts ("5 finding(s)", the red/amber/green header), so a plan item grading
 * itself higher would inflate a number the user cross-checks against the findings list.
 */
export const GA4_CHECK_SEVERITY: Readonly<Record<string, Ga4Severity>> = {
  // Retention at the 2-month default. Real data loss, but nothing is broken and nothing stops
  // collecting, so it is not urgent.
  retention_two_months: 'medium',
  // Returning users ageing out while still active. Narrower than the above.
  retention_no_reset: 'low',
  // No key events marked. Serious (conversions are unmeasured) but a configuration choice, not a fault.
  no_key_events: 'medium',
  // Last-click attribution. A deliberate model choice for many advertisers, so advisory.
  attribution_last_click: 'low',
};

/** The agreed severity for a check, or the caller's own grading when the check is on one surface
 *  only. Never invents a severity for an unknown check. */
export function severityFor(checkId: string, fallback: Ga4Severity): Ga4Severity {
  return GA4_CHECK_SEVERITY[checkId] ?? fallback;
}
