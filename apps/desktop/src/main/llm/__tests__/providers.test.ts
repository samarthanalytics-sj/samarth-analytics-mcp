import assert from 'node:assert/strict';
import { toOpenAiMessages, parseOpenAiReply } from '../openai';
import { toAnthropicMessages, parseAnthropicReply } from '../anthropic';
import type { LlmTurn } from '../types';

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

const convo: LlmTurn[] = [
  { role: 'user', text: 'list accounts' },
  { role: 'assistant', text: 'checking', toolCalls: [{ id: 'c1', name: 'list_gtm_accounts', args: {} }] },
  { role: 'tool', results: [{ id: 'c1', name: 'list_gtm_accounts', content: '[]' }] },
];

console.log('\nLLM provider mappers:');

test('OpenAI: system prepended, tool_calls + tool role mapped', () => {
  const msgs = toOpenAiMessages('SYS', convo);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'SYS');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].tool_calls?.[0].function.name, 'list_gtm_accounts');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
});

test('OpenAI: parse content + tool_calls with JSON args', () => {
  const reply = parseOpenAiReply({
    choices: [
      {
        message: {
          content: 'hi',
          tool_calls: [{ id: '1', type: 'function', function: { name: 't', arguments: '{"x":1}' } }],
        },
      },
    ],
  });
  assert.equal(reply.text, 'hi');
  assert.equal(reply.toolCalls?.[0].name, 't');
  assert.deepEqual(reply.toolCalls?.[0].args, { x: 1 });
});

test('Anthropic: tool_use + tool_result blocks mapped', () => {
  const msgs = toAnthropicMessages(convo);
  assert.equal(msgs[1].content.some((b) => b.type === 'tool_use'), true);
  const toolResultMsg = msgs[2];
  assert.equal(toolResultMsg.role, 'user');
  assert.equal(toolResultMsg.content[0].type, 'tool_result');
  assert.equal(toolResultMsg.content[0].tool_use_id, 'c1');
});

test('Anthropic: parse text + tool_use blocks', () => {
  const reply = parseAnthropicReply({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: '1', name: 't', input: { a: 2 } },
    ],
  });
  assert.equal(reply.text, 'hello');
  assert.equal(reply.toolCalls?.[0].name, 't');
  assert.deepEqual(reply.toolCalls?.[0].args, { a: 2 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
