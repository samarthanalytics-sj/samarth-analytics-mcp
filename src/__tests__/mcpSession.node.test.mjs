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
import { existsSync, readFileSync } from 'fs';
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

console.log('\nindex.ts: HTTP transport session lifetime and body limit');

// These two live in src/index.ts, which cannot be imported: it calls main() at module load, so
// loading it would start a server. The routing decision above was extracted into utils/mcpSession.ts
// precisely so it could be tested; the remaining two invariants are structural, so they are read
// out of the source the way listPagination.node.test.mjs reads the tool tree. Comments are stripped
// first - a sentence about a sweep is not a sweep - with the same care over the `//` inside a URL.
const indexSrc = readFileSync(path.resolve(here, '../index.ts'), 'utf-8');
const indexCode = indexSrc
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*/, '$1'))
  .join('\n');

test('REGRESSION: express.json carries an explicit body limit', () => {
  // It used to be a bare express.json(), whose 100 kB default rejected a legitimate tools/call
  // (templates_create with a real template's templateData) with an HTML 413 the client could not
  // parse, while the identical call succeeded over stdio.
  assert.ok(
    !/express\.json\(\s*\)/.test(indexCode),
    'express.json() with no options is back: the 100 kB default silently 413s large writes'
  );
  assert.match(indexCode, /express\.json\(\s*\{\s*limit:/);
});

test('a body-parser failure is answered as JSON-RPC, not as Express HTML', () => {
  assert.ok(
    indexCode.includes("err.type === 'entity.too.large'"),
    'nothing recognises an oversized body, so the client still gets Express HTML'
  );
  const at = indexCode.indexOf('Malformed request body');
  assert.ok(at >= 0, 'no body-parser error handler');
  assert.match(indexCode.slice(at, at + 400), /jsonrpc: '2\.0'/);
});

test('REGRESSION: every stored session records lastActivity', () => {
  // Sessions used to live until the client sent an explicit DELETE. A client that crashes,
  // relaunches or loses the network never sends one, so each reconnect left a full McpServer
  // resident forever and activeSessions only ever climbed.
  assert.match(indexCode, /sessions\.set\([^)]*lastActivity:/);
  const refreshes = indexCode.match(/lastActivity = Date\.now\(\)/g) ?? [];
  assert.ok(
    refreshes.length >= 2,
    `a resumed session and an opened event stream must both refresh lastActivity, found ${refreshes.length}`
  );
});

test('REGRESSION: an idle sweep closes sessions the client never deleted', () => {
  assert.match(indexCode, /GTM_MCP_HTTP_SESSION_TTL_MS/);
  const sweep = /setInterval\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(indexCode);
  assert.ok(sweep, 'no setInterval sweep over the session map');
  assert.match(sweep[1], /lastActivity/);
  assert.match(sweep[1], /sessions\.delete\(/);
  assert.match(sweep[1], /transport\.close\(\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
