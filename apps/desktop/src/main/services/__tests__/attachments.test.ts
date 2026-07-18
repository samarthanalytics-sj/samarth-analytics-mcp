import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { extractAttachmentText, htmlTablesToText, MAX_ATTACHMENT_CHARS } from '../attachments';

let passed = 0;
let failed = 0;
let pending = 0;
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) { void cleanup().then(() => { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); }); } });
}

let dir = '';
async function tmp(name: string, data: string | Buffer): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'attach-test-'));
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}
async function cleanup(): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('\nattachments:');

test('plain text roundtrips with honest metadata', async () => {
  const p = await tmp('notes.md', '# Plan\n\nShip the thing.');
  const a = await extractAttachmentText(p);
  assert.equal(a.name, 'notes.md');
  assert.equal(a.text, '# Plan\n\nShip the thing.');
  assert.equal(a.chars, a.text.length);
  assert.equal(a.truncated, false);
});

test('csv passes through unchanged', async () => {
  const p = await tmp('rows.csv', 'event,count\npurchase,42\n');
  const a = await extractAttachmentText(p);
  assert.ok(a.text.includes('purchase,42'));
});

test('oversized text is truncated WITH a note that says so', async () => {
  const p = await tmp('big.txt', 'x'.repeat(MAX_ATTACHMENT_CHARS + 500));
  const a = await extractAttachmentText(p);
  assert.equal(a.truncated, true);
  assert.equal(a.chars, MAX_ATTACHMENT_CHARS + 500, 'chars reports the REAL size');
  assert.ok(a.text.includes('[Attachment truncated: showing the first'), 'the model is told it saw a cut');
});

test('xlsx extracts per-sheet CSV blocks with quoting', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tags');
  ws.addRow(['Name', 'Note']);
  ws.addRow(['GA4 - Purchase', 'has, comma']);
  const p = join(dir || (dir = await mkdtemp(join(tmpdir(), 'attach-test-'))), 'book.xlsx');
  await wb.xlsx.writeFile(p);
  const a = await extractAttachmentText(p);
  assert.ok(a.text.includes('## Sheet: Tags'));
  assert.ok(a.text.includes('GA4 - Purchase,"has, comma"'), 'comma cell is quoted: ' + a.text);
});

test('a .doc that is really HTML (this app exports) reads as text', async () => {
  const p = await tmp('report.doc', '<html><body><h1>Verification results</h1><p>All 12 tags fired.</p></body></html>');
  const a = await extractAttachmentText(p);
  assert.ok(a.text.includes('All 12 tags fired.'));
});

test('a corrupt .docx fails with a parser error, never "Unsupported"', async () => {
  const p = await tmp('broken.docx', 'this is not a zip');
  await assert.rejects(() => extractAttachmentText(p), (e: Error) => !/Unsupported file type/.test(e.message));
});

test('an image attaches as NATIVE media (base64 + mime), never as fabricated text', async () => {
  // Tiny valid 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const p = await tmp('shot.png', png);
  const a = await extractAttachmentText(p);
  assert.equal(a.media!.kind, 'image');
  assert.equal(a.media!.mimeType, 'image/png');
  assert.equal(a.media!.base64, png.toString('base64'));
  assert.equal(a.chars, 0, 'no fabricated text for an image');
  assert.ok(/cannot view images/.test(a.media!.fallbackText ?? ''), 'honest fallback for non-vision providers');
});

test('an unparseable (scanned-style) pdf still attaches NATIVELY with an honest fallback note', async () => {
  // Not a well-formed PDF body - extraction yields nothing, which must NOT refuse the attach:
  // vision providers can still read the pages; others get the honest scanned-PDF note.
  const p = await tmp('scan.pdf', '%PDF-1.4 not really parseable');
  const a = await extractAttachmentText(p);
  assert.equal(a.media!.kind, 'pdf');
  assert.equal(a.chars, 0, 'no text layer extracted');
  assert.ok(/Scanned PDF/.test(a.media!.fallbackText ?? ''), 'fallback says WHY non-vision providers see nothing');
});

test('docx TABLES come out in table format (pipe rows), built with a real docx zip', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const cell = (t: string): string => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Tag inventory</w:t></w:r></w:p><w:tbl><w:tr>${cell('Tag')}${cell('Status')}</w:tr><w:tr>${cell('GA4 - Purchase')}${cell('fired')}</w:tr></w:tbl></w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const p = await tmp('table.docx', buf);
  const a = await extractAttachmentText(p);
  assert.ok(a.text.includes('| Tag | Status |'), 'header row as pipes: ' + a.text);
  assert.ok(a.text.includes('| GA4 - Purchase | fired |'), 'data row as pipes: ' + a.text);
});

test('htmlTablesToText: cells to pipe rows, entities decoded, tags stripped', () => {
  return Promise.resolve().then(() => {
    const out = htmlTablesToText('<h1>T</h1><table><tr><th>A&amp;B</th><th>C</th></tr><tr><td>1</td><td>2</td></tr></table>');
    assert.ok(out.includes('| A&B | C |'));
    assert.ok(out.includes('| 1 | 2 |'));
    assert.ok(!/[<>]/.test(out.replace(/&/g, '')));
  });
});

test('unsupported extension is refused with the supported list', async () => {
  const p = await tmp('archive.zip', 'PK');
  await assert.rejects(() => extractAttachmentText(p), /Unsupported file type ".zip"/);
});

test('files over the 15 MB cap are refused before reading', async () => {
  const p = await tmp('huge.txt', Buffer.alloc(16 * 1024 * 1024, 97));
  await assert.rejects(() => extractAttachmentText(p), /too large/);
});

test('an empty file is refused honestly', async () => {
  const p = await tmp('empty.txt', '   \n  ');
  await assert.rejects(() => extractAttachmentText(p), /No readable text/);
});
