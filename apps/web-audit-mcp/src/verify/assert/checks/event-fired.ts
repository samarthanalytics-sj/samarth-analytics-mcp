import type { CaptureResult, CheckResult, CheckSpec, VerifySpec } from '../../types.js';
import { candidateHits, tidText } from '../helpers.js';
import { assertEventFired } from './event-common.js';

/** event_fired — assert a named event fired on load in the given phase/tracker/tid. */
export function checkEventFired(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): CheckResult {
  const cands = candidateHits(capture, spec, check);
  return assertEventFired(
    check,
    spec,
    capture,
    cands,
    `no "${check.event}"${tidText(spec, check)} hit within the settle window`,
  );
}
