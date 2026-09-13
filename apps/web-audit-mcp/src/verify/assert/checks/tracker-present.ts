import type { CaptureResult, CheckResult, CheckSpec, VerifySpec } from '../../types.js';
import { pass, fail } from '../helpers.js';
import { resolveTrackerName } from '../../trackers.js';

/**
 * tracker_present — assert at least one request to the named tracker's domain
 * was observed. Missing tracker is a Fail (catches "Clarity never loaded").
 */
export function checkTrackerPresent(capture: CaptureResult, _spec: VerifySpec, check: CheckSpec): CheckResult {
  const vendor = resolveTrackerName(check.tracker ?? '');
  const matches = capture.trackers.filter((t) => t.vendor === vendor);
  const observed = matches.length > 0 || (vendor === 'ga4' && capture.ga4Hits.length > 0);

  if (observed) {
    return pass(check, undefined, {
      tracker: vendor,
      observed: true,
      requests: matches.slice(0, 3).map((m) => ({ domain: m.domain, tRelativeMs: m.tRelativeMs })),
    });
  }
  return fail(check, `No request to ${vendor} observed within the settle window`, undefined, { tracker: vendor, observed: false });
}
