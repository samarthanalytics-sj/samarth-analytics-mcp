/**
 * Node test for folders_entities pagination (tools/folders.ts).
 *
 * The hole: one un-tokened .entities() call, then `return jsonResult(res.data)`. The endpoint
 * paginates (tagmanager v2 declares pageToken on the Entities params and nextPageToken on
 * Schema$FolderEntities), and the input schema exposed no pageToken, so page 2 was unreachable
 * through the tool entirely. The failure was silent and confidently wrong: a folder whose triggers
 * all landed on page 2 came back with no `trigger` key at all, which reads as "this folder has no
 * triggers" rather than as a short answer.
 *
 * folders_list directly above already used paginate + buildListResult, so this was never house style.
 * It escaped the coverage guard by construction - listPagination.node.test.mjs matched only `.list(`.
 *
 * Imports the COMPILED tool from dist. Run: node src/__tests__/folders.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distTool = path.resolve(here, '../../dist/tools/folders.js');
const distSdk = path.resolve(here, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
if (!existsSync(distTool)) {
  console.error(`\n✗ folders test: ${distTool} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { registerFolderTools } = await import(pathToFileURL(distTool).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

/** `pages` is an array of page bodies; page N carries a nextPageToken while more remain. */
function buildServer(pages) {
  const calls = [];
  const entities = (params) => {
    calls.push(params);
    const idx = params.pageToken ? Number(params.pageToken) : 0;
    const hasNext = idx + 1 < pages.length;
    return Promise.resolve({
      data: { ...pages[idx], ...(hasNext ? { nextPageToken: String(idx + 1) } : {}) },
    });
  };
  const client = { accounts: { containers: { workspaces: { folders: { entities } } } } };
  const server = new McpServer({ name: 'folders-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerFolderTools(server, () => client);
  return { server, calls };
}

const ARGS = { accountId: '1', containerId: '2', workspaceId: '3', folderId: '9' };
const run = async (server, extra = {}) => {
  const tool = server._registeredTools['folders_entities'];
  const r = await tool.handler({ ...ARGS, ...extra }, { requestId: 'test' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

/** The load-bearing fixture: a folder whose triggers and variables live ENTIRELY on page 2. */
const SPLIT = [
  { tag: [{ tagId: '1' }, { tagId: '2' }] },
  {
    tag: [{ tagId: '3' }],
    trigger: [{ triggerId: 'tr1' }, { triggerId: 'tr2' }],
    variable: [{ variableId: 'v1' }],
  },
];

console.log('\nfolders_entities:');

await test('REGRESSION: follows nextPageToken instead of stopping at page 1', async () => {
  const { server, calls } = buildServer(SPLIT);
  await run(server);
  assert.strictEqual(calls.length, 2, 'must fetch both pages');
  assert.strictEqual(calls[0].pageToken, undefined);
  assert.strictEqual(calls[1].pageToken, '1');
});

await test('REGRESSION: a collection that only exists on page 2 is not reported as absent', async () => {
  // The sharpest one. Pre-fix `trigger` is undefined, so this throws: the tool answered
  // "no triggers" for a folder with two.
  const { server } = buildServer(SPLIT);
  const b = await run(server);
  assert.deepStrictEqual(b.trigger.map((t) => t.triggerId), ['tr1', 'tr2']);
  assert.strictEqual(b.variable.length, 1);
});

await test('REGRESSION: all three collections concatenate in page order', async () => {
  const { server } = buildServer(SPLIT);
  const b = await run(server);
  assert.deepStrictEqual(b.tag.map((t) => t.tagId), ['1', '2', '3']);
  assert.deepStrictEqual(b.counts, { tag: 3, trigger: 2, variable: 1 });
});

await test('REGRESSION: maxPages bounds the walk and the result says it was bounded', async () => {
  const three = [...SPLIT, { tag: [{ tagId: '4' }] }];
  const { server, calls } = buildServer(three);
  const b = await run(server, { maxPages: 2 });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(b.truncated, true);
  assert.strictEqual(b.nextPageToken, '2');
});

await test('REGRESSION: resumes from a supplied pageToken', async () => {
  const three = [...SPLIT, { tag: [{ tagId: '4' }] }];
  const { server, calls } = buildServer(three);
  const b = await run(server, { pageToken: '1' });
  assert.strictEqual(calls[0].pageToken, '1');
  assert.ok(!b.tag.some((t) => t.tagId === '1'), 'page 0 items must not appear when resuming');
});

await test('REGRESSION: the schema exposes pageToken and maxPages', async () => {
  // Pre-fix this has 4 keys, so the returned token was unusable even though it was passed through.
  const { server } = buildServer(SPLIT);
  assert.deepStrictEqual(
    Object.keys(server._registeredTools['folders_entities'].inputSchema.shape),
    ['accountId', 'containerId', 'workspaceId', 'folderId', 'pageToken', 'maxPages']
  );
});

await test('a complete answer carries no pagination noise', async () => {
  // Passes before AND after. Over-reporting guard, not a repro.
  const { server } = buildServer([{ tag: [{ tagId: '1' }] }]);
  const b = await run(server);
  assert.ok(!('truncated' in b));
  assert.ok(!('nextPageToken' in b));
});

await test('an empty folder returns empty arrays, not a bare {}', async () => {
  // Fails before the fix, but it asserts the deliberate SHAPE change, not the paging bug. Absent
  // versus empty is the confusion the defect produced, so the arrays are always present now.
  const { server } = buildServer([{}]);
  const b = await run(server);
  assert.deepStrictEqual(b.tag, []);
  assert.deepStrictEqual(b.trigger, []);
  assert.deepStrictEqual(b.variable, []);
  assert.deepStrictEqual(b.counts, { tag: 0, trigger: 0, variable: 0 });
});

console.log(`\nfolders_entities: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
