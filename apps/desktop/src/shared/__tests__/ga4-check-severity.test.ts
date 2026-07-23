// The GA4 tab states the same property fact twice: as an audit FINDING and as a SETUP PLAN item.
// This pins that both read ONE severity, which they did not before (retention at 2 months was HIGH
// in the plan and Medium in the findings, on the same screen).
// Run: tsx src/shared/__tests__/ga4-check-severity.test.ts
import { GA4_CHECK_SEVERITY, severityFor, type Ga4Severity } from '../ga4-check-severity';
import { buildGa4Plan } from '../../main/google/ga4-plan';
import { auditGa4 } from '../../main/google/ga4-audit';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// -- the table itself -------------------------------------------------------------
const VALID: Ga4Severity[] = ['high', 'medium', 'low', 'info'];
check('every entry is a real severity', Object.values(GA4_CHECK_SEVERITY).every((v) => VALID.includes(v)));
check('the four overlapping checks are covered',
  ['retention_two_months', 'retention_no_reset', 'no_key_events', 'attribution_last_click'].every((k) => k in GA4_CHECK_SEVERITY));
check('a known check returns the table value, ignoring the fallback', severityFor('retention_two_months', 'info') === 'medium');
// A check on one surface only must keep its own grading rather than being invented here.
check('an unknown check falls back to the caller', severityFor('not_a_real_check', 'low') === 'low');
check('the fallback is used verbatim', severityFor('also_not_real', 'high') === 'high');

// -- the two engines agree, on a snapshot that trips all four ---------------------
/** A property that is at the 2-month default, never resets retention, has no key events and is on
 *  last-click attribution: every overlapping check fires at once. */
const snapshot = {
  property: { name: 'properties/1', displayName: 'Test', currencyCode: 'USD', timeZone: 'UTC', industryCategory: 'TECHNOLOGY' },
  dataStreams: [{ name: 'properties/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', webStreamData: { defaultUri: 'https://example.com', measurementId: 'G-X' } }],
  dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: false },
  keyEvents: [],
  attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_LAST_CLICK', acquisitionConversionEventLookbackWindow: 'ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS' },
  customDimensions: [],
  customMetrics: [],
} as unknown as Parameters<typeof buildGa4Plan>[0];

const plan = buildGa4Plan(snapshot);
const findings = auditGa4(snapshot).findings;
const sevOf = (checkId: string): string | undefined => findings.find((f) => f.checkId === checkId)?.severity;
const catOf = (id: string): string | undefined => plan.items.find((i) => i.id === id)?.category;

// The pairs: a plan item id and the audit checkId that states the SAME fact.
const PAIRS: Array<[planId: string, checkId: string]> = [
  ['retention_14', 'retention_two_months'],
  ['retention_reset', 'retention_no_reset'],
  ['key_events', 'no_key_events'],
  ['attribution_data_driven', 'attribution_last_click'],
];

for (const [planId, checkId] of PAIRS) {
  const p = catOf(planId);
  const a = sevOf(checkId);
  // Only assert agreement when BOTH surfaces actually raised it: a check that one engine does not
  // implement for this snapshot is a coverage question, not a disagreement.
  if (p === undefined || a === undefined) {
    check(`${planId} / ${checkId}: both surfaces raised it`, false, `plan=${p ?? 'absent'} audit=${a ?? 'absent'}`);
    continue;
  }
  check(`${planId} and ${checkId} agree on severity`, p === a, `plan=${p} audit=${a}`);
  check(`${planId} matches the shared table`, p === GA4_CHECK_SEVERITY[checkId], `plan=${p} table=${GA4_CHECK_SEVERITY[checkId]}`);
}

// The regression that started this: these two were 'high' vs 'medium' for one property fact.
check('retention is no longer HIGH in the plan while Medium in the findings', catOf('retention_14') === sevOf('retention_two_months'));
check('key events is no longer graded differently on the two surfaces', catOf('key_events') === sevOf('no_key_events'));

if (failures.length) console.error(failures.join('\n'));
console.log(`ga4-check-severity: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
