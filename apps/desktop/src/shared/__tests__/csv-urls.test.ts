import assert from 'node:assert/strict';
import { parseCsvUrls, CSV_URL_CAP } from '../csv-urls';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
