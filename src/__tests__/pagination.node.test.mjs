/**
 * Standalone Node test for the pagination helper logic.
 * Run: node src/__tests__/pagination.node.test.mjs
 *
 * Mirrors the runtime behaviour of src/utils/pagination.ts `paginate` /
 * `buildListResult` without importing TS (kept dependency-free like the other
 * .node.test.mjs files).
 */

import assert from 'assert';

const DEFAULT_MAX_PAGES = 50;

async function paginate(fetchPage, extract, options = {}) {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const items = [];
  let pageToken = options.pageToken;
  let pagesFetched = 0;

  do {
    const data = await fetchPage(pageToken);
    const pageItems = extract(data) ?? [];
    items.push(...pageItems);
    pagesFetched++;
    pageToken =
      data && typeof data === 'object' && typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0
        ? data.nextPageToken
        : undefined;
    if (pageToken && pagesFetched >= maxPages) {
      return { items, pagesFetched, nextPageToken: pageToken, truncated: true };
    }
  } while (pageToken);

  return { items, pagesFetched, truncated: false };
}

function buildListResult(key, result) {
  const body = { [key]: result.items, count: result.items.length };
  if (result.truncated) {
    body.truncated = true;
    body.nextPageToken = result.nextPageToken;
  }
  return body;
}

/** Build a fake paged endpoint over `pages` (array of arrays of items). */
function fakeEndpoint(pages, listKey = 'item') {
  const calls = [];
  const fetchPage = async (token) => {
    const idx = token ? Number(token) : 0;
    calls.push(idx);
    const items = pages[idx] ?? [];
    const hasNext = idx + 1 < pages.length;
    return { [listKey]: items, ...(hasNext ? { nextPageToken: String(idx + 1) } : {}) };
  };
  return { fetchPage, calls, extract: (d) => d[listKey] };
}

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

async function run() {
  console.log('\nPagination:');

  await test('single page returns all items, not truncated', async () => {
    const ep = fakeEndpoint([[1, 2, 3]]);
    const r = await paginate(ep.fetchPage, ep.extract);
    assert.deepStrictEqual(r.items, [1, 2, 3]);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.pagesFetched, 1);
  });

  await test('follows multiple pages and concatenates in order', async () => {
    const ep = fakeEndpoint([[1, 2], [3, 4], [5]]);
    const r = await paginate(ep.fetchPage, ep.extract);
    assert.deepStrictEqual(r.items, [1, 2, 3, 4, 5]);
    assert.strictEqual(r.pagesFetched, 3);
    assert.strictEqual(r.truncated, false);
  });

  await test('respects maxPages and reports truncation + nextPageToken', async () => {
    const ep = fakeEndpoint([[1], [2], [3], [4]]);
    const r = await paginate(ep.fetchPage, ep.extract, { maxPages: 2 });
    assert.deepStrictEqual(r.items, [1, 2]);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.nextPageToken, '2');
    assert.strictEqual(r.pagesFetched, 2);
  });

  await test('resumes from a provided pageToken', async () => {
    const ep = fakeEndpoint([[1], [2], [3]]);
    const r = await paginate(ep.fetchPage, ep.extract, { pageToken: '1' });
    assert.deepStrictEqual(r.items, [2, 3]);
  });

  await test('missing list key yields empty items', async () => {
    const fetchPage = async () => ({});
    const r = await paginate(fetchPage, (d) => d.item);
    assert.deepStrictEqual(r.items, []);
    assert.strictEqual(r.truncated, false);
  });

  await test('buildListResult omits pagination fields when not truncated', async () => {
    const body = buildListResult('tags', { items: [1, 2], truncated: false });
    assert.deepStrictEqual(body, { tags: [1, 2], count: 2 });
  });

  await test('buildListResult adds truncated + nextPageToken when truncated', async () => {
    const body = buildListResult('tags', { items: [1], truncated: true, nextPageToken: '5' });
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(body.nextPageToken, '5');
    assert.strictEqual(body.count, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
