/**
 * The runtime probe: the one hit verification is allowed to deliver, and the read-back verdict.
 *
 * Run: tsx src/main/google/__tests__/runtime-probe.test.ts
 */
import assert from 'node:assert/strict';
import { buildProbeHit, probeSuffix, probeVerdict, describeProbe } from '../runtime-probe';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

console.log('\nruntime-probe:');

test('the hit is the GA4 collect request the server\'s GA4 client claims, on the tagging host', () => {
  const h = buildProbeHit({ taggingUrl: 'https://our.example.com', measurementId: 'g-abc1234', suffix: 'deadbeef' });
  const u = new URL(h.url);
  assert.equal(u.origin, 'https://our.example.com');
  assert.equal(u.pathname, '/g/collect', 'the default GA4 client path');
  assert.equal(u.searchParams.get('v'), '2', 'GA4 protocol version');
  assert.equal(u.searchParams.get('tid'), 'G-ABC1234', 'id normalised to upper case');
  assert.equal(u.searchParams.get('en'), 'samarth_probe_deadbeef');
  assert.equal(u.searchParams.get('_dbg'), '1', 'visible in DebugView');
  assert.equal(u.searchParams.get('ep.debug_mode'), '1');
  assert.equal(u.searchParams.get('ep.probe_source'), 'samarth_runtime_probe', 'labelled so it is never mistaken for traffic');
  assert.match(u.searchParams.get('cid') ?? '', /^\d{9,10}\.\d{10}$/, 'a throwaway client id in gtag\'s own shape');
  assert.equal(h.eventName, 'samarth_probe_deadbeef');
});

test('each probe has its own event name, so a stale probe can never pass a new one', () => {
  const a = buildProbeHit({ taggingUrl: 'https://our.example.com', measurementId: 'G-ABC1234', suffix: probeSuffix(() => 0.1) });
  const b = buildProbeHit({ taggingUrl: 'https://our.example.com', measurementId: 'G-ABC1234', suffix: probeSuffix(() => 0.9) });
  assert.notEqual(a.eventName, b.eventName);
  assert.match(a.eventName, /^samarth_probe_[0-9a-f]{8}$/);
  assert.ok(a.eventName.length <= 40, 'GA4 event names are capped at 40 characters');
});

test('a hit is refused, not sent, for a bad id, a non-https host, or embedded credentials', () => {
  assert.throws(() => buildProbeHit({ taggingUrl: 'https://our.example.com', measurementId: 'UA-1', suffix: 'a' }), /Not a GA4 Measurement ID/);
  assert.throws(() => buildProbeHit({ taggingUrl: 'http://our.example.com', measurementId: 'G-ABC1234', suffix: 'a' }), /must be https/);
  assert.throws(() => buildProbeHit({ taggingUrl: 'https://u:p@our.example.com', measurementId: 'G-ABC1234', suffix: 'a' }), /credentials/);
  assert.throws(() => buildProbeHit({ taggingUrl: 'not a url', measurementId: 'G-ABC1234', suffix: 'a' }), /valid tagging server URL/);
});

test('the verdict passes only on THIS probe\'s exact event name', () => {
  const rows = [
    { dimensions: ['page_view'], metrics: ['412'] },
    { dimensions: ['samarth_probe_11111111'], metrics: ['1'] },   // an earlier probe
    { dimensions: ['SAMARTH_PROBE_deadbeef'], metrics: ['1'] },   // this one (case differs)
  ];
  assert.deepEqual(probeVerdict(rows, 'samarth_probe_deadbeef'), { status: 'pass', eventCount: 1 });
  assert.deepEqual(probeVerdict(rows, 'samarth_probe_22222222'), { status: 'not_verified' }, 'someone else\'s probe never counts');
  assert.deepEqual(probeVerdict([], 'samarth_probe_deadbeef'), { status: 'not_verified' });
  assert.deepEqual(probeVerdict([{ dimensions: ['samarth_probe_deadbeef'], metrics: ['0'] }], 'samarth_probe_deadbeef'), { status: 'not_verified' }, 'a zero count is not a sighting');
});

test('the summary says what each outcome proves, and never calls a missing sighting a failure', () => {
  const base = { measurementId: 'G-ABC1234', property: 'properties/1', propertyDisplayName: 'AU', taggingHost: 'our.example.com', eventName: 'samarth_probe_deadbeef', sentAt: 0, polls: 3 };
  const pass = describeProbe({ ...base, status: 'pass', sendStatus: 204, seenAt: 12000, latencyMs: 12000 });
  assert.match(pass.note, /reached AU 12s after/);
  assert.match(pass.boundary, /ONE synthetic event/);
  const nv = describeProbe({ ...base, status: 'not_verified', sendStatus: 204, seenAt: null, latencyMs: null });
  assert.match(nv.note, /NOT VERIFIED rather than failed/);
  assert.match(nv.note, /rather than failed/, 'the disclaimer is explicit');
  assert.doesNotMatch(nv.note, /(probe|verification|check) failed/i, 'never calls a missing sighting a failure');
  const sf = describeProbe({ ...base, status: 'send_failed', sendStatus: 400, seenAt: null, latencyMs: null });
  assert.match(sf.note, /no client claimed/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
