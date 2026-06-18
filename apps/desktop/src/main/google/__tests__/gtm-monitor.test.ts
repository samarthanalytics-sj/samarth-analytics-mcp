import assert from 'node:assert/strict';
import { diffAudits, diffSnapshots, findingKey } from '../gtm-monitor';
import type { AuditFinding, ContainerSnapshot } from '../gtm-builders';

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

const f = (over: Partial<AuditFinding>): AuditFinding => ({
  severity: 'medium',
  category: 'paused',
  message: 'x',
  recommendation: 'y',
  autoFixable: false,
  ...over,
});

const emptySnap = (): ContainerSnapshot => ({ tags: [], triggers: [], variables: [] });

console.log('\nGTM monitor — issue drift:');

test('diffAudits: first run → everything is new, nothing resolved', () => {
  const curr = [f({ category: 'paused', resource: { kind: 'tag', id: '1', name: 'A' } })];
  const d = diffAudits(null, curr);
  assert.equal(d.newFindings.length, 1);
  assert.equal(d.resolvedFindings.length, 0);
  assert.equal(d.unchangedCount, 0);
});

test('diffAudits: classifies new, resolved, unchanged', () => {
  const prev = [
    f({ category: 'paused', resource: { kind: 'tag', id: '1', name: 'A' }, message: 'A paused' }),
    f({ category: 'firing', resource: { kind: 'tag', id: '2', name: 'B' }, message: 'B no trigger' }),
  ];
  const curr = [
    f({ category: 'paused', resource: { kind: 'tag', id: '1', name: 'A' }, message: 'A paused' }), // unchanged
    f({ category: 'consent', resource: { kind: 'tag', id: '3', name: 'C' }, message: 'C consent' }), // new
  ];
  const d = diffAudits(prev, curr);
  assert.deepEqual(d.newFindings.map((x) => x.resource?.id), ['3']);
  assert.deepEqual(d.resolvedFindings.map((x) => x.resource?.id), ['2']);
  assert.equal(d.unchangedCount, 1);
});

test('findingKey: digit changes (counts) do NOT churn the key', () => {
  const two = f({ category: 'naming', message: 'Duplicate tag name "X" (2 tags).' });
  const three = f({ category: 'naming', message: 'Duplicate tag name "X" (3 tags).' });
  assert.equal(findingKey(two), findingKey(three));
  const d = diffAudits([two], [three]);
  assert.equal(d.newFindings.length, 0, 'count change is the same issue');
  assert.equal(d.resolvedFindings.length, 0);
});

test('findingKey: resource-less findings differing only by a DIGIT IN THE NAME do NOT collide', () => {
  const a = f({ category: 'naming', message: 'Duplicate tag name "GA4 Event 1" (2 tags).' });
  const b = f({ category: 'naming', message: 'Duplicate tag name "GA4 Event 2" (2 tags).' });
  assert.notEqual(findingKey(a), findingKey(b), 'names differing by a digit are distinct issues');
  // A newly-duplicated "Event 1" must be reported as NEW; "Event 2" stays unchanged.
  const d = diffAudits([b], [a, b]);
  assert.deepEqual(d.newFindings.map((x) => x.message), [a.message]);
  assert.equal(d.resolvedFindings.length, 0);
  assert.equal(d.unchangedCount, 1);
});

test('findingKey: a changed measurement-ID set is a different issue (not normalized away)', () => {
  const a = f({ category: 'ga4', message: 'Multiple GA4 measurement IDs are in use (G-1, G-2).' });
  const b = f({ category: 'ga4', message: 'Multiple GA4 measurement IDs are in use (G-3, G-4).' });
  assert.notEqual(findingKey(a), findingKey(b));
  const d = diffAudits([a], [b]);
  assert.equal(d.newFindings.length, 1);
  assert.equal(d.resolvedFindings.length, 1);
});

console.log('\nGTM monitor — config drift:');

const tag = (over: Record<string, unknown>) => ({
  tagId: '', name: '', type: 'html', firingTriggerId: [] as string[], paused: false,
  parameter: [] as Array<Record<string, unknown>>, ...over,
});

test('diffSnapshots: added / removed / modified tags (workspace vs live)', () => {
  const live: ContainerSnapshot = {
    ...emptySnap(),
    tags: [tag({ tagId: '1', name: 'Keep', paused: false }), tag({ tagId: '2', name: 'Gone' })],
  };
  const workspace: ContainerSnapshot = {
    ...emptySnap(),
    tags: [
      tag({ tagId: '1', name: 'Keep', paused: true }), // modified (paused flipped)
      tag({ tagId: '3', name: 'New' }), // added
    ],
  };
  const d = diffSnapshots(live, workspace);
  assert.deepEqual(d.tags.added.map((t) => t.id), ['3']);
  assert.deepEqual(d.tags.removed.map((t) => t.id), ['2']);
  assert.deepEqual(d.tags.modified.map((t) => t.id), ['1']);
  assert.equal(d.changeCount, 3);
});

test('diffSnapshots: identical snapshots → zero changes', () => {
  const snap: ContainerSnapshot = {
    ...emptySnap(),
    tags: [tag({ tagId: '1', name: 'A' })],
    triggers: [{ triggerId: 'T1', name: 'Tr', type: 'pageview' }],
    variables: [{ variableId: 'V1', name: 'V', type: 'c' }],
  };
  const d = diffSnapshots(snap, structuredClone(snap));
  assert.equal(d.changeCount, 0);
});

test('diffSnapshots: firingTriggerId order does not count as a change', () => {
  const live: ContainerSnapshot = { ...emptySnap(), tags: [tag({ tagId: '1', name: 'A', firingTriggerId: ['T1', 'T2'] })] };
  const ws: ContainerSnapshot = { ...emptySnap(), tags: [tag({ tagId: '1', name: 'A', firingTriggerId: ['T2', 'T1'] })] };
  assert.equal(diffSnapshots(live, ws).changeCount, 0);
});

test('diffSnapshots: parameter key-ORDER differences are not treated as changes', () => {
  const live: ContainerSnapshot = {
    ...emptySnap(),
    tags: [tag({ tagId: '1', name: 'A', parameter: [{ type: 'template', key: 'k', value: 'v' }] })],
  };
  const ws: ContainerSnapshot = {
    ...emptySnap(),
    tags: [tag({ tagId: '1', name: 'A', parameter: [{ value: 'v', key: 'k', type: 'template' }] })],
  };
  assert.equal(diffSnapshots(live, ws).changeCount, 0, 'same data, different key order → no drift');
});

test('diffSnapshots: trigger + variable changes are detected', () => {
  const live: ContainerSnapshot = {
    ...emptySnap(),
    triggers: [{ triggerId: 'T1', name: 'Old', type: 'pageview' }],
    variables: [{ variableId: 'V1', name: 'V', type: 'c', parameter: [{ key: 'value', value: '1' }] }],
  };
  const ws: ContainerSnapshot = {
    ...emptySnap(),
    triggers: [{ triggerId: 'T1', name: 'Renamed', type: 'pageview' }],
    variables: [{ variableId: 'V1', name: 'V', type: 'c', parameter: [{ key: 'value', value: '2' }] }],
  };
  const d = diffSnapshots(live, ws);
  assert.deepEqual(d.triggers.modified.map((t) => t.id), ['T1']);
  assert.deepEqual(d.variables.modified.map((v) => v.id), ['V1']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
