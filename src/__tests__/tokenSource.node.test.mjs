/**
 * Node test for OAuth token-source selection (auth/tokenSource.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before `npm test`), matching the
 * other .node.test.mjs files here. Note this one imports the REAL implementation rather than
 * mirroring it the way auth.node.test.mjs does, so it cannot drift from the shipped behaviour.
 *
 * The hole: tokens were chosen per FIELD, not per source. With GOOGLE_ACCESS_TOKEN set, no
 * GOOGLE_REFRESH_TOKEN, and a token file present, the client got the env's access token stamped with
 * the FILE's expiry_date and backed by the FILE's refresh token. A dead env token plus a future file
 * expiry means google-auth-library never refreshes and every call 401s; and when it does refresh, it
 * refreshes into the file's identity, which can be a different Google account.
 *
 * Run: node src/__tests__/tokenSource.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/auth/tokenSource.js');
if (!existsSync(distPath)) {
  console.error(`\n✗ tokenSource test: ${distPath} not found. Run "npm run build" first.`);
  process.exit(1);
}
const { selectTokenSource } = await import(pathToFileURL(distPath).href);

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

// A complete, healthy token file for account B.
const FILE = {
  access_token: 'file-access',
  refresh_token: 'file-refresh',
  expiry_date: 4102444800000, // year 2100: "not expiring" as far as the client is concerned
  scope: 'https://www.googleapis.com/auth/tagmanager.readonly',
  token_type: 'Bearer',
};

console.log('\ntokenSource: selectTokenSource');

test('no env and no file yields undefined, so the caller falls through to ADC', () => {
  assert.strictEqual(selectTokenSource({}, null), undefined);
  assert.strictEqual(selectTokenSource({}, undefined), undefined);
  assert.strictEqual(selectTokenSource({}, {}), undefined);
});

test('a token file alone is the source, and may be persisted back', () => {
  const sel = selectTokenSource({}, FILE);
  assert.strictEqual(sel.source, 'file');
  assert.strictEqual(sel.persist, true);
  assert.deepStrictEqual(sel.tokens, FILE);
});

test('a file with only a refresh token still counts as a source', () => {
  const sel = selectTokenSource({}, { refresh_token: 'r' });
  assert.strictEqual(sel.source, 'file');
});

test('env alone is the source and is never persisted to disk', () => {
  const sel = selectTokenSource({ GOOGLE_REFRESH_TOKEN: 'env-refresh' }, null);
  assert.strictEqual(sel.source, 'env');
  assert.strictEqual(sel.persist, false);
  assert.strictEqual(sel.tokens.refresh_token, 'env-refresh');
});

test('REGRESSION: an env access token does NOT inherit the file expiry_date', () => {
  // This is the wedge: a dead env token stamped with a year-2100 expiry never triggers a refresh, so
  // every API call 401s with nothing in the logs explaining it.
  const sel = selectTokenSource({ GOOGLE_ACCESS_TOKEN: 'env-access' }, FILE);
  assert.strictEqual(sel.source, 'env');
  assert.strictEqual(sel.tokens.access_token, 'env-access');
  assert.strictEqual(sel.tokens.expiry_date, undefined, 'must not borrow the file expiry');
});

test('REGRESSION: an env access token does NOT inherit the file refresh token', () => {
  // The identity swap: refreshing an account-A access token with account-B's refresh token silently
  // continues the session as account B.
  const sel = selectTokenSource({ GOOGLE_ACCESS_TOKEN: 'env-access' }, FILE);
  assert.strictEqual(sel.tokens.refresh_token, undefined, 'must not borrow the file refresh token');
});

test('REGRESSION: env-sourced credentials are never written back over the token file', () => {
  assert.strictEqual(selectTokenSource({ GOOGLE_ACCESS_TOKEN: 'env-access' }, FILE).persist, false);
  assert.strictEqual(selectTokenSource({ GOOGLE_REFRESH_TOKEN: 'env-refresh' }, FILE).persist, false);
});

test('env borrows no scope or token_type from the file either', () => {
  const sel = selectTokenSource({ GOOGLE_ACCESS_TOKEN: 'env-access' }, FILE);
  assert.strictEqual(sel.tokens.scope, undefined);
  assert.strictEqual(sel.tokens.token_type, undefined);
});

test('env wins whole when it supplies BOTH tokens', () => {
  const sel = selectTokenSource(
    { GOOGLE_ACCESS_TOKEN: 'env-access', GOOGLE_REFRESH_TOKEN: 'env-refresh' },
    FILE
  );
  assert.strictEqual(sel.source, 'env');
  assert.strictEqual(sel.tokens.access_token, 'env-access');
  assert.strictEqual(sel.tokens.refresh_token, 'env-refresh');
  assert.strictEqual(sel.tokens.expiry_date, undefined);
});

test('blank and whitespace-only env vars are not a source', () => {
  for (const value of ['', '   ', '\n']) {
    const sel = selectTokenSource({ GOOGLE_ACCESS_TOKEN: value }, FILE);
    assert.strictEqual(sel.source, 'file', `value ${JSON.stringify(value)} should not win`);
  }
  assert.strictEqual(selectTokenSource({ GOOGLE_ACCESS_TOKEN: '  ' }, null), undefined);
});

test('the file object is passed through unmutated', () => {
  const snapshot = JSON.parse(JSON.stringify(FILE));
  selectTokenSource({ GOOGLE_ACCESS_TOKEN: 'env-access' }, FILE);
  selectTokenSource({}, FILE);
  assert.deepStrictEqual(FILE, snapshot, 'selectTokenSource must be pure');
});

console.log(`\ntokenSource: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
