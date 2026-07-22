import assert from 'node:assert/strict';
import { openaiStreamAccumulator } from '../openai';
import { anthropicStreamAccumulator } from '../anthropic';
import { geminiStreamAccumulator } from '../gemini';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nStreaming accumulators:');

test('OpenAI: assembles text deltas + fragmented tool-call args', () => {
  const deltas: string[] = [];
  const acc = openaiStreamAccumulator((d) => deltas.push(d));
  acc.push({ choices: [{ delta: { content: 'Hel' } }] });
  acc.push({ choices: [{ delta: { content: 'lo' } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'list_gtm_accounts' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] });
  const r = acc.result();
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(r.text, 'Hello');
  assert.equal(r.toolCalls?.[0].name, 'list_gtm_accounts');
  assert.deepEqual(r.toolCalls?.[0].args, { a: 1 });
});

test('Anthropic: text_delta + tool_use input_json_delta across events', () => {
  const deltas: string[] = [];
  const acc = anthropicStreamAccumulator((d) => deltas.push(d));
  acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } });
  acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } });
  acc.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'list_ga4_accounts' } });
  acc.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } });
  const r = acc.result();
  assert.deepEqual(deltas, ['Hi ', 'there']);
  assert.equal(r.text, 'Hi there');
  assert.equal(r.toolCalls?.[0].id, 't1');
  assert.equal(r.toolCalls?.[0].name, 'list_ga4_accounts');
});

test('Gemini: text parts stream, functionCall parts collected', () => {
  const deltas: string[] = [];
  const acc = geminiStreamAccumulator((d) => deltas.push(d));
  acc.push({ candidates: [{ content: { parts: [{ text: 'one ' }] } }] });
  acc.push({ candidates: [{ content: { parts: [{ text: 'two' }] } }] });
  acc.push({ candidates: [{ content: { parts: [{ functionCall: { name: 'run_ga4_report', args: { property: 'properties/1' } } }] } }] });
  const r = acc.result();
  assert.deepEqual(deltas, ['one ', 'two']);
  assert.equal(r.text, 'one two');
  assert.equal(r.toolCalls?.[0].name, 'run_ga4_report');
  assert.deepEqual(r.toolCalls?.[0].args, { property: 'properties/1' });
});

// -- Prompt-cache usage riding the SAME streams --------------------------------
// The counts have to survive the real chunk order (usage arrives on a different event to the text),
// otherwise the feature is unverifiable and we would be assuming caching works.

test('OpenAI: the trailing usage chunk is read, and its empty choices do not disturb the text', () => {
  const deltas: string[] = [];
  const acc = openaiStreamAccumulator((d) => deltas.push(d));
  acc.push({ choices: [{ delta: { content: 'hi' } }] });
  acc.push({ choices: [], usage: { prompt_tokens: 20_438, prompt_tokens_details: { cached_tokens: 19_968 } } });
  const r = acc.result();
  assert.equal(r.text, 'hi', 'text unaffected by the usage chunk');
  assert.equal(r.usage?.read, 19_968);
  assert.equal(r.usage?.input, 470);
});

test('Anthropic: cache counts come off message_start, before any text arrives', () => {
  const acc = anthropicStreamAccumulator(() => {});
  acc.push({ type: 'message_start', message: { usage: { input_tokens: 21, cache_read_input_tokens: 20_417 } } });
  acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
  const r = acc.result();
  assert.equal(r.text, 'ok');
  assert.equal(r.usage?.read, 20_417, 'the cache hit is what step 2+ of a turn should show');
  assert.equal(r.usage?.written, 0);
});

test('Anthropic: step 1 of a turn reports the WRITE, not a read', () => {
  const acc = anthropicStreamAccumulator(() => {});
  acc.push({ type: 'message_start', message: { usage: { input_tokens: 21, cache_creation_input_tokens: 20_417 } } });
  assert.equal(acc.result().usage?.written, 20_417);
  assert.equal(acc.result().usage?.read, 0);
});

test('Gemini: usageMetadata on a chunk is picked up', () => {
  const acc = geminiStreamAccumulator(() => {});
  acc.push({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
  acc.push({ usageMetadata: { promptTokenCount: 12_000, cachedContentTokenCount: 8_000 } });
  const r = acc.result();
  assert.equal(r.text, 'hi');
  assert.equal(r.usage?.read, 8_000);
});

test('a provider that reports NO usage leaves the field undefined (never a fake zero)', () => {
  const acc = openaiStreamAccumulator(() => {});
  acc.push({ choices: [{ delta: { content: 'hi' } }] });
  assert.equal(acc.result().usage, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
