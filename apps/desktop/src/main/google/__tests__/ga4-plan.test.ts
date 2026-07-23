import assert from 'node:assert/strict';
import { severityFor } from '../../../shared/ga4-check-severity';
import { buildGa4Plan, streamIdOf } from '../ga4-plan';
import type { Ga4PropertySnapshot } from '../ga4-audit';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const snap = (over: Partial<Ga4PropertySnapshot> = {}): Ga4PropertySnapshot => ({
  property: 'properties/5',
  displayName: 'Store',
  timeZone: 'Asia/Kolkata',
  currencyCode: 'INR',
  industryCategory: 'SHOPPING',
  dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true },
  keyEvents: [{ eventName: 'purchase' }],
  customDimensions: [],
  customMetrics: [],
  dataStreams: [
    { name: 'properties/5/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true, enhancedMeasurement: { siteSearchEnabled: true, pageChangesEnabled: true, formInteractionsEnabled: true } },
  ],
  googleAdsLinks: 1,
  googleSignals: 'GOOGLE_SIGNALS_ENABLED',
  attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN', acquisitionLookback: '30', otherLookback: '90' } as never,
  bigQueryLinks: [],
  audiences: 2,
  ...over,
});

console.log('\nga4-plan:');

test('a clean property plans NOTHING to fix - verified states listed as ok, email redaction stays optional', () => {
  const plan = buildGa4Plan(snap());
  const issues = plan.items.filter((i) => i.status === 'issue');
  assert.deepEqual(issues.map((i) => i.id), ['email_redaction:9'], 'only the unread-state hardening offer remains');
  assert.equal(issues[0].defaultSelected, false, 'never pre-checked when current state is unread');
  assert.ok(/not read by this audit/.test(issues[0].description), 'honest about the unread state');
  assert.ok(plan.items.some((i) => i.id === 'retention' && i.status === 'ok'));
  assert.ok(plan.items.some((i) => i.id === 'em_ok:9' && i.status === 'ok'));
});

test('2-month retention plans a pre-checked fix graded LIKE THE AUDIT; reset-off plans a LOW fix', () => {
  const plan = buildGa4Plan(snap({ dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: false } }));
  const r = plan.items.find((i) => i.id === 'retention_14')!;
  // Was 'high' here while the audit called the same fact 'medium', on the same screen. One table
  // now grades it (shared/ga4-check-severity), and the audit's scale wins.
  assert.equal(r.category, severityFor('retention_two_months', 'medium'));
  assert.equal(r.category, 'medium');
  assert.equal(r.defaultSelected, true);
  assert.ok(plan.items.some((i) => i.id === 'retention_reset' && i.category === 'low'));
});

test('EM master OFF plans one HIGH item and suppresses sub-toggles; per-toggle items when master is on', () => {
  const off = buildGa4Plan(snap({ dataStreams: [{ name: 'properties/5/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: false }] }));
  assert.ok(off.items.some((i) => i.id === 'em_master:9' && i.category === 'high' && i.defaultSelected));
  assert.ok(!off.items.some((i) => i.id.startsWith('em_site_search')), 'sub-toggles meaningless while master is off');
  const partial = buildGa4Plan(snap({ dataStreams: [{ name: 'properties/5/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true, enhancedMeasurement: { siteSearchEnabled: false, pageChangesEnabled: false, formInteractionsEnabled: true } }] }));
  const search = partial.items.find((i) => i.id === 'em_site_search:9')!;
  assert.deepEqual(search.requires, ['searchQueryParameter']);
  assert.ok(partial.items.some((i) => i.id === 'em_page_changes:9'));
});

test('privacy/business decisions are executable but NEVER pre-selected', () => {
  const plan = buildGa4Plan(snap({ googleSignals: 'GOOGLE_SIGNALS_DISABLED', attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_LAST_CLICK' } as never }));
  const sig = plan.items.find((i) => i.id === 'google_signals_on')!;
  assert.equal(sig.executable, true);
  assert.equal(sig.defaultSelected, false);
  assert.ok(/privacy disclosures/.test(sig.description));
  const at = plan.items.find((i) => i.id === 'attribution_data_driven')!;
  assert.equal(at.defaultSelected, false);
  assert.ok(/re-states historical/.test(at.description));
});

test('zero key events is an advisory graded like the audit, not fake-executable (needs a human event choice)', () => {
  const plan = buildGa4Plan(snap({ keyEvents: [] }));
  const ke = plan.items.find((i) => i.id === 'key_events')!;
  assert.equal(ke.category, severityFor('no_key_events', 'medium'));
  assert.equal(ke.executable, false);
  // Unreadable is DISTINCT from zero - no finding when null.
  assert.ok(!buildGa4Plan(snap({ keyEvents: null })).items.some((i) => i.id === 'key_events'));
});

test('streamIdOf extracts the numeric id', () => {
  assert.equal(streamIdOf('properties/5/dataStreams/91'), '91');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
