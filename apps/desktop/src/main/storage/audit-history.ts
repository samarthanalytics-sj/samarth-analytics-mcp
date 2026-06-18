import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonFileAtomic } from './json-file';
import type { AuditReport } from '../google/gtm-builders';

// One stored audit run: when it ran + the report it produced. Findings are kept
// so the next run can diff against them (new vs resolved issues).
export interface AuditRun {
  at: number;
  report: AuditReport;
}

interface AuditHistoryFile {
  version: 1;
  // keyed by `${accountId}/${containerId}/${workspaceId}`
  runs: Record<string, AuditRun[]>;
}

const EMPTY: AuditHistoryFile = { version: 1, runs: {} };

/**
 * Local, append-only history of container audits per workspace — the memory
 * that lets continuous monitoring say "what changed since last time". Plain
 * config metadata (no secrets), persisted atomically next to registry.json.
 */
export class AuditHistoryStore {
  private data: AuditHistoryFile;

  constructor(
    private readonly filePath: string,
    /** How many runs to retain per workspace (oldest pruned). */
    private readonly keep = 20,
    /** How many distinct workspaces to retain (least-recently-audited evicted). */
    private readonly maxKeys = 50
  ) {
    const fileExisted = existsSync(filePath);
    const loaded = readJsonFile<AuditHistoryFile>(filePath, structuredClone(EMPTY));
    // Only accept a known-schema file; anything else (corrupt or a future
    // version) is reset — but surface it so the data loss isn't silent.
    if (loaded && loaded.version === 1 && loaded.runs && typeof loaded.runs === 'object') {
      this.data = loaded;
    } else {
      if (fileExisted) {
        console.warn(`[samarth-desktop] audit-history unreadable or incompatible — resetting: ${filePath}`);
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

  /** Most recent run for a workspace, or null if none recorded yet. */
  last(key: string): AuditRun | null {
    const runs = this.data.runs[key];
    return runs && runs.length ? runs[runs.length - 1] : null;
  }

  /** All retained runs for a workspace, oldest first. */
  runs(key: string): AuditRun[] {
    return this.data.runs[key] ?? [];
  }

  /** Append a run and prune to the retention window. Returns the stored run. */
  append(key: string, run: AuditRun): AuditRun {
    const list = this.data.runs[key] ?? [];
    list.push(run);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    this.data.runs[key] = list;
    this.pruneKeys(key);
    this.persist();
    return run;
  }

  /** Bound the number of workspaces tracked: evict the least-recently-audited
   *  keys (by newest run) once over the cap. The just-touched key is kept. */
  private pruneKeys(keep: string): void {
    const keys = Object.keys(this.data.runs);
    if (keys.length <= this.maxKeys) return;
    const recencyOf = (k: string): number => {
      const runs = this.data.runs[k];
      return runs && runs.length ? runs[runs.length - 1].at : 0;
    };
    const evictable = keys
      .filter((k) => k !== keep)
      .sort((a, b) => recencyOf(a) - recencyOf(b));
    for (const k of evictable.slice(0, keys.length - this.maxKeys)) delete this.data.runs[k];
  }
}
