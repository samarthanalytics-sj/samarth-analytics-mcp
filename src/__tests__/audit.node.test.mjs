/**
 * Node test for audit_container — the two audit-finding correctness fixes:
 *  1. Pagination: every list follows nextPageToken, so a trigger on page 2 is not reported as a broken
 *     reference for a page-1 tag (and entities beyond page 1 are not silently dropped).
 *  2. GA4-config count: a `googtag` counts as a GA4 config only when its id is G-; an AW- (Google Ads)
 *     googtag no longer trips the false "multiple GA4 config" error.
 * Imports the COMPILED tool from dist. Run: node src/__tests__/audit.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(__dirname, '../../dist/tools/audit.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

if (!existsSync(distTools)) {
  console.error(`\n✗ audit test: ${distTools} not found. Run "npm run build" before "npm test".`);
  process.exit(1);
}

const { registerAuditTools } = await import(pathToFileURL(distTools).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

// A paginating list mock: `pages` is an array of item-arrays; the Nth page carries a nextPageToken while
// more pages remain (token is just the next index).
function makeList(itemKey, pages) {
  return (params) => {
    const i = params.pageToken ? Number(params.pageToken) : 0;
    const page = pages[i] ?? [];
    const hasNext = i + 1 < pages.length;
    return Promise.resolve({ data: { [itemKey]: page, ...(hasNext ? { nextPageToken: String(i + 1) } : {}) } });
  };
}
function buildServer({ tags = [[]], triggers = [[]], variables = [[]], folders = [[]], biv = [[]] } = {}) {
  const workspaces = {
    tags: { list: makeList('tag', tags) },
    triggers: { list: makeList('trigger', triggers) },
    variables: { list: makeList('variable', variables) },
    folders: { list: makeList('folder', folders) },
    built_in_variables: { list: makeList('builtInVariable', biv) },
  };
  const client = { accounts: { containers: { workspaces } } };
  const server = new McpServer({ name: 'audit-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerAuditTools(server, () => client);
  return server;
}
async function audit(server, extra = {}) {
  const tool = server._registeredTools['audit_container'];
  const r = await tool.handler({ accountId: '1', containerId: '2', workspaceId: '3', includeInfo: true, ...extra }, { requestId: 't' });
  assert.ok(!r?.isError, `unexpected error: ${r?.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}
const byCat = (res, cat) => res.findings.filter((f) => f.category === cat);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nGTM audit_container:');

await test('pagination: a trigger on page 2 is NOT a broken reference for a page-1 tag', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'GA4 Event', type: 'gaawe', firingTriggerId: ['2'] }]],
    triggers: [[{ triggerId: '1', name: 'T1', type: 'customEvent' }], [{ triggerId: '2', name: 'T2 (page 2)', type: 'customEvent' }]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broken_reference').length, 0, `expected no broken_reference, got ${JSON.stringify(byCat(res, 'broken_reference'))}`);
  assert.strictEqual(res.stats.triggers, 2, 'both trigger pages should be counted');
});

await test('ga4_config: a GA4 googtag (G-) next to a Google Ads googtag (AW-) does NOT false-alarm', async () => {
  const server = buildServer({
    tags: [[
      { tagId: 't1', name: 'GA4 Config', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC123' }], firingTriggerId: ['1'] },
      { tagId: 't2', name: 'Google Ads', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'AW-999' }], firingTriggerId: ['1'] },
    ]],
    triggers: [[{ triggerId: '1', name: 'All Pages', type: 'pageview' }]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'ga4_config').length, 0, `expected no ga4_config error, got ${JSON.stringify(byCat(res, 'ga4_config'))}`);
});

await test('ga4_config: TWO GA4 googtags (both G-) DO trip the duplicate-config error', async () => {
  const server = buildServer({
    tags: [[
      { tagId: 't1', name: 'GA4 A', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-AAA' }], firingTriggerId: ['1'] },
      { tagId: 't2', name: 'GA4 B', type: 'googtag', parameter: [{ type: 'template', key: 'measurementId', value: 'G-BBB' }], firingTriggerId: ['1'] },
    ]],
    triggers: [[{ triggerId: '1', name: 'All Pages', type: 'pageview' }]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'ga4_config').length, 1, 'two G- config tags should trip the error');
});

console.log(`\naudit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
