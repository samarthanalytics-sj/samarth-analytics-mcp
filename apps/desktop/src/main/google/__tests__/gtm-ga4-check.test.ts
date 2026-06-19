import assert from 'node:assert/strict';
import { extractConfiguredGa4Ids, crossCheckMeasurementIds } from '../gtm-ga4-check';
import type { ContainerSnapshot } from '../gtm-builders';

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

const tag = (over: Record<string, unknown>) => ({
  tagId: '', name: '', type: 'gaawe', firingTriggerId: [] as string[], paused: false,
  parameter: [] as Array<Record<string, unknown>>, ...over,
});
const snap = (tags: Array<Record<string, unknown>>): ContainerSnapshot => ({ tags: tags as never, triggers: [], variables: [] });

console.log('\nGTM↔GA4 measurement-id check:');

test('extracts G- ids from gaawe / gaawc / googtag / html, and flags {{variable}}', () => {
  const c = extractConfiguredGa4Ids(
    snap([
      tag({ name: 'GA4 Event', type: 'gaawe', parameter: [{ key: 'measurementIdOverride', value: 'G-ABC123' }] }),
      tag({ name: 'GA4 Config', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-DEF456' }] }),
      tag({ name: 'Google Tag', type: 'googtag', parameter: [{ key: 'tagId', value: 'G-GHI789' }] }),
      tag({ name: 'Inline gtag', type: 'html', parameter: [{ key: 'html', value: "gtag('config','G-HTML0001')" }] }),
      tag({ name: 'Var Event', type: 'gaawe', parameter: [{ key: 'measurementIdOverride', value: '{{GA4 Measurement ID}}' }] }),
    ])
  );
  assert.deepEqual(c.ids.map((x) => x.id).sort(), ['G-ABC123', 'G-DEF456', 'G-GHI789', 'G-HTML0001']);
  assert.equal(c.variableRefs.length, 1);
  assert.equal(c.variableRefs[0].tag, 'Var Event');
});

test('an empty measurementIdOverride does NOT shadow the real measurementId', () => {
  // Common GTM serialization: GA4 tag emits an empty override slot ahead of the
  // real id. The ?? chain must fall through the empty value.
  const c = extractConfiguredGa4Ids(
    snap([
      tag({ name: 'Inherits id', type: 'gaawc', parameter: [{ key: 'measurementIdOverride', value: '' }, { key: 'measurementId', value: 'G-CONFIG99' }] }),
    ])
  );
  assert.deepEqual(c.ids.map((x) => x.id), ['G-CONFIG99']);
  assert.equal(c.variableRefs.length, 0);
});

test('a short GA4 id in an inline gtag snippet is extracted (HTML/param thresholds agree)', () => {
  const c = extractConfiguredGa4Ids(
    snap([tag({ name: 'Inline', type: 'html', parameter: [{ key: 'html', value: "gtag('config','G-ABC123')" }] })])
  );
  assert.deepEqual(c.ids.map((x) => x.id), ['G-ABC123']);
});

test('googtag carrying an AW- id is not a GA4 id', () => {
  const c = extractConfiguredGa4Ids(snap([tag({ name: 'Ads gtag', type: 'googtag', parameter: [{ key: 'tagId', value: 'AW-12345' }] })]));
  assert.equal(c.ids.length, 0);
  assert.equal(c.variableRefs.length, 0);
});

test('crossCheck: matched ids resolve to their property; unmatched are reported', () => {
  const configured = extractConfiguredGa4Ids(
    snap([
      tag({ name: 'Live', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-LIVE111' }] }),
      tag({ name: 'Typo', type: 'gaawe', parameter: [{ key: 'measurementIdOverride', value: 'G-WRONG99' }] }),
    ])
  );
  const accessible = [
    { measurementId: 'G-LIVE111', property: 'properties/1', propertyDisplayName: 'Main Site' },
    { measurementId: 'G-OTHER22', property: 'properties/2', propertyDisplayName: 'Blog' },
  ];
  const r = crossCheckMeasurementIds(configured, accessible);
  assert.deepEqual(r.matched.map((m) => [m.id, m.propertyDisplayName]), [['G-LIVE111', 'Main Site']]);
  assert.deepEqual(r.notFound.map((n) => n.id), ['G-WRONG99']);
  assert.deepEqual(r.summary, { configured: 2, matched: 1, notFound: 1, usesVariable: 0 });
});

test('crossCheck: id match is case-insensitive', () => {
  const configured = extractConfiguredGa4Ids(snap([tag({ name: 'T', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'g-abc123' }] })]));
  const r = crossCheckMeasurementIds(configured, [{ measurementId: 'G-ABC123', property: 'properties/1', propertyDisplayName: 'Site' }]);
  assert.equal(r.matched.length, 1);
  assert.equal(r.notFound.length, 0);
});

test('crossCheck: a clean container with all ids accessible has no notFound', () => {
  const configured = extractConfiguredGa4Ids(snap([tag({ name: 'T', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-OK00001' }] })]));
  const r = crossCheckMeasurementIds(configured, [{ measurementId: 'G-OK00001', property: 'properties/1', propertyDisplayName: 'Site' }]);
  assert.equal(r.notFound.length, 0);
  assert.equal(r.matched.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
