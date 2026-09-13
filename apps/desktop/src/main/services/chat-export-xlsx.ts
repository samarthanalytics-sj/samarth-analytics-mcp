// Chat reply tables → a native .xlsx workbook (one worksheet per table, bold headers, sized columns).
// Main-process only (uses exceljs + returns a Buffer); imported lazily by the llm:exportReply IPC.

import ExcelJS from 'exceljs';
import { extractReplyTables, sheetNameFor } from '../../shared/chat-export';

/** Build the workbook buffer for a reply's tables. Throws when the reply has no tables — the
 *  renderer disables the button in that case, so this only guards a stale/forged invoke. */
export async function chatReplyXlsx(markdown: string): Promise<Buffer> {
  const tables = extractReplyTables(markdown);
  if (tables.length === 0) throw new Error('This reply has no tables to export as XLSX.');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Samarth Desktop';
  const used = new Set<string>();
  tables.forEach((t, i) => {
    // Sheet names must be unique too — suffix duplicates ("Findings", "Findings (2)", …).
    let name = sheetNameFor(t.title, i);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${sheetNameFor(t.title, i).slice(0, 25)} (${n})`;
    used.add(name.toLowerCase());

    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(t.header);
    ws.getRow(1).font = { bold: true };
    for (const r of t.rows) ws.addRow(t.header.map((_, j) => r[j] ?? ''));
    // Column widths from content (capped so one long cell doesn't produce an unusable sheet).
    t.header.forEach((h, j) => {
      const widest = Math.max(h.length, ...t.rows.map((r) => (r[j] ?? '').length));
      ws.getColumn(j + 1).width = Math.min(60, Math.max(10, widest + 2));
    });
  });

  const { plainDashesWorkbook } = await import('../google/server-doc-xlsx');
  plainDashesWorkbook(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
