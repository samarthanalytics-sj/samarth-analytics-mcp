/** Reporter — assembles the final VerifyReport from capture + check results. */

import { ENGINE_VERSION, type CaptureResult, type CheckResult, type VerifyReport, type VerifySpec } from '../types.js';
import { rollupOverall } from '../assert/engine.js';

/**
 * Build the report in the spec's exact output shape. `overall` rolls up per the
 * spec: Fail if any Fail; else Partial if any Partial; else Not Verified only
 * when nothing could be verified; otherwise Pass.
 */
export function buildReport(
  spec: VerifySpec,
  specHash: string,
  capture: CaptureResult,
  results: CheckResult[],
): VerifyReport {
  const report: VerifyReport = {
    url: spec.url,
    engineVersion: ENGINE_VERSION,
    specHash,
    overall: rollupOverall(results),
    checks: results,
  };
  if (capture.notes.length > 0) report.notes = capture.notes;
  return report;
}
