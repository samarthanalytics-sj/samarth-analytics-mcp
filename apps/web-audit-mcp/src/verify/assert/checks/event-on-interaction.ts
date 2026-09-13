import type { CaptureResult, CheckResult, CheckSpec, VerifySpec } from '../../types.js';
import { candidateHits, fail, notVerified, tidText } from '../helpers.js';
import { assertEventFired } from './event-common.js';

/**
 * event_on_interaction — an action (click/submit/navigate) is run, then the
 * expected event must fire as a result. Fail if the selector was not found or
 * the action produced no matching hit.
 */
export function checkEventOnInteraction(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): CheckResult {
  const action = capture.actions.find((a) => a.checkId === check.id);
  if (!action) {
    return notVerified(check, 'the interaction step was not executed by the capture layer');
  }
  if (!action.selectorFound) {
    return fail(check, action.note ?? 'the interaction target (selector/form) was not found on the page');
  }
  if (!action.performed) {
    return fail(check, action.note ?? 'the interaction could not be performed');
  }

  const since = action.atTMs;
  const cands = candidateHits(capture, spec, check).filter((h) => since == null || h.tRelativeMs >= since);
  return assertEventFired(
    check,
    spec,
    capture,
    cands,
    `the interaction ran but produced no "${check.event}"${tidText(spec, check)} hit`,
  );
}
