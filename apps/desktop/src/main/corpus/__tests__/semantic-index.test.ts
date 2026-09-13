// Tests for the corpus semantic index and its vector cache. The properties that keep this from ever
// making the corpus tool worse: the first call NEVER blocks, a failure degrades to keyword, and a
// model change misses the cache instead of comparing vectors from two different spaces.
// Run: tsx src/main/corpus/__tests__/semantic-index.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusSemanticIndex, corpusVocabulary, termToText } from '../semantic-index';
import { EmbeddingStore } from '../../storage/embedding-store';
import { embeddingCacheKey } from '../../../shared/embeddings';
import type { PatternLibrary } from '../../../shared/corpus-patterns';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.error(`  FAIL ${name}: ${(e as Error).message}`); failed += 1; }
}

const dir = mkdtempSync(join(tmpdir(), 'embed-'));

/** Offline embedder: a crude bag-of-concepts vector, so these tests never touch the network. */
const AXES = ['demo', 'consultation', 'purchase', 'item'];
let embedCalls = 0;
const fakeEmbed = async (_p: string, _k: string, texts: readonly string[]): Promise<{ vectors: number[][] }> => {
  embedCalls += 1;
  return { vectors: texts.map((t) => AXES.map((a) => (t.toLowerCase().includes(a) ? 1 : 0))) };
};
const lib = {
  version: 1, minedAt: '2026-07-22', containersScanned: 490, minContainers: 2,
  tagPatterns: [{ eventName: 'book_a_demo_click' }, { eventName: 'purchase' }, { eventName: 'purchase' }],
  triggerPatterns: [{ event: 'schedule_a_consultation_click' }],
  variablePatterns: [{ keyPath: 'ecommerce.items.0.item_id' }],
  vendorStats: [],
} as unknown as PatternLibrary;

async function main(): Promise<void> {
  console.log('\nCorpus semantic index:');

  await test('vocabulary is the DISTINCT names, not every pattern', () => {
    const v = corpusVocabulary(lib);
    assert.deepEqual(v, ['book_a_demo_click', 'ecommerce.items.0.item_id', 'purchase', 'schedule_a_consultation_click']);
    assert.equal(v.length, 4, 'the duplicate purchase collapses');
  });

  await test('a term is rendered as language the model can read', () => {
    assert.match(termToText('book_a_demo_click'), /book a demo click/);
    assert.match(termToText('ecommerce.items.0.item_id'), /ecommerce items 0 item id/);
    assert.match(termToText('addToCart'), /add to cart/, 'camelCase is split too');
    assert.match(termToText('x'), /analytics event or data layer field/, 'the domain prefix anchors the space');
  });

  await test('the FIRST search never blocks: it returns null and builds in the background', async () => {
    const store = new EmbeddingStore(join(dir, 'a.json'));
    const idx = new CorpusSemanticIndex(store, fakeEmbed);
    const started = Date.now();
    const hits = await idx.search(lib, 'openai', 'key', 'demo booking');
    assert.equal(hits, null, 'no semantic hits yet');
    assert.ok(Date.now() - started < 2_000, 'returned immediately rather than waiting on the API');
    // 'building' or already 'ready': the offline embedder resolves instantly. What matters is that
    // the CALLER was not made to wait for it.
    assert.ok(['building', 'ready'].includes(idx.status().state), `kicked off a build, got ${idx.status().state}`);

    // Once the background build lands, the SAME query answers semantically.
    await idx.build(lib, 'openai', 'key');
    assert.equal(idx.status().state, 'ready');
    const now = await idx.search(lib, 'openai', 'key', 'demo');
    assert.ok(now && now.includes('book_a_demo_click'), `expected the demo term, got ${JSON.stringify(now)}`);
  });

  await test('an unsupported provider or missing key is a no-op, not an error', async () => {
    const idx = new CorpusSemanticIndex(new EmbeddingStore(join(dir, 'b.json')), fakeEmbed);
    assert.equal(await idx.search(lib, 'anthropic', 'key', 'q'), null);
    assert.equal(await idx.search(lib, 'openai', '', 'q'), null);
    assert.equal(await idx.search(lib, 'openai', 'key', '   '), null);
    assert.equal(idx.status().state, 'idle', 'nothing was even attempted');
  });

  await test('a failed build reports itself and leaves the tool on keyword', async () => {
    const idx = new CorpusSemanticIndex(new EmbeddingStore(join(dir, 'c.json')), fakeEmbed);
    // 'nonsense' has no embedding model, so the build refuses before any network call.
    await idx.build(lib, 'nonsense', 'key');
    const st = idx.status();
    assert.equal(st.state, 'failed');
    assert.match(st.error ?? '', /cannot embed/i);
    assert.equal(await idx.search(lib, 'nonsense', 'key', 'q'), null, 'search still returns null, never throws');
  });

  console.log('\nEmbedding cache:');

  await test('a vector round-trips and persists across a reload', () => {
    const file = join(dir, 'store1.json');
    const a = new EmbeddingStore(file);
    a.set('k1', [0.1, 0.2]);
    a.flush();
    assert.deepEqual(new EmbeddingStore(file).get('k1'), [0.1, 0.2]);
  });

  await test('nothing is written until flush, so a bulk build rewrites the file once', () => {
    const file = join(dir, 'store2.json');
    const a = new EmbeddingStore(file);
    a.set('k1', [1]);
    assert.equal(new EmbeddingStore(file).get('k1'), null, 'not on disk yet');
    a.flush();
    assert.deepEqual(new EmbeddingStore(file).get('k1'), [1]);
  });

  await test('a MODEL change misses the cache (vectors from two models are not comparable)', () => {
    const store = new EmbeddingStore(join(dir, 'store3.json'));
    store.set(embeddingCacheKey('model-a', 'hello'), [1, 0]);
    assert.deepEqual(store.get(embeddingCacheKey('model-a', 'hello')), [1, 0]);
    assert.equal(store.get(embeddingCacheKey('model-b', 'hello')), null);
  });

  await test('the cap evicts the least recently used', () => {
    let t = 0;
    const store = new EmbeddingStore(join(dir, 'store4.json'), 2, () => (t += 1));
    store.set('old', [1]);
    store.set('mid', [2]);
    store.get('old');       // touched, so 'mid' is now the coldest
    store.set('new', [3]);  // over the cap
    store.flush();
    assert.deepEqual(store.get('old'), [1], 'recently used survives');
    assert.deepEqual(store.get('new'), [3], 'the newest survives');
    assert.equal(store.get('mid'), null, 'the coldest was evicted');
  });

  await test('empty and malformed writes are ignored', () => {
    const store = new EmbeddingStore(join(dir, 'store5.json'));
    store.set('', [1]);
    store.set('k', []);
    assert.equal(store.size(), 0);
  });

  await test('a corrupt file loads as empty rather than throwing', () => {
    const file = join(dir, 'store6.json');
    require('node:fs').writeFileSync(file, 'not json at all', 'utf8');
    assert.equal(new EmbeddingStore(file).size(), 0);
  });

  await test('clear empties it and persists', () => {
    const file = join(dir, 'store7.json');
    const a = new EmbeddingStore(file);
    a.set('k', [1]);
    a.flush();
    a.clear();
    assert.equal(new EmbeddingStore(file).size(), 0);
  });

  rmSync(dir, { recursive: true, force: true });
  console.log(`\nsemantic-index: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
