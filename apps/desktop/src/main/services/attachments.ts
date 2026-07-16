// Chat attachments: read a user-picked file and extract PLAIN TEXT for the model. Provider-agnostic
// by design - the extracted text is injected into the outgoing chat message, so every provider
// (Anthropic / OpenAI / Gemini) "reads" the document without per-provider media plumbing.
// Size and character caps keep prompts sane; when the text is truncated, the text SAYS so - the
// model must never believe it saw the whole file when it did not.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export interface AttachmentText {
  name: string;
  bytes: number;
  /** Characters extracted BEFORE the cap - the honest size of what the file contained. */
  chars: number;
  /** The text handed to the model (capped; carries an explicit truncation note when cut). */
  text: string;
  truncated: boolean;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENT_CHARS = 120_000;
const XLSX_ROW_CAP = 2000;
// Read-as-text extensions. Everything else needs a real extractor (xlsx/pdf below) or is refused -
// binary formats are never dumped raw into a prompt.
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yml', '.yaml', '.js', '.ts']);

export async function extractAttachmentText(filePath: string): Promise<AttachmentText> {
  const info = await stat(filePath);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large (${Math.round(info.size / (1024 * 1024))} MB; the limit is 15 MB).`);
  }
  const ext = extname(filePath).toLowerCase();
  let raw: string;
  if (TEXT_EXTS.has(ext)) raw = await readFile(filePath, 'utf8');
  else if (ext === '.xlsx') raw = await readXlsx(filePath);
  else if (ext === '.pdf') raw = await readPdf(filePath);
  else if (ext === '.docx') raw = await readDocx(filePath);
  else if (ext === '.doc') raw = await readDoc(filePath);
  else throw new Error(`Unsupported file type "${ext || '(no extension)'}". Supported: pdf, docx, doc, xlsx, csv, tsv, txt, md, json, log, html, xml, yaml.`);
  raw = raw.replace(/\u0000/g, '').trim();
  if (!raw) throw new Error('No readable text found in this file.');
  const truncated = raw.length > MAX_ATTACHMENT_CHARS;
  const text = truncated
    ? `${raw.slice(0, MAX_ATTACHMENT_CHARS)}\n\n[Attachment truncated: showing the first ${MAX_ATTACHMENT_CHARS.toLocaleString('en-US')} of ${raw.length.toLocaleString('en-US')} characters.]`
    : raw;
  return { name: basename(filePath), bytes: info.size, chars: raw.length, text, truncated };
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Workbook -> per-sheet CSV blocks (row-capped, cap stated in place). exceljs is lazy - it only
 *  loads when someone actually attaches a spreadsheet. */
async function readXlsx(filePath: string): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [`## Sheet: ${ws.name}`];
    let count = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (count >= XLSX_ROW_CAP) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(csvCell(String(cell.text ?? '')));
      });
      lines.push(cells.join(','));
      count += 1;
    });
    if (ws.actualRowCount > XLSX_ROW_CAP) lines.push(`[Sheet truncated at ${XLSX_ROW_CAP} rows of ${ws.actualRowCount}.]`);
    parts.push(lines.join('\n'));
  });
  return parts.join('\n\n');
}

/** PDF -> text. Imports pdf-parse's lib file directly: the package's index.js runs a debug harness
 *  when it can't see a parent module (the classic ESM-import crash), so never import the root. */
async function readPdf(filePath: string): Promise<string> {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = await readFile(filePath);
  const res = await pdfParse(data);
  return res.text ?? '';
}

/** .docx -> text (mammoth extractRawText: paragraphs preserved, styling/images dropped). */
async function readDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const res = await mammoth.extractRawText({ path: filePath });
  return res.value ?? '';
}

/** .doc -> text. TWO real formats hide behind this extension: this app's own ".doc" exports are
 *  HTML documents (Word opens them), while genuine legacy Word files are the OLE binary format.
 *  Sniff the first bytes: HTML-looking content is read as text; everything else goes through
 *  word-extractor's binary parser. */
async function readDoc(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  const head = data.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<html')) return data.toString('utf8');
  const { default: WordExtractor } = await import('word-extractor');
  const doc = await new WordExtractor().extract(data);
  return doc.getBody() ?? '';
}
