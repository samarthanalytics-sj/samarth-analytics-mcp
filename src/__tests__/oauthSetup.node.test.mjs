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
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
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

function runSetup(stdin) {
  const res = spawnSync(process.execPath, [tsxCli, script], {
    cwd: repoRoot,
    env: childEnv,
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

console.log(`\noauth-setup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
