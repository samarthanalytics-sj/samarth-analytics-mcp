/**
 * Node test for export_container's truncation notice (tools/export.ts + utils/exportCompleteness.ts).
 *
 * The hole: the incomplete / truncatedCollections / warning object was spread into the `full` branch
 * only. `summary` is the DEFAULT format AND the branch that prints an authoritative-looking stats
 * block, so the artifact most likely to be trusted was the only one that never admitted it was short:
 * a caller got stats.tags: 50 with nothing anywhere saying 50 was a floor. names_only had the same gap.
 *
 * Imports the COMPILED tool from dist (CI runs `npm run build` before `npm test`). The helper module
 * is imported LAZILY inside its own test: it does not exist pre-fix, and a top-level import would kill
 * the whole file on the existsSync guard before any handler assertion ran, which is indistinguishable
 * from a stale build and destroys the before/after evidence.
 *
 * Run: node src/__tests__/exportCompleteness.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distTool = path.resolve(here, '../../dist/tools/export.js');
const distSdk = path.resolve(here, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
const helperPath = path.resolve(here, '../../dist/utils/exportCompleteness.js');

if (!existsSync(distTool)) {
  console.error(`\n✗ exportCompleteness test: ${distTool} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { registerExportTools } = await import(pathToFileURL(distTool).href);
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

/** A list mock that returns one item per page, and a nextPageToken FOREVER when `truncate` is set, so
 *  paginate() exits through its pagesFetched >= maxPages branch with truncated: true. */
const page = (key, truncate) => (p) =>
  Promise.resolve({
    data: {
      [key]: [
        {
          name: `${key}-${p.pageToken ?? '0'}`,
          tagId: '1',
          triggerId: '1',
          variableId: '1',
          folderId: '1',
          type: 'x',
        },
      ],
      ...(truncate ? { nextPageToken: 'more' } : {}),
    },
  });

function buildServer(truncate) {
  const ws = {
    tags: { list: page('tag', truncate) },
    triggers: { list: page('trigger', truncate) },
    variables: { list: page('variable', truncate) },
    folders: { list: page('folder', truncate) },
    built_in_variables: { list: page('builtInVariable', truncate) },
    get: () => Promise.resolve({ data: { workspaceId: '3', name: 'WS', fingerprint: 'f' } }),
  };
  const server = new McpServer({ name: 'export-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerExportTools(server, () => ({ accounts: { containers: { workspaces: ws } } }));
  return server;
}

const toolOf = (server) => server._registeredTools['export_container'];

/** Route args through the schema on purpose: calling the handler directly bypasses zod's
 *  .default('summary'), and format: undefined then falls into the names_only else-branch, so the
 *  default format would never be exercised. */
const call = async (server, args) => {
  const tool = toolOf(server);
  const parsed = tool.inputSchema.parse(args);
  const r = await tool.handler(parsed, { requestId: 'test' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

const BASE = { accountId: '1', containerId: '2', workspaceId: '3' };
const FORMATS = ['summary', 'full', 'names_only'];

console.log('\nexport_container: truncation notice');

await test('premise: format defaults to summary', async () => {
  // Pins which branch matters. Passes today; exists so a later default change cannot quietly move it.
  assert.strictEqual(toolOf(buildServer(false)).inputSchema.parse(BASE).format, 'summary');
});

await test('REGRESSION: every format admits truncation, not just full', async () => {
  const server = buildServer(true);
  for (const format of FORMATS) {
    const body = await call(server, { ...BASE, format });
    assert.strictEqual(body.incomplete, true, `format ${format} must admit truncation`);
    assert.match(body.warning, /INCOMPLETE/, `format ${format} carries no warning`);
    assert.deepStrictEqual(
      body.truncatedCollections,
      ['tags', 'triggers', 'variables', 'folders', 'builtInVariables'],
      `format ${format} must name the short collections`
    );
  }
});

await test('REGRESSION: summary carries the notice ABOVE the stats it qualifies', async () => {
  // Presence is asserted first on purpose. An index comparison alone passes against unfixed code
  // (-1 < 2) and would keep passing if the key were dropped again.
  const body = await call(buildServer(true), { ...BASE, format: 'summary' });
  const keys = Object.keys(body);
  assert.ok(keys.includes('incomplete'), 'summary must carry the notice');
  assert.ok(
    keys.indexOf('incomplete') < keys.indexOf('stats'),
    'the warning must sit above the counts it qualifies'
  );
});

await test('a truncated export names a resume token per collection', async () => {
  const body = await call(buildServer(true), { ...BASE, format: 'summary' });
  assert.strictEqual(body.nextPageTokens.tags, 'more');
  assert.strictEqual(body.nextPageTokens.builtInVariables, 'more');
});

await test('a COMPLETE export gains no notice in any format', async () => {
  // Passes before AND after. This is the guard that the fix does not add noise to healthy exports,
  // not a repro of the defect.
  const server = buildServer(false);
  for (const format of FORMATS) {
    const body = await call(server, { ...BASE, format });
    assert.ok(!('incomplete' in body), `format ${format} gained a spurious incomplete`);
    assert.ok(!('warning' in body), `format ${format} gained a spurious warning`);
    assert.ok(!('nextPageTokens' in body), `format ${format} gained spurious tokens`);
    assert.strictEqual(Object.keys(body)[0], 'exportedAt');
  }
});

await test('REGRESSION: maxPages is accepted and bounds the walk, not silently dropped', async () => {
  // Pre-fix the schema has no maxPages and z.object strips unknown keys rather than throwing, so the
  // value vanished without a word and the export ran to the 50-page ceiling anyway.
  const server = buildServer(true);
  assert.ok('maxPages' in toolOf(server).inputSchema.shape, 'maxPages must be an input, not silently dropped');
  const body = await call(server, { ...BASE, format: 'summary', maxPages: 2 });
  assert.strictEqual(body.tags.length, 2, 'maxPages must bound the per-collection walk');
  assert.strictEqual(body.incomplete, true);
});

await test('buildTruncationNotice stays silent on a complete result', async () => {
  const { buildTruncationNotice } = await import(pathToFileURL(helperPath).href);
  assert.deepStrictEqual(
    buildTruncationNotice({ tags: { items: [], pagesFetched: 1, truncated: false } }),
    {}
  );
  const n = buildTruncationNotice({
    tags: { items: [], pagesFetched: 1, truncated: true, nextPageToken: 'tok' },
    triggers: { items: [], pagesFetched: 1, truncated: false },
  });
  assert.deepStrictEqual(n.truncatedCollections, ['tags']);
  assert.deepStrictEqual(n.nextPageTokens, { tags: 'tok' });
  assert.ok(!n.warning.includes('—'), 'no em dash may reach an export artifact');
});

console.log(`\nexportCompleteness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
