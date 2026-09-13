// Pure engine: flag REGISTERED-but-UNUSED ("dead") custom dimensions. A dimension that received no
// data over a wide window is either clutter — it consumes one of GA4's limited custom-dimension slots —
// or a sign that the event parameter meant to populate it is not being sent. Read-only, advisory.
//
// The per-dimension DATA-PRESENCE check (an I/O concern: one Data API report per dimension) lives in
// data-service.getGa4CustomDimensionUsage. This engine only CLASSIFIES that usage into a finding, so it
// stays pure and unit-testable. It deliberately errs toward NOT flagging: a dimension is only ever
// called dead when it was conclusively checked and returned no real data on a property that has traffic.

import type { Ga4Finding } from './ga4-audit';

/** One registered custom dimension plus whether the Data API found any real (non-"(not set)") value.
 *  `checked` is false when the dimension was NOT conclusively checked — item-scoped (skipped to avoid
 *  item-metric false positives), an unrecognised scope, or a throttled/errored query. A not-checked
 *  dimension is NEVER flagged dead; it is treated as inconclusive. */
export interface Ga4DimensionUsage {
  parameterName: string;
  displayName: string;
  scope: string;
  hasData: boolean;
  checked: boolean;
}

export interface Ga4DeadDimensionInput {
  usage: Ga4DimensionUsage[];
  /** The property had traffic in the checked window. With zero traffic every dimension looks empty, so
   *  we cannot tell "dead" from "idle property" and emit nothing. */
  activelyMeasuring: boolean;
  /** The lookback (days) the usage check queried — surfaced in the finding wording. */
  windowDays: number;
}

// Name at most this many dead dimensions inline; the rest are summarised as "and N more".
const MAX_NAMED = 8;

/** Zero or one finding (a single aggregated 'customdef' advisory, never one-per-dimension). */
export function auditGa4DeadDimensions(input: Ga4DeadDimensionInput): Ga4Finding[] {
  if (!input.activelyMeasuring) return [];
  const dead = input.usage.filter((u) => u.checked && !u.hasData);
  if (dead.length === 0) return [];
  const names = dead.map((d) => (d.displayName || d.parameterName).trim()).filter(Boolean);
  const shown = names.slice(0, MAX_NAMED);
  const more = names.length - shown.length;
  const list = shown.join(', ') + (more > 0 ? `, and ${more} more` : '');
  const noun = dead.length === 1 ? 'custom dimension' : 'custom dimensions';
  return [
    {
      severity: 'low',
      category: 'customdef',
      message: `${dead.length} registered ${noun} received no data in the last ${input.windowDays} days: ${list}. Each one uses one of GA4's limited custom-dimension slots, so an unused dimension is either clutter or a sign the event parameter meant to populate it is not being sent.`,
      recommendation:
        'Confirm the source events actually send these parameters; archive any genuinely unused dimension in Admin > Custom definitions to free the slot. If you registered any of these in the last few days, disregard - GA4 does not backfill, so a brand-new dimension can look empty.',
    },
  ];
}
