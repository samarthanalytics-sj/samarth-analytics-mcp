/**
 * Assertion engine — a PURE function of (CaptureResult, VerifySpec). No browser,
 * no I/O, no clock. This is what makes verdicts deterministic and testable in
 * isolation: the same capture + spec always yields the same per-check statuses.
 */

import type { CaptureResult, CheckResult, CheckSpec, Status, VerifySpec } from '../types.js';
import { notVerified } from './helpers.js';
import { checkEventFired } from './checks/event-fired.js';
import { checkParamValidation } from './checks/param-validation.js';
import { checkEventOnInteraction } from './checks/event-on-interaction.js';
import { checkConsentMode } from './checks/consent-mode.js';
import { checkDuplicateEvent } from './checks/duplicate-event.js';
import { checkTrackerPresent } from './checks/tracker-present.js';
import { checkCrossDomainLinker } from './checks/cross-domain-linker.js';

type CheckFn = (capture: CaptureResult, spec: VerifySpec, check: CheckSpec) => CheckResult;

const DISPATCH: Record<CheckSpec['type'], CheckFn> = {
  event_fired: checkEventFired,
  param_validation: checkParamValidation,
  event_on_interaction: checkEventOnInteraction,
  consent_mode: checkConsentMode,
  duplicate_event: checkDuplicateEvent,
  tracker_present: checkTrackerPresent,
  cross_domain_linker: checkCrossDomainLinker,
};

/** Run a single check. Exposed for targeted unit tests. */
export function runCheck(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): CheckResult {
  // Global gate: if the page never loaded, nothing can be verified.
  if (!capture.loaded) {
    return notVerified(check, 'page or tag manager failed to load — capture could not settle');
  }
  return DISPATCH[check.type](capture, spec, check);
}

/** Run every check in the spec (order preserved). */
export function runAssertions(capture: CaptureResult, spec: VerifySpec): CheckResult[] {
  return spec.checks.map((check) => runCheck(capture, spec, check));
}

/** Roll per-check statuses up to the overall verdict. */
export function rollupOverall(results: CheckResult[]): Status {
  if (results.length === 0) return 'Not Verified';
  if (results.some((r) => r.status === 'Fail')) return 'Fail';
  if (results.some((r) => r.status === 'Partial')) return 'Partial';
  // If nothing failed/partial but at least one is a real Pass, that's a Pass even
  // if some checks are Not Verified. Only all-Not-Verified rolls up to Not Verified.
  if (results.every((r) => r.status === 'Not Verified')) return 'Not Verified';
  return 'Pass';
}
