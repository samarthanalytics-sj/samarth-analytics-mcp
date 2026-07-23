// Pure tests for Google Ads monitoring OVER TIME: config changes between sweeps, and volume
// anomalies. The two rules that matter most are the negatives - no previous run means no findings,
// and an unread section is never reported as a deletion.
// Run: tsx src/main/google/__tests__/ads-snapshot.test.ts
import {
  captureAdsSnapshot,
  diffAdsSnapshots,
  detectVolumeAnomalies,
  MIN_VOLUME_FOR_ANOMALY,
  type AdsSnapshot,
} from '../ads-snapshot';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}
const has = (fs: Array<{ finding: string }>, re: RegExp): boolean => fs.some((f) => re.test(f.finding));
const sevOf = (fs: Array<{ finding: string; severity: string }>, re: RegExp): string | undefined => fs.find((f) => re.test(f.finding))?.severity;

const snap = (at: number, over: Partial<AdsSnapshot> = {}): AdsSnapshot => ({ at, windowDays: 30, ...over });

// ── capture ────────────────────────────────────────────────────────────────────
const captured = captureAdsSnapshot({
  at: 100,
  windowDays: 30,
  actions: [{ id: '1', name: 'Lead', status: 'ENABLED', primaryForGoal: true }],
  campaigns: [{ id: 'c1', name: 'Brand', status: 'ENABLED', budget: { amountMicros: 50_000_000 } }],
  audiences: [{ id: 'a1', name: 'Visitors', sizeForDisplay: 5000 }],
  volume: [{ id: '1', name: 'Lead', conversions: 40, conversionValue: 800 }],
});
check('capture keeps only the compared fields', Object.keys(captured.actions![0]).sort().join(',') === 'id,name,primaryForGoal,status');
check('capture defaults a missing primary flag to false', captureAdsSnapshot({ at: 1, windowDays: 30, actions: [{ id: '1', name: 'x', status: 'ENABLED' }] }).actions![0].primaryForGoal === false);
check('capture records a null budget as null, not 0', captureAdsSnapshot({ at: 1, windowDays: 30, campaigns: [{ id: 'c', name: 'x', status: 'ENABLED' }] }).campaigns![0].budgetMicros === null);
// The load-bearing distinction: a section that was not read is ABSENT, never an empty array.
check('an unread section is omitted, not emptied', captureAdsSnapshot({ at: 1, windowDays: 30 }).audiences === undefined);
check('a genuinely empty section IS an empty array', captureAdsSnapshot({ at: 1, windowDays: 30, audiences: [] }).audiences?.length === 0);

// ── rule 1: no previous run, no findings ───────────────────────────────────────
check('the FIRST sweep reports nothing', diffAdsSnapshots(undefined, captured).length === 0);
check('the first sweep reports no anomalies either', detectVolumeAnomalies(undefined, captured).length === 0);
check('a snapshot older than itself is refused', diffAdsSnapshots(snap(200, { actions: [] }), snap(100, { actions: [] })).length === 0);
check('two runs at the same instant are refused', diffAdsSnapshots(snap(100, { actions: [] }), snap(100, { actions: [] })).length === 0);

// ── rule 2: unread is not absent ───────────────────────────────────────────────
const withActions = snap(100, { actions: [{ id: '1', name: 'Lead', status: 'ENABLED', primaryForGoal: true }] });
// The audiences read failed this sweep. That must NOT read as "every audience was deleted".
const audiencesUnread = snap(200, { actions: withActions.actions });
const prevHadAudiences = snap(100, { actions: withActions.actions, audiences: [{ id: 'a1', name: 'Visitors', size: 5000 }] });
check('a section unread THIS run reports no deletions', diffAdsSnapshots(prevHadAudiences, audiencesUnread).length === 0);
check('a section unread LAST run reports nothing either',
  diffAdsSnapshots(snap(100, {}), snap(200, { audiences: [{ id: 'a1', name: 'V', size: 1 }] })).length === 0);

// ── conversion actions ─────────────────────────────────────────────────────────
const before = snap(100, { actions: [
  { id: '1', name: 'Lead', status: 'ENABLED', primaryForGoal: true },
  { id: '2', name: 'Call', status: 'ENABLED', primaryForGoal: false },
] });
const deleted = diffAdsSnapshots(before, snap(200, { actions: [{ id: '2', name: 'Call', status: 'ENABLED', primaryForGoal: false }] }));
check('a deleted conversion action is CRITICAL', sevOf(deleted, /"Lead" is gone/) === 'critical');
check('the deletion says what it costs', has(deleted, /stopped being recorded/));

const disabled = diffAdsSnapshots(before, snap(200, { actions: [
  { id: '1', name: 'Lead', status: 'REMOVED', primaryForGoal: true },
  { id: '2', name: 'Call', status: 'ENABLED', primaryForGoal: false },
] }));
check('ENABLED -> anything else is CRITICAL', sevOf(disabled, /ENABLED to REMOVED/) === 'critical');

const demoted = diffAdsSnapshots(before, snap(200, { actions: [
  { id: '1', name: 'Lead', status: 'ENABLED', primaryForGoal: false },
  { id: '2', name: 'Call', status: 'ENABLED', primaryForGoal: false },
] }));
check('losing primary-for-goal is CRITICAL', sevOf(demoted, /no longer counted in "Conversions"/) === 'critical');
check('it explains the bidding impact', has(demoted, /smart bidding|Smart bidding/i));

const renamed = diffAdsSnapshots(before, snap(200, { actions: [
  { id: '1', name: 'Lead Form', status: 'ENABLED', primaryForGoal: true },
  { id: '2', name: 'Call', status: 'ENABLED', primaryForGoal: false },
] }));
// A rename is not a fault. Grading it above info would train the user to ignore the section.
check('a rename is INFO, not a fault', sevOf(renamed, /renamed/) === 'info');
check('a new action is INFO', sevOf(diffAdsSnapshots(before, snap(200, { actions: [...before.actions!, { id: '3', name: 'Chat', status: 'ENABLED', primaryForGoal: false }] })), /New conversion action/) === 'info');
check('an unchanged account reports nothing', diffAdsSnapshots(before, snap(200, { actions: before.actions })).length === 0);

// ── campaigns ──────────────────────────────────────────────────────────────────
const camps = snap(100, { campaigns: [{ id: 'c1', name: 'Brand', status: 'ENABLED', budgetMicros: 50_000_000 }] });
check('a paused campaign is a WARNING', sevOf(diffAdsSnapshots(camps, snap(200, { campaigns: [{ id: 'c1', name: 'Brand', status: 'PAUSED', budgetMicros: 50_000_000 }] })), /was paused/) === 'warning');
check('a removed campaign is CRITICAL', sevOf(diffAdsSnapshots(camps, snap(200, { campaigns: [] })), /is gone/) === 'critical');
check('resuming is INFO', sevOf(diffAdsSnapshots(snap(100, { campaigns: [{ id: 'c1', name: 'B', status: 'PAUSED', budgetMicros: 1 }] }), snap(200, { campaigns: [{ id: 'c1', name: 'B', status: 'ENABLED', budgetMicros: 1 }] })), /resumed/) === 'info');
const bigBudget = diffAdsSnapshots(camps, snap(200, { campaigns: [{ id: 'c1', name: 'Brand', status: 'ENABLED', budgetMicros: 100_000_000 }] }));
check('a large budget move is a WARNING', sevOf(bigBudget, /Daily budget/) === 'warning');
check('the budget finding shows currency units, never micros', has(bigBudget, /50\.00 to 100\.00/) && !has(bigBudget, /50000000/));
check('a small budget move is INFO', sevOf(diffAdsSnapshots(camps, snap(200, { campaigns: [{ id: 'c1', name: 'Brand', status: 'ENABLED', budgetMicros: 55_000_000 }] })), /Daily budget/) === 'info');

// ── audiences ──────────────────────────────────────────────────────────────────
const auds = snap(100, { audiences: [{ id: 'a1', name: 'Visitors', size: 10_000 }] });
check('an audience emptying is a WARNING', sevOf(diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'Visitors', size: 0 }] })), /dropped to zero/) === 'warning');
check('a halved audience is reported', has(diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'Visitors', size: 4_000 }] })), /shrank 60%/));
check('a mild dip is NOT reported', diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'Visitors', size: 9_000 }] })).length === 0);
// A size Google did not report is not a shrink to zero.
check('an unreported size is never a shrink', diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'Visitors', size: null }] })).length === 0);
check('growth is not reported as a problem', diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'Visitors', size: 50_000 }] })).length === 0);

// ── volume anomalies ───────────────────────────────────────────────────────────
const vBefore = snap(100, { volume: [{ id: '1', name: 'Lead', conversions: 100, value: 5000 }] });
check('a 70%+ collapse is CRITICAL', sevOf(detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 20, value: 1000 }] })), /fell 80%/) === 'critical');
check('a 3x spike is a WARNING', sevOf(detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 400, value: 20000 }] })), /rose 300%/) === 'warning');
check('the collapse names the likely cause', has(detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 5, value: 0 }] })), /broken tag/));
check('normal movement is not an anomaly', detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 90, value: 4500 }] })).length === 0);

// The floor: a percentage over a handful of conversions is arithmetic, not signal.
const tiny = snap(100, { volume: [{ id: '1', name: 'Lead', conversions: MIN_VOLUME_FOR_ANOMALY - 1, value: 10 }] });
check('a tiny baseline going to zero is NOT an anomaly', detectVolumeAnomalies(tiny, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 0, value: 0 }] })).length === 0);
check('exactly at the floor DOES report', detectVolumeAnomalies(snap(100, { volume: [{ id: '1', name: 'L', conversions: MIN_VOLUME_FOR_ANOMALY, value: 1 }] }), snap(200, { volume: [{ id: '1', name: 'L', conversions: 0, value: 0 }] })).length > 0);

// Value disappearing while conversions continue is invisible in a conversion count.
check('value collapsing while conversions continue is caught',
  has(detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 95, value: 0 }] })), /value is now zero/));
check('value zero with zero conversions is NOT double-reported as a value break',
  !has(detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 0, value: 0 }] })), /value is now zero/));

// Comparing across different windows manufactures a drop out of arithmetic alone.
check('different windows are refused, not compared',
  detectVolumeAnomalies(snap(100, { windowDays: 7, volume: [{ id: '1', name: 'L', conversions: 100, value: 1 }] }), snap(200, { windowDays: 30, volume: [{ id: '1', name: 'L', conversions: 20, value: 1 }] })).length === 0);
check('an action absent last run is skipped, not called a drop',
  detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '9', name: 'New', conversions: 1, value: 0 }] })).length === 0);

// ── house style ────────────────────────────────────────────────────────────────
const ALL = [
  ...diffAdsSnapshots(before, snap(200, { actions: [] })),
  ...diffAdsSnapshots(camps, snap(200, { campaigns: [] })),
  ...diffAdsSnapshots(auds, snap(200, { audiences: [{ id: 'a1', name: 'V', size: 0 }] })),
  ...detectVolumeAnomalies(vBefore, snap(200, { volume: [{ id: '1', name: 'Lead', conversions: 1, value: 0 }] })),
].map((f) => f.finding).join(' ');
check('no em or en dashes in any finding', !/[—–]/.test(ALL), ALL.match(/.{0,25}[—–].{0,25}/)?.[0]);
check('every finding names the entity it is about', diffAdsSnapshots(before, snap(200, { actions: [] })).every((f) => /"/.test(f.finding)));

if (failures.length) console.error(failures.join('\n'));
console.log(`ads-snapshot: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
