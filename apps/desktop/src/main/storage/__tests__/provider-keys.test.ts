import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../secret-store';
import type { Cryptor } from '../secret-store';
import { ProviderKeyStore } from '../provider-keys';

class FakeCryptor implements Cryptor {
  isAvailable(): boolean {
    return true;
  }
  encrypt(p: string): Buffer {
    return Buffer.from(`enc::${p}`, 'utf8');
  }
  decrypt(b: Buffer): string {
    return b.toString('utf8').slice(5);
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

const dir = mkdtempSync(join(tmpdir(), 'samarth-prov-'));
let n = 0;
function make(): { store: ProviderKeyStore } {
  const secrets = new SecretStore(join(dir, `sec-${n}.json`), new FakeCryptor());
  const store = new ProviderKeyStore(join(dir, `app-${n}.json`), secrets);
  n++;
  return { store };
}

console.log('\nProviderKeyStore:');

test('set / get / has / status round-trip', () => {
  const { store } = make();
  assert.equal(store.hasKey('openai'), false);
  store.setKey('openai', 'sk-1');
  assert.equal(store.hasKey('openai'), true);
  assert.equal(store.getKey('openai'), 'sk-1');
  assert.deepEqual(store.status(), { openai: true, anthropic: false, gemini: false });
});

test('clearKey removes the key', () => {
  const { store } = make();
  store.setKey('gemini', 'g');
  store.clearKey('gemini');
  assert.equal(store.hasKey('gemini'), false);
  assert.equal(store.getKey('gemini'), null);
});

test('persists across instances; key is encrypted at rest', () => {
  const appFile = join(dir, 'persist-app.json');
  const secFile = join(dir, 'persist-sec.json');
  new ProviderKeyStore(appFile, new SecretStore(secFile, new FakeCryptor())).setKey('anthropic', 'sk-secret');
  const reopened = new ProviderKeyStore(appFile, new SecretStore(secFile, new FakeCryptor()));
  assert.equal(reopened.getKey('anthropic'), 'sk-secret');
  // app-settings holds only a ref; the key bytes live (encrypted) in the secret file.
  assert.equal(readFileSync(appFile, 'utf8').includes('sk-secret'), false);
  assert.equal(readFileSync(secFile, 'utf8').includes('sk-secret'), false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
