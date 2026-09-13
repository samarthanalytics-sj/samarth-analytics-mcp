import type { CaptureResult, CheckResult, CheckSpec, VerifySpec } from '../../types.js';
import { candidateHits, tidText } from '../helpers.js';
import { assertEventFired } from './event-common.js';

/**
 * param_validation — the event must fire, then its params are validated
 * (ep. string match, epn./upn. numeric match, `true` = present). Partial when
 * the event fired but params are wrong (the common real-world state).
 */
export function checkParamValidation(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): CheckResult {
  const cands = candidateHits(capture, spec, check);
  return assertEventFired(
    check,
    spec,
    capture,
    cands,
    `"${check.event}"${tidText(spec, check)} did not fire, so its params could not be validated`,
  );
}
