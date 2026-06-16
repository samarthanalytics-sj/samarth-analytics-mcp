import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, SecretStoreUnavailableError } from '../secret-store';
import type { Cryptor } from '../secret-store';

// Reversible, NON-secure stand-in for safeStorage — lets us exercise SecretStore
// logic in plain Node. Prefixes a marker so we can assert ciphertext != plaintext.
class FakeCryptor implements Cryptor {
  available = true;
  isAvailable(): boolean {
    return this.available;
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(`enc::${plaintext}`, 'utf8');
  }
  decrypt(ciphertext: Buffer): string {
    const s = ciphertext.toString('utf8');
    if (!s.startsWith('enc::')) throw new Error('bad ciphertext');
    return s.slice(5);
  }
}

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

const dir = mkdtempSync(join(tmpdir(), 'samarth-secret-'));
const file = join(dir, 'secrets.json');

console.log('\nSecretStore:');

test('set + get round-trips', () => {
  const s = new SecretStore(file, new FakeCryptor());
  s.set('a', 'hello');
  assert.equal(s.get('a'), 'hello');
});

test('has reflects presence', () => {
  const s = new SecretStore(join(dir, 's2.json'), new FakeCryptor());
  assert.equal(s.has('x'), false);
  s.set('x', 'v');
  assert.equal(s.has('x'), true);
});

test('get returns null for missing ref', () => {
  const s = new SecretStore(join(dir, 's3.json'), new FakeCryptor());
  assert.equal(s.get('nope'), null);
});

test('set overwrites', () => {
  const s = new SecretStore(join(dir, 's4.json'), new FakeCryptor());
  s.set('k', 'one');
  s.set('k', 'two');
  assert.equal(s.get('k'), 'two');
});

test('delete removes (idempotent)', () => {
  const s = new SecretStore(join(dir, 's5.json'), new FakeCryptor());
  s.set('k', 'v');
  s.delete('k');
  assert.equal(s.get('k'), null);
  s.delete('k'); // no throw
});

test('persists across instances and decrypts', () => {
  const f = join(dir, 's6.json');
  new SecretStore(f, new FakeCryptor()).set('tok', 'secret-bytes');
  const reopened = new SecretStore(f, new FakeCryptor());
  assert.equal(reopened.get('tok'), 'secret-bytes');
});

test('bytes at rest are ciphertext, not plaintext', () => {
  const f = join(dir, 's7.json');
  const s = new SecretStore(f, new FakeCryptor());
  s.set('tok', 'PLAINTEXT_VALUE');
  const raw = readFileSync(f, 'utf8');
  assert.ok(!raw.includes('PLAINTEXT_VALUE'), 'plaintext must not appear on disk');
  assert.ok(raw.includes(Buffer.from('enc::PLAINTEXT_VALUE').toString('base64')));
});

test('unavailable encryption: set throws, available() false', () => {
  const c = new FakeCryptor();
  c.available = false;
  const s = new SecretStore(join(dir, 's8.json'), c);
  assert.equal(s.available(), false);
  assert.throws(() => s.set('k', 'v'), SecretStoreUnavailableError);
});

test('corrupt ciphertext decrypts to null, not a throw', () => {
  const f = join(dir, 's9.json');
  const s = new SecretStore(f, new FakeCryptor());
  s.set('k', 'v');
  // Tamper: reopen with a cryptor whose decrypt rejects the stored bytes.
  const broken = new FakeCryptor();
  broken.decrypt = () => {
    throw new Error('tampered');
  };
  const s2 = new SecretStore(f, broken);
  assert.equal(s2.get('k'), null);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
