// Tests for the embedding client. Driven by an injected fetch, so they run offline and assert what
// we actually send: batching, ordering, normalization, and that a failure message never carries the
// API key.
// Run: tsx src/main/llm/__tests__/embeddings.test.ts
import assert from 'node:assert/strict';
import { embedTexts, embeddingModelFor, EMBED_BATCH } from '../embeddings';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed += 1; }
}

/** A fetch that records every call and replies with a scripted body. */
function fakeFetch(reply: (body: Record<string, unknown>) => unknown, status = 200): {
  impl: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: (init.headers ?? {}) as Record<string, string> });
    const payload = reply(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function main(): Promise<void> {
  console.log('\nEmbedding client:');

  await test('openai: sends the texts and returns one unit vector each, in order', async () => {
    const { impl, calls } = fakeFetch((b) => ({
      data: (b.input as string[]).map((_t, i) => ({ index: i, embedding: [i + 1, 0, 0] })),
    }));
    const res = await embedTexts('openai', 'sk-test', ['a', 'b'], impl);
    assert.equal(res.model, 'text-embedding-3-small');
    assert.equal(res.vectors.length, 2);
    // Normalized on the way out, so callers never have to remember to do it.
    assert.ok(Math.abs(Math.hypot(...res.vectors[0]) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...res.vectors[1]) - 1) < 1e-9);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.input, ['a', 'b']);
  });

  await test('openai: out-of-order responses are re-sorted by index', async () => {
    const { impl } = fakeFetch(() => ({
      data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }],
    }));
    const res = await embedTexts('openai', 'k', ['first', 'second'], impl);
    assert.deepEqual(res.vectors[0], [1, 0, 0], 'the first input keeps the first vector');
  });

  await test('gemini: uses its own endpoint and payload shape', async () => {
    const { impl, calls } = fakeFetch((b) => ({
      embeddings: (b.requests as unknown[]).map(() => ({ values: [1, 0] })),
    }));
    const res = await embedTexts('gemini', 'key123', ['x'], impl);
    assert.equal(res.model, 'text-embedding-004');
    assert.match(calls[0].url, /batchEmbedContents/);
    assert.equal(res.vectors.length, 1);
  });

  await test('batches larger inputs rather than sending one huge request', async () => {
    const texts = Array.from({ length: EMBED_BATCH + 5 }, (_, i) => `t${i}`);
    const { impl, calls } = fakeFetch((b) => ({
      data: (b.input as string[]).map((_t, i) => ({ index: i, embedding: [1, 0] })),
    }));
    const res = await embedTexts('openai', 'k', texts, impl);
    assert.equal(calls.length, 2, 'split into two requests');
    assert.equal(res.vectors.length, texts.length, 'every input still gets a vector');
  });

  await test('blank texts are dropped before anything is sent', async () => {
    const { impl, calls } = fakeFetch((b) => ({ data: (b.input as string[]).map((_t, i) => ({ index: i, embedding: [1] })) }));
    const res = await embedTexts('openai', 'k', ['', '   ', 'real'], impl);
    assert.deepEqual(calls[0].body.input, ['real']);
    assert.equal(res.vectors.length, 1);
  });

  await test('an empty list makes no request at all', async () => {
    const { impl, calls } = fakeFetch(() => ({ data: [] }));
    const res = await embedTexts('openai', 'k', [], impl);
    assert.equal(calls.length, 0);
    assert.equal(res.vectors.length, 0);
  });

  await test('anthropic is refused rather than silently routed elsewhere', async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    await assert.rejects(embedTexts('anthropic', 'k', ['x'], impl), /does not offer an embeddings API/i);
    assert.equal(calls.length, 0, 'the text was never sent anywhere');
  });

  await test('a provider error surfaces its message and NEVER the api key', async () => {
    const { impl } = fakeFetch(() => ({ error: { message: 'insufficient_quota' } }), 429);
    await assert.rejects(embedTexts('openai', 'sk-super-secret-key', ['x'], impl), (e: Error) => {
      assert.match(e.message, /insufficient_quota/);
      assert.ok(!e.message.includes('sk-super-secret-key'), 'the key must not reach the message');
      return true;
    });
  });

  await test('a short response is rejected, not silently mis-paired with the inputs', async () => {
    // Two inputs, one embedding back: pairing them by position would attach the wrong vector.
    const { impl } = fakeFetch(() => ({ data: [{ index: 0, embedding: [1, 0] }] }));
    await assert.rejects(embedTexts('openai', 'k', ['a', 'b'], impl), /returned 1 embeddings for 2 inputs/);
  });

  await test('embeddingModelFor states capability honestly', async () => {
    assert.equal(embeddingModelFor('openai'), 'text-embedding-3-small');
    assert.equal(embeddingModelFor('gemini'), 'text-embedding-004');
    assert.equal(embeddingModelFor('anthropic'), null);
    assert.equal(embeddingModelFor('nonsense'), null);
  });

  console.log(`\nembedding-client: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
