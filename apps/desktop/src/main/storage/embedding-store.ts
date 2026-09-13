// Cached vectors, so an embedding is paid for once.
//
// Keys already carry the model (see embeddingCacheKey), so entries for two models coexist without
// ever being compared to each other. Writes are batched behind flush(): a build inserts hundreds of
// vectors, and persisting each one would rewrite the whole file hundreds of times.
//
// Bounded on purpose. Vectors are the largest thing this app stores per item (1,536 floats each for
// text-embedding-3-small), so the file is capped and the oldest entries are dropped first.
import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonFileAtomic } from './json-file';

interface EmbeddingFile {
  version: 1;
  /** cache key -> vector, alongside when it was last used. */
  entries: Record<string, { v: number[]; at: number }>;
}

const EMPTY: EmbeddingFile = { version: 1, entries: {} };

/** Roughly 3,000 vectors at 1,536 dims is a large file but a bounded one. The corpus vocabulary is
 *  ~330 terms, so this leaves generous room for queries and a model change. */
export const MAX_EMBEDDINGS = 3_000;

export class EmbeddingStore {
  private data: EmbeddingFile;
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly cap: number = MAX_EMBEDDINGS,
    private readonly clock: () => number = () => Date.now(),
  ) {
    const loaded = existsSync(file) ? readJsonFile<EmbeddingFile | null>(file, null) : null;
    this.data = loaded && loaded.version === 1 && loaded.entries && typeof loaded.entries === 'object'
      ? loaded
      : structuredClone(EMPTY);
  }

  /** The cached vector, or null. Touches the entry so the cap evicts genuinely cold ones. */
  get(key: string): number[] | null {
    const hit = this.data.entries[key];
    if (!hit || !Array.isArray(hit.v) || !hit.v.length) return null;
    hit.at = this.clock();
    this.dirty = true;
    return hit.v;
  }

  /** Remember a vector. Held in memory until flush(), so a bulk build writes the file once. */
  set(key: string, vector: readonly number[]): void {
    if (!key || !vector?.length) return;
    this.data.entries[key] = { v: [...vector], at: this.clock() };
    this.dirty = true;
  }

  /** Persist, evicting the least recently used first when over the cap. */
  flush(): void {
    if (!this.dirty) return;
    const keys = Object.keys(this.data.entries);
    if (keys.length > this.cap) {
      const byAge = keys.sort((a, b) => (this.data.entries[a].at ?? 0) - (this.data.entries[b].at ?? 0));
      for (const k of byAge.slice(0, keys.length - this.cap)) delete this.data.entries[k];
    }
    writeJsonFileAtomic(this.file, this.data);
    this.dirty = false;
  }

  /** How many vectors are cached. */
  size(): number {
    return Object.keys(this.data.entries).length;
  }

  /** Drop everything, e.g. after switching provider. Persists immediately. */
  clear(): void {
    this.data = structuredClone(EMPTY);
    this.dirty = true;
    this.flush();
  }
}
