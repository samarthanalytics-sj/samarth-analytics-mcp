import assert from 'node:assert/strict';
import { runChat } from '../gateway';
import {
  MAX_BLOCK_CHARS,
  MAX_CARRIED_RESULTS,
  MAX_RESULT_CHARS,
  ToolMemoryStore,
  foldToolResults,
  formatToolMemory,
  isReadOnlyToolName,
} from '../tool-memory';
import { TOOL_RESULT_MAX_CHARS } from '../../../shared/context-budget';
import type { LlmChatInput, LlmClient, LlmReply, LlmToolCall, RetryNotice, ToolExecutor } from '../types';

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

/** Executor whose isWrite verdict is decided by a predicate — for the progress-aware step budget. */
function writeExecutor(execute: ToolExecutor['execute'], isWrite: (name: string) => boolean): ToolExecutor {
  return { list: () => [{ name: 't', description: 'test tool', inputSchema: {} }], execute, isWrite };
}

/** Client that replays a fixed list of tool-call names, one call per step, then a final answer. Each
 *  call gets DISTINCT args (its index) so the repeated-identical-write guard never trips - these
 *  helpers model progress across distinct items, not a loop on one. */
function callsThenAnswer(names: string[], answer = 'done'): ScriptedClient {
  return new ScriptedClient([
    ...names.map((name, i) => ({ toolCalls: [{ id: String(i + 1), name, args: { i } }] })),
    { text: answer },
  ]);
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

await test('BULK: a realistic 40-tag build finishes in ONE turn under the production budget (soft 40 / hard 300)', async () => {
  // Faithful to chat-service: a reasoning model does ONE call per step. The user says "create these
  // 40 tags"; the model lists once, then issues 40 create_gtm_tracking_tag calls (each a draft-write),
  // then a final summary. That is 42 steps - past the soft ceiling of 40. The progress-aware budget
  // must carry it to the end because a write lands on every build step.
  const SOFT = 40, HARD = 300; // the exact values chat-service passes
  const isGtmWrite = (name: string): boolean => name.startsWith('create_');
  // DISTINCT args per tag (real builds have unique names), so the repeated-write guard never trips -
  // it only blocks IDENTICAL repeats, which a genuine 40-tag build never issues.
  const buildCalls = [
    { id: '1', name: 'list_gtm_tags', args: {} },
    ...Array.from({ length: 40 }, (_, i) => ({ id: String(i + 2), name: 'create_gtm_tracking_tag', args: { tagName: `GA4 - Event - Tag ${i + 1}` } })),
  ];
  const clientReplies = [...buildCalls.map((c) => ({ toolCalls: [c] })), { text: 'Done. All 40 tags were created in the draft workspace.' }];

  const client = new ScriptedClient(clientReplies);
  let creates = 0;
  const exec = writeExecutor(async (name) => {
    if (name.startsWith('create_')) creates += 1;
    return name.startsWith('create_') ? JSON.stringify({ tag: { tagId: `T${creates}` } }) : '[]';
  }, isGtmWrite);

  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'create these 40 tags' }] },
    exec,
    {},
    SOFT,
    { hardMaxSteps: HARD }
  );
  assert.equal(creates, 40, `all 40 tags were created (built ${creates})`);
  assert.equal(res.text, 'Done. All 40 tags were created in the draft workspace.', 'one final summary, not a mid-batch "proceed" prompt');
  assert.doesNotMatch(res.text, /tool-call limit|NOT done|proceed/i, 'never surfaced the step-limit / proceed message');
  assert.equal(res.steps, 42, '1 list + 40 creates + 1 final answer, carried past the soft ceiling of 40');

  // Before the fix (no extension: hard == soft == 40) the SAME build stalls out and forces "proceed".
  const before = await runChat(
    new ScriptedClient([...buildCalls.map((c) => ({ toolCalls: [c] })), { text: 'Done.' }]),
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'create these 40 tags' }] },
    writeExecutor(async () => '{}', isGtmWrite),
    {},
    SOFT // no hardMaxSteps -> old fixed-budget behaviour
  );
  assert.match(before.text, /tool-call limit|NOT done/i, 'the old fixed budget stopped this exact build partway (the bug being fixed)');
});

await test('repeated-write guard: an identical write is blocked after 2 tries, ending the loop', async () => {
  // The model loops on the SAME write (observed: update_gtm_trigger on one trigger 15+ times). The
  // guard must run it at most twice, then feed back a "blocked" notice and let the turn end.
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 'update_gtm_trigger', args: { triggerId: '3', eventName: 'form_submission' } }] }]);
  let executed = 0;
  const exec = writeExecutor(async () => { executed += 1; return 'ok'; }, () => true);
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'fix triggers' }] },
    exec,
    {},
    3,
    { hardMaxSteps: 30, stallSteps: 2 }
  );
  assert.equal(executed, 2, 'the identical write ran at most twice, not in a loop');
  assert.match(res.text, /NOT done/i, 'the turn ends (the blocked repeats make no progress, so the stall stop fires)');
  // The 3rd call fed back a blocked notice so the model could react.
  const blocked = client.inputs.flatMap((i) => i.messages).filter((m) => m.role === 'tool').flatMap((m) => (m as { results: Array<{ content: string }> }).results).some((r) => /Blocked: you have already called/.test(r.content));
  assert.ok(blocked, 'a blocked notice was fed back to the model');
});

await test('repeated-write guard: DISTINCT writes are never blocked', async () => {
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 'update_gtm_trigger', args: { triggerId: '3' } }] },
    { toolCalls: [{ id: '2', name: 'update_gtm_trigger', args: { triggerId: '6' } }] },
    { toolCalls: [{ id: '3', name: 'update_gtm_trigger', args: { triggerId: '8' } }] },
    { text: 'all three updated' },
  ]);
  let executed = 0;
  const exec = writeExecutor(async () => { executed += 1; return 'ok'; }, () => true);
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'update three triggers' }] },
    exec, {}, 10, { hardMaxSteps: 30 }
  );
  assert.equal(res.text, 'all three updated');
  assert.equal(executed, 3, 'three DISTINCT writes all ran');
});

await test('repeated-write guard: identical READS are NOT blocked (only writes are)', async () => {
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 'list_gtm_triggers', args: { x: 1 } }] }]);
  let executed = 0;
  const exec = writeExecutor(async () => { executed += 1; return '[]'; }, () => false); // not a write
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'list' }] },
    exec, {}, 4
  );
  assert.equal(executed, 4, 'identical reads ran every step (the guard is write-only)');
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

await test('progress budget: a build that keeps landing writes runs PAST the soft ceiling to completion', async () => {
  // Soft ceiling 3, but the model needs 5 write steps (a 5-item build). Because every step lands a
  // write, the loop extends past 3 up to the hard cap and reaches the final answer — no "proceed".
  const client = callsThenAnswer(['t', 't', 't', 't', 't'], 'all created');
  const exec = writeExecutor(async () => 'created', () => true);
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'create 5' }] },
    exec,
    {},
    3,
    { hardMaxSteps: 20 }
  );
  assert.equal(res.text, 'all created', 'the build completed under one turn');
  assert.equal(res.steps, 6, 'ran all 5 write steps + the final answer, past the soft ceiling of 3');
});

await test('progress budget: a read-only loop still STOPS at the soft ceiling (no runaway to hardMax)', async () => {
  // Never writes → never earns an extension → stops at the soft ceiling, not the hard cap.
  let executed = 0;
  const client = new ScriptedClient([{ toolCalls: [{ id: '1', name: 't', args: {} }] }]); // always a tool call
  const exec = writeExecutor(async () => { executed += 1; return 'read'; }, () => false);
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'loop' }] },
    exec,
    {},
    2,
    { hardMaxSteps: 50, stallSteps: 2 }
  );
  assert.match(res.text, /NOT done/i, 'a stalled loop still surfaces the honest not-done message');
  assert.equal(executed, 2, 'ran exactly the soft-ceiling steps, never entered the extended zone');
});

await test('progress budget: an occasional read between writes does NOT trip the stall stop', async () => {
  // Past the soft ceiling, writes interleaved with single reads keep the build alive to the end.
  const client = callsThenAnswer(['w', 'r', 'w', 'r', 'w'], 'built');
  const exec = writeExecutor(async () => 'ok', (n) => n === 'w');
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'build' }] },
    exec,
    {},
    2,
    { hardMaxSteps: 20, stallSteps: 3 }
  );
  assert.equal(res.text, 'built', 'reads between writes did not end the build early');
  assert.equal(res.steps, 6);
});

await test('progress budget: writes stopping past the ceiling ends the loop after stallSteps', async () => {
  // Two writes get it into the extended zone, then it goes quiet (reads only) → stops without a
  // final answer once stallSteps writeless steps pass, instead of burning the whole hard cap.
  let executed = 0;
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 'w', args: {} }] },
    { toolCalls: [{ id: '2', name: 'w', args: {} }] },
    { toolCalls: [{ id: '3', name: 'r', args: {} }] }, // step 3+: reads only from here (clamped)
  ]);
  const exec = writeExecutor(async () => { executed += 1; return 'ok'; }, (n) => n === 'w');
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'go' }] },
    exec,
    {},
    2,
    { hardMaxSteps: 100, stallSteps: 2 }
  );
  assert.match(res.text, /NOT done/i);
  // steps 1,2 (writes) + steps 3,4 (reads, stall counter climbs to 2) then step 5 breaks: 4 executes.
  assert.equal(executed, 4, `stopped a few steps into the extended zone, not at the hard cap (ran ${executed})`);
});

await test('onToolResult fires with ok=false + the error message when a tool fails', async () => {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 't', args: {} }] },
    { text: 'done' },
  ]);
  const exec = executor(async () => {
    throw new Error('vendorTemplate.key: Unknown entity type');
  });
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    exec,
    { onToolResult: (r) => results.push(r) }
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].name, 't');
  assert.match(results[0].error ?? '', /Unknown entity type/);
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

await test('stop: aborting MID-BATCH halts the remaining tool calls (the only brake now that creates have no approval card)', async () => {
  const executed: unknown[] = [];
  const ac = new AbortController();
  const client = new ScriptedClient([
    { toolCalls: [
      { id: '1', name: 't', args: { tag: 1 } },
      { id: '2', name: 't', args: { tag: 2 } },
      { id: '3', name: 't', args: { tag: 3 } },
    ] },
    { text: 'should not matter' },
  ]);
  // The user presses Stop while the first write is in flight; 2 & 3 must never run.
  const exec = executor(async (_n, a) => {
    executed.push(a);
    ac.abort();
    return 'created';
  });
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }], signal: ac.signal },
    exec
  );
  assert.equal(executed.length, 1, 'only the in-flight write ran; queued writes died at the abort check');
  assert.equal(res.text, 'Stopped.', 'the loop exits as Stopped at the next step');
  assert.equal(client.inputs.length, 1, 'the model is never re-invoked after Stop');
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

await test('a provider TIMEOUT is surfaced as an error, never swallowed as "Stopped."', async () => {
  // withRequestTimeout rewrites a budget expiry into a plain Error (not an AbortError) precisely so
  // this path reports the real reason instead of pretending the user cancelled.
  const client: LlmClient = {
    async chatStream() {
      throw new Error('OpenAI did not respond within 180s, so the request was cancelled.');
    },
  };
  await assert.rejects(
    () =>
      runChat(
        client,
        { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
        executor(async () => 'ok')
      ),
    /did not respond within 180s/
  );
});

await test('onRetry is threaded to the provider so a rate-limit wait reaches the UI', async () => {
  const seen: RetryNotice[] = [];
  const client: LlmClient = {
    async chatStream(input) {
      input.onRetry?.({ provider: 'OpenAI', status: 429, attempt: 2, maxAttempts: 4, delayMs: 42_000 });
      return { text: 'answered after the wait' };
    },
  };
  const res = await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    executor(async () => 'ok'),
    { onRetry: (n) => seen.push(n) }
  );
  assert.equal(res.text, 'answered after the wait');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].delayMs, 42_000);
  assert.equal(seen[0].attempt, 2);
  assert.equal(seen[0].maxAttempts, 4);
});

await test('onToolResult carries the tool OUTPUT (so the next turn need not re-call the tool)', async () => {
  const got: Array<{ name: string; ok: boolean; content?: string; args?: Record<string, unknown> }> = [];
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 't', args: { workspaceId: '9' } }] },
    { text: 'done' },
  ]);
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    executor(async () => '["tag a","tag b"]'),
    { onToolResult: (r) => got.push(r) }
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].content, '["tag a","tag b"]', 'the raw result is handed to the caller');
  assert.deepEqual(got[0].args, { workspaceId: '9' }, 'with the args that produced it');
});

/* ── Tool-result carry-over (the duplicate-tool-call fix), and its BOUNDS ── */
console.log('\nTool-result carry-over (tool-memory):');

const okRead = (name: string, content: string, args: Record<string, unknown> = {}) => ({ name, args, content, ok: true });

await test('a read result is carried, so a follow-up question can answer from it', async () => {
  const carried = foldToolResults([], [okRead('list_gtm_tags', '80 tags here', { containerId: '1' })]);
  assert.equal(carried.length, 1);
  const block = formatToolMemory(carried);
  assert.match(block, /RECENT TOOL RESULTS/);
  assert.match(block, /list_gtm_tags/);
  assert.match(block, /80 tags here/);
  assert.match(block, /do NOT call the tool again/i);
});

await test('BOUND: never more than MAX_CARRIED_RESULTS entries, oldest dropped first', async () => {
  let carried = foldToolResults([], [okRead('list_gtm_tags', 'A', { i: 1 })]);
  carried = foldToolResults(carried, [okRead('list_gtm_triggers', 'B', { i: 2 })]);
  carried = foldToolResults(carried, [okRead('list_gtm_variables', 'C', { i: 3 })]);
  carried = foldToolResults(carried, [okRead('list_ga4_key_events', 'D', { i: 4 })]);
  assert.equal(carried.length, MAX_CARRIED_RESULTS, 'capped at the carry limit');
  assert.deepEqual(carried.map((c) => c.content), ['B', 'C', 'D'], 'the oldest fell off');
});

await test('BOUND: a huge result is truncated to MAX_RESULT_CHARS and FLAGGED as partial', async () => {
  const huge = 'x'.repeat(MAX_RESULT_CHARS * 3);
  const carried = foldToolResults([], [okRead('audit_gtm_container', huge)]);
  assert.equal(carried[0].content.length, MAX_RESULT_CHARS);
  assert.equal(carried[0].truncated, true);
  const block = formatToolMemory(carried);
  assert.match(block, /TRUNCATED/, 'the model is told it is partial, so it re-calls instead of guessing');
});

await test('BOUND: the whole injected block never exceeds MAX_BLOCK_CHARS', async () => {
  const big = 'y'.repeat(MAX_RESULT_CHARS);
  const carried = foldToolResults(
    [],
    [okRead('list_gtm_tags', big, { i: 1 }), okRead('list_gtm_triggers', big, { i: 2 }), okRead('list_gtm_variables', big, { i: 3 })]
  );
  assert.equal(carried.length, 3);
  const block = formatToolMemory(carried);
  assert.ok(block.length <= MAX_BLOCK_CHARS, `block is ${block.length}, cap is ${MAX_BLOCK_CHARS}`);
  assert.match(block, /list_gtm_variables/, 'the NEWEST result survives the cap');
});

await test('a WRITE clears the carry-over, so a stale list is never re-quoted after a change', async () => {
  const carried = foldToolResults([], [okRead('list_gtm_tags', 'old list')]);
  const after = foldToolResults(carried, [{ name: 'create_gtm_tag', args: {}, content: '{"tagId":"5"}', ok: true }]);
  assert.deepEqual(after, [], 'everything read before the write is dropped');
  assert.equal(isReadOnlyToolName('create_gtm_tag'), false);
  assert.equal(isReadOnlyToolName('list_gtm_tags'), true);
  assert.equal(isReadOnlyToolName('audit_ga4_property'), true);
  assert.equal(isReadOnlyToolName('delete_gtm_trigger'), false);
});

await test('a FAILED tool result is not carried (an error is not an answer)', async () => {
  const carried = foldToolResults([], [{ name: 'list_gtm_tags', args: {}, content: 'boom', ok: false }]);
  assert.deepEqual(carried, []);
  assert.equal(formatToolMemory([]), '', 'nothing carried means nothing added to the prompt');
});

await test('re-reading the same tool+args replaces its own entry instead of stacking', async () => {
  let carried = foldToolResults([], [okRead('list_gtm_tags', 'v1', { containerId: '1' })]);
  carried = foldToolResults(carried, [okRead('list_gtm_tags', 'v2', { containerId: '1' })]);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].content, 'v2', 'the fresher read wins');
});

await test('ToolMemoryStore keeps threads apart and evicts old ones (bounded process memory)', async () => {
  const store = new ToolMemoryStore();
  store.record('acct|gtm|containerA', [okRead('list_gtm_tags', 'A tags')]);
  store.record('acct|gtm|containerB', [okRead('list_gtm_tags', 'B tags')]);
  assert.equal(store.get('acct|gtm|containerA')[0].content, 'A tags');
  assert.equal(store.get('acct|gtm|containerB')[0].content, 'B tags', 'one container never sees another\'s results');
  store.clear('acct|gtm|containerA');
  assert.deepEqual(store.get('acct|gtm|containerA'), [], 'clearing a thread (new conversation) drops its carry-over');

  for (let i = 0; i < 30; i++) store.record(`t${i}`, [okRead('list_gtm_tags', `tags ${i}`)]);
  let live = 0;
  for (let i = 0; i < 30; i++) if (store.get(`t${i}`).length) live++;
  assert.ok(live <= 8, `at most 8 threads retained, saw ${live}`);
  assert.equal(store.get('t29').length, 1, 'the most recent thread is the one kept');
});

await test('an oversized tool result is capped for the MODEL but delivered in full to the UI', async () => {
  // The uncapped payload was re-sent on every remaining step of the turn, so one large list could
  // dominate a whole build. The UI and the change journal must still receive the real thing.
  const huge = JSON.stringify({ tags: Array.from({ length: 4000 }, (_, i) => ({ tagId: String(i), name: `GA4 - Event - Tag ${i}`, type: 'gaawe' })) });
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 'list_gtm_tags', args: {} }] },
    { text: 'done' },
  ]);
  let uiContent = '';
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'list them' }] },
    executor(async () => huge),
    { onToolResult: (r) => { uiContent = r.content ?? ''; } }
  );

  // What the provider saw on the SECOND request (after the tool result was folded in).
  const sent = client.inputs[1].messages.find((m) => m.role === 'tool') as { results: Array<{ content: string }> };
  const modelSaw = sent.results[0].content;
  assert.ok(modelSaw.length < huge.length, 'the model copy is smaller');
  assert.ok(modelSaw.length <= TOOL_RESULT_MAX_CHARS, `capped to the budget (${modelSaw.length})`);
  assert.equal(uiContent, huge, 'the UI callback still receives the FULL result');
  // The model must know it is holding partial data.
  assert.match(modelSaw, /truncated/i);
  assert.match(modelSaw, /never present it as the complete set/i);
  assert.doesNotThrow(() => JSON.parse(modelSaw), 'the capped payload is still valid JSON');
});

await test('an ordinary tool result reaches the model untouched', async () => {
  const small = JSON.stringify({ tags: [{ tagId: '1', name: 'GA4 - Purchase' }] });
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 'list_gtm_tags', args: {} }] },
    { text: 'done' },
  ]);
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }] },
    executor(async () => small),
    {}
  );
  const sent = client.inputs[1].messages.find((m) => m.role === 'tool') as { results: Array<{ content: string }> };
  assert.equal(sent.results[0].content, small, 'no cap, no marker, byte-identical');
});

await test('an audit result carries the reporting methodology to the model, not to the UI', async () => {
  const findings = JSON.stringify({ counts: { tags: 2 }, findings: [{ severity: 'high', message: 'x' }] });
  const client = new ScriptedClient([
    { toolCalls: [{ id: '1', name: 'audit_gtm_container', args: {} }] },
    { text: 'done' },
  ]);
  let uiContent = '';
  await runChat(
    client,
    { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'audit it' }] },
    executor(async () => findings),
    { onToolResult: (r) => { uiContent = r.content ?? ''; } }
  );
  const sent = client.inputs[1].messages.find((m) => m.role === 'tool') as { results: Array<{ content: string }> };
  const modelSaw = JSON.parse(sent.results[0].content) as { findings?: unknown[]; _methodology?: string };
  assert.ok(Array.isArray(modelSaw.findings), 'the findings still arrive');
  assert.match(String(modelSaw._methodology), /boundary statement/i, 'the audit methodology rides along');
  assert.equal(uiContent, findings, 'the UI copy is untouched');
});

await test('a rejected RAW create carries the resource shapes; a typed create does not', async () => {
  const run = async (tool: string): Promise<string> => {
    const client = new ScriptedClient([
      { toolCalls: [{ id: '1', name: tool, args: {} }] },
      { text: 'done' },
    ]);
    await runChat(
      client,
      { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'make it' }] },
      executor(async () => { throw new Error('vendorTemplate.key: Unknown entity type'); }),
      {}
    );
    const sent = client.inputs[1].messages.find((m) => m.role === 'tool') as { results: Array<{ content: string }> };
    return sent.results[0].content;
  };
  const raw = await run('create_gtm_variable');
  assert.match(raw, /Unknown entity type/, 'the real error is still first');
  assert.match(raw, /RAW SHAPES/, 'the shapes arrive exactly when the shape was wrong');
  const typed = await run('create_gtm_variable_typed');
  assert.doesNotMatch(typed, /RAW SHAPES/, 'a typed builder failure does not pay for them');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
