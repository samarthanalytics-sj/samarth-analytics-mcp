/**
 * Workspace snapshot tests. No network: the MCP connection is a stub.
 *
 * The behaviour under test is the trade this makes. It removes four model round trips from the
 * front of every build turn by answering "what already exists" in the prompt, and the danger of
 * doing that is a summary that looks complete when it is not: a model that believes a trigger is
 * absent creates a duplicate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWorkspaceSnapshot, renderWorkspaceSnapshot } from '../workspace-snapshot.js';
import type { McpConnection } from '../mcp-client.js';

const WS = { accountId: '1', containerId: '2', workspaceId: '3' };

/** An MCP whose answers are scripted per tool. */
function stubMcp(answers: Record<string, { ok?: boolean; body?: unknown }>): McpConnection {
  const calls: string[] = [];
  const mcp = {
    calls,
    async callTool(name: string) {
      calls.push(name);
      const a = answers[name];
      if (!a) return { ok: false, text: 'no such tool' };
      return { ok: a.ok !== false, text: JSON.stringify(a.body ?? {}) };
    },
  };
  return mcp as unknown as McpConnection & { calls: string[] };
}

const FULL = {
  tags_list: { body: { tags: [{ name: 'GA4 Event - Email Click', type: 'gaawe' }, { name: 'GA4 Config', type: 'googtag' }] } },
  triggers_list: { body: { triggers: [{ name: 'Mailto Link Click', type: 'linkClick' }] } },
  variables_list: { body: { variables: [{ name: 'DLV - Email Address', type: 'v' }] } },
  built_in_variables_list: { body: { builtInVariables: [{ type: 'clickUrl' }, { type: 'pageUrl' }] } },
};

void test('one snapshot covers all four lists', async () => {
  const mcp = stubMcp(FULL) as McpConnection & { calls: string[] };
  const s = await fetchWorkspaceSnapshot(mcp, WS);
  assert.deepEqual([...mcp.calls].sort(), [
    'built_in_variables_list', 'tags_list', 'triggers_list', 'variables_list',
  ]);
  assert.equal(s.tags.length, 2);
  assert.equal(s.triggers[0].name, 'Mailto Link Click');
  assert.deepEqual(s.builtIns, ['clickUrl', 'pageUrl']);
  assert.deepEqual(s.incomplete, []);
});

void test('a complete snapshot tells the model to stop re-listing', async () => {
  const text = renderWorkspaceSnapshot(await fetchWorkspaceSnapshot(stubMcp(FULL), WS));
  assert.match(text, /COMPLETE contents/);
  assert.match(text, /do not\s+call tags_list/i, 'the whole point is removing those round trips');
  assert.match(text, /gaawe/, 'types matter: a tag name alone does not say what it is');
  // Must not over-reach into "never read anything again", or it cannot fetch a trigger's filter.
  assert.match(text, /only when you need a detail this summary does not carry/i);
});

void test('a failed list is never presented as an empty container', async () => {
  // The dangerous case. "Triggers (0): none" for a list that errored is how a model decides to
  // create a second Mailto Link Click.
  const s = await fetchWorkspaceSnapshot(stubMcp({ ...FULL, triggers_list: { ok: false } }), WS);
  assert.deepEqual(s.incomplete, ['triggers']);
  const text = renderWorkspaceSnapshot(s);
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /could not be read/i);
  assert.equal(/Triggers \(0\): none/.test(text), false, 'a failed read must not read as "empty"');
  assert.equal(/COMPLETE contents/.test(text), false, 'nothing may claim completeness here');
});

void test('a truncated list is treated as incomplete, not as the whole container', async () => {
  const s = await fetchWorkspaceSnapshot(
    stubMcp({ ...FULL, tags_list: { body: { tags: [{ name: 'A', type: 'gaawe' }], truncated: true } } }),
    WS,
  );
  assert.ok(s.incomplete.includes('tags'));
  assert.equal(/COMPLETE contents/.test(renderWorkspaceSnapshot(s)), false);
});

void test('a genuinely empty workspace says empty, and still counts as complete', async () => {
  const s = await fetchWorkspaceSnapshot(
    stubMcp({
      tags_list: { body: { tags: [] } },
      triggers_list: { body: { triggers: [] } },
      variables_list: { body: { variables: [] } },
      built_in_variables_list: { body: { builtInVariables: [] } },
    }),
    WS,
  );
  const text = renderWorkspaceSnapshot(s);
  assert.deepEqual(s.incomplete, []);
  assert.match(text, /Tags \(0\): none/);
  assert.match(text, /COMPLETE contents/);
});

void test('a large workspace lists a sample and admits the rest are not shown', async () => {
  const tags = Array.from({ length: 150 }, (_, i) => ({ name: `Tag ${i}`, type: 'gaawe' }));
  const s = await fetchWorkspaceSnapshot(stubMcp({ ...FULL, tags_list: { body: { tags } } }), WS);
  const text = renderWorkspaceSnapshot(s);
  assert.match(text, /Tags \(150\)/, 'the true count must be stated even when the list is sampled');
  assert.match(text, /and 90 more, not listed here/);
});

void test('malformed JSON degrades that kind only', async () => {
  const mcp = { async callTool(name: string) {
    return name === 'variables_list' ? { ok: true, text: 'not json' } : { ok: true, text: JSON.stringify((FULL as Record<string, { body: unknown }>)[name].body) };
  } } as unknown as McpConnection;
  const s = await fetchWorkspaceSnapshot(mcp, WS);
  assert.deepEqual(s.incomplete, ['variables']);
  assert.equal(s.tags.length, 2, 'the kinds that parsed are still usable');
});

// Reading the container's own Measurement ID off its base tag.
//
// Why it is here rather than asked for: the container knows it, and making someone retype something
// we can read is a worse product. The old behaviour refused the whole create instead.

test('the Google tag and its Measurement ID are found in a raw tags list', async () => {
  const { findGa4BaseTag } = await import('../workspace-snapshot.js');
  const found = findGa4BaseTag([
    { name: 'Some HTML', type: 'html', parameter: [{ key: 'html', value: '<script></script>' }] },
    { name: 'Google Tag', type: 'googtag', parameter: [{ key: 'tagId', value: 'G-REAL12345' }] },
  ]);
  assert.equal(found?.name, 'Google Tag');
  assert.equal(found?.measurementId, 'G-REAL12345');
});

test('the legacy GA4 Configuration keeps its id under a different key', async () => {
  const { findGa4BaseTag } = await import('../workspace-snapshot.js');
  const found = findGa4BaseTag([
    { name: 'Old Config', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-LEGACY99' }] },
  ]);
  assert.equal(found?.type, 'gaawc');
  assert.equal(found?.measurementId, 'G-LEGACY99');
});

test('a base tag referencing a variable is found, but yields no id', async () => {
  // It IS the base tag, so a second must not be created. But "{{GA4 Variable}}" is not an id, and
  // copying it into a Constant would produce a variable that resolves to nothing.
  const { findGa4BaseTag } = await import('../workspace-snapshot.js');
  const found = findGa4BaseTag([
    { name: 'GT', type: 'googtag', parameter: [{ key: 'tagId', value: '{{GA4 Variable}}' }] },
  ]);
  assert.equal(found?.name, 'GT');
  assert.equal(found?.measurementId, undefined);
});

test('an AW- Google tag is Ads, not a GA4 Measurement ID', async () => {
  const { findGa4BaseTag } = await import('../workspace-snapshot.js');
  const found = findGa4BaseTag([
    { name: 'Ads', type: 'googtag', parameter: [{ key: 'tagId', value: 'AW-123456789' }] },
  ]);
  assert.equal(found?.measurementId, undefined, 'an Ads id must not end up in the GA4 Constant');
});

test('a container with no base tag reports none', async () => {
  const { findGa4BaseTag } = await import('../workspace-snapshot.js');
  assert.equal(findGa4BaseTag([{ name: 'X', type: 'gaawe' }]), undefined);
  assert.equal(findGa4BaseTag([]), undefined);
});
