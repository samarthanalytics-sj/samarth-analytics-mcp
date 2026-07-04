import type { CaptureResult, CheckResult, CheckSpec, Ga4Hit, VerifySpec } from '../../types.js';
import { candidateHits, pass, fail } from '../helpers.js';

/**
 * duplicate_event — detect the same en + same key params fired more than the
 * allowed count in a phase. Report the count; Fail if it exceeds allowedCount
 * (default 1). An event that never fired is not a duplicate (Pass, count 0).
 */
export function checkDuplicateEvent(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): CheckResult {
  const allowed = check.allowedCount ?? 1;
  const cands = candidateHits(capture, spec, check);
  if (cands.length === 0) {
    return pass(check, [], { count: 0, allowed, note: 'event did not fire — no duplicates possible' });
  }

  const keyParams = check.keyParams ?? [];
  const groups = new Map<string, Ga4Hit[]>();
  for (const h of cands) {
    const key = keyParams.length ? keyParams.map((k) => `${k}=${h.params[k] ?? ''}`).join('&') : '*';
    const bucket = groups.get(key);
    if (bucket) bucket.push(h);
    else groups.set(key, [h]);
  }

  let worstKey = '';
  let worstHits: Ga4Hit[] = [];
  for (const [key, hits] of groups) {
    if (hits.length > worstHits.length) {
      worstKey = key;
      worstHits = hits;
    }
  }

  const count = worstHits.length;
  if (count > allowed) {
    const where = keyParams.length ? ` for ${worstKey}` : '';
    return fail(check, `"${check.event}" fired ${count} times${where} in-phase (allowed ${allowed})`, worstHits.slice(0, 5), { count, allowed });
  }
  return pass(check, worstHits.slice(0, 3), { count, allowed });
}
