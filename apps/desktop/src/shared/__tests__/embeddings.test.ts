// Tests for the pure half of semantic retrieval. The properties that matter: the maths never returns
// NaN into a ranking, fusion cannot let a fuzzy match evict an exact one, and a model change misses
// the cache rather than mixing two incompatible vector spaces.
// Run: tsx src/shared/__tests__/embeddings.test.ts
import {
  cosineSimilarity, normalizeVector, nearest, fuseRankings, embeddingCacheKey,
  supportsEmbeddings, semanticUnavailableReason, RRF_K, type EmbeddedItem,
} from '../embeddings';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// ── Cosine similarity ───────────────────────────────────────────────────────────
check('identical vectors are 1', close(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1));
check('opposite vectors are -1', close(cosineSimilarity([1, 0], [-1, 0]), -1));
check('orthogonal vectors are 0', close(cosineSimilarity([1, 0], [0, 1]), 0));
check('magnitude does not matter, only direction', close(cosineSimilarity([1, 1], [10, 10]), 1));
// Every one of these would otherwise put NaN into a sort comparator and scramble the ranking.
check('mismatched lengths are 0, not NaN', cosineSimilarity([1, 2], [1, 2, 3]) === 0);
check('empty vectors are 0', cosineSimilarity([], []) === 0 && cosineSimilarity([1], []) === 0);
check('a zero vector is 0, not NaN', cosineSimilarity([0, 0], [1, 1]) === 0);
check('the result is always finite', [
  cosineSimilarity([1e308, 1e308], [1e308, 1e308]),
  cosineSimilarity([0, 0], [0, 0]),
].every(Number.isFinite));

// ── Normalizing ─────────────────────────────────────────────────────────────────
check('normalize gives unit length', (() => {
  const n = normalizeVector([3, 4]);
  return close(Math.hypot(n[0], n[1]), 1) && close(n[0], 0.6) && close(n[1], 0.8);
})());
check('normalize leaves a zero vector alone rather than dividing by zero', (() => {
  const n = normalizeVector([0, 0]);
  return n.length === 2 && n.every((x) => x === 0);
})());
check('normalize does not mutate its input', (() => {
  const v = [3, 4];
  normalizeVector(v);
  return v[0] === 3 && v[1] === 4;
})());

// ── Nearest ─────────────────────────────────────────────────────────────────────
{
  const items: EmbeddedItem[] = [
    { id: 'demo', vector: [1, 0, 0] },
    { id: 'consultation', vector: [0.9, 0.1, 0] },
    { id: 'purchase', vector: [0, 1, 0] },
  ];
  const hits = nearest([1, 0, 0], items, 5);
  check('nearest returns the closest first', hits[0].id === 'demo' && hits[1].id === 'consultation');
  check('nearest drops what is merely unrelated', !hits.some((h) => h.id === 'purchase'), JSON.stringify(hits));
  check('nearest respects the limit', nearest([1, 0, 0], items, 1).length === 1);
  check('nearest is deterministic when scores tie', (() => {
    const tied: EmbeddedItem[] = [{ id: 'b', vector: [1, 0] }, { id: 'a', vector: [1, 0] }];
    return nearest([1, 0], tied, 2).map((h) => h.id).join() === 'a,b';
  })());
  check('nearest ignores vectors of the wrong width (a stale cache entry)',
    nearest([1, 0, 0], [{ id: 'old', vector: [1, 0] }], 5).length === 0);
  check('nearest on an empty index is empty, not an error', nearest([1, 0, 0], [], 5).length === 0);
  check('nearest with no query is empty', nearest([], items, 5).length === 0);
  check('a higher minScore keeps only the strong matches', nearest([1, 0, 0], items, 5, 0.999).map((h) => h.id).join() === 'demo');
}

// ── Rank fusion ─────────────────────────────────────────────────────────────────
check('an id in BOTH lists outranks one in a single list', (() => {
  const fused = fuseRankings(['a', 'b'], ['b', 'c']);
  return fused[0] === 'b';
})());
check('fusion keeps ids that only ONE side found (that is the point)', (() => {
  const fused = fuseRankings(['a'], ['z']);
  return fused.includes('a') && fused.includes('z');
})());
check('an exact keyword hit is never evicted by a merely similar one', (() => {
  // 'exact' is keyword rank 1 and absent from semantic; 'vague' is semantic rank 1 only.
  const fused = fuseRankings(['exact'], ['vague']);
  return fused[0] === 'exact';
})());
check('keyword outweighs semantic at equal rank, by default', (() => {
  const fused = fuseRankings(['k'], ['s']);
  return fused[0] === 'k';
})());
check('weights are honoured when the caller overrides them', (() => {
  const fused = fuseRankings(['k'], ['s'], { keyword: 1, semantic: 5 });
  return fused[0] === 's';
})());
check('an empty semantic list leaves the keyword order untouched', (() => {
  const kw = ['a', 'b', 'c'];
  return fuseRankings(kw, []).join() === kw.join();
})());
check('an empty keyword list still returns the semantic order', fuseRankings([], ['x', 'y']).join() === 'x,y');
check('both empty is empty', fuseRankings([], []).length === 0);
check('duplicates within one list do not double-count into first place', (() => {
  const fused = fuseRankings(['dup', 'dup', 'other'], ['other']);
  return fused[0] === 'other';
})());
check('blank ids are ignored', fuseRankings(['', 'a'], ['']).join() === 'a');
check('RRF_K is the standard 60', RRF_K === 60);

// ── Cache keys ──────────────────────────────────────────────────────────────────
check('the same model + text gives the same key', embeddingCacheKey('m1', 'hello') === embeddingCacheKey('m1', 'hello'));
check('case and whitespace do not pay for a second embedding',
  embeddingCacheKey('m1', '  Hello   World ') === embeddingCacheKey('m1', 'hello world'));
// Vectors from two models are not comparable; mixing them would silently corrupt every ranking.
check('a DIFFERENT model is a different key', embeddingCacheKey('m1', 'hello') !== embeddingCacheKey('m2', 'hello'));
check('different text is a different key', embeddingCacheKey('m1', 'hello') !== embeddingCacheKey('m1', 'goodbye'));
check('the key is opaque hex, not the text', /^[0-9a-f]{32,}$/.test(embeddingCacheKey('m1', 'secret text')));
check('empty input is still a usable key', embeddingCacheKey('', '').length >= 32);

// ── Provider capability, stated honestly ───────────────────────────────────────
check('openai and gemini can embed', supportsEmbeddings('openai') && supportsEmbeddings('gemini'));
check('anthropic cannot (it publishes no embeddings endpoint)', !supportsEmbeddings('anthropic'));
check('an unknown provider cannot', !supportsEmbeddings('whatever'));
check('disabled is not an error', semanticUnavailableReason({ enabled: false, provider: 'anthropic', hasKey: false }) === null);
check('an unsupported provider explains itself and names the way out', (() => {
  const r = semanticUnavailableReason({ enabled: true, provider: 'anthropic', hasKey: true }) ?? '';
  return /does not offer an embeddings API/i.test(r) && /keyword/i.test(r) && /OpenAI or Gemini/i.test(r);
})());
check('a missing key says where to add one', /Settings/.test(semanticUnavailableReason({ enabled: true, provider: 'openai', hasKey: false }) ?? ''));
check('available means no message', semanticUnavailableReason({ enabled: true, provider: 'openai', hasKey: true }) === null);
check('no em dashes in operator-facing text (house style)',
  !/[—–]/.test((semanticUnavailableReason({ enabled: true, provider: 'anthropic', hasKey: true }) ?? '')
    + (semanticUnavailableReason({ enabled: true, provider: 'openai', hasKey: false }) ?? '')));

console.log(`\nembeddings: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
