/**
 * Tool scoping and truncation tests. No network, no credentials.
 */
import assert from 'node:assert/strict';
import { capToolResult, compactToolHistory, productOf, scopeTools, toOpenAiTools } from '../tools.js';
import type { ToolDef } from '../types.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
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

console.log(`\n${passed} assertions passed`);
