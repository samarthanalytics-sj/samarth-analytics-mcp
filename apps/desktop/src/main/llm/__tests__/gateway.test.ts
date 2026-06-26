import assert from 'node:assert/strict';
import { runChat } from '../gateway';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, ToolExecutor } from '../types';

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
  /** Every input passed to chatStream, in order — lets tests assert what got fed back. */
  readonly inputs: LlmChatInput[] = [];
  constructor(private readonly replies: LlmReply[]) {}
  async chatStream(input: LlmChatInput, onDelta: (t: string) => void): Promise<LlmReply> {
    this.inputs.push(input);
    const reply = this.replies[Math.min(this.i++, this.replies.length - 1)];
    if (reply.text) onDelta(reply.text);
    return reply;
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
    { onToolCall: (c) => calls.push(c) }
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

await test('fail-fast: after one tool error, the rest of the batch is skipped (not executed/approved)', async () => {
  const executed: unknown[] = [];
  const announced: string[] = [];
  const client = new ScriptedClient([
    { toolCalls: [
      { id: '1', name: 't', args: { tag: 1 } },
      { id: '2', name: 't', args: { tag: 2 } },
      { id: '3', name: 't', args: { tag: 3 } },
    ] },
    { text: 'done' },
  ]);
  // execute() throws on the first call; 2 & 3 must never reach it.
  const exec = executor(async (_n, a) => {
    executed.push(a);
    throw new Error('tag 1 failed');
  });
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    { onToolCall: (c) => announced.push(c.id) }
  );
  assert.equal(res.text, 'done');
  assert.equal(executed.length, 1, 'only the first tool actually ran');
  assert.deepEqual(announced, ['1'], 'calls 2 & 3 were skipped before any approval prompt');
  // Protocol invariant: EVERY tool call must get a paired result fed back, or the
  // provider 400s. The 2nd model turn's last message is the tool turn — assert all 3.
  const secondTurnMessages = client.inputs[1]?.messages ?? [];
  const toolTurn = secondTurnMessages[secondTurnMessages.length - 1] as { role: string; results?: Array<{ id: string; isError?: boolean }> };
  assert.equal(toolTurn.role, 'tool', 'a tool-result turn was fed back');
  assert.deepEqual((toolTurn.results ?? []).map((r) => r.id), ['1', '2', '3'], 'all 3 tool calls have a paired result (incl. the 2 skipped)');
  assert.equal((toolTurn.results ?? []).every((r) => r.isError), true, 'the failed call + both skipped results are all errors');
});

await test('caps at maxSteps when the model keeps calling tools, and says the task is NOT done', async () => {
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 't', args: {} }] }]);
  const exec = executor(async () => 'ok');
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    {},
    2
  );
  assert.equal(res.steps, 2);
  assert.match(res.text, /tool-call limit/);
  assert.match(res.text, /NOT done/i);
});

await test('at the tool-call limit, surfaces the real tool error + names the tool', async () => {
  // Model keeps retrying a tool that always fails — the final message must explain WHY.
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 't', args: {} }] }]);
  const exec = executor(async () => {
    throw new Error('customEventFilter: must have exactly one custom-event filter');
  });
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    {},
    2
  );
  assert.match(res.text, /NOT done/i, 'states the task did not complete');
  assert.match(res.text, /customEventFilter: must have exactly one/, 'quotes the real error');
  assert.match(res.text, /`t`/, 'names the failing tool');
});

await test('forwards streamed text deltas via onDelta', async () => {
  const deltas: string[] = [];
  const client = new ScriptedClient([{ text: 'streamed reply' }]);
  const exec = executor(async () => 'ok');
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    { onDelta: (d) => deltas.push(d) }
  );
  assert.equal(res.text, 'streamed reply');
  assert.deepEqual(deltas, ['streamed reply']);
});

await test('stop: an already-aborted signal returns "Stopped." and never calls the model', async () => {
  const client = new ScriptedClient([{ text: 'should not run' }]);
  const ac = new AbortController();
  ac.abort();
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }], signal: ac.signal },
    executor(async () => 'ok')
  );
  assert.equal(res.text, 'Stopped.');
  assert.equal(client.inputs.length, 0, 'model not called once stopped');
});

await test('stop: a provider AbortError is returned as "Stopped." (not thrown)', async () => {
  const client: LlmClient = {
    async chatStream() {
      const e = new Error('aborted') as Error & { name: string };
      e.name = 'AbortError';
      throw e;
    },
  };
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    executor(async () => 'ok')
  );
  assert.equal(res.text, 'Stopped.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
