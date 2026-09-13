/**
 * audit_brain compatibility adapter — PURE, and deliberately does NOT import
 * apps/desktop/src/main/google/ga4-scorecard.ts. It projects a VerifyReport
 * onto the minimal { areas, findings } contract that buildGa4Scorecard()
 * consumes, so a future integration can feed verify results into the scoring
 * engine without this engine ever depending on it.
 *
 * Vocabulary matches audit_brain: statusKey pass|partial|fail|not_verified;
 * severity critical|high|medium|low|info.
 */

import type { CheckResult, CheckType, Status, VerifyReport } from '../types.js';

export type ScorecardStatusKey = 'pass' | 'partial' | 'fail' | 'not_verified';
export type ScorecardSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ScorecardArea {
  area: string;
  statusKey: ScorecardStatusKey;
}
export interface ScorecardFindingLite {
  severity: ScorecardSeverity;
  category: string;
}
export interface ScorecardInput {
  areas: ScorecardArea[];
  findings: ScorecardFindingLite[];
}

const STATUS_KEY: Record<Status, ScorecardStatusKey> = {
  Pass: 'pass',
  Partial: 'partial',
  Fail: 'fail',
  'Not Verified': 'not_verified',
};

/** audit_brain finding category for each check type. */
const CATEGORY: Record<CheckType, string> = {
  event_fired: 'measurement',
  event_on_interaction: 'measurement',
  param_validation: 'measurement',
  duplicate_event: 'data_quality',
  consent_mode: 'privacy',
  tracker_present: 'integrations',
  cross_domain_linker: 'measurement',
};

function severityFor(check: CheckResult): ScorecardSeverity {
  if (check.status === 'Fail') return check.type === 'consent_mode' ? 'critical' : 'high';
  if (check.status === 'Partial') return 'medium';
  return 'info';
}

/** Project a VerifyReport onto audit_brain's minimal scorecard input. */
export function toScorecardInput(report: VerifyReport): ScorecardInput {
  const areas: ScorecardArea[] = report.checks.map((c) => ({ area: c.id, statusKey: STATUS_KEY[c.status] }));
  const findings: ScorecardFindingLite[] = report.checks
    .filter((c) => c.status === 'Fail' || c.status === 'Partial')
    .map((c) => ({ severity: severityFor(c), category: CATEGORY[c.type] }));
  return { areas, findings };
}
