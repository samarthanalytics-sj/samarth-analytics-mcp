// Native Excel (.xlsx) export of the Tag Suggestions structure — the same tag/trigger/parameter grid the
// CSV export produces, but as a real spreadsheet (bold frozen header, per-column widths, autofilter).
// Main-process only (uses exceljs + returns a Buffer); imported lazily by the suggestions:exportXlsx IPC.
// Rows are built in the renderer via shared/tag-template suggestionsToTemplateRows so Excel never drifts
// from the CSV.

import ExcelJS from 'exceljs';

// Sensible widths per known column header; anything else gets a default.
const WIDTHS: Record<string, number> = {
  'Page': 22,
  'Tag Type': 16,
  'GTM Tag Name': 40,
  'GA4 Event Name': 26,
  'Parameters': 20,
  'Parameter Variable': 24,
  'Trigger Name': 28,
  'Trigger Type': 18,
  'Trigger when - Variable': 22,
  'Trigger when - Condition': 22,
  'Trigger when - Value': 40,
};

/** Build a self-contained .xlsx workbook from a header row + pre-built string rows. */
export async function buildSuggestionsXlsx(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Samarth Analytics';
  const ws = wb.addWorksheet('GA4 Tag Suggestions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h) => ({ header: h, width: WIDTHS[h] ?? 18 }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  for (const r of rows) {
    const excelRow = ws.addRow(r);
    excelRow.alignment = { vertical: 'top', wrapText: true };
  }
  if (headers.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }
  // Strip em/en dashes at the export boundary (house rule), same as the other .xlsx exports.
  const { plainDashesWorkbook } = await import('../google/server-doc-xlsx');
  plainDashesWorkbook(wb);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
