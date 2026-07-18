// Chat attachments: read a user-picked file and extract PLAIN TEXT for the model. Provider-agnostic
// by design - the extracted text is injected into the outgoing chat message, so every provider
// (Anthropic / OpenAI / Gemini) "reads" the document without per-provider media plumbing.
// Size and character caps keep prompts sane; when the text is truncated, the text SAYS so - the
// model must never believe it saw the whole file when it did not.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { ChatMediaPart } from '../../shared/ipc';

export interface AttachmentText {
  name: string;
  bytes: number;
  /** Characters extracted BEFORE the cap - the honest size of what the file contained. */
  chars: number;
  /** The text handed to the model (capped; carries an explicit truncation note when cut). */
  text: string;
  truncated: boolean;
  /** Native bytes for vision-capable providers (pdf <= 8 MB, image <= 5 MB); absent otherwise. */
  media?: ChatMediaPart;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENT_CHARS = 120_000;
// Native-media caps: Anthropic's image limit is 5 MB; PDFs stay comfortably inside request limits.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_NATIVE_PDF_BYTES = 8 * 1024 * 1024;
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
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
  const name = basename(filePath);

  // Images: no text layer to extract - the model must SEE them. Vision-capable providers get the
  // bytes; others get an honest can't-view note (never a fabricated description).
  const imageMime = IMAGE_MIMES[ext];
  if (imageMime) {
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image is too large (${Math.round(info.size / (1024 * 1024))} MB; the limit is 5 MB). Resize or crop it first.`);
    }
    const data = await readFile(filePath);
    return {
      name,
      bytes: info.size,
      chars: 0,
      text: '',
      truncated: false,
      media: {
        kind: 'image',
        mimeType: imageMime,
        base64: data.toString('base64'),
        name,
        fallbackText: `[Image attached: "${name}". The active provider/model cannot view images - switch to a vision-capable one (e.g. Claude, GPT-4o, Gemini).]`,
      },
    };
  }

  let raw: string;
  if (TEXT_EXTS.has(ext)) raw = await readFile(filePath, 'utf8');
  else if (ext === '.xlsx') raw = await readXlsx(filePath);
  // A scanned PDF has no text layer; that is only fatal when it ALSO can't ride natively.
  else if (ext === '.pdf') raw = await readPdf(filePath).catch(() => '');
  else if (ext === '.docx') raw = await readDocx(filePath);
  else if (ext === '.doc') raw = await readDoc(filePath);
  else throw new Error(`Unsupported file type "${ext || '(no extension)'}". Supported: pdf, docx, doc, xlsx, csv, tsv, txt, md, json, log, html, xml, yaml, png, jpg, webp, gif.`);
  raw = raw.replace(/\u0000/g, '').trim();
  const nativePdf = ext === '.pdf' && info.size <= MAX_NATIVE_PDF_BYTES;
  if (!raw && !nativePdf) throw new Error('No readable text found in this file.');
  const truncated = raw.length > MAX_ATTACHMENT_CHARS;
  const text = truncated
    ? `${raw.slice(0, MAX_ATTACHMENT_CHARS)}\n\n[Attachment truncated: showing the first ${MAX_ATTACHMENT_CHARS.toLocaleString('en-US')} of ${raw.length.toLocaleString('en-US')} characters.]`
    : raw;
  let media: ChatMediaPart | undefined;
  if (nativePdf) {
    const data = await readFile(filePath);
    media = {
      kind: 'pdf',
      mimeType: 'application/pdf',
      base64: data.toString('base64'),
      name,
      fallbackText: text || `[Scanned PDF "${name}": it has no text layer, and the active provider/model cannot view documents natively - switch to Claude or Gemini, or attach a text-based export.]`,
    };
  }
  return { name, bytes: info.size, chars: raw.length, text, truncated, media };
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

/** .docx -> text with TABLES kept in table format: mammoth's HTML keeps <table> structure
 *  (its markdown writer does not), and htmlTablesToText renders rows as "| a | b |" lines. */
async function readDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const res = await mammoth.convertToHtml({ path: filePath });
  const asText = htmlTablesToText(res.value ?? '');
  if (asText.trim()) return asText;
  const rawRes = await mammoth.extractRawText({ path: filePath });
  return rawRes.value ?? '';
}

/** Minimal deterministic HTML -> text: table cells become "| a | b |" pipe rows, list items get a
 *  dash, block ends get newlines, all other tags are stripped, basic entities decoded. PURE. */
export function htmlTablesToText(html: string): string {
  // Cells first: mammoth wraps each cell's text in <p>, so flatten a cell's ENTIRE inner html to
  // one line before the row/block handling (otherwise every cell would break its row).
  const withCells = html.replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => ` ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()} |`);
  return withCells
    .replace(/<tr[^>]*>/gi, '| ')
    .replace(/<\/(tr|p|h[1-6]|li|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\|/g, ' |')
    .replace(/\|[ \t]{2,}/g, '| ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
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
