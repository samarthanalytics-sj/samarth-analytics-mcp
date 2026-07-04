/** Shared event-assertion logic for event_fired / param_validation / event_on_interaction. */

import type { CaptureResult, CheckResult, CheckSpec, Ga4Hit, VerifySpec } from '../../types.js';
import { matchParams, describeMismatches, pass, fail, partial, notVerified } from '../helpers.js';

/**
 * Given the candidate hits already filtered to (event + tid + phase [+ post-action]),
 * apply the Pass/Partial/Fail/Not-Verified rules:
 *  - no candidate + tag manager absent → Not Verified (cannot verify)
 *  - no candidate + tag manager present → Fail (tag did not fire)
 *  - candidate with all params matching → Pass
 *  - candidate(s) but none fully match params → Partial (best-effort mismatch report)
 *  - candidate + no params asserted → Pass
 */
export function assertEventFired(
  check: CheckSpec,
  _spec: VerifySpec,
  capture: CaptureResult,
  candidates: Ga4Hit[],
  noHitReason: string,
): CheckResult {
  if (candidates.length === 0) {
    if (!capture.gtmPresent) {
      return notVerified(check, `tag manager / dataLayer not detected — cannot verify (${noHitReason})`);
    }
    return fail(check, noHitReason);
  }

  const params = check.params;
  if (!params || Object.keys(params).length === 0) {
    return pass(check, [candidates[0]]);
  }

  for (const h of candidates) {
    if (matchParams(h, params).allMatch) return pass(check, [h]);
  }

  const ranked = candidates
    .map((h) => ({ h, m: matchParams(h, params) }))
    .sort((a, b) => a.m.mismatches.length - b.m.mismatches.length);
  const best = ranked[0];
  return partial(check, `event fired but params did not match: ${describeMismatches(best.m.mismatches)}`, [best.h]);
}
