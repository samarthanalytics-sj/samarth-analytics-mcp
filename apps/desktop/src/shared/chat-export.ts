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

/** Whether a reply earns the export bar: it has at least one table, or enough prose to be a document.
 *  Short conversational answers ("Done - the tag was created.") stay bar-free. */
export function replyLooksExportable(md: string): boolean {
  const text = (md ?? '').trim();
  if (!text) return false;
  return extractReplyTables(text).length > 0 || text.length >= 500;
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
