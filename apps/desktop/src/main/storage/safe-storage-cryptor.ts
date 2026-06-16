import { safeStorage } from 'electron';
import type { Cryptor } from './secret-store';

// Production Cryptor backed by Electron safeStorage. On Windows this is DPAPI
// (CryptProtectData): the ciphertext is bound to the logged-in OS user account
// on this machine, so copying the secret file to another machine/user yields
// undecryptable bytes. Imported only by the main process wiring — never by tests
// (which use a FakeCryptor) — so this is the one file that pulls in `electron`.
export class SafeStorageCryptor implements Cryptor {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(plaintext: string): Buffer {
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    return safeStorage.decryptString(ciphertext);
  }
}
