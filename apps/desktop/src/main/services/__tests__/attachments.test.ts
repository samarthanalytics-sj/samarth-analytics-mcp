import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { extractAttachmentText, MAX_ATTACHMENT_CHARS } from '../attachments';

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
