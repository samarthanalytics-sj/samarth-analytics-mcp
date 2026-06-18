import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditHistoryStore } from '../audit-history';
import type { AuditReport } from '../../google/gtm-builders';

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

const report = (n: number): AuditReport => ({
  counts: { tags: n, triggers: 0, variables: 0, findings: 0 },
  summary: { high: 0, medium: 0, low: 0, info: 0 },
  findings: [],
});

console.log('\nAuditHistoryStore:');

const dir = mkdtempSync(join(tmpdir(), 'samarth-audit-hist-'));

test('last() is null before any run', () => {
  const store = new AuditHistoryStore(join(dir, 'a.json'));
  assert.equal(store.last(AuditHistoryStore.key('1', '2', '3')), null);
});

test('append then last() returns the most recent run', () => {
  const store = new AuditHistoryStore(join(dir, 'b.json'));
  const k = AuditHistoryStore.key('1', '2', '3');
  store.append(k, { at: 100, report: report(1) });
  store.append(k, { at: 200, report: report(2) });
  assert.equal(store.last(k)?.at, 200);
  assert.equal(store.last(k)?.report.counts.tags, 2);
  assert.equal(store.runs(k).length, 2);
});

test('keys are isolated per account/container/workspace', () => {
  const store = new AuditHistoryStore(join(dir, 'c.json'));
  store.append(AuditHistoryStore.key('1', '2', '3'), { at: 1, report: report(1) });
  store.append(AuditHistoryStore.key('1', '2', '9'), { at: 1, report: report(7) });
  assert.equal(store.last(AuditHistoryStore.key('1', '2', '3'))?.report.counts.tags, 1);
  assert.equal(store.last(AuditHistoryStore.key('1', '2', '9'))?.report.counts.tags, 7);
});

test('prunes to the retention window (oldest dropped)', () => {
  const store = new AuditHistoryStore(join(dir, 'd.json'), 3);
  const k = AuditHistoryStore.key('1', '2', '3');
  for (let i = 1; i <= 5; i++) store.append(k, { at: i, report: report(i) });
  const runs = store.runs(k);
  assert.equal(runs.length, 3, 'kept only 3');
  assert.deepEqual(runs.map((r) => r.at), [3, 4, 5], 'kept the newest 3');
});

test('persists to disk and reloads', () => {
  const path = join(dir, 'e.json');
  const k = AuditHistoryStore.key('1', '2', '3');
  new AuditHistoryStore(path).append(k, { at: 42, report: report(4) });
  const reloaded = new AuditHistoryStore(path);
  assert.equal(reloaded.last(k)?.at, 42);
});

test('rejects an incompatible (future-version) file and resets', () => {
  const path = join(dir, 'ver.json');
  writeFileSync(path, JSON.stringify({ version: 2, runs: { x: [{ at: 1, report: report(1) }] } }));
  assert.equal(new AuditHistoryStore(path).last('x'), null, 'future-version file is not trusted');
});

test('rejects a corrupt file and resets', () => {
  const path = join(dir, 'corrupt.json');
  writeFileSync(path, '{ not json');
  assert.equal(new AuditHistoryStore(path).last('x'), null);
});

test('caps the number of tracked workspaces (evicts least-recently-audited)', () => {
  const store = new AuditHistoryStore(join(dir, 'cap.json'), 5, 3); // keep=5, maxKeys=3
  for (let i = 1; i <= 5; i++) store.append(`k${i}`, { at: i, report: report(i) });
  assert.equal(store.last('k1'), null, 'oldest evicted');
  assert.equal(store.last('k2'), null, 'second oldest evicted');
  assert.ok(store.last('k3'), 'recent kept');
  assert.ok(store.last('k5'), 'newest kept');
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
