// Native Excel (.xlsx) export of the Tag Suggestions structure — the same tag/trigger/parameter grid the
// CSV export produces, but as a real spreadsheet (bold frozen header, per-column widths, autofilter).
// Main-process only (uses exceljs + returns a Buffer); imported lazily by the suggestions:exportXlsx IPC.
// Rows are built in the renderer via shared/tag-template suggestionsToTemplateRows so Excel never drifts
// from the CSV.

import ExcelJS from 'exceljs';
import type { SuggestedTagView } from '../../shared/ipc';
import { suggestionToGroup, triggerConditionText } from '../../shared/tag-template';

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

// ---------------------------------------------------------------------------
// Proof variant: one row PER suggested tag with its locate-only proof screenshot embedded in the Proof
// cell. This is the one download format that can show the located control INSIDE the spreadsheet (the CSV
// and the tabular xlsx above can't hold images). Kept separate from buildSuggestionsXlsx so the plain
// tabular export (block layout + autofilter, shared with the CSV) is untouched.
// ---------------------------------------------------------------------------

// Only genuine base64 image data-URIs are embedded (never a remote URL / markup). exceljs supports
// jpeg/png/gif; our proofs are JPEG. Anything else is noted in text rather than embedded.
const IMG_DATA_URI = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;

/** One proof-export row: the (edit-applied) suggestion + its proof screenshot data-URI, if one was captured. */
export interface SuggestionProofRow {
  tag: SuggestedTagView;
  screenshot?: string;
}

const PROOF_COLUMNS = [
  { header: 'Tag Type', key: 'tagType', width: 20 },
  { header: 'GTM Tag Name', key: 'tagName', width: 44 },
  { header: 'GA4 Event Name', key: 'eventName', width: 24 },
  { header: 'Trigger Name', key: 'triggerName', width: 30 },
  { header: 'Trigger Type', key: 'triggerType', width: 18 },
  { header: 'Trigger Condition', key: 'condition', width: 40 },
  { header: 'Parameters', key: 'params', width: 40 },
  { header: 'Page', key: 'page', width: 34 },
  { header: 'Proof', key: 'proof', width: 28 },
] as const;

// 0-based column index of the Proof column (the last one), where the image is anchored.
const PROOF_COL = PROOF_COLUMNS.length - 1;

/** Build a self-contained .xlsx workbook of the tag suggestions with proof images embedded per row. */
export async function buildSuggestionsProofsXlsx(rows: SuggestionProofRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Samarth Analytics';
  const ws = wb.addWorksheet('GA4 tag suggestions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = PROOF_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };

  rows.forEach((r, i) => {
    const s = r.tag;
    const g = suggestionToGroup(s);
    const params = g.params
      .filter((p) => p.name)
      .map((p) => `${p.name} = ${p.variable}`)
      .join('\n');
    const rowNum = i + 2; // 1-based; row 1 is the header
    const excelRow = ws.addRow({
      tagType: g.tagType,
      tagName: g.tagName,
      eventName: g.eventName,
      triggerName: g.triggerName,
      triggerType: g.triggerType,
      condition: triggerConditionText(s),
      params,
      page: s.page ?? '',
      proof: r.screenshot ? '' : '—',
    });
    excelRow.alignment = { vertical: 'top', wrapText: true };

    const m = r.screenshot ? IMG_DATA_URI.exec(r.screenshot) : null;
    if (m) {
      const raw = m[1] === 'jpg' ? 'jpeg' : m[1];
      if (raw === 'jpeg' || raw === 'png' || raw === 'gif') {
        const imageId = wb.addImage({ base64: m[2].replace(/\s+/g, ''), extension: raw });
        // Anchor the image into the Proof cell at this row (both 0-based). Sized to the cell.
        ws.addImage(imageId, { tl: { col: PROOF_COL, row: rowNum - 1 }, ext: { width: 184, height: 108 } });
        excelRow.height = 86; // points (~115px) so the 108px image fits with a little padding
      } else {
        excelRow.getCell('proof').value = 'captured (unsupported image type)';
      }
    }
  });

  const { plainDashesWorkbook } = await import('../google/server-doc-xlsx');
  plainDashesWorkbook(wb);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
