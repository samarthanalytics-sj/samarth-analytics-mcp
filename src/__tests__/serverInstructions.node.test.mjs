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
 * Imports the COMPILED module from dist. Run: node src/__tests__/serverInstructions.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distServer = path.resolve(here, '../../dist/server.js');
if (!existsSync(distServer)) {
  console.error(`\n✗ serverInstructions test: ${distServer} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { createGtmMcpServer, buildInstructions } = await import(pathToFileURL(distServer).href);

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

console.log(`\nserverInstructions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
