import assert from 'node:assert/strict';
import { parseCsvUrls, parseCsvUrlStats, CSV_URL_CAP } from '../csv-urls';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nCSV URL parsing:');

test('one URL per line', () => {
  assert.deepEqual(parseCsvUrls('https://a.com/x\nhttps://a.com/y'), ['https://a.com/x', 'https://a.com/y']);
});

test('takes the first URL cell of a "url,label" row (ignores the label)', () => {
  assert.deepEqual(parseCsvUrls('https://a.com/pricing, Pricing page\nhttps://a.com/demo,Demo'), ['https://a.com/pricing', 'https://a.com/demo']);
});

test('skips a header cell (url / page / landing page / link)', () => {
  assert.deepEqual(parseCsvUrls('URL\nhttps://a.com/x'), ['https://a.com/x']);
  assert.deepEqual(parseCsvUrls('Landing Page\nhttps://a.com/y'), ['https://a.com/y']);
});

test('adds https:// to a bare domain/path', () => {
  assert.deepEqual(parseCsvUrls('example.com/contact'), ['https://example.com/contact']);
  assert.deepEqual(parseCsvUrls('example.com'), ['https://example.com/']);
});

test('de-duplicates identical URLs', () => {
  assert.deepEqual(parseCsvUrls('https://a.com/x\nhttps://a.com/x'), ['https://a.com/x']);
});

test('folds trailing-slash near-dupes to one page (first written form kept)', () => {
  assert.deepEqual(parseCsvUrls('https://a.com/x\nhttps://a.com/x/'), ['https://a.com/x']);
  assert.deepEqual(parseCsvUrls('https://a.com/x/\nhttps://a.com/x'), ['https://a.com/x/']);
  // root "/" is left alone (already normalized by URL) and still de-dupes
  assert.deepEqual(parseCsvUrls('https://a.com\nhttps://a.com/'), ['https://a.com/']);
});

test('folds plain #anchor near-dupes (same page, different in-page anchor)', () => {
  assert.deepEqual(parseCsvUrls('https://a.com/p\nhttps://a.com/p#contact'), ['https://a.com/p']);
  assert.deepEqual(parseCsvUrls('https://a.com/p#a\nhttps://a.com/p#b'), ['https://a.com/p#a']);
  // trailing slash AND anchor together still collapse
  assert.deepEqual(parseCsvUrls('https://a.com/x/#top\nhttps://a.com/x'), ['https://a.com/x/#top']);
});

test('keeps genuinely-distinct URLs apart (query string + hash-route SPA pages)', () => {
  // different query = potentially different content → NOT merged
  assert.deepEqual(parseCsvUrls('https://a.com/p?id=1\nhttps://a.com/p?id=2'), ['https://a.com/p?id=1', 'https://a.com/p?id=2']);
  // hash-routing SPA: the #/route IS the page → kept distinct
  assert.deepEqual(parseCsvUrls('https://a.com/#/products\nhttps://a.com/#/pricing'), ['https://a.com/#/products', 'https://a.com/#/pricing']);
});

test('ignores blanks, junk cells, and non-http(s) schemes', () => {
  assert.deepEqual(parseCsvUrls('\n  \nnot a url\njavascript:alert(1)\nmailto:a@b.com\nhttps://ok.com/p'), ['https://ok.com/p']);
});

test('preserves commas inside a query string (re-joins the split cells)', () => {
  assert.deepEqual(parseCsvUrls('https://x.com/p?ids=1,2,3'), ['https://x.com/p?ids=1,2,3']);
  assert.deepEqual(parseCsvUrls('https://x.com/p?utm_content=a,b, Pricing'), ['https://x.com/p?utm_content=a,b']);
  assert.deepEqual(parseCsvUrls('"https://x.com/p?ids=1,2,3"'), ['https://x.com/p?ids=1,2,3']);
});

test('does not promote bare filenames to URLs (report.csv / index.html)', () => {
  assert.deepEqual(parseCsvUrls('report.csv\nindex.html\nphoto.png\nhttps://ok.com/p'), ['https://ok.com/p']);
});

test('keeps an explicit http:// URL', () => {
  assert.deepEqual(parseCsvUrls('http://insecure.example/x'), ['http://insecure.example/x']);
});

test('handles CRLF line endings and quoted cells', () => {
  assert.deepEqual(parseCsvUrls('"https://a.com/x"\r\n"https://a.com/y", "Label"'), ['https://a.com/x', 'https://a.com/y']);
});

test('empty / nullish input → empty list (no throw)', () => {
  assert.deepEqual(parseCsvUrls(''), []);
  assert.deepEqual(parseCsvUrls(undefined as unknown as string), []);
});

test('CSV cap is a sane positive bound', () => {
  assert.ok(CSV_URL_CAP >= 25 && CSV_URL_CAP <= 1000);
});

test('parseCsvUrlStats reports unique urls + total + duplicates (exact and near-dupes)', () => {
  const s = parseCsvUrlStats('https://a.com/x\nhttps://a.com/x\nhttps://a.com/x/\nhttps://a.com/x#top\nhttps://a.com/y');
  assert.deepEqual(s.urls, ['https://a.com/x', 'https://a.com/y']);
  assert.equal(s.total, 5); // 5 valid URL rows before de-dup
  assert.equal(s.duplicates, 3); // exact + trailing-slash + anchor near-dupes of /x
});

test('parseCsvUrlStats: no duplicates → duplicates 0, and parseCsvUrls === stats.urls', () => {
  const s = parseCsvUrlStats('https://a.com/x\nhttps://a.com/y');
  assert.equal(s.total, 2);
  assert.equal(s.duplicates, 0);
  assert.deepEqual(parseCsvUrls('https://a.com/x\nhttps://a.com/y'), s.urls);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
