/**
 * Tool scoping and truncation tests. No network, no credentials.
 */
import assert from 'node:assert/strict';
import { capToolResult, compactToolHistory, productOf, scopeTools, toOpenAiTools } from '../tools.js';
import { runTurn } from '../loop.js';
import { ApprovalBroker } from '../approvals.js';
import type { OrchestratorConfig } from '../config.js';
import { McpConnection } from '../mcp-client.js';
import type { OpenAiClient } from '../openai.js';
import type { UsageMeter } from '../usage.js';
import type { StreamEvent, ToolDef } from '../types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function tool(name: string, isWrite = false, isDestructive = false, isDelete = false): ToolDef {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: { type: 'object', properties: isWrite ? { confirm: { type: 'boolean' } } : {} },
    isWrite,
    isDestructive,
    isDelete,
  };
}

const CATALOG: ToolDef[] = [
  tool('accounts_list'),
  tool('containers_list'),
  tool('containers_lookup'),
  tool('tags_list'),
  tool('tags_get'),
  tool('tags_create', true),
  tool('tags_delete', true, false, true),
  tool('audit_container'),
  tool('ga4_properties_list'),
  tool('ga4_run_report'),
  tool('ga4_create_property', true),
  tool('ga4_archive_audience', true, true),
  tool('versions_publish', true, true),
];

console.log('tool scoping');

test('ga4_ prefix decides the product', () => {
  assert.equal(productOf('ga4_run_report'), 'ga4');
  assert.equal(productOf('tags_list'), 'gtm');
  assert.equal(productOf('audit_container'), 'gtm');
});

test('read-only scoping hides every confirm-gated tool', () => {
  const scoped = scopeTools(CATALOG, { product: 'gtm', includeWrites: false });
  assert.ok(scoped.length > 0);
  assert.equal(
    scoped.some((t) => t.isWrite),
    false,
    'a write tool leaked into a read-only scope',
  );
});

test('gtm scope excludes ga4 tools and vice versa', () => {
  const gtm = scopeTools(CATALOG, { product: 'gtm', includeWrites: true }).map((t) => t.name);
  assert.ok(gtm.includes('tags_list'));
  assert.equal(gtm.includes('ga4_run_report'), false);

  const ga4 = scopeTools(CATALOG, { product: 'ga4', includeWrites: true }).map((t) => t.name);
  assert.ok(ga4.includes('ga4_run_report'));
  assert.equal(ga4.includes('tags_list'), false);
});

test('account and container discovery stays available in the ga4 scope', () => {
  const ga4 = scopeTools(CATALOG, { product: 'ga4', includeWrites: false }).map((t) => t.name);
  assert.ok(ga4.includes('accounts_list'), 'GA4 chats still need to resolve the account');
  assert.ok(ga4.includes('containers_list'));
});

test('maxTools truncation drops writes before reads', () => {
  const scoped = scopeTools(CATALOG, { product: 'gtm', includeWrites: true, maxTools: 3 });
  assert.equal(scoped.length, 3);
  assert.equal(
    scoped.some((t) => t.isWrite),
    false,
    'truncation kept a write tool while dropping reads',
  );
});

console.log('destructive tools are never exposed');

test('a GTM delete stays hidden unless deletes are separately enabled', () => {
  // Writes and deletes are different decisions. Turning on the first must not turn on the second.
  const writesOnly = scopeTools(CATALOG, { product: 'gtm', includeWrites: true }).map((t) => t.name);
  assert.equal(writesOnly.includes('tags_delete'), false);

  const withDeletes = scopeTools(CATALOG, {
    product: 'gtm',
    includeWrites: true,
    includeDeletes: true,
  }).map((t) => t.name);
  assert.ok(withDeletes.includes('tags_delete'), 'deletes should appear once explicitly enabled');
});

test('enabling deletes without writes is incoherent and offers nothing', () => {
  const scoped = scopeTools(CATALOG, {
    product: 'gtm',
    includeWrites: false,
    includeDeletes: true,
  });
  assert.equal(scoped.some((t) => t.isWrite || t.isDelete), false);
});

test('GA4 archives stay hidden even with writes AND deletes enabled', () => {
  // GA4 has no draft concept and the MCP calls archiving "effectively permanent (no un-archive)".
  const ga4 = scopeTools(CATALOG, {
    product: 'ga4',
    includeWrites: true,
    includeDeletes: true,
  }).map((t) => t.name);
  assert.equal(ga4.includes('ga4_archive_audience'), false, 'an irreversible GA4 archive was exposed');
});

test('publish is never offered, at any setting', () => {
  // The approval card is a reasonable gate for creating a tag and not for deleting one, and a GA4
  // archive is irreversible. This is the second of two independent refusals; the MCP guardrail
  // flags are the first.
  const scoped = scopeTools(CATALOG, {
    product: 'gtm',
    includeWrites: true,
    includeDeletes: true,
  }).map((t) => t.name);
  assert.equal(scoped.includes('versions_publish'), false, 'publish was exposed to the model');
});

test('non-destructive writes ARE exposed when writes are enabled', () => {
  const scoped = scopeTools(CATALOG, { product: 'gtm', includeWrites: true }).map((t) => t.name);
  assert.ok(scoped.includes('tags_create'), 'creating a tag should be possible behind approval');
});

test('enabling writes never widens the surface into deletes or publish', () => {
  const readOnly = scopeTools(CATALOG, { product: 'gtm', includeWrites: false });
  const withWrites = scopeTools(CATALOG, { product: 'gtm', includeWrites: true });
  assert.equal(withWrites.some((t) => t.isDestructive || t.isDelete), false);
  assert.ok(withWrites.length > readOnly.length, 'writes should add tools');
});

test('truncation drops deletes first, then writes, then reads', () => {
  const scoped = scopeTools(CATALOG, {
    product: 'gtm',
    includeWrites: true,
    includeDeletes: true,
    maxTools: 3,
  });
  assert.equal(scoped.length, 3);
  assert.equal(scoped.some((t) => t.isDelete), false, 'a delete survived truncation ahead of a read');
});

console.log('openai mapping');

test('schemas are normalized to a valid function-calling shape', () => {
  const mapped = toOpenAiTools([
    { name: 'x', description: 'd', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' }, isWrite: false, isDestructive: false, isDelete: false },
  ]);
  assert.equal(mapped[0].function.parameters.type, 'object');
  assert.deepEqual(mapped[0].function.parameters.properties, {});
  assert.equal('$schema' in mapped[0].function.parameters, false);
});

test('descriptions are bounded', () => {
  const mapped = toOpenAiTools([
    { name: 'x', description: 'a'.repeat(5000), inputSchema: {}, isWrite: false, isDestructive: false, isDelete: false },
  ]);
  assert.ok(mapped[0].function.description.length <= 1024);
});

console.log('truncation');

test('short results pass through untouched', () => {
  assert.equal(capToolResult('hello', 100), 'hello');
});

test('long results are marked INCOMPLETE, never silently cut', () => {
  const capped = capToolResult('x'.repeat(500), 100);
  assert.ok(capped.startsWith('x'.repeat(100)));
  assert.match(capped, /TRUNCATED/);
  assert.match(capped, /INCOMPLETE/);
});

console.log('tool-history compaction');

const toolMsg = (id: string, len: number) =>
  ({ role: 'tool' as const, tool_call_id: id, name: 't', content: 'x'.repeat(len) });

test('a turn under budget is returned untouched', () => {
  const msgs = [toolMsg('a', 100), toolMsg('b', 100)];
  const out = compactToolHistory(msgs, 1000);
  assert.deepEqual(
    out.map((m) => m.content),
    msgs.map((m) => m.content),
  );
});

test('the NEWEST result keeps its full size, the oldest gives way', () => {
  const out = compactToolHistory([toolMsg('old', 5000), toolMsg('new', 5000)], 6000);
  assert.equal(out[1].content?.length, 5000, 'the newest result must survive whole');
  assert.ok((out[0].content?.length ?? 0) < 5000, 'the oldest must be the one shortened');
});

test('a shortened result says so, and says it did not fail', () => {
  const out = compactToolHistory([toolMsg('old', 9000), toolMsg('new', 9000)], 9000);
  // ChatMessage.content is string | ChatContentPart[]; a tool result is always the string arm.
  const older = typeof out[0].content === 'string' ? out[0].content : '';
  assert.match(older, /SHORTENED/);
  // The dangerous misreading: a digest that looks like a tool which returned nothing.
  assert.match(older, /did not\s+fail/);
  assert.match(older, /Call the tool again/, 'must say how to recover the dropped part');
});

test('EVERY tool message survives — dropping one breaks the tool_call_id pairing', () => {
  const msgs = [toolMsg('a', 9000), toolMsg('b', 9000), toolMsg('c', 9000)];
  const out = compactToolHistory(msgs, 1000);
  assert.equal(out.length, msgs.length, 'no message may be removed');
});

test('non-tool messages are never touched', () => {
  const sys = { role: 'system' as const, content: 'y'.repeat(9000) };
  const out = compactToolHistory([sys, toolMsg('a', 9000)], 100);
  assert.equal(out[0].content?.length, 9000, 'the system prompt is not a tool result');
});

test('the input array is not mutated', () => {
  const msgs = [toolMsg('a', 9000), toolMsg('b', 9000)];
  compactToolHistory(msgs, 1000);
  assert.equal(msgs[0].content?.length, 9000);
});

test('a seven-call turn is bounded instead of growing without limit', () => {
  // The measured failure: seven results at the 16k per-result cap, resent on every round trip.
  const msgs = Array.from({ length: 7 }, (_, i) => toolMsg(String(i), 16_000));
  const before = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  const after = compactToolHistory(msgs, 24_000).reduce((n, m) => n + (m.content?.length ?? 0), 0);
  assert.equal(before, 112_000);
  assert.ok(after < 30_000, `expected the turn to fit its budget, got ${after}`);
});

console.log('the turn enforces the scoped set at call time');

const TURN_CFG = {
  enableWriteTools: true,
  enableDeleteTools: false,
  approveLiveWrites: false,
  openai: { model: 'test-model' },
  limits: {
    maxToolCallsPerTurn: 10,
    maxTurnMs: 60_000,
    maxHistoryMessages: 20,
    maxToolResultChars: 10_000,
    maxToolHistoryChars: 50_000,
  },
} as unknown as OrchestratorConfig;

/**
 * Runs one real turn against stubs: the model makes exactly `calls`, then answers. Returns what
 * reached the MCP, what was streamed, and what was billed.
 */
async function turnWith(
  calls: { name: string; arguments: string }[],
): Promise<{ forwarded: { name: string; args: Record<string, unknown> }[]; events: StreamEvent[]; billed: number | null }> {
  const forwarded: { name: string; args: Record<string, unknown> }[] = [];
  const events: StreamEvent[] = [];
  let billed: number | null = null;
  const mcp = {
    listTools: () => CATALOG,
    getInstructions: () => '',
    async callTool(name: string, args: Record<string, unknown>) {
      forwarded.push({ name, args });
      return { ok: true, text: '{}' };
    },
  } as unknown as McpConnection;
  let round = 0;
  const llm = {
    async streamChat() {
      round++;
      if (round > 1) return { content: 'done', toolCalls: [], finishReason: 'stop' };
      return {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function' as const, function: c })),
      };
    },
  } as unknown as OpenAiClient;

  await runTurn({
    cfg: TURN_CFG,
    mcp,
    llm,
    history: [{ role: 'user', content: 'zzz' }],
    context: { product: 'gtm' },
    user: { id: 'user-1' },
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    // A broker, so a write can run at all. No delete is in scope and approveLiveWrites is off, so
    // nothing in these turns parks on a card.
    approvals: new ApprovalBroker(),
    usage: { record: (_user: string, tokens: number) => (billed = tokens) } as unknown as UsageMeter,
  });
  return { forwarded, events, billed };
}

const results = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'tool_result' }> => e.type === 'tool_result');
const doneReason = (events: StreamEvent[]) =>
  events.find((e): e is Extract<StreamEvent, { type: 'done' }> => e.type === 'done')?.reason;

await testAsync('a hidden publish called by name never reaches the MCP, confirm or not', async () => {
  // versions_publish is in the catalog but never offered. Before the guard, a model that named it
  // anyway skipped the approval gate (it keys off the scoped entry) and was forwarded verbatim.
  const { forwarded, events } = await turnWith([
    { name: 'versions_publish', arguments: '{"versionId":"7","confirm":true}' },
  ]);
  assert.deepEqual(forwarded, [], 'an unscoped tool was forwarded to the MCP');
  assert.equal(results(events)[0]?.ok, false);
  assert.equal(doneReason(events), 'complete', 'a refusal is an answer the model reads, not a crash');
});

await testAsync('a delete this deployment switched off is refused, not run without its card', async () => {
  const { forwarded } = await turnWith([{ name: 'tags_delete', arguments: '{"tagId":"1","confirm":true}' }]);
  assert.deepEqual(forwarded, []);
});

await testAsync('another product\'s tool and an invented name are refused the same way', async () => {
  const { forwarded, events } = await turnWith([
    { name: 'ga4_create_property', arguments: '{"confirm":true}' },
    { name: 'tags_nuke_everything', arguments: '{}' },
  ]);
  assert.deepEqual(forwarded, []);
  assert.deepEqual(results(events).map((r) => r.ok), [false, false]);
});

await testAsync('a tool in the scoped set still runs, with the confirm a guarded write needs', async () => {
  const { forwarded } = await turnWith([
    { name: 'tags_list', arguments: '{}' },
    { name: 'tags_create', arguments: '{"name":"x"}' },
  ]);
  assert.deepEqual(forwarded.map((f) => f.name), ['tags_list', 'tags_create']);
  assert.equal(forwarded[1].args.confirm, true);
});

await testAsync('the connection itself refuses a name its server never listed', async () => {
  // The backstop for any caller that skips its own permitted-set check.
  const sent: string[] = [];
  const conn = new McpConnection({} as OrchestratorConfig);
  Object.assign(conn as unknown as Record<string, unknown>, {
    client: {
      async callTool({ name }: { name: string }) {
        sent.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      },
    },
    tools: [tool('tags_list')],
  });
  const refused = await conn.callTool('tags_nuke_everything', { confirm: true });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /not a tool this server provides/);
  const ran = await conn.callTool('tags_list', {});
  assert.equal(ran.ok, true);
  assert.deepEqual(sent, ['tags_list'], 'only the listed tool may reach the server');
});

console.log('tool arguments that are JSON but not an object');

await testAsync('null, a string, a number or an array is an invalid-arguments result, not a dead turn', async () => {
  // Each of these parses. `parsedArgs.confirm = true` then threw a TypeError for the first three,
  // which ended the turn as internal_error before finish() billed it.
  for (const raw of ['null', '"x"', '5', '[1]']) {
    const { forwarded, events, billed } = await turnWith([{ name: 'tags_create', arguments: raw }]);
    assert.deepEqual(forwarded, [], `${raw} reached the MCP`);
    assert.equal(results(events)[0]?.summary, 'Invalid arguments', `${raw} was not refused as invalid`);
    assert.equal(doneReason(events), 'complete', `${raw} did not let the turn finish`);
    assert.notEqual(billed, null, `${raw} skipped billing`);
  }
});

console.log(`\n${passed} assertions passed`);
