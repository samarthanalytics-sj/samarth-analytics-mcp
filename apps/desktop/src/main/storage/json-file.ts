import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Tiny atomic JSON persistence used by the registry + secret store. Writes go to
// a temp file then rename (atomic on the same volume) so a crash mid-write can't
// corrupt the live file. Files are created 0600 (best-effort on Windows).

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    // A malformed file falls back rather than crashing the app on boot.
    return fallback;
  }
}

export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op / unsupported on some Windows filesystems.
  }
}
