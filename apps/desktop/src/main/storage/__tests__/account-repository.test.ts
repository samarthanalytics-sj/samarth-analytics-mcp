import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepository } from '../account-repository';

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

const dir = mkdtempSync(join(tmpdir(), 'samarth-registry-'));
let n = 0;
const freshFile = (): string => join(dir, `reg-${n++}.json`);

console.log('\nAccountRepository:');

test('add creates an account; first add becomes active', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'a@example.com' });
  assert.ok(a.id);
  assert.equal(a.email, 'a@example.com');
  assert.equal(repo.activeId(), a.id);
  assert.equal(repo.list().length, 1);
});

test('add is idempotent by email (case-insensitive)', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'Dup@Example.com' });
  const b = repo.add({ email: 'dup@example.com' });
  assert.equal(a.id, b.id);
  assert.equal(repo.list().length, 1);
});

test('get and getByEmail', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'x@example.com', displayName: 'X' });
  assert.equal(repo.get(a.id)?.displayName, 'X');
  assert.equal(repo.getByEmail('X@EXAMPLE.COM')?.id, a.id);
  assert.equal(repo.get('missing'), null);
});

test('update patches fields', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'u@example.com' });
  const updated = repo.update(a.id, { llm: { provider: 'anthropic', model: 'claude-opus-4-8' } });
  assert.equal(updated.llm?.model, 'claude-opus-4-8');
  assert.throws(() => repo.update('nope', { displayName: 'z' }), /account not found/);
});

test('remove deletes; active reassigns to first remaining', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'a@example.com' });
  const b = repo.add({ email: 'b@example.com' });
  assert.equal(repo.activeId(), a.id);
  repo.remove(a.id);
  assert.equal(repo.activeId(), b.id, 'active falls through to the next account');
  repo.remove(b.id);
  assert.equal(repo.activeId(), null, 'no accounts → no active');
});

test('setActive switches; unknown id throws', () => {
  const repo = new AccountRepository(freshFile());
  const a = repo.add({ email: 'a@example.com' });
  const b = repo.add({ email: 'b@example.com' });
  repo.setActive(b.id);
  assert.equal(repo.activeId(), b.id);
  assert.notEqual(a.id, b.id);
  assert.throws(() => repo.setActive('nope'), /account not found/);
});

test('persists across instances', () => {
  const f = freshFile();
  const id = new AccountRepository(f).add({ email: 'persist@example.com' }).id;
  const reopened = new AccountRepository(f);
  assert.equal(reopened.get(id)?.email, 'persist@example.com');
  assert.equal(reopened.activeId(), id);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
