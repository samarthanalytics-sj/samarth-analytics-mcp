// Google Ads monitoring OVER TIME: what changed since the last sweep, and what moved unusually.
//
// The monitor could only ever report the account's state right now, so a whole class of problem was
// invisible to it: a conversion action that was DELETED, a campaign someone PAUSED, an audience that
// COLLAPSED, a conversion count that fell off a cliff. None of those are answerable from a single
// live read. They need the previous run to compare against.
//
// PURE + framework-free. The service owns persistence and the network; everything here is
// (previous, current) -> findings.
//
// TWO RULES run through all of it, and both exist because a monitor that cries wolf gets muted:
//
//   1. NO PREVIOUS RUN MEANS NO FINDINGS. The first sweep after this ships has nothing to compare
//      against, and reporting every existing entity as "new" would open dozens of alerts at once.
//   2. UNREAD IS NOT ABSENT. A permission error or an API hiccup that returns no audiences must
//      never be reported as "every audience was deleted". Each section records whether it was
//      actually read, and a section that was not read is skipped rather than diffed.

import type { HealthFinding } from './ads-map';

/** One conversion action, reduced to the fields whose CHANGE is worth an alert. */
export interface ConversionActionState {
  id: string;
  name: string;
  status: string;
  primaryForGoal: boolean;
}

export interface CampaignState {
  id: string;
  name: string;
  status: string;
  budgetMicros: number | null;
}

export interface AudienceState {
  id: string;
  name: string;
  /** Display-network size, the one Google populates most reliably. null when not reported. */
  size: number | null;
}

/** Per-conversion-action counts for the window, used for the volume anomaly pass. */
export interface VolumeState {
  id: string;
  name: string;
  conversions: number;
  value: number;
}

/**
 * A compact record of one sweep. Deliberately NOT the whole API response: this is persisted on every
 * target on every run, so it holds only the fields something is actually compared against. Storing
 * the full read would grow the config file without making a single extra finding possible.
 */
export interface AdsSnapshot {
  /** Epoch ms of the sweep that produced it. */
  at: number;
  /** The window the volume figures cover, so a comparison across different windows can be refused. */
  windowDays: number;
  /** Each section is undefined when that read did not succeed - distinct from an empty array. */
  actions?: ConversionActionState[];
  campaigns?: CampaignState[];
  audiences?: AudienceState[];
  volume?: VolumeState[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Reduce a sweep's reads to the persisted snapshot. A section is omitted (not emptied) when the
 *  caller could not read it, which is what keeps "unread" distinguishable from "gone". */
export function captureAdsSnapshot(input: {
  at: number;
  windowDays: number;
  actions?: Array<{ id: string; name: string; status: string; primaryForGoal?: boolean }>;
  campaigns?: Array<{ id: string; name: string; status: string; budget?: { amountMicros: number } }>;
  audiences?: Array<{ id: string; name: string; sizeForDisplay: number | null }>;
  volume?: Array<{ id?: string; name: string; conversions: number; conversionValue?: number }>;
}): AdsSnapshot {
  return {
    at: input.at,
    windowDays: input.windowDays,
    ...(input.actions ? { actions: input.actions.map((a) => ({ id: a.id, name: a.name, status: a.status, primaryForGoal: a.primaryForGoal === true })) } : {}),
    ...(input.campaigns ? { campaigns: input.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, budgetMicros: c.budget ? num(c.budget.amountMicros) : null })) } : {}),
    ...(input.audiences ? { audiences: input.audiences.map((u) => ({ id: u.id, name: u.name, size: u.sizeForDisplay })) } : {}),
    ...(input.volume ? { volume: input.volume.map((v) => ({ id: v.id ?? v.name, name: v.name, conversions: num(v.conversions), value: num(v.conversionValue) })) } : {}),
  };
}

/** A conversion count below this is too small for a percentage to mean anything: 2 -> 0 is a 100%
 *  drop and is usually just a quiet week. Anomaly findings need a floor or they are noise. */
export const MIN_VOLUME_FOR_ANOMALY = 10;
/** Fractional change that counts as a collapse / a spike. */
export const DROP_THRESHOLD = 0.7;
export const SPIKE_THRESHOLD = 3;
/** An audience shrinking by more than this is worth saying. */
export const AUDIENCE_SHRINK_THRESHOLD = 0.5;

const pct = (from: number, to: number): number => (from === 0 ? 0 : Math.round(((to - from) / from) * 100));
const byId = <T extends { id: string }>(list: T[]): Map<string, T> => new Map(list.map((x) => [x.id, x]));

/**
 * Everything that changed between two sweeps, as monitor findings.
 *
 * Returns [] when there is no previous snapshot, when the two are the same run, or when the windows
 * differ (comparing a 7-day count against a 30-day one produces an anomaly out of arithmetic alone).
 */
export function diffAdsSnapshots(prev: AdsSnapshot | undefined, curr: AdsSnapshot): HealthFinding[] {
  if (!prev || prev.at >= curr.at) return [];
  const out: HealthFinding[] = [];

  // ── Conversion actions: the highest-stakes section. A tracking resource disappearing or being
  //    demoted breaks measurement and, for primary actions, bidding.
  if (prev.actions && curr.actions) {
    const before = byId(prev.actions);
    const after = byId(curr.actions);
    for (const [id, was] of before) {
      const now = after.get(id);
      if (!now) {
        out.push({ severity: 'critical', area: 'changes', finding: `Conversion action "${was.name}" is gone since the last check. If it was deleted, everything it measured stopped being recorded, and any campaign bidding on it has lost its signal.` });
        continue;
      }
      if (was.status === 'ENABLED' && now.status !== 'ENABLED') {
        out.push({ severity: 'critical', area: 'changes', finding: `Conversion action "${now.name}" went from ENABLED to ${now.status} since the last check. It is no longer recording conversions.` });
      }
      if (was.primaryForGoal && !now.primaryForGoal) {
        out.push({ severity: 'critical', area: 'changes', finding: `Conversion action "${now.name}" is no longer counted in "Conversions". Smart bidding optimises against that column, so campaigns using it are now bidding on a different signal.` });
      }
      // A rename is not a fault, but it is why a report the user built yesterday no longer matches.
      if (was.name !== now.name) {
        out.push({ severity: 'info', area: 'changes', finding: `Conversion action renamed: "${was.name}" is now "${now.name}".` });
      }
    }
    for (const [id, now] of after) {
      if (!before.has(id)) out.push({ severity: 'info', area: 'changes', finding: `New conversion action since the last check: "${now.name}" (${now.status}).` });
    }
  }

  // ── Campaigns: paused or removed without anyone noticing is money stopping.
  if (prev.campaigns && curr.campaigns) {
    const before = byId(prev.campaigns);
    const after = byId(curr.campaigns);
    for (const [id, was] of before) {
      const now = after.get(id);
      if (!now) {
        out.push({ severity: 'critical', area: 'changes', finding: `Campaign "${was.name}" is gone since the last check. A removed campaign stops serving immediately.` });
        continue;
      }
      if (was.status === 'ENABLED' && now.status === 'PAUSED') {
        out.push({ severity: 'warning', area: 'changes', finding: `Campaign "${now.name}" was paused since the last check. It is no longer serving.` });
      }
      if (was.status === 'PAUSED' && now.status === 'ENABLED') {
        out.push({ severity: 'info', area: 'changes', finding: `Campaign "${now.name}" was resumed since the last check.` });
      }
      // Budget moves are reported in MICROS-free terms: the reader wants the direction and the size.
      if (was.budgetMicros !== null && now.budgetMicros !== null && was.budgetMicros !== now.budgetMicros) {
        const change = pct(was.budgetMicros, now.budgetMicros);
        out.push({
          severity: Math.abs(change) >= 50 ? 'warning' : 'info',
          area: 'changes',
          finding: `Daily budget for "${now.name}" changed by ${change > 0 ? '+' : ''}${change}% since the last check (${(was.budgetMicros / 1e6).toFixed(2)} to ${(now.budgetMicros / 1e6).toFixed(2)} in account currency).`,
        });
      }
    }
  }

  // ── Audiences: a list that empties stops remarketing without any error anywhere.
  if (prev.audiences && curr.audiences) {
    const before = byId(prev.audiences);
    const after = byId(curr.audiences);
    for (const [id, was] of before) {
      const now = after.get(id);
      if (!now) {
        out.push({ severity: 'warning', area: 'changes', finding: `Audience "${was.name}" is gone since the last check. Campaigns targeting it lose that audience.` });
        continue;
      }
      if (was.size === null || now.size === null) continue; // size not reported is not a shrink
      if (was.size > 0 && now.size === 0) {
        out.push({ severity: 'warning', area: 'changes', finding: `Audience "${now.name}" dropped to zero members (was ${was.size.toLocaleString('en-US')}). Remarketing to it has stopped.` });
      } else if (was.size > 0 && (was.size - now.size) / was.size >= AUDIENCE_SHRINK_THRESHOLD) {
        out.push({ severity: 'warning', area: 'changes', finding: `Audience "${now.name}" shrank ${Math.abs(pct(was.size, now.size))}% since the last check (${was.size.toLocaleString('en-US')} to ${now.size.toLocaleString('en-US')}). Check the tag still fires and the membership duration has not been shortened.` });
      }
    }
  }

  return out;
}

/**
 * Volume anomalies: the same window, one sweep apart, per conversion action.
 *
 * Kept separate from the config diff because it is comparing MEASUREMENTS rather than settings, and
 * it carries a floor the config diff does not need: a percentage over a handful of conversions is
 * arithmetic, not signal.
 */
export function detectVolumeAnomalies(prev: AdsSnapshot | undefined, curr: AdsSnapshot): HealthFinding[] {
  if (!prev?.volume || !curr.volume || prev.at >= curr.at) return [];
  // Two different windows are not comparable; saying so beats inventing a drop.
  if (prev.windowDays !== curr.windowDays) return [];

  const out: HealthFinding[] = [];
  const before = byId(prev.volume);
  for (const now of curr.volume) {
    const was = before.get(now.id);
    if (!was) continue;
    if (was.conversions >= MIN_VOLUME_FOR_ANOMALY) {
      const change = (now.conversions - was.conversions) / was.conversions;
      if (change <= -DROP_THRESHOLD) {
        out.push({
          severity: 'critical',
          area: 'volume',
          finding: `Conversions for "${now.name}" fell ${Math.abs(pct(was.conversions, now.conversions))}% between the last two checks (${was.conversions} to ${now.conversions}, same ${curr.windowDays}-day window). A drop this size is usually a broken tag rather than a quiet week.`,
        });
      } else if (change >= SPIKE_THRESHOLD - 1) {
        out.push({
          severity: 'warning',
          area: 'volume',
          finding: `Conversions for "${now.name}" rose ${pct(was.conversions, now.conversions)}% between the last two checks (${was.conversions} to ${now.conversions}, same ${curr.windowDays}-day window). Check the tag is not firing more than once per conversion.`,
        });
      }
    }
    // Revenue disappearing while conversions continue is a value-mapping break, and it is invisible
    // in a conversion count.
    if (was.value > 0 && now.value === 0 && now.conversions > 0) {
      out.push({
        severity: 'warning',
        area: 'volume',
        finding: `"${now.name}" is still recording conversions but their value is now zero (was ${was.value.toLocaleString('en-US')}). The conversion value is no longer reaching Google Ads.`,
      });
    }
  }
  return out;
}
