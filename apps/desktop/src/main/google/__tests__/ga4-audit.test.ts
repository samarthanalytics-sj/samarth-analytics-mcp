import assert from 'node:assert/strict';
import { auditGa4 } from '../ga4-audit';
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

// A fully-healthy property — every check should pass.
const base = (over: Partial<Ga4PropertySnapshot> = {}): Ga4PropertySnapshot => ({
  property: 'properties/1',
  displayName: 'Site',
  timeZone: 'UTC',
  currencyCode: 'USD',
  industryCategory: 'TECHNOLOGY',
  dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true },
  keyEvents: [{ eventName: 'purchase' }],
  // Fully instrumented by default (a dimension + a metric) so "healthy" means no under-instrumentation.
  customDimensions: [{ parameterName: 'membership_tier', displayName: 'Membership Tier', scope: 'USER' }],
  customMetrics: [{ parameterName: 'loyalty_points', displayName: 'Loyalty Points' }],
  dataStreams: [{ name: 'properties/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true }],
  googleAdsLinks: 1,
  googleSignals: 'GOOGLE_SIGNALS_ENABLED',
  ...over,
});

const cats = (s: Ga4PropertySnapshot): string[] => auditGa4(s).findings.map((f) => f.category);

console.log('\nGA4 audit:');

test('a healthy property produces no findings', () => {
  assert.equal(auditGa4(base()).findings.length, 0);
});

test('no data streams → high collection finding', () => {
  const r = auditGa4(base({ dataStreams: [] }));
  assert.ok(r.findings.some((f) => f.category === 'collection' && f.severity === 'high'));
});

test('2-month (default) retention → medium retention finding', () => {
  const r = auditGa4(base({ dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: true } }));
  assert.ok(r.findings.some((f) => f.category === 'retention' && f.severity === 'medium'));
  // 14 months is fine.
  assert.ok(!cats(base({ dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true } })).includes('retention'));
  // unreadable retention (null) is not flagged.
  assert.ok(!cats(base({ dataRetention: null })).includes('retention'));
});

test('no key events → medium conversions finding', () => {
  assert.ok(cats(base({ keyEvents: [] })).includes('conversions'));
});

test('enhanced measurement off on a WEB stream → low measurement finding', () => {
  const r = auditGa4(base({ dataStreams: [{ name: 'p/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: false }] }));
  assert.ok(r.findings.some((f) => f.category === 'measurement' && f.severity === 'low' && f.message.includes('Web')));
});

test('app stream (enhanced n/a) is not flagged for measurement', () => {
  const r = cats(base({ dataStreams: [{ name: 'p/1/dataStreams/9', displayName: 'Android', type: 'ANDROID_APP_DATA_STREAM', enhancedMeasurementEnabled: null }] }));
  assert.ok(!r.includes('measurement'));
});

test('PII-looking custom dimension → high privacy finding; user_id is NOT flagged', () => {
  const pii = auditGa4(base({ customDimensions: [{ parameterName: 'user_email', displayName: 'User Email', scope: 'EVENT' }] }));
  assert.ok(pii.findings.some((f) => f.category === 'privacy' && f.severity === 'high' && f.message.includes('Email')));
  // user_id is a pseudonymous id, not PII.
  assert.ok(!cats(base({ customDimensions: [{ parameterName: 'user_id', displayName: 'User ID', scope: 'USER' }] })).includes('privacy'));
  // bare "name" is too broad (page_name, event_name) — not flagged.
  assert.ok(!cats(base({ customDimensions: [{ parameterName: 'page_name', displayName: 'Page Name', scope: 'EVENT' }] })).includes('privacy'));
});

test('PII check matches snake_case parameter names even when the displayName is generic', () => {
  // The real GA4 case: parameterName is snake_case, displayName is non-PII.
  const cases = [
    { parameterName: 'user_email', displayName: 'Customer Contact' },
    { parameterName: 'phone_number', displayName: 'phone_number' },
    { parameterName: 'billing_address', displayName: 'Addr' },
    { parameterName: 'zip_code', displayName: 'Zip' },
    { parameterName: 'user_first_name', displayName: 'First' },
  ];
  for (const c of cases) {
    assert.ok(
      cats(base({ customDimensions: [{ ...c, scope: 'EVENT' }] })).includes('privacy'),
      `expected ${c.parameterName} to be flagged as PII`
    );
  }
  // Still no false positives on these snake_case non-PII names.
  for (const safe of ['user_id', 'page_name', 'event_name', 'item_id', 'session_id']) {
    assert.ok(
      !cats(base({ customDimensions: [{ parameterName: safe, displayName: safe, scope: 'EVENT' }] })).includes('privacy'),
      `did not expect ${safe} to be flagged`
    );
  }
});

test('unreadable sub-resources (null) are not reported as "zero" misconfigurations', () => {
  // A failed read = null (not []), so the audit must NOT fabricate a finding.
  assert.ok(!cats(base({ keyEvents: null })).includes('conversions'));
  assert.ok(!cats(base({ googleAdsLinks: null })).includes('integrations'));
  // Unreadable custom dimensions → no PII scan (can't assert clean), no crash.
  assert.doesNotThrow(() => auditGa4(base({ customDimensions: null })));
  assert.ok(!cats(base({ customDimensions: null })).includes('privacy'));
});

test('no Google Ads links → info integrations finding', () => {
  assert.ok(cats(base({ googleAdsLinks: 0 })).includes('integrations'));
  assert.ok(!cats(base({ googleAdsLinks: 2 })).includes('integrations'));
});

test('Google Signals disabled + Ads linked → info integrations finding (only when both hold)', () => {
  const msgs = (over = {}) => auditGa4(base(over)).findings.filter((f) => /Google Signals is disabled/.test(f.message));
  assert.equal(msgs({ googleSignals: 'GOOGLE_SIGNALS_DISABLED', googleAdsLinks: 2 }).length, 1, 'disabled + Ads → flagged');
  assert.equal(msgs({ googleSignals: 'GOOGLE_SIGNALS_DISABLED', googleAdsLinks: 0 }).length, 0, 'disabled but no Ads → not flagged');
  assert.equal(msgs({ googleSignals: 'GOOGLE_SIGNALS_ENABLED', googleAdsLinks: 2 }).length, 0, 'enabled → not flagged');
  assert.equal(msgs({ googleSignals: null, googleAdsLinks: 2 }).length, 0, 'unreadable signals → not flagged');
  assert.equal(msgs({ googleSignals: 'GOOGLE_SIGNALS_DISABLED', googleAdsLinks: null }).length, 0, 'unreadable ads → not flagged');
});

test('industry category unset → info benchmarking finding', () => {
  assert.ok(cats(base({ industryCategory: '' })).includes('benchmarking'));
  assert.ok(cats(base({ industryCategory: 'INDUSTRY_CATEGORY_UNSPECIFIED' })).includes('benchmarking'));
});

test('a fully-instrumented healthy property: every area Pass except Data collection (Partial — deep health not API-verifiable)', () => {
  const r = auditGa4(base());
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  const st = (a: string) => r.areas.find((x) => x.area === a)?.status;
  assert.equal(st('Data collection'), 'partial', 'collection is Partial, never a blind Pass');
  for (const a of ['Data retention', 'Key events', 'Custom definitions', 'Privacy (PII)', 'Integrations', 'Benchmarking']) {
    assert.equal(st(a), 'pass', `${a} should pass`);
  }
});

test('Data collection grading: Partial when a stream exists (deep health unverifiable), Fail when none', () => {
  assert.equal(auditGa4(base()).areas.find((a) => a.area === 'Data collection')?.status, 'partial');
  assert.equal(auditGa4(base({ dataStreams: [] })).areas.find((a) => a.area === 'Data collection')?.status, 'fail');
});

test('zero custom definitions on a property that marks key events → under-instrumentation finding + Partial', () => {
  const r = auditGa4(base({ customDimensions: [], customMetrics: [] }));
  assert.ok(r.findings.some((f) => f.category === 'customdef' && /No custom dimensions or metrics/.test(f.message)));
  assert.equal(r.areas.find((a) => a.area === 'Custom definitions')?.status, 'partial');
  // A property with NO key events (nothing to measure) is not nagged about missing custom defs.
  assert.ok(!auditGa4(base({ customDimensions: [], customMetrics: [], keyEvents: [] })).findings.some((f) => /No custom dimensions or metrics/.test(f.message)));
});

test('custom-dimension slot usage near the cap → low customdef finding + Partial coverage', () => {
  const ev = Array.from({ length: 46 }, (_, i) => ({ parameterName: `p${i}`, displayName: `P${i}`, scope: 'EVENT' }));
  const r = auditGa4(base({ customDimensions: ev }));
  assert.ok(r.findings.some((f) => f.category === 'customdef' && f.severity === 'low' && /50/.test(f.message)));
  assert.equal(r.areas.find((a) => a.area === 'Custom definitions')?.status, 'partial');
  const us = Array.from({ length: 23 }, (_, i) => ({ parameterName: `u${i}`, displayName: `U${i}`, scope: 'USER' }));
  assert.ok(auditGa4(base({ customDimensions: us })).findings.some((f) => f.category === 'customdef' && /25/.test(f.message)));
  // Well under the cap → no slot finding.
  assert.ok(!cats(base({ customDimensions: [{ parameterName: 'a', displayName: 'A', scope: 'EVENT' }] })).includes('customdef'));
});

test('more than one WEB data stream → info collection finding', () => {
  const r = auditGa4(base({ dataStreams: [
    { name: 'p/1/dataStreams/1', displayName: 'A', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true },
    { name: 'p/1/dataStreams/2', displayName: 'B', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true },
  ] }));
  assert.ok(r.findings.some((f) => f.category === 'collection' && f.severity === 'info' && /web data streams/i.test(f.message)));
});

test('retention not resetting on new activity → low retention finding', () => {
  const r = auditGa4(base({ dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: false } }));
  assert.ok(r.findings.some((f) => f.category === 'retention' && f.severity === 'low' && /reset/i.test(f.message)));
});

test('coverage marks unread (null) sub-resources Not Verified, never a silent Pass', () => {
  const r = auditGa4(base({ keyEvents: null, dataRetention: null, customDimensions: null, googleAdsLinks: null, googleSignals: null }));
  const st = (area: string) => r.areas.find((a) => a.area === area)?.status;
  assert.equal(st('Key events'), 'not_verified');
  assert.equal(st('Data retention'), 'not_verified');
  assert.equal(st('Custom definitions'), 'not_verified');
  assert.equal(st('Privacy (PII)'), 'not_verified');
  assert.equal(st('Integrations'), 'not_verified');
  // Collection always reads (data streams exist) → Partial (deep health unverifiable), never Not Verified.
  assert.equal(st('Data collection'), 'partial');
});

test('coverage reflects severity: Fail on a high finding, Partial on medium/low', () => {
  assert.equal(auditGa4(base({ dataStreams: [] })).areas.find((a) => a.area === 'Data collection')?.status, 'fail');
  assert.equal(auditGa4(base({ keyEvents: [] })).areas.find((a) => a.area === 'Key events')?.status, 'partial');
});

test('counts + severity summary are consistent', () => {
  const r = auditGa4(base({ dataStreams: [], keyEvents: [], googleAdsLinks: 0 }));
  assert.equal(r.counts.findings, r.findings.length);
  assert.equal(r.summary.high + r.summary.medium + r.summary.low + r.summary.info, r.findings.length);
  assert.equal(r.counts.dataStreams, 0);
});

test('service-level-aware retention: GA360 at 14 months is under-retained (recommend 50); standard 14mo is fine', () => {
  const r = auditGa4(base({ serviceLevel: 'GOOGLE_ANALYTICS_360', dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true } }));
  assert.ok(r.findings.some((f) => f.category === 'retention' && /50 months/.test(f.recommendation)));
  // TWENTY_SIX_MONTHS (a real GA360 value) renders as "26 months", not the raw enum.
  const r26 = auditGa4(base({ serviceLevel: 'GOOGLE_ANALYTICS_360', dataRetention: { eventDataRetention: 'TWENTY_SIX_MONTHS', resetOnNewActivity: true } }));
  assert.ok(r26.findings.some((f) => f.category === 'retention' && /26 months/.test(f.message) && !/TWENTY_SIX/.test(f.message)));
  assert.ok(!cats(base({ serviceLevel: 'GOOGLE_ANALYTICS_360', dataRetention: { eventDataRetention: 'FIFTY_MONTHS', resetOnNewActivity: true } })).includes('retention'));
  assert.ok(!cats(base({ dataRetention: { eventDataRetention: 'FOURTEEN_MONTHS', resetOnNewActivity: true } })).includes('retention'));
});

test('attribution: last-click model + short "other" lookback → findings; data-driven + 90d is clean; unread → Not Verified', () => {
  const bad = auditGa4(base({ attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_LAST_CLICK', acquisitionLookback: 'X_30_DAYS', otherLookback: 'CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS' } }));
  assert.ok(bad.findings.some((f) => f.category === 'attribution' && /last-click/i.test(f.message)));
  assert.ok(bad.findings.some((f) => f.category === 'attribution' && /lookback/i.test(f.message)));
  assert.equal(bad.areas.find((a) => a.area === 'Attribution')?.status, 'partial');
  const good = auditGa4(base({ attribution: { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN', acquisitionLookback: 'X', otherLookback: 'CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS' } }));
  assert.ok(!good.findings.some((f) => f.category === 'attribution'));
  assert.equal(good.areas.find((a) => a.area === 'Attribution')?.status, 'pass');
  assert.equal(auditGa4(base()).areas.find((a) => a.area === 'Attribution')?.status, 'not_verified');
});

test('enhanced-measurement sub-toggles off while master on → measurement finding', () => {
  const r = auditGa4(base({ dataStreams: [{ name: 'p/1/dataStreams/9', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true, enhancedMeasurement: { siteSearchEnabled: false, pageChangesEnabled: false, formInteractionsEnabled: true } }] }));
  assert.ok(r.findings.some((f) => f.category === 'measurement' && /site search/i.test(f.message) && /SPA page changes/i.test(f.message)));
  assert.equal(r.areas.find((a) => a.area === 'Enhanced measurement')?.status, 'partial');
  assert.ok(!cats(base({ dataStreams: [{ name: 'x', displayName: 'Web', type: 'WEB_DATA_STREAM', enhancedMeasurementEnabled: true, enhancedMeasurement: { siteSearchEnabled: true, pageChangesEnabled: true, formInteractionsEnabled: true } }] })).includes('measurement'));
});

test('BigQuery: none configured → info; a link with no export enabled → low; a working link → clean', () => {
  assert.ok(auditGa4(base({ bigQueryLinks: [] })).findings.some((f) => f.category === 'integrations' && /No BigQuery/i.test(f.message)));
  assert.ok(auditGa4(base({ bigQueryLinks: [{ project: 'my-gcp', dailyExportEnabled: false, streamingExportEnabled: false }] })).findings.some((f) => f.category === 'integrations' && f.severity === 'low' && /no export/i.test(f.message)));
  assert.ok(!auditGa4(base({ bigQueryLinks: [{ project: 'my-gcp', dailyExportEnabled: true, streamingExportEnabled: false }] })).findings.some((f) => /BigQuery/i.test(f.message)));
});

test('audiences: none while Ads linked + key events → integrations info; not flagged without Ads or when present', () => {
  assert.ok(auditGa4(base({ audiences: 0 })).findings.some((f) => /No audiences/i.test(f.message)));
  assert.ok(!auditGa4(base({ audiences: 0, googleAdsLinks: 0 })).findings.some((f) => /No audiences/i.test(f.message)));
  assert.ok(!auditGa4(base({ audiences: 3 })).findings.some((f) => /No audiences/i.test(f.message)));
});

test('reporting currency unset → info collection finding', () => {
  assert.ok(auditGa4(base({ currencyCode: '' })).findings.some((f) => f.category === 'collection' && /currency/i.test(f.message)));
  assert.ok(!auditGa4(base({ currencyCode: 'EUR' })).findings.some((f) => /currency/i.test(f.message)));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
