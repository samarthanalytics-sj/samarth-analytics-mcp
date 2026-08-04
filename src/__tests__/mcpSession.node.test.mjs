/**
 * Node test for the POST /mcp session-routing decision (utils/mcpSession.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before `npm test`), matching the
 * other .node.test.mjs files here.
 *
 * The hole: /mcp minted a new transport for ANY request without a known session id and connected the
 * one shared McpServer to it. An McpServer refuses a second connect(), so the second client threw
 * inside an async handler and, with no rejection net, killed the process along with the first
 * client's session. A stale session id from a client that outlived a restart did the same thing, and
 * left an orphan transport that never entered the session map.
 *
 * Run: node src/__tests__/mcpSession.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/utils/mcpSession.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ mcpSession test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { decidePostRoute, isInitializeRequest, UNKNOWN_SESSION_MESSAGE } = await import(
  pathToFileURL(distPath).href
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_gtm_accounts' } };

console.log('\nmcpSession: isInitializeRequest');

test('recognises a single initialize request', () => {
  assert.strictEqual(isInitializeRequest(INIT), true);
});

test('rejects a non-initialize request', () => {
  assert.strictEqual(isInitializeRequest(CALL), false);
});

test('recognises a batch containing an initialize', () => {
  assert.strictEqual(isInitializeRequest([CALL, INIT]), true);
});

test('rejects a batch with no initialize', () => {
  assert.strictEqual(isInitializeRequest([CALL, CALL]), false);
});

test('rejects null, undefined and non-objects without throwing', () => {
  for (const body of [null, undefined, '', 'initialize', 42, []]) {
    assert.strictEqual(isInitializeRequest(body), false, `body ${JSON.stringify(body)}`);
  }
});

console.log('\nmcpSession: decidePostRoute');

test('a known session id resumes that session, whatever the method', () => {
  const route = decidePostRoute('sess-1', true, CALL);
  assert.strictEqual(route.kind, 'resume');
  assert.strictEqual(route.sessionId, 'sess-1');
});

test('an initialize with no session id creates a session', () => {
  assert.strictEqual(decidePostRoute(undefined, false, INIT).kind, 'create');
});

test('REGRESSION: a second client initializing gets its OWN session, not the first one', () => {
  // Both clients arrive with no session id. Each must take the create path, which is what gives
  // each one its own McpServer instance. The old code took this path too, but connected the single
  // shared server twice - the second connect() threw and killed the process.
  assert.strictEqual(decidePostRoute(undefined, false, INIT).kind, 'create');
  assert.strictEqual(decidePostRoute(undefined, false, INIT).kind, 'create');
});

test('REGRESSION: a stale session id on a non-initialize is refused, not minted', () => {
  const route = decidePostRoute('sess-from-before-the-restart', false, CALL);
  assert.strictEqual(route.kind, 'unknown-session');
});

test('a stale session id on an initialize is allowed to start over', () => {
  assert.strictEqual(decidePostRoute('sess-from-before-the-restart', false, INIT).kind, 'create');
});

test('no session id and no initialize is refused', () => {
  assert.strictEqual(decidePostRoute(undefined, false, CALL).kind, 'unknown-session');
});

test('an empty-string session id is treated as absent', () => {
  assert.strictEqual(decidePostRoute('', false, INIT).kind, 'create');
  assert.strictEqual(decidePostRoute('', false, CALL).kind, 'unknown-session');
});

test('the unknown-session message tells the client how to recover', () => {
  assert.match(UNKNOWN_SESSION_MESSAGE, /initialize/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
