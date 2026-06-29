import assert from 'node:assert/strict';
import { markdownToHtml, reportHtmlDocument } from '../ga4-report-export';

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

console.log('\nGA4 report export:');

test('headings → <h1>/<h2>', () => {
  assert.ok(markdownToHtml('# Title').includes('<h1>Title</h1>'));
  assert.ok(markdownToHtml('## Section').includes('<h2>Section</h2>'));
});

test('GFM table → <table> with <th>/<td>, separator row dropped', () => {
  const html = markdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(html.includes('<table>') && html.includes('<th>A</th>') && html.includes('<td>1</td>'));
  assert.ok(!html.includes('---'), 'separator row not rendered');
});

test('inline bold / italic / code', () => {
  assert.ok(markdownToHtml('**b**').includes('<strong>b</strong>'));
  assert.ok(markdownToHtml('*i*').includes('<em>i</em>'));
  assert.ok(markdownToHtml('`c`').includes('<code>c</code>'));
});

test('list → <ul><li>', () => {
  const html = markdownToHtml('- one\n- two');
  assert.ok(html.includes('<ul>') && html.includes('<li>one</li>') && html.includes('<li>two</li>'));
});

test('code fence → <pre><code>, content HTML-escaped, bars preserved', () => {
  const html = markdownToHtml('```\nmobile  ████░░ 70%\n```');
  assert.ok(html.includes('<pre><code>') && html.includes('████░░ 70%'));
});

test('HTML in text is escaped (no injection)', () => {
  const html = markdownToHtml('a <script>x</script> & <b>');
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;') && !html.includes('<script>'));
});

test('reportHtmlDocument is a full styled HTML page; word mode adds Office namespaces', () => {
  const plain = reportHtmlDocument('My Report', '# Hi\n\ntext');
  assert.ok(plain.startsWith('<!DOCTYPE html>') && plain.includes('<title>My Report</title>') && plain.includes('<style>'));
  assert.ok(plain.includes('<h1>Hi</h1>') && !plain.includes('schemas-microsoft-com'));
  const word = reportHtmlDocument('My Report', '# Hi', { word: true });
  assert.ok(word.includes('urn:schemas-microsoft-com:office:word'), 'word namespaces present');
});

test('title is HTML-escaped in the document', () => {
  assert.ok(reportHtmlDocument('A & B <x>', '# h').includes('<title>A &amp; B &lt;x&gt;</title>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
