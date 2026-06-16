import assert from 'node:assert/strict';
import { runChat } from '../gateway';
import type { LlmClient, LlmReply, LlmToolCall, ToolExecutor } from '../types';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

class ScriptedClient implements LlmClient {
  private i = 0;
  constructor(private readonly replies: LlmReply[]) {}
  async chat(): Promise<LlmReply> {
    return this.replies[Math.min(this.i++, this.replies.length - 1)];
  }
}

function executor(execute: ToolExecutor['execute']): ToolExecutor {
  return { list: () => [{ name: 't', description: 'test tool', inputSchema: {} }], execute };
}

async function main(): Promise<void> {
console.log('\nLLM gateway (runChat):');

await test('executes a tool call then returns the final answer', async () => {
  const calls: LlmToolCall[] = [];
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 't', args: { x: 1 } }] },
    { text: 'final answer' },
  ]);
  const exec = executor(async (n, a) => `result:${n}:${JSON.stringify(a)}`);
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    (c) => calls.push(c)
  );
  assert.equal(res.text, 'final answer');
  assert.equal(res.steps, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 't');
});

await test('a thrown tool error is fed back, loop recovers', async () => {
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 't', args: {} }] },
    { text: 'recovered' },
  ]);
  const exec = executor(async () => {
    throw new Error('boom');
  });
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec
  );
  assert.equal(res.text, 'recovered');
});

await test('caps at maxSteps when the model keeps calling tools', async () => {
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 't', args: {} }] }]);
  const exec = executor(async () => 'ok');
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    undefined,
    2
  );
  assert.equal(res.steps, 2);
  assert.match(res.text, /Stopped after/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
