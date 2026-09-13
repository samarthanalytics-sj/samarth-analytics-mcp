import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import {
  upsertResources,
  type InstallManifest,
  type ManifestResource,
} from '../../shared/install-manifest';

// On-disk shape: one InstallManifest per `${account}/${container}/${workspace}`.
interface ManifestFile {
  version: 1;
  manifests: Record<string, InstallManifest>;
}

const EMPTY: ManifestFile = { version: 1, manifests: {} };

/**
 * Local record of the GTM resources our setup tools created, per workspace —
 * the memory that makes a setup re-run safe (we know what we own) and makes
 * user edits / deletions / manual additions detectable as DRIFT. Plain config
 * metadata (no secrets, no live config — only a fingerprint), persisted
 * atomically next to audit-history.json. Mirrors AuditHistoryStore.
 */
export class ManifestStore {
  private data: ManifestFile;

  constructor(private readonly filePath: string) {
    const fileExisted = existsSync(filePath);
    const loaded = readJsonFile<ManifestFile>(filePath, structuredClone(EMPTY));
    // Only accept a known-schema file; anything else (corrupt or a future
    // version) is reset — but surface it so the data loss isn't silent.
    if (loaded && loaded.version === 1 && loaded.manifests && typeof loaded.manifests === 'object') {
      this.data = loaded;
    } else {
      if (fileExisted) {
        console.warn(`[samarth-desktop] install-manifest unreadable or incompatible — resetting: ${filePath}`);
      }
      this.data = structuredClone(EMPTY);
    }
  }

  static key(accountId: string, containerId: string, workspaceId: string): string {
    return `${accountId}/${containerId}/${workspaceId}`;
  }

  private persist(): void {
    writeJsonFileAtomic(this.filePath, this.data);
  }

  /** The manifest for a workspace, or null if nothing recorded yet. */
  get(key: string): InstallManifest | null {
    return this.data.manifests[key] ?? null;
  }

  /**
   * Merge `entries` into the workspace's manifest (creating it on first use),
   * persist, and return the updated manifest. `ids` seed a new manifest's
   * account/container/workspace fields; `updatedAt` is stamped on the result.
   */
  record(
    key: string,
    ids: { account: string; container: string; workspace: string },
    entries: ManifestResource[],
    updatedAt: string
  ): InstallManifest {
    const existing = this.data.manifests[key];
    const base: InstallManifest =
      existing ?? {
        version: 1,
        account: ids.account,
        container: ids.container,
        workspace: ids.workspace,
        updatedAt,
        resources: [],
      };
    const next = upsertResources(base, entries, updatedAt);
    this.data.manifests[key] = next;
    this.persist();
    return next;
  }
}
