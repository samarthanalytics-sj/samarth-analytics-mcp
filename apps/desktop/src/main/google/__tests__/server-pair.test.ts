/**
 * Pair findings: what a web + server pair reveals that neither container shows alone, expressed
 * as findings that APPEAR on regression so the drift monitor can alert on them.
 *
 * Run: tsx src/main/google/__tests__/server-pair.test.ts
 */
import assert from 'node:assert/strict';
import { isPairFinding, pairDriftFindings, pairedWebContainers, withPairFindings, type WebPair } from '../server-pair';
import type { AuditReport, AuditTag, ServerContainerSnapshot } from '../gtm-builders';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

const HOST = 'https://our.example.com';
const wired = (url: string) => ({ type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [
  { type: 'template', key: 'parameter', value: 'server_container_url' }, { type: 'template', key: 'parameterValue', value: url },
] }] });
const googleTag = (tagId: string, name: string, id: string, url?: string): AuditTag => ({
  tagId, name, type: 'googtag', firingTriggerId: ['1'], blockingTriggerId: [], paused: false, consentSettings: null,
  parameter: [{ type: 'template', key: 'tagId', value: id }, ...(url ? [wired(url)] : [])],
} as unknown as AuditTag);
const relay = (tagId: string, name: string, mid: string, paused = false): AuditTag => ({
  tagId, name, type: 'sgtmgaaw', firingTriggerId: ['90'], blockingTriggerId: [], paused, consentSettings: null,
  parameter: mid ? [{ type: 'template', key: 'measurementId', value: mid }] : [],
} as unknown as AuditTag);
const server = (over: Partial<ServerContainerSnapshot> = {}): ServerContainerSnapshot => ({
  taggingServerUrls: [HOST], clients: [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }], transformations: [],
  tags: [relay('s1', 'AU relay', 'G-AUAUAU1')], triggers: [], variables: [], ...over,
});
const web = (tags: AuditTag[], name = 'web'): WebPair => ({ containerId: 'w', name, snapshot: { tags, triggers: [], variables: [] } });
const SUMMARY = { critical: 0, high: 0, medium: 0, low: 0 };
const ids = (fs: ReturnType<typeof pairDriftFindings>) => fs.map((f) => f.checkId).sort();

console.log('\nserver-pair:');

test('a correct pair (wired tag, matching relay) produces no findings', () => {
  const fs = pairDriftFindings(server(), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY);
  assert.deepEqual(fs, []);
});

test('a region the server has NO relay for is left direct in silence: that is a decision, not drift', () => {
  const fs = pairDriftFindings(server(), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST), googleTag('t2', 'US GA4', 'G-USUSUS1')])], SUMMARY);
  assert.deepEqual(fs, [], 'US sends direct and the server never claimed it');
});

test('a region left direct is silent whatever the tag order, and with an inheriting relay too', () => {
  const tags = [googleTag('t2', 'US GA4', 'G-USUSUS1'), googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)];
  assert.deepEqual(pairDriftFindings(server(), [web(tags)], SUMMARY), [], 'the direct US tag listed first must not decide the container\'s wiring');
  assert.deepEqual(pairDriftFindings(server({ tags: [relay('s1', 'Relay', '')] }), [web(tags)], SUMMARY), [], 'an inheriting relay cannot double a direct tag');
});

test('a wired tag LOSING its server URL surfaces as pair_relay_without_wiring (high)', () => {
  const fs = pairDriftFindings(server(), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1')])], SUMMARY);
  assert.deepEqual(ids(fs), ['pair_relay_without_wiring']);
  assert.equal(fs[0].severity, 'high');
  assert.match(fs[0].message, /"AUS GA4"/);
  assert.match(fs[0].message, /G-AUAUAU1/);
  assert.equal(fs[0].resource?.id, 't1', 'keyed on the web tag so the monitor diff is stable');
});

test('a relay PAUSED or REMOVED under a wired tag surfaces as pair_wired_but_unforwarded (critical)', () => {
  const paused = pairDriftFindings(server({ tags: [relay('s1', 'AU relay', 'G-AUAUAU1', true)] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY);
  assert.deepEqual(ids(paused), ['pair_wired_but_unforwarded']);
  assert.equal(paused[0].severity, 'critical');
  const removed = pairDriftFindings(server({ tags: [] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY);
  assert.deepEqual(ids(removed), ['pair_wired_but_unforwarded']);
  assert.match(removed[0].message, /claimed by the GA4 client and dropped/);
});

test('an INHERITING relay forwards whatever arrives, so a wired tag is never "unforwarded"', () => {
  const fs = pairDriftFindings(server({ tags: [relay('s1', 'Relay', '')] }), [web([googleTag('t1', 'US GA4', 'G-USUSUS1', HOST)])], SUMMARY);
  assert.deepEqual(fs, []);
});

test('a relay whose Measurement ID is a non-Constant variable forwards an unknown set: no "certain" blackhole', () => {
  for (const mid of ['{{ed - measurement_id}}', '{{Lookup - GA4 ID}}']) {
    const fs = pairDriftFindings(server({ tags: [relay('s1', 'Relay', mid)] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY);
    assert.deepEqual(fs, [], mid);
  }
});

test('Constant-backed ids match on both sides', () => {
  const srv = server({
    tags: [relay('s1', 'AU relay', '{{AU ID}}')],
    variables: [{ variableId: 'v1', name: 'AU ID', type: 'c', parameter: [{ key: 'value', value: 'G-AUAUAU1' }] }],
  });
  const w: WebPair = { containerId: 'w', name: 'web', snapshot: {
    tags: [googleTag('t1', 'AUS GA4', '{{GA4 AU}}', HOST)], triggers: [],
    variables: [{ variableId: 'v9', name: 'GA4 AU', type: 'c', parameter: [{ key: 'value', value: 'G-AUAUAU1' }] }],
  } };
  assert.deepEqual(pairDriftFindings(srv, [w], SUMMARY), [], 'both sides resolve to G-AUAUAU1');
});

test('a server URL held in a Constant or a Configuration Settings (gtcs) variable is resolved, so the tag is wired and paired', () => {
  const urlConst = { variableId: 'v1', name: 'sGTM URL', type: 'c', parameter: [{ key: 'value', value: HOST }] };
  const viaConst: WebPair = { containerId: 'w', name: 'web', snapshot: {
    tags: [googleTag('t1', 'AUS GA4', 'G-AUAUAU1', '{{sGTM URL}}')], triggers: [], variables: [urlConst],
  } };
  assert.equal(pairedWebContainers(server(), [viaConst]).length, 1, 'Constant-wired container is paired');
  assert.deepEqual(pairDriftFindings(server(), [viaConst], SUMMARY), [], 'not reported as sending direct');
  const pausedRelay = pairDriftFindings(server({ tags: [relay('s1', 'AU relay', 'G-AUAUAU1', true)] }), [viaConst], SUMMARY);
  assert.deepEqual(ids(pausedRelay), ['pair_wired_but_unforwarded'], 'a relay paused under it is still caught');

  const gtcsTag = { ...googleTag('t1', 'AUS GA4', 'G-AUAUAU1'), parameter: [
    { type: 'template', key: 'tagId', value: 'G-AUAUAU1' }, { type: 'template', key: 'configSettingsVariable', value: '{{GT Settings}}' },
  ] } as unknown as AuditTag;
  const viaGtcs: WebPair = { containerId: 'w', name: 'web', snapshot: {
    tags: [gtcsTag], triggers: [], variables: [{ variableId: 'v2', name: 'GT Settings', type: 'gtcs', parameter: [wired('{{sGTM URL}}')] }, urlConst],
  } };
  assert.equal(pairedWebContainers(server(), [viaGtcs]).length, 1, 'gtcs-wired container is paired');
  assert.deepEqual(pairDriftFindings(server(), [viaGtcs], SUMMARY), []);
});

test('a server URL in a variable that cannot be resolved is not "sends direct"', () => {
  const fs = pairDriftFindings(server(), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', '{{Lookup - sGTM URL}}')])], SUMMARY);
  assert.deepEqual(fs, [], 'no pair_relay_without_wiring, and no blackhole claim either');
});

test('pairing is by tagging host; a web tag pointing at a DIFFERENT host is not this server\'s pair', () => {
  const other = web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', 'https://elsewhere.example.com')]);
  assert.deepEqual(pairedWebContainers(server(), [other]), []);
  // ...but its relay-without-wiring still shows, because that tag sends nothing to THIS server.
  const fs = pairDriftFindings(server(), [other], SUMMARY);
  assert.deepEqual(ids(fs), [], 'a tag wired elsewhere is neither direct nor ours; no claim is made');
});

test('with no tagging URL recorded nothing is paired and nothing is claimed', () => {
  const fs = pairDriftFindings(server({ taggingServerUrls: [] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1')])], SUMMARY);
  assert.deepEqual(fs, [], 'the missing URL is already a high finding in the server audit');
});

test('the coverage engine\'s pair findings are carried through for paired containers', () => {
  // A second, unwired Google tag for the SAME id in the paired web container: duplicate config.
  const w = web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST), googleTag('t2', 'AUS GA4 (plugin)', 'G-AUAUAU1')]);
  const fs = pairDriftFindings(server(), [w], SUMMARY);
  assert.ok(fs.some((f) => f.checkId === 'duplicate_web_ga4_config'), ids(fs).join(','));
  assert.ok(fs.some((f) => f.checkId === 'pair_relay_without_wiring'), 'the unwired duplicate is also an idle-relay case');
});

test('withPairFindings appends and recounts, and is a no-op with nothing to add', () => {
  const base: AuditReport = { counts: { tags: 1, triggers: 0, variables: 0, clients: 1, transformations: 0, findings: 1 }, summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, findings: [{ severity: 'high', confidence: 'certain', category: 'firing', message: 'x', recommendation: 'y', autoFixable: false }], boundary: 'b', runtimeRequired: [], hasGa4Config: true } as unknown as AuditReport;
  assert.equal(withPairFindings(base, []), base);
  const extra = pairDriftFindings(server({ tags: [] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY);
  const out = withPairFindings(base, extra);
  assert.equal(out.findings.length, 2);
  assert.deepEqual(out.summary, { critical: 1, high: 1, medium: 0, low: 0, info: 0 });
  assert.equal(out.counts.findings, 2);
});

test('every pair finding is marked origin=pair (so a failed pair read can carry them forward)', () => {
  // Section 3 reuses the coverage engine's checkIds (duplicate_web_ga4_config), so a `pair_` prefix
  // alone would miss them; the marker covers all three sections.
  const w = web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST), googleTag('t2', 'AUS GA4 (plugin)', 'G-AUAUAU1')]);
  const fs = [...pairDriftFindings(server(), [w], SUMMARY), ...pairDriftFindings(server({ tags: [] }), [web([googleTag('t1', 'AUS GA4', 'G-AUAUAU1', HOST)])], SUMMARY)];
  assert.ok(fs.some((f) => !(f.checkId ?? '').startsWith('pair_')), 'the fixture includes a coverage-engine finding');
  assert.ok(fs.length > 0 && fs.every((f) => f.origin === 'pair' && isPairFinding(f)), ids(fs).join(','));
  assert.equal(isPairFinding({ severity: 'high', confidence: 'certain', category: 'firing', message: 'x', recommendation: 'y', autoFixable: false }), false, 'a container-audit finding is not a pair finding');
  assert.equal(isPairFinding({ severity: 'critical', confidence: 'certain', category: 'coverage', checkId: 'pair_wired_but_unforwarded', message: 'x', recommendation: 'y', autoFixable: false }), true, 'history stored before the marker is still recognised');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
