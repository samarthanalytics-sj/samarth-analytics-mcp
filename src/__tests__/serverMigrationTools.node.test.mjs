/**
 * Web→server migration tools on the MCP server (E2 of the migration program).
 *
 * No network: the GTM client is a stub that records what it was asked to create. What matters is that
 * the MCP server now exposes the SAME migration surface the desktop app has - the planner, the native
 * server-tag builder and the 17 typed CAPI tools - each importing its gallery template itself, refusing
 * without its own credentials, and landing a correctly-shaped tag in the draft workspace.
 *
 * Run: node src/__tests__/serverMigrationTools.node.test.mjs   (after "npm run build")
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../dist/tools/serverMigration.js');
const sdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
if (!existsSync(dist)) {
  console.error('\n✗ serverMigrationTools test: run "npm run build" before "npm test".');
  process.exit(1);
}
const { registerServerMigrationTools, SERVER_MIGRATION_TOOL_NAMES } = await import(pathToFileURL(dist).href);
const { McpServer } = await import(pathToFileURL(sdk).href);

/** A GTM client stub. `templates` = what templates.list returns (an installed gallery template or none);
 *  the import path is the raw authenticated request importFromGallery makes, recorded as 'import'. */
function stubClient({ tags = [], triggers = [], variables = [], templates = [] } = {}) {
  const calls = [];
  const lister = (key, items) => ({ list: async () => ({ data: { [key]: items } }) });
  return {
    calls,
    context: { _options: { auth: { request: async (opts) => { calls.push({ kind: 'import', params: opts.params, url: opts.url }); return { data: { templateId: '900', name: 'Imported', galleryReference: { owner: opts.params.galleryOwner, repository: opts.params.galleryRepository, galleryTemplateId: 'IMP9' } } }; } } } },
    accounts: { containers: { workspaces: {
      tags: { ...lister('tag', tags), create: async (a) => { calls.push({ kind: 'tag', body: a.requestBody }); return { data: { tagId: 'TAG-new', name: a.requestBody?.name, type: a.requestBody?.type } }; } },
      triggers: lister('trigger', triggers),
      variables: lister('variable', variables),
      templates: lister('template', templates),
    } } },
  };
}
function serverWith(client) {
  const s = new McpServer({ name: 'migration-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerServerMigrationTools(s, () => client);
  return s;
}
const WS = { accountId: '1', containerId: '2', workspaceId: '3' };
const callValidated = (server, tool, args) => { const t = server._registeredTools[tool]; return t.handler(t.inputSchema.parse(args), { requestId: 't' }); };
const json = (res) => JSON.parse(res.content[0].text);
const text = (res) => res.content[0].text;
const paramVal = (tag, key) => (tag.parameter ?? []).find((p) => p.key === key)?.value;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

process.env.GTM_MCP_ENABLE_WRITES = 'true';
const P = (key, value) => ({ type: 'template', key, value });
// A gallery template already installed in the server workspace (so no import is needed).
const INSTALLED = (owner, repository, id) => ({ templateId: '1', name: `${repository} tpl`, galleryReference: { owner, repository, galleryTemplateId: id } });

console.log('\nserver migration tools on the MCP server:');

await test('registers the planner, create_server_tag and all 17 typed CAPI tools', () => {
  const s = serverWith(stubClient());
  for (const n of SERVER_MIGRATION_TOOL_NAMES) assert.ok(s._registeredTools[n], `${n} registered`);
  assert.equal(SERVER_MIGRATION_TOOL_NAMES.length, 19);
  assert.ok(SERVER_MIGRATION_TOOL_NAMES.includes('create_x_capi_server_tag') && SERVER_MIGRATION_TOOL_NAMES.includes('create_rtb_house_server_tag'));
});

await test('plan_server_migration_from_web: reads the web container and plans each pixel with its public id carried', async () => {
  const client = stubClient({
    tags: [
      { tagId: '1', name: 'Google Tag', type: 'googtag', parameter: [P('tagId', 'G-ABC123')] },
      { tagId: '2', name: 'Ads - Purchase', type: 'awct', parameter: [P('conversionId', 'AW-123'), P('conversionLabel', 'LBL')] },
      { tagId: '3', name: 'Meta Pixel', type: 'html', parameter: [P('html', "<script>fbq('init','111')</script>")] },
      { tagId: '4', name: 'Bing UET', type: 'baut', parameter: [P('tagId', '25015051')] },
      { tagId: '5', name: 'X pixel', type: 'html', parameter: [P('html', "<script>twq('config','o1abc')</script>")] },
    ],
  });
  const res = json(await callValidated(serverWith(client), 'plan_server_migration_from_web', WS));
  assert.deepEqual(res.ga4, { present: true, measurementIds: ['G-ABC123'] });
  const by = (d) => res.items.find((i) => i.destination === d);
  assert.equal(by('Google Ads conversion').serverTool, 'create_server_tag (platform: ads_conversion)');
  assert.deepEqual(by('Meta').derived, { pixelId: '111' });
  assert.deepEqual(by('Meta').requires, ['accessToken']);
  assert.equal(by('Microsoft Ads').detectedBy, 'native-type');
  assert.deepEqual(by('Microsoft Ads').derived, { uetTagId: '25015051' });
  assert.equal(by('X (Twitter)').serverTool, 'create_x_capi_server_tag');
  assert.equal(res.truncated, false);
  assert.ok(/triggers_create/.test(res.note));
});

await test('a CAPI tool with the template already installed: no import, tag created with the cvt type, credentials and trigger', async () => {
  const client = stubClient({ templates: [INSTALLED('stape-io', 'reddit-tag', 'RD01')] });
  const res = json(await callValidated(serverWith(client), 'create_reddit_capi_server_tag', { ...WS, pixelId: '{{Reddit Pixel}}', accessToken: '{{Reddit Token}}', event: 'purchase', eventId: '{{Event ID}}', firingTriggerId: ['5'], confirm: true }));
  assert.equal(res.template.imported, false, 'reused the installed template');
  assert.equal(res.template.tagType, 'cvt_RD01');
  const created = client.calls.find((c) => c.kind === 'tag').body;
  assert.equal(created.type, 'cvt_RD01');
  assert.equal(created.name, 'Reddit CAPI Tag');
  assert.deepEqual(created.firingTriggerId, ['5']);
  assert.equal(paramVal(created, 'accountId'), '{{Reddit Pixel}}');
  assert.equal(paramVal(created, 'accessToken'), '{{Reddit Token}}');
  assert.equal(paramVal(created, 'eventName'), 'PURCHASE');
  assert.equal(client.calls.some((c) => c.kind === 'import'), false, 'nothing imported');
});

await test('a CAPI tool with no template installed: imports the gallery template (permissions acknowledged), then creates the tag', async () => {
  const client = stubClient();
  const res = json(await callValidated(serverWith(client), 'create_x_capi_server_tag', { ...WS, pixelId: 'PX', eventId: 'tw-abc', pixelAccessToken: '{{X Token}}', firingTriggerId: ['7'], confirm: true }));
  const imp = client.calls.find((c) => c.kind === 'import');
  assert.ok(imp, 'imported');
  assert.equal(imp.params.galleryOwner, 'stape-io');
  assert.equal(imp.params.galleryRepository, 'twitter-tag');
  assert.equal(imp.params.acknowledgePermissions, true);
  assert.equal(res.template.imported, true);
  assert.equal(res.template.tagType, 'cvt_IMP9', 'the tag type is read off the imported template, never constructed');
  const created = client.calls.find((c) => c.kind === 'tag').body;
  assert.equal(paramVal(created, 'eventId'), 'tw-abc');
  assert.equal(paramVal(created, 'authMethod'), 'accessToken');
});

await test('each CAPI tool refuses without its OWN credentials, and creates nothing', async () => {
  const client = stubClient({ templates: [INSTALLED('stape-io', 'yelp-tag', 'Y1')] });
  const s = serverWith(client);
  assert.ok(/eventId is required/.test(text(await callValidated(s, 'create_x_capi_server_tag', { ...WS, pixelId: 'P', eventId: '', pixelAccessToken: 'T', confirm: true }))));
  assert.ok(/Auth is required/.test(text(await callValidated(s, 'create_x_capi_server_tag', { ...WS, pixelId: 'P', eventId: 'tw-1', consumerKey: 'only-one', confirm: true }))), 'a partial OAuth quartet is refused');
  assert.ok(/accessToken is required/.test(text(await callValidated(s, 'create_yelp_capi_server_tag', { ...WS, accessToken: ' ', confirm: true }))));
  assert.ok(/event is required/.test(text(await callValidated(s, 'create_rtb_house_server_tag', { ...WS, taggingHash: 'h', partnerKey: 'k', event: '', confirm: true }))));
  assert.ok(/tagIds is required/.test(text(await callValidated(s, 'create_amazon_capi_server_tag', { ...WS, tagIds: [], confirm: true }))));
  assert.equal(client.calls.length, 0, 'no import and no create on a refusal');
});

await test('create_server_tag: GA4 relay + Ads conversion shapes; per-platform validation', async () => {
  const client = stubClient();
  const s = serverWith(client);
  const relay = json(await callValidated(s, 'create_server_tag', { ...WS, name: 'GA4 - Server', platform: 'ga4', measurementId: 'G-ABC123', firingTriggerId: ['90'], confirm: true }));
  assert.equal(relay.created.type, 'sgtmgaaw');
  const relayBody = client.calls[0].body;
  assert.equal(paramVal(relayBody, 'measurementId'), 'G-ABC123');
  assert.equal(paramVal(relayBody, 'eventName'), undefined, 'no eventName -> relays every incoming event');
  assert.equal(paramVal(relayBody, 'epToIncludeDropdown'), 'all');
  const ads = json(await callValidated(s, 'create_server_tag', { ...WS, name: 'Ads - Purchase', platform: 'ads_conversion', conversionId: 'AW-123456', conversionLabel: 'abc', firingTriggerId: ['91'], confirm: true }));
  assert.equal(ads.created.type, 'sgtmadsct');
  assert.equal(paramVal(client.calls[1].body, 'conversionId'), '123456', 'AW- prefix stripped');
  assert.ok(/needs conversionId AND conversionLabel/.test(text(await callValidated(s, 'create_server_tag', { ...WS, name: 'x', platform: 'ads_conversion', conversionId: '1', confirm: true }))));
  assert.ok(/needs measurementId/.test(text(await callValidated(s, 'create_server_tag', { ...WS, name: 'x', platform: 'ga4', confirm: true }))));
});

await test('writes stay guarded: with GTM_MCP_ENABLE_WRITES off a CAPI tool creates nothing and says why', async () => {
  const prev = process.env.GTM_MCP_ENABLE_WRITES;
  process.env.GTM_MCP_ENABLE_WRITES = 'false';
  try {
    const client = stubClient({ templates: [INSTALLED('stape-io', 'quora-tag', 'Q1')] });
    const res = await callValidated(serverWith(client), 'create_quora_capi_server_tag', { ...WS, pixelId: 'P', accessToken: 'T', confirm: true });
    assert.ok(/GTM_MCP_ENABLE_WRITES/i.test(text(res)), text(res));
    assert.equal(client.calls.length, 0);
  } finally {
    process.env.GTM_MCP_ENABLE_WRITES = prev;
  }
});

console.log(`\nserverMigrationTools: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
