/**
 * Node test for the instructions string a real server hands the model (server.ts).
 *
 * THIS is the pre-fix gate for the self-description defect. Section 1 builds an actual server under a
 * given env and reads the instructions it published, so against unfixed code it fails on CONTENT:
 * GA4_MCP_ENABLE_DELETES=true used to yield
 *   "Current mode: READ-ONLY (writes disabled), PUBLISH DISABLED, DELETES DISABLED"
 * while ga4_delete_account was registered and callable.
 *
 * Section 2 exercises buildInstructions() directly against fixture configs. Note that pre-fix that
 * export did not exist, so Section 2 fails with "buildInstructions is not a function" rather than on
 * the string. A red Section 2 is NOT evidence about wording; Section 1 is.
 *
 * The last section drives a real server through a real client to check the tool-call argument
 * element cap (GHSA-46jr-4wx8-v453) that createGtmMcpServer sets.
 *
 * Imports the COMPILED module from dist. Run: node src/__tests__/serverInstructions.node.test.mjs
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distServer = path.resolve(here, '../../dist/server.js');
if (!existsSync(distServer)) {
  console.error(`\n✗ serverInstructions test: ${distServer} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { createGtmMcpServer, buildInstructions, SERVER_VERSION } = await import(
  pathToFileURL(distServer).href
);

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

const GATE_VARS = [
  'GTM_MCP_ENABLE_WRITES',
  'GTM_MCP_ENABLE_PUBLISH',
  'GTM_MCP_ENABLE_DELETES',
  'GA4_MCP_ENABLE_WRITES',
  'GA4_MCP_ENABLE_DELETES',
  'DRY_RUN',
];

/**
 * Build a real server under an exact gate env and return the instructions it published.
 * `auth` is only captured inside lazy per-request client getters, so {} never gets touched here.
 */
function instructionsUnderEnv(env) {
  const saved = { ...process.env };
  try {
    for (const k of GATE_VARS) delete process.env[k];
    Object.assign(process.env, env);
    return createGtmMcpServer({}).server._instructions;
  } finally {
    process.env = saved;
  }
}

const modeLineOf = (text) =>
  String(text)
    .split('\n')
    .find((l) => l.startsWith('Current mode:'));

console.log('\nserverInstructions: what a live server tells the model');

await test('REGRESSION: a server with GA4 deletes enabled does not call itself read-only', async () => {
  const mode = modeLineOf(instructionsUnderEnv({ GA4_MCP_ENABLE_DELETES: 'true' }));
  assert.ok(mode, 'no "Current mode:" line in the instructions');
  assert.ok(
    !/READ-ONLY/i.test(mode),
    `ga4_delete_account is live but the model was told: ${mode}`
  );
  assert.match(mode, /GA4 DELETES ENABLED/);
});

await test('REGRESSION: a server with GA4 writes enabled does not call itself read-only', async () => {
  const mode = modeLineOf(instructionsUnderEnv({ GA4_MCP_ENABLE_WRITES: 'true' }));
  assert.ok(!/READ-ONLY/i.test(mode), `the model was told: ${mode}`);
  assert.match(mode, /GA4 WRITES ENABLED/);
});

await test('REGRESSION: GTM deletes on, writes off, is not read-only', async () => {
  const mode = modeLineOf(instructionsUnderEnv({ GTM_MCP_ENABLE_DELETES: 'true' }));
  assert.ok(!/READ-ONLY/i.test(mode), `the model was told: ${mode}`);
  assert.match(mode, /GTM DELETES ENABLED/);
});

await test('a genuinely locked-down server still leads with READ-ONLY', async () => {
  // Passes before AND after. This is the no-regression guard for the common case, not a repro:
  // the fix must not go the other way and stop saying read-only when it is true.
  const mode = modeLineOf(instructionsUnderEnv({}));
  assert.match(mode, /^Current mode: READ-ONLY/);
});

console.log('\nserverInstructions: buildInstructions fixtures');

const OFF = {
  writesEnabled: false,
  publishEnabled: false,
  deletesEnabled: false,
  ga4WritesEnabled: false,
  ga4DeletesEnabled: false,
  dryRun: false,
};

await test('the guardrail list names the GA4 env vars, not just the GTM ones', async () => {
  const text = buildInstructions(OFF);
  assert.match(text, /GA4_MCP_ENABLE_WRITES/);
  assert.match(text, /GA4_MCP_ENABLE_DELETES/);
});

await test('the GA4 Admin surface is never described as read-only', async () => {
  const text = buildInstructions({ ...OFF, ga4WritesEnabled: true });
  assert.ok(
    !/read-only Google Analytics/i.test(text),
    'the GA4 Admin surface has 68 gated write tools; calling it read-only is false'
  );
});

await test('the GA4 write surface is enumerated, so the listing is not one-sided', async () => {
  const text = buildInstructions(OFF);
  assert.match(text, /GA4 ADMIN WRITES/);
  assert.match(text, /ga4_delete_/);
});

await test('the audiences note no longer implies audiences are unreachable', async () => {
  // v1beta exposes no audience READ, but ga4_create_audience / update / archive exist via v1alpha.
  // The old line said only "Not exposed by Admin API v1beta ... audiences".
  const text = buildInstructions(OFF);
  assert.match(text, /Audiences do\s*',?\s*'?\s*have gated v1alpha WRITE tools|have gated v1alpha WRITE tools/);
});

await test('no em dash reaches the client anywhere in the instructions', async () => {
  // Checking only the mode line would pass trivially while a dozen other lines still shipped them.
  const text = buildInstructions(OFF);
  assert.ok(!text.includes('—'), 'em dash found in the instructions string');
});

console.log('\nserverInstructions: what a live server tells the model about itself');

await test('REGRESSION: serverInfo.version is the shipped package version, not a stale literal', async () => {
  // SERVER_VERSION was hard-coded '1.0.0' while semantic-release moved package.json to 1.4xx.0,
  // so every initialize response advertised a version that had not been true since release one.
  const pkg = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
  assert.strictEqual(
    SERVER_VERSION,
    pkg.version,
    `clients are told version ${SERVER_VERSION} but this build is ${pkg.version}`
  );
});

await test('the server hands the client that same version in serverInfo', async () => {
  // Guards the wiring as well as the constant: the version has to reach the McpServer options.
  const info = createGtmMcpServer({}).server._serverInfo;
  assert.ok(info, 'no serverInfo on the constructed server');
  assert.strictEqual(info.name, 'samarth-gtm-mcp');
  assert.strictEqual(info.version, SERVER_VERSION);
});

console.log('\nserverInstructions: tool-call argument element cap (GHSA-46jr-4wx8-v453)');

// A real server, driven by a real client over the SDK's in-memory transport. Before the fix the
// server set no maxToolInputElements (and SDK 1.30.0 had no such option), so a tools/call carrying
// millions of array elements went straight into schema validation and could exhaust the heap of the
// shared HTTP process. The calls below omit audit_container's required ids on purpose: if the cap
// does not fire, schema validation rejects the call before the handler, so nothing reaches Google.
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { MAX_TOOL_INPUT_ELEMENTS } = await import(pathToFileURL(distServer).href);

async function callWithJunk(count) {
  const server = createGtmMcpServer({});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'element-cap-test', version: '0.0.0' });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({
      name: 'audit_container',
      arguments: { junk: new Array(count).fill(0) },
    });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? '' };
  } finally {
    await client.close();
    await server.close();
  }
}

await test('the element cap is a positive finite number', async () => {
  assert.ok(
    Number.isInteger(MAX_TOOL_INPUT_ELEMENTS) && MAX_TOOL_INPUT_ELEMENTS > 0,
    `MAX_TOOL_INPUT_ELEMENTS is ${MAX_TOOL_INPUT_ELEMENTS}; the server sets no element cap`
  );
});

await test('REGRESSION: a tools/call with 500,000 argument elements is refused before schema validation', async () => {
  // A fixed size, not one derived from the export, so this exercises the behaviour on any build.
  const { isError, text } = await callWithJunk(500_000);
  assert.ok(isError, 'an oversized tools/call was not refused');
  assert.match(
    text,
    /more than the maximum of \d+ elements/,
    `the call reached schema validation instead of the element cap: ${text.slice(0, 200)}`
  );
});

await test('the refusal names the exported cap, and one element over it is enough', async () => {
  const { isError, text } = await callWithJunk(MAX_TOOL_INPUT_ELEMENTS + 1);
  assert.ok(isError, 'a tools/call one element over the cap was not refused');
  assert.match(text, new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
});

await test('a tools/call under the element cap is not refused by it', async () => {
  // No-regression guard: ordinary arguments still reach normal schema validation.
  const { isError, text } = await callWithJunk(1000);
  assert.ok(isError, 'expected the missing required ids to fail validation');
  assert.ok(!/more than the maximum of/.test(text), `an ordinary call hit the element cap: ${text}`);
  assert.match(text, /Input validation error/);
});

console.log(`\nserverInstructions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
