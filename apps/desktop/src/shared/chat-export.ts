// Chat reply → export builders (the "Export report" bar under long/tabular assistant replies).
// PURE + framework-free: table extraction from the chat's Markdown subset (GFM tables, # headings,
// **bold** title lines) and the CSV builder. The main-process IPC does file I/O / PDF / XLSX on top
// of these. House style: builder RETURNS carry plain hyphens, never em/en dashes (export boundary).

export interface ChatReplyTable {
  /** Nearest preceding heading / bold line, else "Table N" — used as the CSV block title / sheet name. */
  title: string;
  header: string[];
  rows: string[][];
}

const plainDashes = (s: string): string => s.replace(/[–—]/g, '-');

const isTableSep = (line: string): boolean => {
  const s = line.trim();
  // ASCII ---|--- plus the Unicode dash variants some models emit (same tolerance as the chat renderer).
  return s.length > 0 && /^[|\s:‐-―\-]+$/.test(s) && /[‐-―\-]/.test(s) && s.includes('|');
};

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Strip the inline markers the chat renders (**bold**, *italic*, `code`) so exported cells are plain text. */
function plainCell(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

/**
 * A fenced JSON array of objects, as a table.
 *
 * Asking for "export format" reliably produces a JSON array rather than a pipe table, and that was
 * the ONE shape the exporter could not read: it understood GFM tables only, so CSV and XLSX sat
 * disabled on the most structured data a reply can contain.
 *
 * Only an array converts. A bare object, a scalar, or anything unparseable returns null, because a
 * guess here becomes a spreadsheet someone works from.
 */
export function jsonBlockToTable(source: string): { header: string[]; rows: string[][] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null; // not JSON (a JS snippet, an HTML tag) - leave it as prose
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  // An array of scalars is still exportable, as one column.
  if (!parsed.some(isRecord)) {
    return { header: ['value'], rows: parsed.map((v) => [cellText(v)]) };
  }

  // Header = the UNION of keys in first-seen order. Using only the first row's keys would silently
  // drop columns that appear later, and sorting them would scramble the order the model chose.
  const header: string[] = [];
  for (const row of parsed) {
    if (!isRecord(row)) continue;
    for (const k of Object.keys(row)) if (!header.includes(k)) header.push(k);
  }
  if (header.length === 0) return null;

  const rows = parsed.map((row) =>
    // Index by KEY, not position, so a row missing a field gets an empty cell instead of shifting
    // every later value into the wrong column.
    header.map((k) => (isRecord(row) ? cellText(row[k]) : '')),
  );
  return { header, rows };
}

/** One JSON value as a cell. Nested structures are stringified rather than flattened or dropped:
 *  a visible {"a":1} tells the reader the shape was nested, an empty cell tells them nothing. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
/** All GFM tables in a chat reply, each titled by the closest preceding heading or standalone bold line. */
export function extractReplyTables(md: string): ChatReplyTable[] {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const tables: ChatReplyTable[] = [];
  let lastTitle = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (h) {
      lastTitle = plainCell(h[1]);
      i++;
      continue;
    }
    const b = /^\*\*([^*]+)\*\*:?\s*$/.exec(line.trim());
    if (b) {
      lastTitle = plainCell(b[1]).replace(/:$/, '');
      i++;
      continue;
    }
    // A fenced block. Only JSON arrays become tables; every other language (a JS snippet, an HTML
    // tag) is skipped WHOLE, so a stray pipe inside code can never be mistaken for a table row.
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // past the closing fence
      // An unlabelled fence is worth trying: models emit bare ``` around JSON as often as ```json.
      if (lang === '' || lang === 'json') {
        const t = jsonBlockToTable(body.join('\n'));
        if (t) {
          tables.push({ title: lastTitle || `Table ${tables.length + 1}`, header: t.header, rows: t.rows });
          lastTitle = '';
        }
      }
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line).map(plainCell);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]).map(plainCell));
        i++;
      }
      tables.push({ title: lastTitle || `Table ${tables.length + 1}`, header, rows });
      lastTitle = ''; // one title claims one table — the next table needs its own heading
      continue;
    }
    i++;
  }
  return tables;
}

/** Whether a reply has anything worth putting in a file: at least one table, or enough prose to be a
 *  document. Short conversational answers ("Done - the tag was created.") never earn a bar. This is
 *  only the CONTENT half of the gate - see shouldOfferExport for the half that matters. */
export function replyLooksExportable(md: string): boolean {
  const text = (md ?? '').trim();
  if (!text) return false;
  return extractReplyTables(text).length > 0 || text.length >= 500;
}

/** Asks that need no verb - naming a file type or "export"/"download" IS the request. */
const EXPORT_STRONG: RegExp[] = [
  /\b(export|exports|exporting|download|downloadable)\b/,
  /\bsave\s+(it|this|that|them|these|the\s+\w+)?\s*(as|to|in|into)\b/,
  /\b(csv|xlsx?|excel|spreadsheet|pdf|docx?|markdown|\.md)\b/,
  // "in a table", "as tabular", "table format", "in table form"
  /\b(in|as|into)\s+(a\s+|the\s+)?tab(le|ular)\b/,
  /\btabular\b/,
  /\btable\s+(format|form|view)\b/,
  /\b(in|as)\s+(a\s+|the\s+)?(report|sheet|document|deck)\b/,
  /\breport\s+(format|form)\b/,
];

/** Nouns that are only a request when someone actually asks for one. "The report says 3 tags" is a
 *  statement about a report; "give me a report" is an ask. Deliberately excludes "list" - asking to
 *  list things is the most common request in this app and would put a bar back on nearly everything. */
const EXPORT_WEAK = /\b(report|table|summary|summarise|summarize|breakdown|matrix|sheet|document|inventory)\b/g;

/** Verbs that turn a weak noun into a request. */
const REQUEST_VERB =
  /\b(give|show|make|create|generate|prepare|prep|build|draft|produce|provide|send|share|write|put|format|output|compile|need|want|get\s+me)\b/g;

/** How far before the noun a verb still reads as asking for it. */
const VERB_REACH = 40;

/** A weak noun counts only when a request verb comes BEFORE it and close by. Order is what separates
 *  "show me a report" (an ask) from "why does the report show 3 tags?" (a question about one), and
 *  the distance stops an unrelated verb earlier in a long message from claiming the noun. */
function weakAsk(text: string): boolean {
  const nouns = [...text.matchAll(EXPORT_WEAK)];
  if (nouns.length === 0) return false;
  const verbEnds = [...text.matchAll(REQUEST_VERB)].map((m) => (m.index ?? 0) + m[0].length);
  return nouns.some((n) => {
    const at = n.index ?? 0;
    return verbEnds.some((end) => end <= at && at - end <= VERB_REACH);
  });
}

/** A follow-up pointing back at what was just shown, rather than asking for something new. */
const BACK_REFERENCE = /\b(that|this|those|these|it|above|previous|earlier|last\s+(one|reply|answer|response)|same)\b/;

/** Whether a user message asks for something file-shaped: an export, a file type, a table, a report.
 *  Questions that merely mention one ("why does the report show 3 tags?") are not asks. */
export function asksForExport(userText: string): boolean {
  const text = (userText ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (EXPORT_STRONG.some((re) => re.test(text))) return true;
  return weakAsk(text);
}

/** Whether the export bar belongs under one assistant reply.
 *
 *  The bar shows only when the user ASKED - either in the message that produced this reply, or in a
 *  follow-up that points back at it ("download that as csv"), which is a request to export the reply
 *  above. A reply that merely happens to be long or tabular stays bar-free.
 *
 *  askBefore/askAfter are the neighbouring USER messages ('' when the neighbour is not one). */
export function shouldOfferExport(reply: string, askBefore: string, askAfter: string): boolean {
  if (!replyLooksExportable(reply)) return false;
  if (asksForExport(askBefore)) return true;
  // A forward ask ("now give me a table of the triggers") is for the NEXT reply, not this one.
  const after = (askAfter ?? '').toLowerCase();
  return asksForExport(after) && BACK_REFERENCE.test(after);
}

function csvCell(value: string): string {
  const v = value ?? '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Every table in the reply as one CSV: a title row, the header, the data rows, blank line between
 *  tables. Throws if the reply has no tables (the button is disabled in that case — never emit an
 *  empty file that pretends to be data). */
export function replyCsv(md: string): string {
  const tables = extractReplyTables(md);
  if (tables.length === 0) throw new Error('This reply has no tables to export as CSV.');
  const blocks = tables.map((t) => {
    const lines = [csvCell(t.title), t.header.map(csvCell).join(','), ...t.rows.map((r) => t.header.map((_, j) => csvCell(r[j] ?? '')).join(','))];
    return lines.join('\n');
  });
  return plainDashes(blocks.join('\n\n') + '\n');
}

/** Worksheet-safe name: Excel forbids []:*?/\ and caps names at 31 chars; blank → fallback. */
export function sheetNameFor(title: string, index: number): string {
  const cleaned = plainDashes(title).replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
  return cleaned || `Table ${index + 1}`;
}
