/**
 * Tool-schema contract tests.
 *
 * These do not exercise the GTM API. They assert that the DESCRIPTIONS a model reads before calling
 * a tool state the things the API will reject it for getting wrong. Both cases here are real
 * failures observed in production chat:
 *
 *   tags_create advertised a tag type of "ga4". There is no such GTM type; the API answers
 *   "vendorTemplate.key: Unknown entity type". The model was following the documentation it was
 *   given, so no amount of prompt tuning would have fixed it.
 *
 *   The trigger condition schema left `key` undescribed. GTM accepts only "arg0" and "arg1" there
 *   and answers "filter[0].parameter[0]: Parameter key is unknown" for anything else. The
 *   convention was documented, but only inside two guided-workflow prompts, so an ordinary
 *   "create a click trigger" conversation never saw it.
 *
 * A tool description is an interface. Run: node src/__tests__/toolContracts.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distTags = path.resolve(__dirname, '../../dist/tools/tags.js');
const distTriggers = path.resolve(__dirname, '../../dist/tools/triggers.js');
const distSdk = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');

for (const f of [distTags, distTriggers]) {
  if (!existsSync(f)) {
    console.error(`\n✗ toolContracts test: ${f} not found. Run "npm run build" before "npm test".`);
    process.exit(1);
  }
}

const { registerTagTools } = await import(pathToFileURL(distTags).href);
const { registerTriggerTools } = await import(pathToFileURL(distTriggers).href);
const { McpServer } = await import(pathToFileURL(distSdk).href);

const server = new McpServer({ name: 'contracts-test', version: '0.0.1' }, { capabilities: { tools: {} } });
const client = { accounts: { containers: { workspaces: { tags: {}, triggers: {} } } } };
registerTagTools(server, () => client);
registerTriggerTools(server, () => client);

const { zodToJsonSchema } = await import('zod-to-json-schema');

/**
 * One field as the MODEL receives it.
 *
 * Converted to JSON Schema rather than read off the zod object, because that conversion is what
 * the MCP server actually sends. A description nested inside an array item is invisible to
 * `shape[field].description` but is exactly the text that has to reach the caller.
 */
function fieldJson(toolName, field) {
  const shape = server._registeredTools[toolName]?.inputSchema?.shape ?? {};
  assert.ok(field in shape, `${toolName} has no "${field}" field`);
  return JSON.stringify(zodToJsonSchema(shape[field]));
}

/** The top-level description text for one field. */
function fieldDescription(toolName, field) {
  const shape = server._registeredTools[toolName]?.inputSchema?.shape ?? {};
  assert.ok(field in shape, `${toolName} has no "${field}" field`);
  return shape[field].description ?? '';
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\nTool schema contracts (what the model is told before it calls):');

await test('tags_create names the REAL GA4 tag types and disowns "ga4"', () => {
  const d = fieldDescription('tags_create', 'type');
  assert.ok(/\bgaawe\b/.test(d), 'the GA4 event type "gaawe" must be named');
  assert.ok(/\bgoogtag\b/.test(d), 'the Google tag type "googtag" must be named');
  assert.ok(
    /no "ga4" type/i.test(d),
    'must say explicitly that "ga4" is not a type — it was advertised as one and the API rejects it',
  );
});

await test('tags_update points at the same type vocabulary', () => {
  const d = fieldDescription('tags_update', 'type');
  assert.ok(/gaawe|tags_create/.test(d), 'must reference the real types or the tool that lists them');
  assert.ok(/no "ga4" type/i.test(d), 'must carry the same warning as tags_create');
});

await test('no tag tool still advertises a bare "ga4" type', () => {
  for (const tool of ['tags_create', 'tags_update']) {
    const d = fieldDescription(tool, 'type');
    // The literal in quotes, other than inside the explicit "there is no" warning.
    const stray = d.replace(/there is no "ga4" type\.?/gi, '');
    assert.ok(!/"ga4"/.test(stray), `${tool} still offers "ga4" as a value`);
  }
});

await test('trigger conditions state the arg0 / arg1 key contract', () => {
  for (const tool of ['triggers_create', 'triggers_update']) {
    for (const field of ['filter', 'customEventFilter', 'autoEventFilter']) {
      const json = fieldJson(tool, field);
      assert.ok(/arg0/.test(json), `${tool}.${field} never mentions arg0`);
      assert.ok(/arg1/.test(json), `${tool}.${field} never mentions arg1`);
      assert.ok(
        /Parameter key is unknown/.test(json),
        `${tool}.${field} should name the error a wrong key produces, so the fix is obvious`,
      );
    }
  }
});

await test('trigger conditions warn that a built-in variable must be enabled first', () => {
  const json = fieldJson('triggers_create', 'filter');
  assert.ok(
    /built_in_variables_enable/.test(json),
    'must name the tool that enables a built-in, since referencing a disabled one fails at the API',
  );
});

await test('tags_create states what a GA4 event tag needs to be accepted', () => {
  const d = fieldDescription('tags_create', 'parameter');
  // The observed failure: "vendorTemplate.parameter.measurementIdOverride: The value must not be
  // empty" — an error naming a field the caller never sent. Cost a whole round trip to discover.
  assert.ok(/measurementIdOverride/.test(d), 'must name the field the API demands');
  assert.ok(/tagReference/.test(d), 'must show the measurementId tagReference that pairs with it');
  assert.ok(/eventSettingsTable/.test(d), 'must keep the shared nesting example, not replace it');
});

await test('workspace-scoped list results echo the scope they were read from', async () => {
  const scoped = new McpServer({ name: 'scope-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerTagTools(scoped, () => ({
    accounts: { containers: { workspaces: { tags: { list: () => Promise.resolve({ data: { tag: [] } }) } } } },
  }));

  const res = await scoped._registeredTools.tags_list.handler(
    { accountId: '6300744495', containerId: '223151851', workspaceId: '2' },
    { requestId: 'test' },
  );
  const body = JSON.parse(res.content[0].text);

  // The EMPTY case is the one that needs this. "There are no tags in your selected workspace"
  // cannot be checked by the person reading it, and a container holds more than one workspace,
  // so an empty answer from the wrong one looks exactly like an empty answer from the right one.
  assert.strictEqual(body.count, 0, 'fixture returns no tags');
  assert.ok(body.scope, 'an empty list must still say where it looked');
  assert.strictEqual(body.scope.workspaceId, '2');
  assert.strictEqual(body.scope.containerId, '223151851');
  assert.strictEqual(body.scope.accountId, '6300744495');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
