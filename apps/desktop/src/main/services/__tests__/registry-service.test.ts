import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepository } from '../../storage/account-repository';
import { SecretStore } from '../../storage/secret-store';
import type { Cryptor } from '../../storage/secret-store';
import { RegistryService } from '../registry-service';

class FakeCryptor implements Cryptor {
  available = true;
  isAvailable(): boolean {
    return this.available;
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

const dir = mkdtempSync(join(tmpdir(), 'samarth-svc-'));
let n = 0;
function makeService(cryptor: Cryptor = new FakeCryptor()): {
  service: RegistryService;
  secrets: SecretStore;
  repo: AccountRepository;
} {
  const repo = new AccountRepository(join(dir, `reg-${n}.json`));
  const secrets = new SecretStore(join(dir, `sec-${n}.json`), cryptor);
  n++;
  return { service: new RegistryService(repo, secrets), secrets, repo };
}

console.log('\nRegistryService:');

test('addAccount → view: active, no token, no llm, no secret leakage', () => {
  const { service } = makeService();
  const v = service.addAccount({ email: 'a@example.com' });
  assert.equal(v.isActive, true);
  assert.equal(v.hasGoogleToken, false);
  assert.equal(v.llm, undefined);
  // The view object must not carry any *Ref field.
  assert.equal(JSON.stringify(v).includes('Ref'), false, 'view must not expose secret refs');
});

test('setLlmConfig then setLlmApiKey vaults the key (encrypted) and flips hasApiKey', () => {
  const { service, secrets, repo } = makeService();
  const a = service.addAccount({ email: 'b@example.com' });
  service.setLlmConfig(a.id, 'anthropic', 'claude-opus-4-8');
  const v = service.setLlmApiKey(a.id, 'sk-secret-123');
  assert.equal(v.llm?.provider, 'anthropic');
  assert.equal(v.llm?.model, 'claude-opus-4-8');
  assert.equal(v.llm?.hasApiKey, true);
  // The key is retrievable via the stored ref and was actually encrypted.
  const ref = repo.get(a.id)?.llm?.apiKeyRef;
  assert.ok(ref);
  assert.equal(secrets.get(ref), 'sk-secret-123');
});

test('setLlmApiKey before config throws', () => {
  const { service } = makeService();
  const a = service.addAccount({ email: 'c@example.com' });
  assert.throws(() => service.setLlmApiKey(a.id, 'k'), /provider\/model/);
});

test('setGoogleToken vaults token and flips hasGoogleToken', () => {
  const { service } = makeService();
  const a = service.addAccount({ email: 'd@example.com' });
  service.setGoogleToken(a.id, JSON.stringify({ refresh_token: 'rt' }));
  const v = service.listViews().find((x) => x.id === a.id);
  assert.equal(v?.hasGoogleToken, true);
  assert.equal(service.getGoogleToken(a.id), '{"refresh_token":"rt"}');
});

test('removeAccount deletes its secrets', () => {
  const { service, secrets, repo } = makeService();
  const a = service.addAccount({ email: 'e@example.com' });
  service.setLlmConfig(a.id, 'openai', 'gpt-4o');
  service.setLlmApiKey(a.id, 'sk-x');
  service.setGoogleToken(a.id, '{}');
  const stored = repo.get(a.id);
  const apiRef = stored?.llm?.apiKeyRef as string;
  const tokRef = stored?.googleTokenRef as string;
  service.removeAccount(a.id);
  assert.equal(secrets.has(apiRef), false, 'llm key secret deleted');
  assert.equal(secrets.has(tokRef), false, 'google token secret deleted');
  assert.equal(service.listViews().length, 0);
});

test('secretSelfTest ok with available crypto, fails when unavailable', () => {
  const ok = makeService().service.secretSelfTest();
  assert.equal(ok.ok, true);
  assert.equal(ok.encryptionAvailable, true);

  const c = new FakeCryptor();
  c.available = false;
  const bad = makeService(c).service.secretSelfTest();
  assert.equal(bad.ok, false);
  assert.equal(bad.encryptionAvailable, false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
