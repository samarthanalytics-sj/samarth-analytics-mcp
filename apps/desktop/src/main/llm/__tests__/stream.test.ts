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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
