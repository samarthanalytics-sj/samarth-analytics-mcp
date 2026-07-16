import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../memory-store';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

const dir = mkdtempSync(join(tmpdir(), 'mem-store-'));
let seq = 100;
const clock = (): number => (seq += 1); // deterministic, monotonic

console.log('\nMemoryStore:');

test('add + list returns the memory', () => {
  const s = new MemoryStore(join(dir, 'a.json'), 500, clock);
  const r = s.add('acct1', { kind: 'rule', text: 'always snake_case events' });
  assert.equal(r.deduped, false);
  assert.equal(r.memory.kind, 'rule');
  const list = s.list('acct1');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'always snake_case events');
  assert.equal(list[0].enabled, true);
});

test('secret in the text is redacted before it persists', () => {
  const s = new MemoryStore(join(dir, 'b.json'), 500, clock);
  const r = s.add('acct1', { kind: 'fact', text: 'the key is AIzaSyA1234567890abcdefghijklmnopqrstuvw' });
  assert.equal(r.redacted, true);
  assert.ok(!r.memory.text.includes('AIzaSy'));
  assert.ok(r.memory.text.includes('[redacted]'));
});

test('duplicate (same kind+scope+text) refreshes instead of adding', () => {
  const s = new MemoryStore(join(dir, 'c.json'), 500, clock);
  s.add('acct1', { kind: 'fact', text: 'client uses shopify' });
  const r2 = s.add('acct1', { kind: 'fact', text: 'Client Uses Shopify' }); // case-insensitive dupe
  assert.equal(r2.deduped, true);
  assert.equal(s.list('acct1').length, 1);
});

test('scope separates memories of the same text', () => {
  const s = new MemoryStore(join(dir, 'd.json'), 500, clock);
  s.add('acct1', { kind: 'fact', text: 'note', scope: { containerId: 'GTM-A' } });
  s.add('acct1', { kind: 'fact', text: 'note', scope: { containerId: 'GTM-B' } });
  assert.equal(s.list('acct1').length, 2);
});

test('accounts are isolated', () => {
  const s = new MemoryStore(join(dir, 'e.json'), 500, clock);
  s.add('acct1', { kind: 'fact', text: 'a1' });
  s.add('acct2', { kind: 'fact', text: 'a2' });
  assert.equal(s.list('acct1').length, 1);
  assert.equal(s.list('acct2').length, 1);
  assert.equal(s.list('acct1')[0].text, 'a1');
});

test('update patches text (re-redacting) + toggles + returns null for missing', () => {
  const s = new MemoryStore(join(dir, 'f.json'), 500, clock);
  const { memory } = s.add('acct1', { kind: 'fact', text: 'old' });
  const up = s.update('acct1', memory.id, { text: 'new value', enabled: false, pinned: true });
  assert.equal(up?.text, 'new value');
  assert.equal(up?.enabled, false);
  assert.equal(up?.pinned, true);
  assert.equal(s.update('acct1', 'nope', { text: 'x' }), null);
});

test('remove + clear', () => {
  const s = new MemoryStore(join(dir, 'g.json'), 500, clock);
  const { memory } = s.add('acct1', { kind: 'fact', text: 'x' });
  s.add('acct1', { kind: 'fact', text: 'y' });
  assert.equal(s.remove('acct1', memory.id), true);
  assert.equal(s.remove('acct1', memory.id), false);
  assert.equal(s.list('acct1').length, 1);
  assert.equal(s.clear('acct1'), 1);
  assert.equal(s.list('acct1').length, 0);
});

test('cap evicts oldest non-pinned first; pinned survive', () => {
  const s = new MemoryStore(join(dir, 'h.json'), 3, clock); // cap = 3
  const pin = s.add('acct1', { kind: 'fact', text: 'keep me', pinned: true }).memory;
  s.add('acct1', { kind: 'fact', text: 'old1' });
  s.add('acct1', { kind: 'fact', text: 'old2' });
  s.add('acct1', { kind: 'fact', text: 'old3' }); // pushes over cap → evict oldest UNPINNED (old1)
  const texts = s.list('acct1').map((m) => m.text);
  assert.equal(s.list('acct1').length, 3);
  assert.ok(texts.includes('keep me'), 'pinned survived');
  assert.ok(!texts.includes('old1'), 'oldest unpinned evicted');
  assert.equal(s.list('acct1').find((m) => m.id === pin.id)?.pinned, true);
});

test('a secret in a scope label is redacted (defense in depth)', () => {
  const s = new MemoryStore(join(dir, 'j.json'), 500, clock);
  const r = s.add('acct1', { kind: 'fact', text: 'note', scope: { containerId: 'GTM-A', label: 'sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX90abYZcd_efGH-ijKL' } });
  assert.ok(!(r.memory.scope.label ?? '').includes('sk-proj-'), 'label secret redacted');
});

test('adding at a cap full of pinned keeps the NEW memory (no silent loss)', () => {
  const s = new MemoryStore(join(dir, 'k.json'), 2, clock);
  s.add('acct1', { kind: 'fact', text: 'p1', pinned: true });
  s.add('acct1', { kind: 'fact', text: 'p2', pinned: true });
  const r = s.add('acct1', { kind: 'fact', text: 'newbie' }); // unpinned, over cap, all existing pinned
  assert.equal(s.list('acct1').length, 2);
  assert.ok(s.list('acct1').map((m) => m.text).includes('newbie'), 'the just-added memory survived');
  assert.ok(s.list('acct1').some((m) => m.id === r.memory.id), 'returned memory is actually present');
});

test('persists across reloads (atomic file)', () => {
  const path = join(dir, 'i.json');
  const s1 = new MemoryStore(path, 500, clock);
  s1.add('acct1', { kind: 'rule', text: 'persisted rule', pinned: true });
  const s2 = new MemoryStore(path, 500, clock); // fresh instance reads the file
  const list = s2.list('acct1');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'persisted rule');
  assert.equal(list[0].pinned, true);
});

console.log(`\nMemoryStore: ${passed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
