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
import { spawn } from 'child_process';
import crypto from 'crypto';
import { once } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { gzipSync } from 'zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/utils/mcpSession.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ mcpSession test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const {
  decidePostRoute,
  decideSessionAccess,
  decideSessionAdmission,
  resolveSessionLimits,
  sessionLimitResponse,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
  sessionErrorResponse,
  sessionOwnedBy,
  redactSessionId,
  isInitializeRequest,
  UNKNOWN_SESSION_MESSAGE,
  MISSING_SESSION_MESSAGE,
} = await import(pathToFileURL(distPath).href);

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

console.log('\nmcpSession: decideSessionAccess (GET / DELETE)');

test('a known session id is served', () => {
  assert.deepStrictEqual(decideSessionAccess('sess-1', true), { kind: 'ok', sessionId: 'sess-1' });
});

test('REGRESSION: an unknown session id is a 404 + -32001 (GET used to answer 400)', () => {
  const access = decideSessionAccess('sess-from-before-the-restart', false);
  assert.strictEqual(access.kind, 'unknown-session');
  const { status, body } = sessionErrorResponse(access.kind);
  assert.strictEqual(status, 404);
  assert.deepStrictEqual(body, {
    jsonrpc: '2.0',
    error: { code: -32001, message: UNKNOWN_SESSION_MESSAGE },
    id: null,
  });
});

test('REGRESSION: a missing header is a 400 (DELETE used to answer 404), never a 404', () => {
  for (const sid of [undefined, '']) {
    const access = decideSessionAccess(sid, false);
    assert.strictEqual(access.kind, 'missing-header', JSON.stringify(sid));
    const { status, body } = sessionErrorResponse(access.kind);
    assert.strictEqual(status, 400);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.error.message, MISSING_SESSION_MESSAGE);
    assert.notStrictEqual(body.error.code, -32001);
  }
});


console.log('\nmcpSession: sessions are bound to the principal that opened them');

// Sessions were keyed by mcp-session-id alone, so in multi-user mode another authenticated member who
// learned an id could resume the session, take its event stream, or DELETE it.
const ALICE = 'stytch:org-1:member-alice';
const BOB = 'stytch:org-1:member-bob';

test('the owner is recognised; anyone else, or no stored session, is not', () => {
  assert.strictEqual(sessionOwnedBy(ALICE, ALICE), true);
  assert.strictEqual(sessionOwnedBy(ALICE, BOB), false);
  assert.strictEqual(sessionOwnedBy(undefined, ALICE), false);
});

test("REGRESSION: another principal's session id on a tools/call is refused like an unknown id", () => {
  const route = decidePostRoute('alice-sess', sessionOwnedBy(ALICE, BOB), CALL);
  assert.strictEqual(route.kind, 'unknown-session');
});

test("REGRESSION: another principal's session id on an initialize mints a NEW session, never resumes", () => {
  assert.strictEqual(decidePostRoute('alice-sess', sessionOwnedBy(ALICE, BOB), INIT).kind, 'create');
});

test("REGRESSION: GET/DELETE with another principal's session id is the same 404 as an unknown id", () => {
  const foreign = decideSessionAccess('alice-sess', sessionOwnedBy(ALICE, BOB));
  const unknown = decideSessionAccess('no-such-sess', sessionOwnedBy(undefined, BOB));
  assert.strictEqual(foreign.kind, 'unknown-session');
  assert.deepStrictEqual(sessionErrorResponse(foreign.kind), sessionErrorResponse(unknown.kind));
});

test('the owner still resumes and reaches its own session', () => {
  assert.strictEqual(decidePostRoute('alice-sess', sessionOwnedBy(ALICE, ALICE), CALL).kind, 'resume');
  assert.strictEqual(decideSessionAccess('alice-sess', sessionOwnedBy(ALICE, ALICE)).kind, 'ok');
});

test('REGRESSION: session ids are redacted for logs, never printed whole', () => {
  const sid = 'f849818d-d6cb-4931-b69a-fe6e0ede948f';
  const shown = redactSessionId(sid);
  assert.ok(!shown.includes(sid), shown);
  assert.ok(shown.startsWith('f849818d'), 'a short prefix stays for correlation');
  assert.ok(shown.length < 16, shown);
  assert.ok(!redactSessionId('short-id').includes('short-id'), 'a short id is not printed either');
});

console.log('\nmcpSession: how many sessions may exist (admission caps)');

// Nothing bounded the number of live sessions: the idle sweep only limits how long one lives, so an
// authenticated caller looping initialize could mint thousands of ~2 MB servers inside one TTL.
const LIMITS = { maxTotal: 5, maxPerPrincipal: 2 };
const sess = (principal, lastActivity, inFlight = 0) => ({ principal, lastActivity, inFlight });

test('defaults: a global cap always; per principal only matters in multi-user mode', () => {
  assert.deepStrictEqual(resolveSessionLimits({}, true), {
    maxTotal: DEFAULT_MAX_SESSIONS,
    maxPerPrincipal: DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
  });
  // Static-token / unauthenticated modes have one principal for everyone holding the token.
  assert.deepStrictEqual(resolveSessionLimits({}, false), {
    maxTotal: DEFAULT_MAX_SESSIONS,
    maxPerPrincipal: DEFAULT_MAX_SESSIONS,
  });
  assert.ok(DEFAULT_MAX_SESSIONS_PER_PRINCIPAL >= 5, 'a user must be able to run several clients');
});

test('env overrides; invalid values fall back; per principal never exceeds the global cap', () => {
  assert.deepStrictEqual(
    resolveSessionLimits({ GTM_MCP_HTTP_MAX_SESSIONS: '40', GTM_MCP_HTTP_MAX_SESSIONS_PER_PRINCIPAL: ' 4 ' }, true),
    { maxTotal: 40, maxPerPrincipal: 4 }
  );
  for (const bad of ['', '0', '-3', 'abc', '2.5']) {
    assert.deepStrictEqual(
      resolveSessionLimits({ GTM_MCP_HTTP_MAX_SESSIONS: bad, GTM_MCP_HTTP_MAX_SESSIONS_PER_PRINCIPAL: bad }, true),
      { maxTotal: DEFAULT_MAX_SESSIONS, maxPerPrincipal: DEFAULT_MAX_SESSIONS_PER_PRINCIPAL },
      JSON.stringify(bad)
    );
  }
  assert.deepStrictEqual(
    resolveSessionLimits({ GTM_MCP_HTTP_MAX_SESSIONS: '3', GTM_MCP_HTTP_MAX_SESSIONS_PER_PRINCIPAL: '50' }, true),
    { maxTotal: 3, maxPerPrincipal: 3 }
  );
});

test('under both caps a new session is admitted', () => {
  const map = new Map([['a1', sess(ALICE, 1)], ['b1', sess(BOB, 2)]]);
  assert.deepStrictEqual(decideSessionAdmission(map, ALICE, LIMITS), { kind: 'admit' });
});

test("REGRESSION: at the per-principal cap the principal's OWN least-recently-active idle session is replaced", () => {
  const map = new Map([
    ['a-new', sess(ALICE, 30)],
    ['b-old', sess(BOB, 1)],
    ['a-old', sess(ALICE, 10)],
  ]);
  assert.deepStrictEqual(decideSessionAdmission(map, ALICE, LIMITS), { kind: 'evict', sessionId: 'a-old' });
});

test('a session with a request in flight is never the one replaced', () => {
  const map = new Map([['a-old', sess(ALICE, 10, 1)], ['a-new', sess(ALICE, 30)]]);
  assert.deepStrictEqual(decideSessionAdmission(map, ALICE, LIMITS), { kind: 'evict', sessionId: 'a-new' });
});

test('REGRESSION: at the per-principal cap with every session busy, the initialize is refused', () => {
  const map = new Map([['a1', sess(ALICE, 10, 1)], ['a2', sess(ALICE, 30, 2)]]);
  assert.deepStrictEqual(decideSessionAdmission(map, ALICE, LIMITS), { kind: 'reject', scope: 'principal' });
});

test("REGRESSION: at the global cap the initialize is refused, never by evicting someone else's session", () => {
  const map = new Map([
    ['a1', sess(ALICE, 1)],
    ['b1', sess(BOB, 2)],
    ['b2', sess(BOB, 3)],
    ['c1', sess('stytch:org-1:member-carol', 4)],
    ['c2', sess('stytch:org-1:member-carol', 5)],
  ]);
  assert.deepStrictEqual(decideSessionAdmission(map, ALICE, LIMITS), { kind: 'reject', scope: 'global' });
});

test('initializes still in progress count against both caps', () => {
  const map = new Map([['a1', sess(ALICE, 1, 1)]]);
  assert.deepStrictEqual(
    decideSessionAdmission(map, ALICE, LIMITS, { total: 1, forPrincipal: 1 }),
    { kind: 'reject', scope: 'principal' }
  );
  assert.deepStrictEqual(
    decideSessionAdmission(map, BOB, LIMITS, { total: 4, forPrincipal: 0 }),
    { kind: 'reject', scope: 'global' }
  );
});

test('a refused initialize gets a JSON-RPC error that says what to do', () => {
  const principal = sessionLimitResponse('principal', LIMITS);
  assert.strictEqual(principal.status, 429);
  assert.strictEqual(principal.body.jsonrpc, '2.0');
  assert.strictEqual(principal.body.id, null);
  assert.match(principal.body.error.message, /limit 2/);
  assert.match(principal.body.error.message, /DELETE \/mcp|retry later/i);
  const global = sessionLimitResponse('global', LIMITS);
  assert.strictEqual(global.status, 503);
  assert.match(global.body.error.message, /limit \(5\)/);
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

test('REGRESSION: GET and DELETE /mcp answer session errors through decideSessionAccess', () => {
  // POST's unknown-session 404 shares the same envelope, so all three methods answer alike.
  const post = indexCode.indexOf("app.post('/mcp'");
  assert.ok(post >= 0, 'POST /mcp not found');
  assert.match(
    indexCode.slice(post, indexCode.indexOf('});', post)),
    /sessionErrorResponse\('unknown-session'\)/,
    'POST must answer an unknown session with sessionErrorResponse'
  );
  for (const route of ["app.get('/mcp'", "app.delete('/mcp'"]) {
    const at = indexCode.indexOf(route);
    assert.ok(at >= 0, `${route} not found`);
    const handler = indexCode.slice(at, indexCode.indexOf('});', at));
    assert.match(handler, /decideSessionAccess\(/, `${route} must use decideSessionAccess`);
    assert.match(handler, /sessionErrorResponse\(/, `${route} must answer with sessionErrorResponse`);
  }
  assert.ok(!indexCode.includes('Missing or invalid mcp-session-id header.'), 'the GET 400-for-unknown body is back');
  assert.ok(!indexCode.includes("'Session not found.'"), 'the non-JSON-RPC DELETE 404 body is back');
});

test('REGRESSION: index.ts binds each session to its principal and checks it on POST, GET and DELETE', () => {
  assert.match(indexCode, /sessions\.set\([^)]*principal/, 'the stored session must record its principal');
  for (const route of ["app.post('/mcp'", "app.get('/mcp'", "app.delete('/mcp'"]) {
    const at = indexCode.indexOf(route);
    const handler = indexCode.slice(at, indexCode.indexOf('});', at));
    assert.match(handler, /ownsSession\(sessionId, principal\)/, `${route} must check the session owner`);
    assert.ok(!/sessions\.has\(sessionId\)/.test(handler), `${route} still routes on bare existence`);
  }
  assert.match(indexCode, /sessionOwnedBy\(sessions\.get\(sessionId\)\?\.principal, principal\)/);
});

test('REGRESSION: index.ts never logs a full session id', () => {
  const logs = indexCode.match(/console\.error\([^;]*HTTP session[^;]*;/g) ?? [];
  assert.ok(logs.length >= 3, `expected the new / closed / idle session logs, found ${logs.length}`);
  for (const line of logs) {
    assert.ok(!/\$\{sid\}/.test(line), `raw session id logged: ${line}`);
    assert.match(line, /redactSessionId\(sid\)/, line);
  }
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

/** The body of an `app.<method>('/mcp', ...)` handler, comments stripped. */
function handlerCode(route) {
  const at = indexCode.indexOf(route);
  assert.ok(at >= 0, `${route} not found`);
  return indexCode.slice(at, indexCode.indexOf('\n  });', at));
}

test('REGRESSION: the JSON body parser is never mounted globally, ahead of authentication', () => {
  // It was the first app.use(), so every request - unauthenticated ones, POSTs to paths that do not
  // exist - was buffered to 8mb and JSON.parse'd on the event loop before /mcp could send its 401.
  assert.ok(!/app\.use\(\s*express\.json/.test(indexCode), 'express.json is mounted with app.use again');
  assert.ok(!/app\.use\(\s*jsonBody/.test(indexCode), 'the parser is mounted with app.use again');
  const post = handlerCode("app.post('/mcp'");
  const auth = post.indexOf('resolveAuthForRequest(req, res)');
  const body = post.indexOf('readJsonBody(req, res)');
  assert.ok(auth >= 0 && body >= 0, 'POST /mcp must authenticate and then read the body');
  assert.ok(auth < body, 'POST /mcp reads the body before authenticating');
  assert.ok(body < post.indexOf('decidePostRoute('), 'the route decision needs the parsed body');
});

test('REGRESSION: trackRequest does not count a response that closed during the async auth step', () => {
  // trackRequest runs after `await resolveAuthForRequest`. A client that hung up during that await
  // has already emitted its only 'close', so incrementing inFlight there pinned it above zero and the
  // idle sweep skipped the session for the life of the process.
  const at = indexCode.indexOf('const trackRequest');
  assert.ok(at >= 0, 'trackRequest not found');
  const fn = indexCode.slice(at, indexCode.indexOf('\n  };', at));
  const guard = fn.search(/if \(res\.destroyed \|\| res\.closed\) return;/);
  assert.ok(guard >= 0, 'trackRequest must bail out when the response has already closed');
  assert.ok(guard < fn.indexOf('entry.inFlight += 1'), 'the closed check must come before the increment');
});

test('REGRESSION: POST /mcp runs the session admission check before building a server', () => {
  const post = handlerCode("app.post('/mcp'");
  const admit = post.indexOf('decideSessionAdmission(');
  const build = post.indexOf('createGtmMcpServer(');
  assert.ok(admit >= 0, 'POST /mcp creates sessions with no admission check');
  assert.ok(build >= 0, 'createGtmMcpServer not found in POST /mcp');
  assert.ok(admit < build, 'the admission check must run before createGtmMcpServer');
  assert.match(post.slice(admit, build), /sessionLimitResponse\(/, 'a refusal must answer with sessionLimitResponse');
});

test('REGRESSION: the parser never inflates a compressed body', () => {
  // gzip turned an 8 kB unauthenticated request into an 8 MB JSON.parse.
  assert.ok(
    /express\.json\(\s*\{\s*limit: bodyLimit,\s*inflate: false\s*\}\s*\)/.test(indexCode),
    'express.json must be built with inflate: false'
  );
});

// ── End to end: the real HTTP transport ───────────────────────────────────────
// Spawns dist/index.js on a free loopback port with a scrubbed environment: no Google credentials,
// no guardrail flags, a sandbox cwd and a dead DOTENV_CONFIG_PATH so a developer .env is never read.
// Only the transport is exercised (initialize, ping, the session endpoints); no tool ever runs, so
// nothing can reach Google.
const serverEntry = path.resolve(here, '../../dist/index.js');
const TOKEN = 'mcp-session-e2e-token';
const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcpSession-e2e', version: '1' } },
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-e2e-'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(GOOGLE_|SAMARTH_|GTM_MCP_|GA4_MCP_|STYTCH_|DOTENV_)/i.test(k)) env[k] = v;
  }
  Object.assign(env, {
    GTM_MCP_TRANSPORT: 'http',
    GTM_MCP_HTTP_PORT: String(port),
    GTM_MCP_HTTP_HOST: '127.0.0.1',
    DOTENV_CONFIG_PATH: path.join(sandbox, 'no.env'),
    CLOUDSDK_CONFIG: sandbox,
    GOOGLE_APPLICATION_CREDENTIALS: path.join(sandbox, 'no-adc.json'),
    GTM_MCP_TOKEN_FILE: path.join(sandbox, 'no-tokens.json'),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [serverEntry], { cwd: sandbox, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-8000);
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    rmSync(sandbox, { recursive: true, force: true });
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`server exited during startup:\n${stderr}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server not ready after 20s:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { base, stop, stderr: () => stderr };
}

async function e2e(name, fn) {
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

const post = (base, body, headers = {}) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body });

console.log('\nindex.ts end to end: request bodies are read only after authentication');

await e2e('REGRESSION: unauthenticated requests are refused before their body is read', async () => {
  const srv = await startServer({ GTM_MCP_HTTP_AUTH_TOKEN: TOKEN, GTM_MCP_HTTP_BODY_LIMIT: '1kb' });
  try {
    // Before the fix each of these was parsed first: the malformed body answered 400, the oversized
    // one 413, and a POST to a path with no route still had its body buffered and parsed.
    let r = await post(srv.base, '{');
    assert.strictEqual(r.status, 401, 'malformed body without a token');
    r = await post(srv.base, JSON.stringify({ pad: 'x'.repeat(4096) }));
    assert.strictEqual(r.status, 401, 'oversized body without a token');
    r = await post(srv.base, gzipSync(Buffer.from(INIT_BODY)), { 'content-encoding': 'gzip' });
    assert.strictEqual(r.status, 401, 'gzip body without a token');
    r = await fetch(`${srv.base}/no-such-route`, { method: 'POST', headers: MCP_HEADERS, body: '{' });
    assert.strictEqual(r.status, 404, 'a POST to an unrouted path must not be parsed at all');
  } finally {
    await srv.stop();
  }
});

await e2e('authenticated body errors are still JSON-RPC errors, and a normal initialize still works', async () => {
  const srv = await startServer({ GTM_MCP_HTTP_AUTH_TOKEN: TOKEN, GTM_MCP_HTTP_BODY_LIMIT: '1kb' });
  const auth = { authorization: `Bearer ${TOKEN}` };
  try {
    let r = await post(srv.base, '{', auth);
    assert.strictEqual(r.status, 400);
    let body = await r.json();
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.error.code, -32700);
    r = await post(srv.base, JSON.stringify({ pad: 'x'.repeat(4096) }), auth);
    assert.strictEqual(r.status, 413);
    body = await r.json();
    assert.strictEqual(body.error.code, -32600);
    assert.match(body.error.message, /GTM_MCP_HTTP_BODY_LIMIT/);
    // A compressed body is refused (not inflated), as a JSON-RPC error rather than Express HTML.
    r = await post(srv.base, gzipSync(Buffer.from(INIT_BODY)), { ...auth, 'content-encoding': 'gzip' });
    assert.strictEqual(r.status, 415);
    body = await r.json();
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.match(body.error.message, /uncompressed/);
    r = await post(srv.base, INIT_BODY, auth);
    assert.strictEqual(r.status, 200, await r.text());
    assert.ok(r.headers.get('mcp-session-id'), 'initialize must mint a session');
  } finally {
    await srv.stop();
  }
});

console.log('\nindex.ts end to end: session caps');

await e2e('REGRESSION: initialize stops minting sessions at the cap, and replaces idle ones', async () => {
  // Static-token mode has a single principal, so its per-principal cap is the global one (2 here).
  const srv = await startServer({ GTM_MCP_HTTP_AUTH_TOKEN: TOKEN, GTM_MCP_HTTP_MAX_SESSIONS: '2' });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const init = async () => {
    const r = await post(srv.base, INIT_BODY, auth);
    return { status: r.status, sid: r.headers.get('mcp-session-id'), text: await r.text(), r };
  };
  const ping = (sid) =>
    post(srv.base, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }), { ...auth, 'mcp-session-id': sid });
  const streams = [];
  try {
    const a = await init();
    const b = await init();
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(b.status, 200, b.text);
    // At the cap a third initialize replaces the least-recently-active idle session (a), never more.
    const c = await init();
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(await activeSessions(srv.base), 2, 'the session count must stay at the cap');
    assert.strictEqual((await ping(a.sid)).status, 404, 'the replaced session must be gone');
    assert.strictEqual((await ping(b.sid)).status, 200, 'the other session must be untouched');

    // Hold an event stream open on both live sessions: nothing is idle, so the next one is refused.
    for (const sid of [b.sid, c.sid]) {
      const ac = new AbortController();
      const res = await fetch(`${srv.base}/mcp`, {
        headers: { accept: 'text/event-stream', ...auth, 'mcp-session-id': sid },
        signal: ac.signal,
      });
      assert.strictEqual(res.status, 200, `event stream on ${sid}`);
      streams.push(ac);
    }
    const refused = await init();
    assert.strictEqual(refused.status, 429, refused.text);
    assert.ok(refused.r.headers.get('retry-after'), 'a refusal must say when to retry');
    const body = JSON.parse(refused.text);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.error.code, -32000);
    assert.match(body.error.message, /Too many open MCP sessions/);
    assert.ok(!refused.sid, 'no session id for a refused initialize');
    assert.strictEqual(await activeSessions(srv.base), 2);

    // Once a stream closes, that session is idle again and can be replaced.
    for (const ac of streams.splice(0)) ac.abort();
    const replaced = await waitFor(async () => (await init()).status === 200, 3000);
    assert.ok(replaced, 'an idle session must be replaceable once its stream closed');
    assert.strictEqual(await activeSessions(srv.base), 2);
  } finally {
    for (const ac of streams) ac.abort();
    await srv.stop();
  }
});

// ── Multi-user (Stytch) mode against a local mock of Stytch ───────────────────
// The mock serves the project JWKS and the member's vaulted Google token. The Google token is a
// placeholder and no tool ever runs, so nothing reaches Google or Stytch.
const STYTCH_PROJECT = 'project-test-mcpsession-e2e';
const { publicKey: e2ePub, privateKey: e2ePriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const e2eJwk = (kid) => ({ ...e2ePub.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });

function stytchToken({ kid = 'k1', sub = 'member-test-e2e-1' } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64({
    aud: [STYTCH_PROJECT],
    iss: `stytch.com/${STYTCH_PROJECT}`,
    client_id: 'connected-app-test-e2e',
    sub,
    'https://stytch.com/organization': { organization_id: 'organization-test-e2e', slug: 'e2e' },
    scope: 'openid email profile',
    iat: nowSec,
    nbf: nowSec,
    exp: nowSec + 3600,
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), e2ePriv).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** Mock Stytch. `state.jwks` (keys, delayMs, status) is read on every JWKS request. */
async function startMockStytch() {
  const state = { jwks: { kids: ['k1'], delayMs: 0, status: 200 }, jwksHits: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/jwks') {
      state.jwksHits += 1;
      const { kids, delayMs, status } = state.jwks;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ keys: kids.map(e2eJwk) }) : '{"error":"unavailable"}');
      return;
    }
    if (/\/oauth_providers\/google$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'placeholder-not-a-google-token',
          access_token_expires_in: 3600,
          scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
        })
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    env: {
      STYTCH_PROJECT_ID: STYTCH_PROJECT,
      STYTCH_SECRET: 'secret-test-e2e',
      STYTCH_API_BASE: base,
      STYTCH_JWKS_URL: `${base}/jwks`,
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function activeSessions(base) {
  return (await (await fetch(`${base}/health`)).json()).activeSessions;
}

async function waitFor(pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

console.log('\nindex.ts end to end: multi-user mode (mock Stytch)');

await e2e('REGRESSION: a client that hangs up during async auth does not pin its session forever', async () => {
  const stytch = await startMockStytch();
  // A short TTL so the idle sweep runs within the test.
  const srv = await startServer({ ...stytch.env, GTM_MCP_HTTP_SESSION_TTL_MS: '1500' });
  try {
    const r = await post(srv.base, INIT_BODY, { authorization: `Bearer ${stytchToken()}` });
    assert.strictEqual(r.status, 200, await r.text());
    const sid = r.headers.get('mcp-session-id');
    assert.ok(sid);
    assert.strictEqual(await activeSessions(srv.base), 1);

    // A token signed by a key the server has not cached forces a JWKS refetch, which the mock holds
    // for 400 ms. The client gives up after 100 ms, so its response closes while auth is awaiting.
    stytch.state.jwks = { kids: ['k1', 'k2'], delayMs: 400, status: 200 };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await fetch(`${srv.base}/mcp`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${stytchToken({ kid: 'k2' })}`, 'mcp-session-id': sid },
      signal: ac.signal,
    }).then(
      () => assert.fail('the request was expected to be aborted'),
      (err) => assert.strictEqual(err.name, 'AbortError')
    );
    // Before the fix inFlight stayed at 1 and the sweep skipped this session for good.
    const swept = await waitFor(async () => (await activeSessions(srv.base)) === 0, 6000);
    assert.ok(swept, 'the abandoned session was never swept: its in-flight count leaked');
  } finally {
    await srv.stop();
    await stytch.stop();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
