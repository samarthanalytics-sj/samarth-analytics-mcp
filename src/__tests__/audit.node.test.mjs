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

await test('a {{token}} inside a Custom HTML tag body is NOT flagged as a broken variable', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'Widget', type: 'html', parameter: [{ type: 'template', key: 'html', value: '<script>render("{{handlebars_token}}")</script>' }], firingTriggerId: ['1'] }]],
    triggers: [[{ triggerId: '1', name: 'All Pages', type: 'pageview' }]],
  });
  const res = await audit(server);
  const hit = byCat(res, 'broken_reference').filter((f) => /handlebars_token/.test(f.message));
  assert.strictEqual(hit.length, 0, `incidental {{token}} in Custom HTML must not be flagged, got ${JSON.stringify(hit)}`);
});

await test('a {{Missing Var}} in a STRUCTURED tag param IS still a broken variable reference', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'GA4', type: 'gaawe', parameter: [{ type: 'template', key: 'measurementIdOverride', value: '{{Missing Var}}' }], firingTriggerId: ['1'] }]],
    triggers: [[{ triggerId: '1', name: 'All Pages', type: 'pageview' }]],
  });
  const res = await audit(server);
  const hit = byCat(res, 'broken_reference').filter((f) => /Missing Var/.test(f.message));
  assert.strictEqual(hit.length, 1, 'a real missing variable in a non-code param must still be flagged');
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

// ── Built-in triggers ────────────────────────────────────────────────────────
// GTM's reserved built-ins (All Pages 2147479553, Consent Init 2147479572, Init 2147479573, ...) are
// never returned by triggers.list, so every one of these audits runs with an EMPTY triggers page -
// exactly what a real container looks like when the only trigger a tag uses is a built-in.

await test('REGRESSION: a tag firing on the built-in All Pages trigger is NOT a broken reference', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'GA4 Config', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC' }], firingTriggerId: ['2147479553'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(
    byCat(res, 'broken_reference').length,
    0,
    `built-in All Pages should not be reported missing, got ${JSON.stringify(byCat(res, 'broken_reference'))}`
  );
});

await test('REGRESSION: a built-in BLOCKING trigger is not a broken reference either', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'GA4 Config', type: 'gaawc', firingTriggerId: ['2147479553'], blockingTriggerId: ['2147479572'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broken_reference').length, 0, 'built-in blocking trigger should not be reported missing');
});

await test('REGRESSION: a variable enabled by a built-in trigger is not a broken reference', async () => {
  const server = buildServer({
    variables: [[{ variableId: 'v1', name: 'Scoped Var', type: 'c', enablingTriggerId: ['2147479553'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broken_reference').length, 0, 'built-in enabling trigger should not be reported missing');
});

await test('a genuinely missing trigger id IS still a broken reference', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'Orphan', type: 'gaawe', firingTriggerId: ['999'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broken_reference').length, 1, 'a normal missing id must still be flagged');
  assert.match(byCat(res, 'broken_reference')[0].message, /999/);
});

await test('an id NEAR the built-in range but outside it is still a broken reference', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'Almost', type: 'gaawe', firingTriggerId: ['2147478553', '21474795530'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broken_reference').length, 2, 'only 2147479xxx is reserved');
});

await test('a Custom HTML tag on the built-in All Pages trigger IS flagged as a broad trigger', async () => {
  // The old code built allPagesIds only from listed no-filter pageview triggers, and the built-in is
  // never listed - so the single most common "custom HTML on every page" case slipped the check.
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'Legacy Pixel', type: 'html', firingTriggerId: ['2147479553'] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'broad_trigger').length, 1, 'custom HTML on built-in All Pages should warn');
  assert.match(byCat(res, 'broad_trigger')[0].message, /Legacy Pixel/);
});

// ── Tag sequencing ───────────────────────────────────────────────────────────

await test('REGRESSION: a setup/teardown tag with no firing trigger is NOT a missing_trigger error', async () => {
  // GTM fires setup and cleanup tags as part of the parent tag's sequence, so no trigger of their own
  // is correct. They used to be reported as error-severity "it will never fire".
  const server = buildServer({
    tags: [[
      { tagId: 't1', name: 'GA4 Config', type: 'gaawc', firingTriggerId: [] },
      { tagId: 't2', name: 'Cleanup', type: 'html', firingTriggerId: [] },
      {
        tagId: 't3',
        name: 'GA4 Event',
        type: 'gaawe',
        firingTriggerId: ['2147479553'],
        setupTag: [{ tagName: 'GA4 Config', stopOnSetupFailure: true }],
        teardownTag: [{ tagName: 'Cleanup', stopTeardownOnFailure: false }],
      },
    ]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(
    byCat(res, 'missing_trigger').length,
    0,
    `sequenced tags must not be reported as never firing, got ${JSON.stringify(byCat(res, 'missing_trigger'))}`
  );
  assert.strictEqual(byCat(res, 'sequenced_tag').length, 2, 'both sequenced tags get an info note instead');
  assert.strictEqual(byCat(res, 'sequenced_tag')[0].severity, 'info');
});

await test('a tag with no firing trigger that is NOT sequenced is still a missing_trigger error', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'Orphan Tag', type: 'gaawe', firingTriggerId: [] }]],
    triggers: [[]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'missing_trigger').length, 1, 'a genuinely untriggered tag must still error');
  assert.strictEqual(byCat(res, 'sequenced_tag').length, 0);
});

// ── Variable references ──────────────────────────────────────────────────────

await test('REGRESSION: a tag referencing a deleted {{Variable}} is a broken_reference', async () => {
  // This check was promised by the file header and the /audit recipe but never ran: the set built for
  // it held variable IDs and was never read, so a tag bound to a deleted variable audited clean.
  const server = buildServer({
    tags: [[{
      tagId: 't1',
      name: 'GA4 Event',
      type: 'gaawe',
      firingTriggerId: ['2147479553'],
      parameter: [
        { type: 'template', key: 'measurementId', value: '{{GA4 Measurement ID}}' },
        { type: 'list', key: 'eventSettingsTable', list: [{ type: 'map', map: [
          { type: 'template', key: 'parameter', value: 'plan' },
          { type: 'template', key: 'parameterValue', value: '{{DLV - plan}}' },
        ] }] },
      ],
    }]],
    triggers: [[]],
    variables: [[]],
  });
  const res = await audit(server);
  const refs = byCat(res, 'broken_reference');
  assert.strictEqual(refs.length, 2, `expected both refs flagged (nested map rows too), got ${JSON.stringify(refs)}`);
  assert.strictEqual(refs.filter((f) => f.severity === 'error').length, 2);
  assert.ok(refs.some((f) => /GA4 Measurement ID/.test(f.message)), 'top-level parameter ref');
  assert.ok(refs.some((f) => /DLV - plan/.test(f.message)), 'nested list/map ref');
});

await test('an existing variable, an enabled built-in and GTM\'s {{_event}} token are NOT broken references', async () => {
  const server = buildServer({
    tags: [[{
      tagId: 't1',
      name: 'GA4 Event',
      type: 'gaawe',
      firingTriggerId: ['2147479553'],
      parameter: [
        { type: 'template', key: 'measurementId', value: '{{GA4 Measurement ID}}' },
        { type: 'template', key: 'eventName', value: '{{Page URL}}-{{_event}}' },
      ],
    }]],
    triggers: [[]],
    variables: [[{ variableId: 'v1', name: 'GA4 Measurement ID', type: 'c' }]],
    biv: [[{ type: 'pageUrl', name: 'Page URL' }]],
  });
  const res = await audit(server);
  assert.strictEqual(
    byCat(res, 'broken_reference').length,
    0,
    `resolvable references must not be flagged, got ${JSON.stringify(byCat(res, 'broken_reference'))}`
  );
});

await test('REGRESSION: a variable\'s dangling DISABLING trigger is a broken reference', async () => {
  const server = buildServer({
    variables: [[{ variableId: 'v1', name: 'Scoped Var', type: 'c', enablingTriggerId: ['1'], disablingTriggerId: ['999'] }]],
    triggers: [[{ triggerId: '1', name: 'T1', type: 'customEvent' }]],
  });
  const res = await audit(server);
  const refs = byCat(res, 'broken_reference');
  assert.strictEqual(refs.length, 1, `only the disabling id is dangling, got ${JSON.stringify(refs)}`);
  assert.match(refs[0].message, /disabling trigger ID "999"/);
});

// ── Trigger usage ────────────────────────────────────────────────────────────

await test('REGRESSION: members of a Trigger Group a tag uses are NOT reported unused', async () => {
  const server = buildServer({
    tags: [[{ tagId: 't1', name: 'GA4 Event', type: 'gaawe', firingTriggerId: ['g1'] }]],
    triggers: [[
      { triggerId: 'g1', name: 'Group', type: 'triggerGroup', parameter: [
        { type: 'list', key: 'triggerIds', list: [
          { type: 'triggerReference', value: 'a1' },
          { type: 'triggerReference', value: 'b1' },
        ] },
      ] },
      { triggerId: 'a1', name: 'Step A', type: 'customEvent' },
      { triggerId: 'b1', name: 'Step B', type: 'customEvent' },
    ]],
  });
  const res = await audit(server);
  assert.strictEqual(
    byCat(res, 'unused_trigger').length,
    0,
    `group members are in use, got ${JSON.stringify(byCat(res, 'unused_trigger'))}`
  );
});

await test('a trigger reached only by a group NO tag uses is still an orphan', async () => {
  const server = buildServer({
    triggers: [[
      { triggerId: 'g2', name: 'Dead Group', type: 'triggerGroup', parameter: [
        { type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: 'c1' }] },
      ] },
      { triggerId: 'c1', name: 'Step C', type: 'customEvent' },
    ]],
  });
  const res = await audit(server);
  assert.strictEqual(byCat(res, 'unused_trigger').length, 2, 'nothing live reaches either one');
});

await test('REGRESSION: a trigger used only to scope a variable is NOT reported unused', async () => {
  const server = buildServer({
    triggers: [[
      { triggerId: '1', name: 'Enable On', type: 'customEvent' },
      { triggerId: '2', name: 'Disable On', type: 'customEvent' },
    ]],
    variables: [[{ variableId: 'v1', name: 'Scoped Var', type: 'c', enablingTriggerId: ['1'], disablingTriggerId: ['2'] }]],
  });
  const res = await audit(server);
  assert.strictEqual(
    byCat(res, 'unused_trigger').length,
    0,
    `variable-scoping triggers are in use, got ${JSON.stringify(byCat(res, 'unused_trigger'))}`
  );
});

console.log(`\naudit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
