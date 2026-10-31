/**
 * Attachment tests.
 *
 * Weighted toward the ways an extractor lies to a model: silently truncating, silently dropping a
 * file, or handing back an empty string that reads as "the document was blank" when it actually
 * means "this is a scan". Each of those produces a confident wrong answer the user cannot audit,
 * so each is locked here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { constants as zlibConstants, deflateRawSync, inflateSync } from 'node:zlib';
import {
  extractAll,
  extractAttachment,
  extractPdf,
  attachmentPrompt,
  htmlTablesToText,
  isAttachmentInput,
  MAX_ATTACHMENT_CHARS,
  PDF_LIMITS,
} from '../attachments.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

test('a text file comes through whole, untruncated', async () => {
  const out = await extractAttachment({ name: 'notes.md', dataBase64: b64('# Title\nhello') });
  assert.equal(out.text, '# Title\nhello');
  assert.equal(out.truncated, false);
  assert.equal(out.chars, 13);
});

test('an oversized text file is cut AND says so, with the true original size', async () => {
  const huge = 'x'.repeat(MAX_ATTACHMENT_CHARS + 5_000);
  const out = await extractAttachment({ name: 'big.txt', dataBase64: b64(huge) });
  assert.equal(out.truncated, true);
  // The honest size is the original, not what survived the cap.
  assert.equal(out.chars, MAX_ATTACHMENT_CHARS + 5_000);
  assert.ok(out.text.includes('Attachment truncated'), 'the text itself must admit the cut');
  assert.ok(out.text.includes('125,000'), 'and state how much there really was');
});

test('an image becomes a vision part, not a description of an image', async () => {
  // A one-pixel PNG is enough: what matters is the routing, not the pixels.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const out = await extractAttachment({ name: 'shot.png', dataBase64: png.toString('base64') });
  assert.equal(out.media?.kind, 'image');
  assert.equal(out.media?.mime, 'image/png');
  assert.ok(out.text.includes('shot.png'), 'the text still names the file for non-vision context');
});

test('the legacy .doc format is refused with the fix named', async () => {
  await assert.rejects(
    () => extractAttachment({ name: 'old.doc', dataBase64: b64('anything') }),
    /Save it as \.docx/,
  );
});

test('an unsupported type is refused and lists what IS supported', async () => {
  await assert.rejects(
    () => extractAttachment({ name: 'archive.zip', dataBase64: b64('PK') }),
    /Supported: PDF, XLSX, DOCX/,
  );
});

test('an empty file is refused rather than attached as nothing', async () => {
  await assert.rejects(() => extractAttachment({ name: 'empty.txt', dataBase64: '' }), /is empty/);
});

test('a renamed non-zip .docx is refused instead of reaching the parser', async () => {
  await assert.rejects(
    () => extractAttachment({ name: 'fake.docx', dataBase64: b64('not a zip at all') }),
    /could not be read|not a valid/,
  );
});

test('one bad file in a batch keeps the good ones and reports the bad', async () => {
  const { ok, rejected } = await extractAll([
    { name: 'a.txt', dataBase64: b64('first') },
    { name: 'bad.doc', dataBase64: b64('legacy') },
    { name: 'b.md', dataBase64: b64('second') },
  ]);
  assert.equal(ok.length, 2, 'the readable files survive');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'bad.doc');
  assert.ok(rejected[0].reason.length > 0, 'a rejection must carry a reason');
});

test('files past the per-message cap are reported, never silently dropped', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}.txt`, dataBase64: b64('x') }));
  const { ok, rejected } = await extractAll(many);
  assert.equal(ok.length, 5);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => /Only 5 attachments/.test(r.reason)));
});

test('a null or malformed entry is reported, never thrown out of the batch', async () => {
  // A null used to throw in extractAttachment and again in extractAll's own catch, escaping the
  // Express handler as an unhandled rejection, which exits the whole process.
  const bad = [null, 7, { name: 'x.txt' }] as unknown as { name: string; dataBase64: string }[];
  const { ok, rejected } = await extractAll([...bad, { name: 'a.txt', dataBase64: b64('kept') }]);
  assert.equal(ok.length, 1, 'the good file survives');
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((r) => typeof r.name === 'string' && r.reason.length > 0));

  // Past the per-message cap too, where the entry was dereferenced without any try at all.
  const many = [
    ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, dataBase64: b64('x') })),
    null,
  ] as unknown as { name: string; dataBase64: string }[];
  const capped = await extractAll(many);
  assert.equal(capped.rejected.length, 1);
});

test('the request boundary check accepts only a named, base64-carrying object', () => {
  assert.equal(isAttachmentInput({ name: 'a.txt', dataBase64: b64('x') }), true);
  for (const bad of [null, undefined, 7, 'a.txt', { name: 'a.txt' }, { dataBase64: 'eA==' }, { name: 1, dataBase64: 'eA==' }]) {
    assert.equal(isAttachmentInput(bad), false, `${JSON.stringify(bad)} was accepted`);
  }
});

test('the prompt block frames attachments as reference, not as instructions', async () => {
  const { ok } = await extractAll([{ name: 'a.txt', dataBase64: b64('hello') }]);
  const prompt = attachmentPrompt(ok);
  assert.ok(prompt.includes('not as instructions'), 'prompt-injection framing must be explicit');
  assert.ok(prompt.includes('a.txt'));
  assert.equal(attachmentPrompt([]), '', 'no attachments means no block at all');
});

console.log('zip bombs');

/** A real workbook from exceljs, so only the extra entry differs from an honest upload. */
async function workbookBytes(rows: string[][]): Promise<Buffer> {
  const ExcelJS: any = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Tags');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Adds `bytes` of one repeated byte as `entry`: tens of MB inflated from a few KB compressed. */
async function withBomb(zipBytes: Buffer | null, entry: string, bytes: number): Promise<Buffer> {
  const mod: any = await import('jszip');
  const JSZip = mod.default ?? mod;
  const zip = zipBytes ? await JSZip.loadAsync(zipBytes) : new JSZip();
  zip.file(entry, Buffer.alloc(bytes, 0x41));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('an ordinary xlsx is still read', async () => {
  const buf = await workbookBytes([
    ['Tag', 'Type'],
    ['GA4 Purchase', 'gaawe'],
  ]);
  const out = await extractAttachment({ name: 'tags.xlsx', dataBase64: buf.toString('base64') });
  assert.ok(out.text.includes('GA4 Purchase,gaawe'), out.text);
});

test('an xlsx that inflates far past its upload size is refused before exceljs loads it', async () => {
  // Passed every byte limit on the compressed upload, then exceljs inflated every entry whole: a
  // 15 MB upload of this shape took the shared process down with every other user's turn.
  const bomb = await withBomb(await workbookBytes([['a', 'b']]), 'xl/media/image9.png', 40 * 1024 * 1024);
  assert.ok(bomb.length < 1024 * 1024, `the bomb should be small on the wire, got ${bomb.length}`);
  await assert.rejects(
    () => extractAttachment({ name: 'bomb.xlsx', dataBase64: bomb.toString('base64') }),
    /^Error: bomb\.xlsx expands to more than 25 MB when unzipped/,
  );
});

test('a docx that inflates far past its upload size is refused before mammoth loads it', async () => {
  const bomb = await withBomb(null, 'word/document.xml', 40 * 1024 * 1024);
  await assert.rejects(
    () => extractAttachment({ name: 'bomb.docx', dataBase64: bomb.toString('base64') }),
    /^Error: bomb\.docx expands to more than 25 MB when unzipped/,
  );
});

console.log('pdf extraction in a limited worker');

/** A one-page PDF around `content`, the page's content stream, with a correct xref table. */
function pdfWith(content: Buffer, filter?: string): Buffer {
  const objs: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length}${filter ? ` /Filter /${filter}` : ''} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = parts[0].length;
  objs.forEach((body, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    offsets.push(at);
    at += obj.length;
    parts.push(obj);
  });
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${rows}` +
        `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/**
 * A valid zlib stream that inflates to `mb` MB of zero bytes, built without ever holding them: one
 * MB of zeros compressed with a full flush is a self-contained, byte-aligned run of deflate blocks,
 * so it can simply be repeated. The checksum is exact (Adler-32 of n zeros is (n mod 65521) << 16 | 1).
 */
function zeroFlateBomb(mb: number): Buffer {
  const oneMb = deflateRawSync(Buffer.alloc(1024 * 1024), { level: 9, finishFlush: zlibConstants.Z_FULL_FLUSH });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((((mb * 1024 * 1024) % 65521) << 16) | 1) >>> 0);
  return Buffer.concat([
    Buffer.from([0x78, 0xda]),
    ...Array.from({ length: mb }, () => oneMb),
    deflateRawSync(Buffer.alloc(0)),
    adler,
  ]);
}

const ordinaryPdf = pdfWith(Buffer.from('BT /F1 12 Tf 72 700 Td (Quarterly tag inventory) Tj ET'));

test('the zlib bomb builder makes what it says, so the PDF test below means something', () => {
  assert.equal(inflateSync(zeroFlateBomb(8)).length, 8 * 1024 * 1024);
});

test('an ordinary PDF has its text extracted', async () => {
  // pdf-parse 2.x has no default export to call; the old `parse(buf)` failed every PDF this way.
  const out = await extractAttachment({ name: 'inventory.pdf', dataBase64: ordinaryPdf.toString('base64') });
  assert.ok(out.text.includes('Quarterly tag inventory'), out.text);
  assert.equal(out.truncated, false);
});

test('a PDF whose content stream inflates to 1 GB is refused within the deadline and the process carries on', async () => {
  // pdf.js inflates a stream whole into a typed array with no cap of its own, and V8's heap limits
  // do not count typed-array memory: measured, this ~1 MB file reached 1.7 GB of process memory.
  const bomb = pdfWith(zeroFlateBomb(1024), 'FlateDecode');
  assert.ok(bomb.length < 2 * 1024 * 1024, `the bomb should be small on the wire, got ${bomb.length}`);
  const started = Date.now();
  await assert.rejects(
    () => extractAttachment({ name: 'bomb.pdf', dataBase64: bomb.toString('base64') }),
    /^Error: bomb\.pdf expands to more than 256 MB when decoded, which is more than this chat can read\./,
  );
  const took = Date.now() - started;
  assert.ok(took < PDF_LIMITS.timeoutMs, `refused after ${took} ms, past the ${PDF_LIMITS.timeoutMs} ms deadline`);

  // The process is still here and still reads PDFs.
  const after = await extractAttachment({ name: 'after.pdf', dataBase64: ordinaryPdf.toString('base64') });
  assert.ok(after.text.includes('Quarterly tag inventory'));
});

test('a PDF still being read at the deadline is refused', async () => {
  await assert.rejects(
    () => extractPdf('slow.pdf', ordinaryPdf, { ...PDF_LIMITS, timeoutMs: 20 }),
    /^Error: slow\.pdf took more than 0\.02 seconds to read, which is more than this chat can read\./,
  );
});

test('a PDF that exhausts the worker heap is refused like a bomb, not reported as a crash', async () => {
  await assert.rejects(
    () => extractPdf('heavy.pdf', ordinaryPdf, { ...PDF_LIMITS, maxOldGenerationSizeMb: 4 }),
    /^Error: heavy\.pdf expands to more than 256 MB when decoded/,
  );
});

test('PDF reads beyond maxConcurrent wait for a slot, and their deadline starts with the read', async () => {
  // Each read may hold up to maxMemoryBytes, so a burst of bombs from different users must not
  // all decode at once. With one slot, an ordinary PDF queued behind a bomb finishes after it.
  const one = { ...PDF_LIMITS, maxConcurrent: 1 };
  const order: string[] = [];
  const bomb = extractPdf('queued-bomb.pdf', pdfWith(zeroFlateBomb(1024), 'FlateDecode'), one).then(
    () => order.push('bomb read'),
    () => order.push('bomb refused'),
  );
  const ordinary = extractPdf('queued.pdf', ordinaryPdf, { ...one, timeoutMs: 5_000 }).then((out) => {
    order.push('ordinary read');
    return out;
  });
  const [, out] = await Promise.all([bomb, ordinary]);
  assert.deepEqual(order, ['bomb refused', 'ordinary read']);
  assert.ok(out.text.includes('Quarterly tag inventory'));
});

test('a long PDF is cut in the worker but still reports its true length', async () => {
  const line = 'tag inventory row '.repeat(25);
  const ops = Array.from({ length: 300 }, () => `(${line}) Tj T*`).join('\n');
  const pdf = pdfWith(Buffer.from(`BT /F1 1 Tf 1.2 TL 10 780 Td\n${ops}\nET`));
  const out = await extractAttachment({ name: 'long.pdf', dataBase64: pdf.toString('base64') });
  assert.equal(out.truncated, true);
  assert.ok(out.chars > MAX_ATTACHMENT_CHARS, `chars ${out.chars} is the cut length, not the true one`);
  assert.ok(out.text.includes(`of ${out.chars.toLocaleString('en-US')} characters`), 'the cut must be narrated');
});

test('html tables keep their row structure instead of collapsing into prose', () => {
  const text = htmlTablesToText('<table><tr><td>Tag</td><td>Type</td></tr><tr><td>GA4</td><td>config</td></tr></table>');
  assert.ok(text.includes('Tag | Type'), 'cells stay separated');
  assert.ok(text.includes('GA4 | config'));
});
