import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepository } from '../../storage/account-repository';
import { SecretStore } from '../../storage/secret-store';
import type { Cryptor } from '../../storage/secret-store';
import { ProviderKeyStore } from '../../storage/provider-keys';
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
  providerKeys: ProviderKeyStore;
} {
  const repo = new AccountRepository(join(dir, `reg-${n}.json`));
  const secrets = new SecretStore(join(dir, `sec-${n}.json`), cryptor);
  const providerKeys = new ProviderKeyStore(join(dir, `app-${n}.json`), secrets);
  n++;
  return { service: new RegistryService(repo, secrets, providerKeys), secrets, repo, providerKeys };
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

test('renameAccount: custom name wins, survives a Google re-sign-in, empty clears it', () => {
  const { service } = makeService();
  const v = service.addAccount({ email: 'a@example.com', displayName: 'Google Name' });
  // Rename → the custom label shows.
  assert.equal(service.renameAccount(v.id, '  My Client Account  ').displayName, 'My Client Account', 'trimmed rename shown');
  // A Google re-sign-in refreshes the profile displayName — the rename must survive it.
  const upserted = service.upsertGoogleAccount('a@example.com', 'Google Name 2', '{"tok":1}');
  assert.equal(upserted.displayName, 'My Client Account', 'rename survives profile refresh');
  // Clearing the rename falls back to the (refreshed) Google name.
  assert.equal(service.renameAccount(v.id, '').displayName, 'Google Name 2', 'empty rename restores profile name');
  assert.throws(() => service.renameAccount('nope', 'x'), /account not found/);
});

test('hasApiKey reflects the app-level provider key, not a per-account key', () => {
  const { service, providerKeys } = makeService();
  const a = service.addAccount({ email: 'b@example.com' });
  let v = service.setLlmConfig(a.id, 'anthropic', 'claude-opus-4-8');
  assert.equal(v.llm?.provider, 'anthropic');
  assert.equal(v.llm?.hasApiKey, false, 'no app key for anthropic yet');

  providerKeys.setKey('anthropic', 'sk-secret-123');
  v = service.listViews().find((x) => x.id === a.id)!;
  assert.equal(v.llm?.hasApiKey, true, 'app-level anthropic key now present');

  // Switching to a provider without a key flips it back to false.
  v = service.setLlmConfig(a.id, 'openai', 'gpt-4o');
  assert.equal(v.llm?.hasApiKey, false);
});

test('setGoogleToken vaults token and flips hasGoogleToken', () => {
  const { service } = makeService();
  const a = service.addAccount({ email: 'd@example.com' });
  service.setGoogleToken(a.id, JSON.stringify({ refresh_token: 'rt' }));
  const v = service.listViews().find((x) => x.id === a.id);
  assert.equal(v?.hasGoogleToken, true);
  assert.equal(service.getGoogleToken(a.id), '{"refresh_token":"rt"}');
});

test('removeAccount deletes its Google token secret', () => {
  const { service, secrets, repo } = makeService();
  const a = service.addAccount({ email: 'e@example.com' });
  service.setLlmConfig(a.id, 'openai', 'gpt-4o');
  service.setGoogleToken(a.id, '{}');
  const tokRef = repo.get(a.id)?.googleTokenRef as string;
  service.removeAccount(a.id);
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
