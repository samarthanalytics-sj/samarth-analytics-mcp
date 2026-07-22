// The semantic index over the corpus vocabulary.
//
// Only the DISTINCT event names and dataLayer key paths are embedded, not all 1,297 patterns. That is
// where the synonym problem actually lives (book_a_demo_click / schedule_a_consultation_click /
// book_call_click are four ways to say one thing), and it turns a 1,297-item build into roughly 330
// short strings, which is the difference between a usable first run and a minute of waiting.
//
// Three properties keep this from ever degrading the tool it augments:
//
//   NEVER BLOCKS. The first call starts the build in the BACKGROUND and returns nothing. The lookup
//   answers from keyword search exactly as before, and says the index is still building. A chat turn
//   must never sit waiting on an embeddings API.
//
//   CACHED BY MODEL AND TEXT. Vectors persist, so the build happens once, later runs are free, and a
//   model change misses the cache rather than silently comparing vectors from two different spaces.
//
//   FAILS TO KEYWORD. No key, no network, an unsupported provider, a provider error: all leave the
//   lookup exactly as it is today, with the reason available to show.
import { embedTexts, embeddingModelFor } from '../llm/embeddings';
import { embeddingCacheKey, nearest, type EmbeddedItem } from '../../shared/embeddings';
import type { EmbeddingStore } from '../storage/embedding-store';
import type { PatternLibrary } from '../../shared/corpus-patterns';

export type IndexState = 'idle' | 'building' | 'ready' | 'failed';

export interface SemanticStatus {
  state: IndexState;
  /** How many vocabulary terms are indexed. */
  terms: number;
  /** Set when the last build failed, for the operator. */
  error?: string;
}

/** Every distinct name worth searching semantically, deduplicated and bounded. */
export function corpusVocabulary(lib: PatternLibrary): string[] {
  const out = new Set<string>();
  for (const t of lib?.tagPatterns ?? []) if (t.eventName) out.add(t.eventName);
  for (const t of lib?.triggerPatterns ?? []) if (t.event) out.add(t.event);
  for (const v of lib?.variablePatterns ?? []) if (v.keyPath) out.add(v.keyPath);
  return [...out].sort();
}

/**
 * A term as a sentence the embedding model can read.
 *
 * "add_to_cart" carries little signal as a token; "analytics event: add to cart" reads as language and
 * lands near "put something in the basket". The prefix also keeps the corpus vocabulary in one region
 * of the space, so a query about analytics does not match on the generic English of a key path.
 */
export function termToText(term: string): string {
  const words = String(term ?? '').replace(/[._]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return `analytics event or data layer field: ${words.toLowerCase()}`;
}

/** The embedding call, injectable so tests never touch the network (same seam style as sse.ts). */
export type EmbedFn = (provider: string, apiKey: string, texts: readonly string[]) => Promise<{ vectors: number[][] }>;

export class CorpusSemanticIndex {
  private state: IndexState = 'idle';
  private error?: string;
  private items: EmbeddedItem[] = [];
  private model = '';
  private building: Promise<void> | null = null;

  constructor(
    private readonly store: EmbeddingStore,
    private readonly embed: EmbedFn = (provider, apiKey, texts) => embedTexts(provider, apiKey, texts),
  ) {}

  status(): SemanticStatus {
    return { state: this.state, terms: this.items.length, ...(this.error ? { error: this.error } : {}) };
  }

  /**
   * Terms semantically near the query, or null when the index cannot answer yet.
   *
   * Null is the normal case on a first call: the build is kicked off and the caller falls back to
   * keyword. It is never an error the user has to act on.
   */
  async search(
    lib: PatternLibrary,
    provider: string,
    apiKey: string,
    query: string,
    limit = 12,
  ): Promise<string[] | null> {
    if (!embeddingModelFor(provider) || !apiKey || !query.trim()) return null;
    if (this.state === 'idle' || (this.state === 'ready' && this.model !== embeddingModelFor(provider))) {
      void this.build(lib, provider, apiKey); // background: the caller must not wait
      return null;
    }
    if (this.state !== 'ready') return null;

    try {
      // One short query embedding per lookup; the vocabulary side is already cached.
      const { vectors } = await this.embed(provider, apiKey, [termToText(query)]);
      if (!vectors.length) return null;
      return nearest(vectors[0], this.items, limit).map((h) => h.id);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null; // a failed query is a keyword-only lookup, never a broken one
    }
  }

  /** Build (or rebuild) the vocabulary index. Safe to call repeatedly; concurrent calls share one run. */
  build(lib: PatternLibrary, provider: string, apiKey: string): Promise<void> {
    if (this.building) return this.building;
    const model = embeddingModelFor(provider);
    if (!model) { this.state = 'failed'; this.error = `${provider} cannot embed.`; return Promise.resolve(); }

    this.state = 'building';
    this.error = undefined;
    this.building = (async () => {
      try {
        const terms = corpusVocabulary(lib);
        const items: EmbeddedItem[] = [];
        const missing: string[] = [];
        for (const term of terms) {
          const cached = this.store.get(embeddingCacheKey(model, termToText(term)));
          if (cached) items.push({ id: term, vector: cached });
          else missing.push(term);
        }
        if (missing.length) {
          const { vectors } = await this.embed(provider, apiKey, missing.map(termToText));
          missing.forEach((term, i) => {
            const vector = vectors[i];
            if (!vector?.length) return;
            this.store.set(embeddingCacheKey(model, termToText(term)), vector);
            items.push({ id: term, vector });
          });
          this.store.flush();
        }
        this.items = items;
        this.model = model;
        this.state = items.length ? 'ready' : 'failed';
        if (!items.length) this.error = 'No corpus vocabulary could be embedded.';
        console.error(`[corpus] semantic index ${this.state}: ${items.length} term(s), ${missing.length} newly embedded`);
      } catch (e) {
        this.state = 'failed';
        this.error = e instanceof Error ? e.message : String(e);
        console.error('[corpus] semantic index failed, keyword search continues:', this.error);
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }
}
