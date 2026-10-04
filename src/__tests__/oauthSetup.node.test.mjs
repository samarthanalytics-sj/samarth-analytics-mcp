/**
 * Node test for the OAuth setup helper (scripts/oauth-setup.ts).
 *
 * Runs the SOURCE script through tsx in a child process, because the behaviour under test is the
 * script's exit code and stderr, not an exported function.
 *
 * The hole: the authorization code was read with a bare `rl.question(...)` promise. If stdin closed
 * before a line arrived (`npm run oauth:setup < /dev/null`, any non-interactive/CI invocation),
 * readline emitted 'close', the question callback never fired, the promise was abandoned, and the
 * process drained the event loop and exited 0 having saved nothing and printed no error. The caller
 * had no way to tell success from silence.
 *
 * The second case pins the fix's ordering hazard: rl.close() emits 'close' synchronously, so a
 * 'close' handler that resolves must not be allowed to beat a real answer to the resolve.
 *
 * Neither case needs valid Google credentials or a network connection: case 2 only asserts that the
 * script got PAST the prompt with the answer in hand, and any token-exchange outcome proves that.
 *
 * Run: node src/__tests__/oauthSetup.node.test.mjs
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const script = path.join(repoRoot, 'src/scripts/oauth-setup.ts');
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

if (!existsSync(tsxCli)) {
  console.error(`\n✗ oauth-setup test: ${tsxCli} not found. Run "npm install" first.`);
  process.exit(1);
}

// A syntactically valid OAuth client so getOAuthAuthorizationUrl() succeeds and the script reaches
// the prompt. Anything already in the environment (a real .env) wins, which is equally fine here.
const childEnv = {
  ...process.env,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? 'test-secret',
};

function runSetup(stdin, extraEnv = {}) {
  const res = spawnSync(process.execPath, [tsxCli, script], {
    cwd: repoRoot,
    env: { ...childEnv, ...extraEnv },
    input: stdin,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

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

console.log('\noauth-setup script');

test('stdin closed with no code: exits 1 and says so, instead of exiting 0 in silence', () => {
  const res = runSetup('');
  assert.ok(
    res.stdout.includes('Paste the authorization code here'),
    'expected the script to reach the prompt (auth URL generation must have succeeded)'
  );
  assert.ok(
    res.stderr.includes('No code provided'),
    'expected "No code provided" on stderr after EOF'
  );
  assert.strictEqual(res.status, 1, 'expected a non-zero exit after EOF');
});

test('a pasted code is not discarded by the close handler', () => {
  const res = runSetup('4/not-a-real-code\n');
  assert.ok(
    !res.stderr.includes('No code provided'),
    'the answer was swallowed: resolve() must run before rl.close()'
  );
  assert.ok(
    res.stderr.includes('Token exchange failed'),
    'expected the script to carry the answer into exchangeCodeForTokens'
  );
});

// ── what the script reports after the exchange ───────────────────────────────
// It used to ignore exchangeCodeForTokens' result, exit 0, and tell the user to copy token values
// "above" that were never printed. With no refresh_token nothing is saved at all, so that was a
// silent failure. Google is stubbed with a preload (NODE_OPTIONS reaches the tsx child) that replaces
// OAuth2Client.prototype.getToken, so no network is involved, and GTM_MCP_TOKEN_FILE points at a temp
// file so a real token file is never touched.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'oauth-setup-test-'));
const preload = path.join(tmp, 'stub-google.mjs');
const galPath = path.join(repoRoot, 'node_modules/google-auth-library/build/src/index.js');
writeFileSync(
  preload,
  [
    "import { createRequire } from 'node:module';",
    `const { OAuth2Client } = createRequire(import.meta.url)(${JSON.stringify(galPath)});`,
    'OAuth2Client.prototype.getToken = async function () {',
    '  return { tokens: JSON.parse(process.env.STUB_GOOGLE_TOKENS), res: null };',
    '};',
  ].join('\n')
);

function runWithStubbedTokens(tokens) {
  const tokenFile = path.join(tmp, `tokens-${Math.random().toString(36).slice(2)}.json`);
  const res = runSetup('4/stubbed-code\n', {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim(),
    STUB_GOOGLE_TOKENS: JSON.stringify(tokens),
    GTM_MCP_TOKEN_FILE: tokenFile,
  });
  return { ...res, tokenFile };
}

const ACCESS = 'ya29.stub-access-token-value';
const REFRESH = '1//stub-refresh-token-value';

test('REGRESSION: no refresh_token returned → exits 1 and says nothing was saved', () => {
  const res = runWithStubbedTokens({ access_token: ACCESS, expiry_date: Date.now() + 3600_000 });
  assert.ok(!res.stderr.includes('Token exchange failed'), `the stub did not apply: ${res.stderr}`);
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.ok(res.stderr.includes('No refresh token was returned'), res.stderr);
  assert.ok(!existsSync(res.tokenFile), 'nothing may be written without a refresh token');
  assert.ok(!res.stdout.includes('Step 3'), 'must not announce success');
});

test('a refresh_token is saved to the token file, the script exits 0, and no secret is printed', () => {
  const res = runWithStubbedTokens({
    access_token: ACCESS,
    refresh_token: REFRESH,
    expiry_date: Date.now() + 3600_000,
  });
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.ok(existsSync(res.tokenFile), 'the token file must be written');
  assert.strictEqual(JSON.parse(readFileSync(res.tokenFile, 'utf8')).refresh_token, REFRESH);
  assert.ok(res.stdout.includes(res.tokenFile), 'Step 3 must say where the tokens went');
  assert.ok(!/Copy the GOOGLE_ACCESS_TOKEN/.test(res.stdout), 'the stale "copy the values above" text is back');
  for (const secret of [ACCESS, REFRESH]) {
    assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret), 'a token value was printed');
  }
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\noauth-setup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
