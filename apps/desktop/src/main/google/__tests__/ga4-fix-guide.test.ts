// Pure tests for the GA4 fix guide: every finding has BOTH a documented manual path and (only where a
// write tool truly applies it) a one-click plan item. Run with tsx.
import { GA4_FIX_GUIDE, fixGuideFor, planItemMatches } from '../ga4-fix-guide';
import { auditGa4, type Ga4PropertySnapshot } from '../ga4-audit';
import { buildGa4Plan } from '../ga4-plan';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean): void => { if (cond) passed += 1; else { failed += 1; failures.push(name); } };

// ── every guide entry is complete ────────────────────────────────────────────────────────────────
{
  const ids = Object.keys(GA4_FIX_GUIDE);
  check('guide: has entries', ids.length >= 20);
  check('guide: EVERY entry has at least one manual step (no dead ends)', ids.every((k) => GA4_FIX_GUIDE[k].steps.length > 0));
  check('guide: every step is a non-empty string', ids.every((k) => GA4_FIX_GUIDE[k].steps.every((s) => s.trim().length > 0)));
  check('guide: where is always set', ids.every((k) => ['auto', 'ga4-ui', 'site'].includes(GA4_FIX_GUIDE[k].where)));
  // The honesty rule: a planIdPrefix EXISTS if and only if where === 'auto'.
  check('guide: planIdPrefix present exactly when where=auto',
    ids.every((k) => (GA4_FIX_GUIDE[k].where === 'auto') === Boolean(GA4_FIX_GUIDE[k].planIdPrefix)));
  // Things GA4's Admin API cannot fix must never claim a one-click.
  check('guide: site-side checks never claim a one-click fix',
    ['pii_custom_dimension', 'param_naming'].every((k) => GA4_FIX_GUIDE[k].where === 'site' && !GA4_FIX_GUIDE[k].planIdPrefix));
  check('guide: 360 under-retention is manual (retention_14 would under-set it to 14mo)',
    GA4_FIX_GUIDE.retention_360_under.where === 'ga4-ui' && !GA4_FIX_GUIDE.retention_360_under.planIdPrefix);
  check('guide: key events stay manual (which events are conversions is a human decision)',
    GA4_FIX_GUIDE.no_key_events.where === 'ga4-ui' && !GA4_FIX_GUIDE.no_key_events.planIdPrefix);
}

// ── planItemMatches: exact id or `id:<streamId>`, never a loose prefix ───────────────────────────
check('match: exact id', planItemMatches('retention_14', 'retention_14'));
check('match: per-stream suffixed id', planItemMatches('em_site_search:123', 'em_site_search'));
check('match: does NOT loosely prefix-match a different id', !planItemMatches('retention_140', 'retention_14'));
check('match: unrelated id does not match', !planItemMatches('google_signals_on', 'retention_14'));

// ── fixGuideFor ──────────────────────────────────────────────────────────────────────────────────
check('lookup: known checkId resolves', fixGuideFor('retention_two_months')?.planIdPrefix === 'retention_14');
check('lookup: unknown checkId is null (never throws)', fixGuideFor('not_a_check') === null);
check('lookup: undefined checkId is null', fixGuideFor(undefined) === null);

// ── the join is REAL: every auto guide's prefix matches a plan item the plan engine can emit ─────
{
  // A deliberately broken property so the plan emits its executable items.
  const snap: Ga4PropertySnapshot = {
    property: 'properties/1', displayName: 'Test', serviceLevel: 'GOOGLE_ANALYTICS_STANDARD',
    dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: false },
    dataStreams: [{ name: 'properties/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true, enhancedMeasurement: { siteSearchEnabled: false, pageChangesEnabled: false, formInteractionsEnabled: false } }],
    keyEvents: [], customDimensions: [], customMetrics: [],
    attribution: { reportingAttributionModel: 'CROSS_CHANNEL_LAST_CLICK', otherConversionEventLookbackWindow: '' },
    googleSignals: 'GOOGLE_SIGNALS_DISABLED',
  } as unknown as Ga4PropertySnapshot;
  // The master-off and master-on branches are mutually exclusive in the plan (sub-toggles are skipped
  // while the master is off), so union BOTH to cover every executable item the engine can emit.
  const snapMasterOff: Ga4PropertySnapshot = {
    ...snap,
    dataStreams: [{ name: 'properties/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: false }],
  } as unknown as Ga4PropertySnapshot;
  const planIds = [
    ...buildGa4Plan(snap).items.filter((i) => i.executable).map((i) => i.id),
    ...buildGa4Plan(snapMasterOff).items.filter((i) => i.executable).map((i) => i.id),
  ];
  const autoPrefixes = Object.values(GA4_FIX_GUIDE).filter((g) => g.where === 'auto').map((g) => g.planIdPrefix!);
  const unmatched = autoPrefixes.filter((p) => !planIds.some((id) => planItemMatches(id, p)));
  check(`join: every auto prefix matches a real executable plan item (unmatched: ${unmatched.join(', ') || 'none'})`, unmatched.length === 0);
}

// ── every finding the audit can emit has a guide entry ───────────────────────────────────────────
{
  // Drive the audit with an empty-ish property to collect the checkIds it emits, then assert coverage.
  const snap = { property: 'properties/1', displayName: 'T', dataStreams: [], dataRetention: null, keyEvents: null, customDimensions: [], customMetrics: [] } as unknown as Ga4PropertySnapshot;
  const emitted = auditGa4(snap).findings.map((f) => f.checkId).filter(Boolean) as string[];
  const missing = emitted.filter((id) => !GA4_FIX_GUIDE[id]);
  check(`coverage: every emitted checkId has a guide (missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
  check('coverage: findings actually carry a checkId', emitted.length > 0);
}

console.log(`\nga4-fix-guide: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 18) { console.error(`expected >= 18 checks, got ${passed}`); process.exit(1); }
