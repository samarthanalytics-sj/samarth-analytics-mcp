/**
 * The runtime probe: the one hit verification is allowed to deliver, and the read-back verdict.
 *
 * Run: tsx src/main/google/__tests__/runtime-probe.test.ts
 */
import assert from 'node:assert/strict';
import { buildProbeHit, probeSuffix, probeVerdict, describeProbe, probeTargets, probeTargetRefusal } from '../runtime-probe';
import type { ServerContainerSnapshot } from '../gtm-builders';

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

// ── Which ids may be probed: decided from the server's relays BEFORE anything is sent ──────────
const relay = (id: string, over: Partial<{ paused: boolean; firingTriggerId: string[] }> = {}) => ({
  tagId: `r-${id || 'blank'}`, name: `GA4 relay ${id}`, type: 'sgtmgaaw', paused: over.paused ?? false,
  firingTriggerId: over.firingTriggerId ?? ['T1'], blockingTriggerId: [], parameter: [{ type: 'template', key: 'measurementId', value: id }],
}) as unknown as ServerContainerSnapshot['tags'][number];
const constant = (name: string, value: string) => ({ variableId: name, name, type: 'c', parameter: [{ type: 'template', key: 'value', value }] }) as unknown as NonNullable<ServerContainerSnapshot['variables']>[number];

test('literal-only relays: a listed id may be probed, an unlisted one is refused before sending', () => {
  const t = probeTargets({ tags: [relay('G-AAAA1111')], variables: [] });
  assert.deepEqual([...t.forwarded], ['G-AAAA1111']);
  assert.equal(t.inherits, false);
  assert.equal(probeTargetRefusal(t, 'g-aaaa1111', true), null, 'the forwarded id (any case) is allowed');
  assert.equal(probeTargetRefusal(t, 'G-AAAA1111', false), null, 'the server\'s own configured id is still allowed when the property is unreadable');
  const r = probeTargetRefusal(t, 'G-BBBB2222', true);
  assert.ok(r, 'an id the server does not forward is refused even when this account can read it');
  assert.match(r!, /does not forward G-BBBB2222/);
  assert.match(r!, /re-routed into G-AAAA1111/, 'says where the probe would really have landed');
  assert.match(r!, /No probe was sent/);
});

test('an inheriting relay: a well-formed id the account can read is allowed; an unreadable one is refused', () => {
  const t = probeTargets({ tags: [relay('')], variables: [] });
  assert.equal(t.inherits, true);
  assert.equal(t.forwarded.size, 0);
  assert.equal(probeTargetRefusal(t, 'G-CCCC3333', true), null);
  const r = probeTargetRefusal(t, 'G-TYPO0000', false);
  assert.ok(r, 'a typo / another client\'s id behind an inheriting relay is never delivered');
  assert.match(r!, /no probe was sent/i);
});

test('paused and trigger-less relays forward nothing; a server with no active relay refuses every id', () => {
  const t = probeTargets({ tags: [relay('G-AAAA1111', { paused: true }), relay('G-BBBB2222', { firingTriggerId: [] }), relay('', { paused: true })], variables: [] });
  assert.equal(t.forwarded.size, 0);
  assert.equal(t.inherits, false, 'a paused blank relay does not inherit');
  assert.equal(t.dynamic, false);
  assert.match(probeTargetRefusal(t, 'G-AAAA1111', true) ?? '', /no active GA4 relay/);
});

test('a {{Constant}} id is resolved; a non-Constant variable is dynamic and needs a readable property', () => {
  const t = probeTargets({ tags: [relay('{{GA4 ID}}')], variables: [constant('GA4 ID', 'g-dddd4444')] });
  assert.deepEqual([...t.forwarded], ['G-DDDD4444']);
  assert.equal(probeTargetRefusal(t, 'G-DDDD4444', false), null);
  const d = probeTargets({ tags: [relay('{{Lookup - GA4 by host}}')], variables: [] });
  assert.equal(d.dynamic, true);
  assert.equal(d.forwarded.size, 0);
  assert.equal(probeTargetRefusal(d, 'G-EEEE5555', true), null, 'a runtime-decided id cannot be ruled out, and the account can read it back');
  assert.ok(probeTargetRefusal(d, 'G-EEEE5555', false), 'but with nothing corroborating it and no read-back, it is refused');
});

test('the boundary discloses that other matching server tags also receive the probe', () => {
  const b = describeProbe({ measurementId: 'G-ABC1234', property: null, propertyDisplayName: null, taggingHost: 'h', eventName: 'samarth_probe_x', sentAt: 0, polls: 0, status: 'send_failed', sendStatus: 400, seenAt: null, latencyMs: null }).boundary;
  assert.match(b, /other server tag whose trigger matches/);
});

// ── The wiring: runServerRuntimeProbe refuses BEFORE any hit leaves the machine ────────────────
async function wiring(): Promise<void> {
  const { GoogleDataService } = await import('../data-service');
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (u: unknown) => { sent.push(String(u)); return new Response(null, { status: 204 }); }) as typeof fetch;
  try {
    const svc = new GoogleDataService({} as never, {} as never) as unknown as {
      getServerContainerSnapshot: () => Promise<ServerContainerSnapshot>;
      listGa4MeasurementIds: () => Promise<Array<{ measurementId: string; property: string; propertyDisplayName: string }>>;
      runServerRuntimeProbe: (a: string, c: string, w: string, o?: { measurementId?: string }) => Promise<unknown>;
    };
    const server = { taggingServerUrls: ['https://sgtm.example.com'], clients: [], tags: [relay('G-AAAA1111')], variables: [] } as unknown as ServerContainerSnapshot;
    svc.getServerContainerSnapshot = async () => server;
    // The account CAN read G-BBBB2222's property: the refusal must still hold, because the server's
    // literal relay would deliver the probe into G-AAAA1111's property instead.
    svc.listGa4MeasurementIds = async () => [{ measurementId: 'G-BBBB2222', property: 'properties/2', propertyDisplayName: 'B' }];
    let err = '';
    try { await svc.runServerRuntimeProbe('1', '2', '3', { measurementId: 'G-BBBB2222' }); } catch (e) { err = (e as Error).message; }
    if (/does not forward G-BBBB2222/.test(err) && sent.length === 0) { passed += 1; console.log('  ✓ runServerRuntimeProbe refuses an id the server does not forward, with nothing sent'); }
    else { failed += 1; console.log(`  ✗ runServerRuntimeProbe refuses an id the server does not forward, with nothing sent: err="${err}" sent=${sent.length}`); }

    // An inheriting relay and an id no readable property has: refused, nothing sent.
    svc.getServerContainerSnapshot = async () => ({ ...server, tags: [relay('')] }) as ServerContainerSnapshot;
    err = '';
    try { await svc.runServerRuntimeProbe('1', '2', '3', { measurementId: 'G-TYPO0000' }); } catch (e) { err = (e as Error).message; }
    if (/no probe was sent/i.test(err) && sent.length === 0) { passed += 1; console.log('  ✓ runServerRuntimeProbe refuses an unreadable id behind an inheriting relay, with nothing sent'); }
    else { failed += 1; console.log(`  ✗ runServerRuntimeProbe refuses an unreadable id behind an inheriting relay, with nothing sent: err="${err}" sent=${sent.length}`); }
  } finally {
    globalThis.fetch = realFetch;
  }
}

void wiring().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
