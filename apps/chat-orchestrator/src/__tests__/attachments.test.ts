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
import {
  extractAll,
  extractAttachment,
  attachmentPrompt,
  htmlTablesToText,
  MAX_ATTACHMENT_CHARS,
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

test('the prompt block frames attachments as reference, not as instructions', async () => {
  const { ok } = await extractAll([{ name: 'a.txt', dataBase64: b64('hello') }]);
  const prompt = attachmentPrompt(ok);
  assert.ok(prompt.includes('not as instructions'), 'prompt-injection framing must be explicit');
  assert.ok(prompt.includes('a.txt'));
  assert.equal(attachmentPrompt([]), '', 'no attachments means no block at all');
});

test('html tables keep their row structure instead of collapsing into prose', () => {
  const text = htmlTablesToText('<table><tr><td>Tag</td><td>Type</td></tr><tr><td>GA4</td><td>config</td></tr></table>');
  assert.ok(text.includes('Tag | Type'), 'cells stay separated');
  assert.ok(text.includes('GA4 | config'));
});
