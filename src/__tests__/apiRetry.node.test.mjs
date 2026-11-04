/**
 * Node test for the Google API retry/backoff configuration (apiRetry.ts).
 *
 * Imports the COMPILED module from dist (CI runs `npm run build` before
 * `npm test`). Verifies:
 *   - safe defaults: 3 retries, read-only HTTP methods, 408/429/5xx only,
 *   - mutations (POST/PUT/DELETE) are never in the default retry set,
 *   - env tuning (GTM_MCP_RETRY_MAX etc.) including the 0-disables contract,
 *   - the read-only-client POST opt-in,
 *   - jittered backoff stays within [0.5x, 1.5x] and respects the cap,
 *   - retryBackoff/onRetryAttempt never throw on malformed errors,
 *   - the request guard spread in beside these options (googleRequestGuard.ts) refuses a request
 *     whose URL a path argument retargeted, through the real googleapis clients.
 *
 * Run: node src/__tests__/apiRetry.node.test.mjs
 */

import assert from 'assert';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRetry = path.resolve(__dirname, '../../dist/utils/apiRetry.js');

if (!existsSync(distRetry)) {
  console.error(
    `\n✗ apiRetry test: ${distRetry} not found. Run "npm run build" before "npm test".`
  );
  process.exit(1);
}

const { buildRetryOptions, jitteredDelay, retryAfterMs, effectiveRetryDelay, SAFE_HTTP_METHODS_TO_RETRY } = await import(
  pathToFileURL(distRetry).href
);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function inRanges(status, ranges) {
  return ranges.some(([min, max]) => status >= min && status <= max);
}

console.log('\nAPI retry config:');

await test('defaults: retry enabled with 3 attempts', () => {
  const opts = buildRetryOptions({});
  assert.strictEqual(opts.retry, true);
  assert.strictEqual(opts.retryConfig.retry, 3);
  assert.strictEqual(opts.retryConfig.noResponseRetries, 2);
  assert.strictEqual(opts.retryConfig.retryDelayMultiplier, 2);
});

await test('defaults: only read methods are retried, never mutations', () => {
  const { retryConfig } = buildRetryOptions({});
  assert.deepStrictEqual(retryConfig.httpMethodsToRetry, [...SAFE_HTTP_METHODS_TO_RETRY]);
  for (const mutating of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !retryConfig.httpMethodsToRetry.includes(mutating),
      `${mutating} must not be auto-retried by default`
    );
  }
});

await test('defaults: retries 408/429/5xx but no other 4xx and no 2xx/3xx', () => {
  const { retryConfig } = buildRetryOptions({});
  const ranges = retryConfig.statusCodesToRetry;
  for (const retryable of [408, 429, 500, 502, 503, 599]) {
    assert.ok(inRanges(retryable, ranges), `${retryable} should be retryable`);
  }
  for (const terminal of [200, 301, 400, 401, 403, 404, 409]) {
    assert.ok(!inRanges(terminal, ranges), `${terminal} should NOT be retryable`);
  }
});

await test('GTM_MCP_RETRY_MAX tunes the attempt count', () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX: '5' });
  assert.strictEqual(opts.retry, true);
  assert.strictEqual(opts.retryConfig.retry, 5);
});

await test('GTM_MCP_RETRY_MAX=0 disables retries entirely', () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX: '0' });
  assert.strictEqual(opts.retry, false);
  assert.strictEqual(opts.retryConfig.retry, 0);
  assert.strictEqual(opts.retryConfig.noResponseRetries, 0);
});

await test('invalid env values fall back to defaults', () => {
  const opts = buildRetryOptions({
    GTM_MCP_RETRY_MAX: 'banana',
    GTM_MCP_RETRY_MAX_DELAY_MS: '-7',
    GTM_MCP_RETRY_TOTAL_TIMEOUT_MS: '',
  });
  assert.strictEqual(opts.retryConfig.retry, 3);
  assert.strictEqual(opts.retryConfig.maxRetryDelay, 30_000);
  assert.strictEqual(opts.retryConfig.totalTimeout, 60_000);
});

await test('delay and total-timeout caps come from env', () => {
  const opts = buildRetryOptions({
    GTM_MCP_RETRY_MAX_DELAY_MS: '5000',
    GTM_MCP_RETRY_TOTAL_TIMEOUT_MS: '20000',
  });
  assert.strictEqual(opts.retryConfig.maxRetryDelay, 5000);
  assert.strictEqual(opts.retryConfig.totalTimeout, 20000);
});

await test('extraMethodsToRetry opt-in adds POST for read-only clients', () => {
  const { retryConfig } = buildRetryOptions({}, { extraMethodsToRetry: ['POST'] });
  assert.ok(retryConfig.httpMethodsToRetry.includes('POST'));
  assert.ok(retryConfig.httpMethodsToRetry.includes('GET'));
});

await test('jitteredDelay spans [0.5x, 1.5x] of the base delay', () => {
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 0), 500);
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 1), 1500);
  assert.strictEqual(jitteredDelay(1000, 60_000, () => 0.5), 1000);
});

await test('jitteredDelay clamps to the max delay and never goes negative', () => {
  assert.strictEqual(jitteredDelay(100_000, 30_000, () => 1), 30_000);
  assert.strictEqual(jitteredDelay(0, 30_000, () => 1), 0);
  assert.ok(jitteredDelay(-50, 30_000, () => 1) >= 0);
});

await test('retryBackoff resolves (sleeps the jittered delay)', async () => {
  const { retryConfig } = buildRetryOptions({ GTM_MCP_RETRY_MAX_DELAY_MS: '10' });
  const start = Date.now();
  await retryConfig.retryBackoff({}, 5);
  assert.ok(Date.now() - start < 1000, 'backoff should resolve promptly for tiny delays');
});

await test('onRetryAttempt never throws on malformed error shapes', () => {
  const { retryConfig } = buildRetryOptions({});
  const origError = console.error;
  console.error = () => {};
  try {
    retryConfig.onRetryAttempt(undefined);
    retryConfig.onRetryAttempt({});
    retryConfig.onRetryAttempt({ config: null, response: 42 });
  } finally {
    console.error = origError;
  }
});


// ── Retry-After ──────────────────────────────────────────────────────────────
// On a 429 Google usually says how long to wait. Retrying inside that window extends the throttle
// instead of clearing it, and gaxios does not read the header itself.

await test('retryAfterMs reads delta-seconds', () => {
  assert.strictEqual(retryAfterMs({ 'retry-after': '120' }), 120_000);
  assert.strictEqual(retryAfterMs({ 'retry-after': '0' }), 0);
});

await test('retryAfterMs reads the capitalised form and header bags with get()', () => {
  assert.strictEqual(retryAfterMs({ 'Retry-After': '30' }), 30_000);
  assert.strictEqual(retryAfterMs({ get: (k) => (k === 'retry-after' ? '45' : null) }), 45_000);
});

await test('retryAfterMs reads an HTTP-date, relative to now', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:02:00 GMT' }, () => now), 120_000);
});

await test('retryAfterMs treats a PAST date as "retry now", never a negative wait', () => {
  const now = Date.parse('2026-01-01T00:05:00Z');
  assert.strictEqual(retryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' }, () => now), 0);
});

await test('retryAfterMs returns null when there is nothing usable', () => {
  // null means "the server said nothing", which is different from "wait 0" - the caller must fall
  // back to its own backoff rather than retrying immediately.
  for (const h of [undefined, null, {}, 'not-an-object', { 'retry-after': '' }, { 'retry-after': 'soon' }, { 'retry-after': {} }]) {
    assert.strictEqual(retryAfterMs(h), null, JSON.stringify(h));
  }
});

await test('effectiveRetryDelay never waits LESS than either source asks', () => {
  assert.strictEqual(effectiveRetryDelay(2_000, 10_000, 30_000), 10_000);
  assert.strictEqual(effectiveRetryDelay(20_000, 5_000, 30_000), 20_000);
  assert.strictEqual(effectiveRetryDelay(8_000, null, 30_000), 8_000);
});

await test('effectiveRetryDelay clamps so one attempt stays bounded', () => {
  assert.strictEqual(effectiveRetryDelay(1_000, 600_000, 30_000), 30_000);
  assert.strictEqual(effectiveRetryDelay(0, 0, 30_000), 0);
  assert.ok(effectiveRetryDelay(-5, null, 30_000) >= 0, 'never negative');
});

await test('retryBackoff honours Retry-After end to end', async () => {
  const opts = buildRetryOptions({ GTM_MCP_RETRY_MAX_DELAY_MS: '30000' });
  const started = Date.now();
  await opts.retryConfig.retryBackoff({ response: { headers: { 'retry-after': '0' } } }, 0);
  assert.ok(Date.now() - started < 1_000, 'a zero Retry-After resolves promptly');
});

await test('retryBackoff still works when the error carries no headers', () => {
  const opts = buildRetryOptions({});
  assert.doesNotThrow(() => opts.retryConfig.retryBackoff(undefined, 0));
  assert.doesNotThrow(() => opts.retryConfig.retryBackoff({ response: {} }, 0));
});

// ── Request guard (utils/googleRequestGuard.ts) ─────────────────────────────────────────────────
// The other option every client factory spreads in next to the retry options. googleapis expands
// {+path} / {+parent} / {+name} as reserved strings, so an id of '2/versions/5:publish#' turned
// workspace_quick_preview into POST .../versions/5:publish. The tool schemas refuse such ids; this
// is the backstop for any field they miss, exercised here through the REAL googleapis clients the
// server builds. fetchImplementation is a stub, so nothing leaves the process.
console.log('\nGoogle request guard (real clients, stubbed fetch):');

const distGuard = path.resolve(__dirname, '../../dist/utils/googleRequestGuard.js');
const { googleRequestProblem } = await import(pathToFileURL(distGuard).href);
const { getGtmClient } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/utils/gtmClient.js')).href);
const { getGa4AdminAlphaClient, getGa4DataClient } = await import(
  pathToFileURL(path.resolve(__dirname, '../../dist/utils/ga4Client.js')).href
);
const { OAuth2Client } = await import('google-auth-library');

const auth = new OAuth2Client();
auth.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
const sent = [];
const stubFetch = {
  fetchImplementation: async (url, init) => {
    sent.push(`${init.method} ${url}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
};
const gtm = getGtmClient(auth);
const ga4 = getGa4AdminAlphaClient(auth);
const ga4Data = getGa4DataClient(auth);

/** Run one request; report what reached fetch, or the refusal. */
async function attempt(fn) {
  sent.length = 0;
  const started = Date.now();
  try {
    await fn();
    return { sent: [...sent], error: null, ms: Date.now() - started };
  } catch (e) {
    return { sent: [...sent], error: e, ms: Date.now() - started };
  }
}

await test('well-formed requests go out exactly as the method template builds them', async () => {
  const cases = [
    [() => gtm.accounts.containers.workspaces.quick_preview({ path: 'accounts/1/containers/2/workspaces/3' }, stubFetch),
      'POST https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3:quick_preview'],
    [() => gtm.accounts.containers.workspaces.tags.list({ parent: 'accounts/1/containers/2/workspaces/3', pageToken: 'a/b:c?d#e' }, stubFetch),
      'GET https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags?pageToken=a%2Fb%3Ac%3Fd%23e'],
    [() => gtm.accounts.containers.workspaces.tags.update({ path: 'accounts/1/containers/2/workspaces/3/tags/4', fingerprint: '9', requestBody: {} }, stubFetch),
      'PUT https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags/4?fingerprint=9'],
    [() => gtm.accounts.containers.versions.live({ parent: 'accounts/1/containers/2' }, stubFetch),
      'GET https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/versions:live'],
    [() => gtm.accounts.containers.combine({ path: 'accounts/1/containers/2', containerId: '9', settingSource: 'other' }, stubFetch),
      'POST https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2:combine?containerId=9&settingSource=other'],
    [() => gtm.accounts.list({}, stubFetch), 'GET https://tagmanager.googleapis.com/tagmanager/v2/accounts'],
    [() => ga4.properties.customDimensions.archive({ name: 'properties/1/customDimensions/7', requestBody: {} }, stubFetch),
      'POST https://analyticsadmin.googleapis.com/v1alpha/properties/1/customDimensions/7:archive'],
    [() => ga4.properties.customDimensions.patch({ name: 'properties/1/customDimensions/7', updateMask: 'displayName', requestBody: {} }, stubFetch),
      'PATCH https://analyticsadmin.googleapis.com/v1alpha/properties/1/customDimensions/7?updateMask=displayName'],
    [() => ga4Data.properties.runReport({ property: 'properties/1', requestBody: {} }, stubFetch),
      'POST https://analyticsdata.googleapis.com/v1beta/properties/1:runReport'],
  ];
  for (const [fn, expected] of cases) {
    const r = await attempt(fn);
    assert.strictEqual(r.error, null, `${expected}: ${r.error?.message}`);
    assert.deepStrictEqual(r.sent, [expected]);
  }
});

await test('a path argument that retargets the request is refused before fetch, and never retried', async () => {
  const cases = [
    // read-tier quick_preview -> versions/5:publish (the reported exploit)
    () => gtm.accounts.containers.workspaces.quick_preview({ path: 'accounts/1/containers/2/versions/5:publish#/workspaces/3' }, stubFetch),
    // -> containers/2:combine with an attacker query
    () => gtm.accounts.containers.workspaces.quick_preview({ path: 'accounts/1/containers/2:combine?containerId=999&settingSource=other#/workspaces/3' }, stubFetch),
    // the same without '#': the template suffix lands in the query instead
    () => gtm.accounts.containers.workspaces.quick_preview({ path: 'accounts/1/containers/2:combine?x=1/workspaces/3' }, stubFetch),
    () => gtm.accounts.containers.workspaces.folders.entities({ path: 'accounts/1/containers/2/versions/7:publish#/workspaces/3/folders/4' }, stubFetch),
    () => gtm.accounts.containers.versions.set_latest({ path: 'accounts/1/containers/2/versions/5:publish#' }, stubFetch),
    // a ':verb' before the template's own suffix, a ':verb' on a PUT, traversal, escapes, a query on a GET
    () => gtm.accounts.containers.workspaces.tags.create({ parent: 'accounts/1/containers/2/workspaces/3:sync', requestBody: {} }, stubFetch),
    () => gtm.accounts.containers.workspaces.tags.update({ path: 'accounts/1/containers/2/workspaces/3:sync', requestBody: {} }, stubFetch),
    () => gtm.accounts.containers.workspaces.tags.get({ path: 'accounts/1/containers/2/workspaces/3/tags/../../../../2' }, stubFetch),
    () => gtm.accounts.containers.workspaces.tags.get({ path: 'accounts/1/containers/2/workspaces/3/tags/%2e%2e' }, stubFetch),
    () => gtm.accounts.containers.workspaces.tags.get({ path: 'accounts/1/containers/2/workspaces/3/tags/4?x=1' }, stubFetch),
    // GA4: create -> irreversible :archive, and '..' -> accessBindings:batchDelete
    () => ga4.properties.audiences.create({ parent: 'properties/1/customDimensions/7:archive#', requestBody: {} }, stubFetch),
    () => ga4.properties.channelGroups.create({ parent: 'properties/1/../../accounts/123/accessBindings:batchDelete#', requestBody: {} }, stubFetch),
    () => ga4.properties.customDimensions.patch({ name: 'properties/1/customDimensions/7:archive', requestBody: {} }, stubFetch),
  ];
  for (const fn of cases) {
    const r = await attempt(fn);
    assert.ok(r.error, `expected a refusal for ${fn.toString().slice(6, 120)}`);
    assert.match(r.error.message, /Refused to send this Google API request/);
    assert.deepStrictEqual(r.sent, [], `nothing may reach fetch: ${r.sent.join(' | ')}`);
    // gaxios would retry a failed GET with backoff (>= 250ms); a refusal is permanent.
    assert.ok(r.ms < 200, `a refusal must not be retried (took ${r.ms}ms)`);
  }
});

// templates_import_from_gallery has no googleapis method, so importFromGallery calls the client's
// OAuth2Client directly. That bypassed the method options the factory sets, so the guard above never
// saw the request. Stubbed at the fetch layer through the auth's own transport defaults.
const { importFromGallery } = await import(pathToFileURL(path.resolve(__dirname, '../../dist/tools/serverSide.js')).href);
const importSent = [];
const importAuth = new OAuth2Client({
  transporterOptions: {
    fetchImplementation: async (url, init) => {
      importSent.push(`${init.method} ${url}`);
      return new Response('{"templateId":"9"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  },
});
importAuth.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
const importClient = getGtmClient(importAuth);

await test('importFromGallery (a raw auth.request) goes out unchanged when its parent is well-formed', async () => {
  importSent.length = 0;
  const tpl = await importFromGallery(importClient, 'accounts/1/containers/2/workspaces/3', 'owner-x', 'repo-y');
  assert.deepStrictEqual(tpl, { templateId: '9' });
  assert.deepStrictEqual(importSent, [
    'POST https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/templates:import_from_gallery' +
      '?galleryOwner=owner-x&galleryRepository=repo-y&acknowledgePermissions=true',
  ]);
});

await test('REGRESSION: importFromGallery refuses a smuggled parent before fetch, like every client method', async () => {
  for (const parent of [
    // -> POST .../versions/5:publish (the '#' drops the real suffix and the query)
    'accounts/1/containers/2/versions/5:publish#',
    // -> POST .../containers/2:combine with the gallery params tacked onto an attacker query
    'accounts/1/containers/2:combine?containerId=999&settingSource=other',
    // traversal out of the workspace
    'accounts/1/containers/2/workspaces/3/../../../../2',
  ]) {
    importSent.length = 0;
    const started = Date.now();
    await assert.rejects(
      importFromGallery(importClient, parent, 'owner-x', 'repo-y'),
      /Refused to send this Google API request/,
      parent
    );
    assert.deepStrictEqual(importSent, [], `nothing may reach fetch for ${parent}: ${importSent.join(' | ')}`);
    assert.ok(Date.now() - started < 200, 'a refusal is not retried');
  }
});

await test('googleRequestProblem: the request gaxios is about to send, judged in isolation', () => {
  const ser = (p) => new URLSearchParams(p).toString();
  const ok = (url, method = 'GET', params) => googleRequestProblem({ url, method, params, paramsSerializer: ser });
  assert.strictEqual(ok('https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3:quick_preview', 'POST'), null);
  assert.strictEqual(ok('https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags?pageToken=x', 'GET', { pageToken: 'x' }), null);
  assert.ok(ok('https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/versions/5:publish#/workspaces/3:quick_preview', 'POST'));
  // A query that is not exactly the request's own params (gaxios joined with "&" after a smuggled "?").
  assert.ok(ok('https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/tags/4?x=1&fingerprint=9', 'PUT', { fingerprint: '9' }));
  assert.ok(ok('https://tagmanager.googleapis.com/tagmanager/v2/accounts//containers/2', 'GET'), 'an empty id segment');
  assert.ok(ok('https://analyticsadmin.googleapis.com/v1beta/properties/1:archive', 'DELETE'), 'no DELETE carries a :verb');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
