import { readJsonFile, writeJsonFileAtomic } from './json-file';

// Encrypted secret store. Holds token bytes / API keys encrypted at rest, keyed
// by an opaque ref. The encryption is delegated to a Cryptor so the store logic
// is testable in plain Node (FakeCryptor) while the app uses SafeStorageCryptor
// (Electron safeStorage → Windows DPAPI). Conceptually mirrors the hosted
// TokenVault (apps/portal/shared/token-vault.ts) but with a local OS backend.

export interface Cryptor {
  /** Whether OS-level encryption is usable right now. */
  isAvailable(): boolean;
  /** Encrypt a UTF-8 string to opaque bytes. */
  encrypt(plaintext: string): Buffer;
  /** Decrypt bytes produced by encrypt(); throws on tampered/foreign input. */
  decrypt(ciphertext: Buffer): string;
}

/** ref -> base64(ciphertext). The on-disk shape of the secret file. */
type SecretFile = Record<string, string>;

export class SecretStoreUnavailableError extends Error {
  constructor() {
    super('OS secret encryption (safeStorage / DPAPI) is not available on this system.');
    this.name = 'SecretStoreUnavailableError';
  }
}

export class SecretStore {
  private readonly filePath: string;
  private readonly cryptor: Cryptor;
  private cache: SecretFile;

  constructor(filePath: string, cryptor: Cryptor) {
    this.filePath = filePath;
    this.cryptor = cryptor;
    this.cache = readJsonFile<SecretFile>(filePath, {});
  }

  available(): boolean {
    return this.cryptor.isAvailable();
  }

  has(ref: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cache, ref);
  }

  /** Encrypt and persist a secret under `ref`, overwriting any existing value. */
  set(ref: string, plaintext: string): void {
    if (!this.cryptor.isAvailable()) throw new SecretStoreUnavailableError();
    this.cache[ref] = this.cryptor.encrypt(plaintext).toString('base64');
    writeJsonFileAtomic(this.filePath, this.cache);
  }

  /** Decrypt the secret at `ref`, or null if absent. Returns null on corrupt bytes. */
  get(ref: string): string | null {
    const b64 = this.cache[ref];
    if (b64 === undefined) return null;
    if (!this.cryptor.isAvailable()) throw new SecretStoreUnavailableError();
    try {
      return this.cryptor.decrypt(Buffer.from(b64, 'base64'));
    } catch {
      return null;
    }
  }

  /** Idempotently remove a secret (absent ref is a no-op). */
  delete(ref: string): void {
    if (!this.has(ref)) return;
    delete this.cache[ref];
    writeJsonFileAtomic(this.filePath, this.cache);
  }
}
