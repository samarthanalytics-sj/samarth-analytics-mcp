// Pure engine: weekly user-RETENTION cohorts for the GA4 audit baseline. GA4's Data API cohort report
// (cohortSpec) tracks users who first engaged in a given week and how many stay active in the following
// weeks. This module owns the three pure pieces so they are unit-testable independent of the API:
//   planRetentionCohorts  — which Sun-Sat acquisition weeks to request, and how many forward weeks are
//                            already "mature" (fully elapsed) for each, given today's date.
//   parseRetentionRows    — pivot GA4's tidy (cohort x cohortNthWeek) rows into a per-cohort matrix.
//   summarizeGa4Retention — a decision-grade HEADLINE (weighted Week-1 / Week-4 retention), honestly
//                            gated: small cohorts and not-yet-mature weeks are excluded, not shown as 0%.
//
// Presentation choice: a compact headline, NOT a full noisy NxM matrix — retention off a tiny cohort or
// an immature week manufactures false signal, so the headline is the honest artifact for a one-page audit.

/** UTC-only date helpers over YYYY-MM-DD strings (no local-timezone drift; weeks are GA4's Sun-Sat). */
const DAY_MS = 86400000;
function ymdToUtc(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function utcToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
// 0=Sunday .. 6=Saturday, matching GA4 week boundaries.
function dow(ms: number): number {
  return new Date(ms).getUTCDay();
}

export interface RetentionCohortPlan {
  cohorts: Array<{ name: string; startDate: string; endDate: string; weeksMature: number }>;
  forwardWeeks: number;
}

/** Build the cohort plan: the `numCohorts` most-recent COMPLETE Sun-Sat weeks (as firstSessionDate
 *  ranges), newest first, plus how many forward weeks (1..forwardWeeks) are already fully elapsed for
 *  each — accounting for a maturity/data-latency buffer so we never treat an unfinished week as data. */
export function planRetentionCohorts(todayYmd: string, numCohorts: number, forwardWeeks: number, bufferDays: number): RetentionCohortPlan {
  const today = ymdToUtc(todayYmd);
  if (!Number.isFinite(today)) return { cohorts: [], forwardWeeks };
  // The latest day we trust as "complete" (data has landed): today minus the buffer.
  const cutoff = today - bufferDays * DAY_MS;
  // Most recent Saturday on/before the cutoff = end of the newest complete cohort week.
  const newestSat = cutoff - ((dow(cutoff) + 1) % 7) * DAY_MS;
  const cohorts = [];
  for (let i = 0; i < numCohorts; i++) {
    const endSat = newestSat - i * 7 * DAY_MS;
    const startSun = endSat - 6 * DAY_MS;
    // Week k (1..forwardWeeks) for this cohort ends at endSat + k*7 days; it is mature when that end is
    // on/before the cutoff. weeksMature = how many of weeks 1..forwardWeeks are complete.
    let weeksMature = 0;
    for (let k = 1; k <= forwardWeeks; k++) {
      if (endSat + k * 7 * DAY_MS <= cutoff) weeksMature = k;
      else break;
    }
    cohorts.push({ name: `w${i}`, startDate: utcToYmd(startSun), endDate: utcToYmd(endSat), weeksMature });
  }
  return { cohorts, forwardWeeks };
}

export interface RetentionCohort {
  name: string;
  /** Acquisition-week (cohortNthWeek 0) active users — the per-cohort retention denominator. */
  week0Users: number;
  /** Active users at forward week k, stored at index k-1 (length = forwardWeeks). 0 when GA4 omitted the
   *  (cohort, week) row (a real/suppressed zero). Only trust index k-1 when weeksMature >= k. */
  weekActive: number[];
  weeksMature: number;
}

/** Pivot GA4's long (cohort x cohortNthWeek) rows into per-cohort week counts, aligned to the plan. */
export function parseRetentionRows(
  rows: Array<{ dimensions: string[]; metrics: string[] }>,
  plan: RetentionCohortPlan
): RetentionCohort[] {
  const byCohort = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const name = r.dimensions[0] ?? '';
    const nth = parseInt(r.dimensions[1] ?? '', 10); // "0000","0001" -> 0,1
    const users = Number(r.metrics[0]) || 0;
    if (!name || !Number.isFinite(nth)) continue;
    let m = byCohort.get(name);
    if (!m) {
      m = new Map();
      byCohort.set(name, m);
    }
    m.set(nth, users);
  }
  return plan.cohorts.map((c) => {
    const m = byCohort.get(c.name) ?? new Map<number, number>();
    return {
      name: c.name,
      week0Users: m.get(0) ?? 0,
      weekActive: Array.from({ length: plan.forwardWeeks }, (_, i) => m.get(i + 1) ?? 0),
      weeksMature: c.weeksMature,
    };
  });
}

/** A compact, honest retention headline, or null when there isn't enough reliable data to average.
 *  Rates are POOLED (weighted by week-0 users) across cohorts that (a) meet the minimum size and (b) are
 *  mature enough for that week — so a tiny or too-young cohort can never swing or fabricate the number. */
export function summarizeGa4Retention(input: { cohorts: RetentionCohort[]; minCohortSize: number }): string | null {
  const big = input.cohorts.filter((c) => c.week0Users >= input.minCohortSize);
  // Each week is pooled over its OWN set of qualifying cohorts (those mature enough for that week), so
  // the cohort count is attached PER week — Week 4 is typically averaged over fewer cohorts than Week 1,
  // and claiming a single shared count would misrepresent the smaller one.
  const pooled = (mature: number, idx: number): { rate: number; n: number } | null => {
    const q = big.filter((c) => c.weeksMature >= mature);
    if (q.length < 2) return null; // fewer than 2 qualifying cohorts is not an honest average
    const base = q.reduce((a, c) => a + c.week0Users, 0);
    const act = q.reduce((a, c) => a + (c.weekActive[idx] ?? 0), 0);
    return base > 0 ? { rate: Math.round((act / base) * 100), n: q.length } : null;
  };
  const w1 = pooled(1, 0);
  if (w1 === null) return null;
  const w4 = pooled(4, 3);
  const w4part = w4 === null ? '' : ` · Week 4: ${w4.rate}% across ${w4.n} cohorts`;
  return `Week 1: ${w1.rate}% across ${w1.n} cohorts${w4part} (weighted, n>=${input.minCohortSize} each)`;
}
