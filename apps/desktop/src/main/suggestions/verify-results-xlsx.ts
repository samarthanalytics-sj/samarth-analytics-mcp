// Native Excel (.xlsx) export of the tag-verification results, with each tag's proof SCREENSHOT embedded
// into the Proof cell — the one export format that shows the image inside a spreadsheet (a CSV can't).
// Main-process only (uses exceljs + returns a Buffer); imported lazily by the verify:exportResults IPC.

import ExcelJS from 'exceljs';
import type { VerifyExportPayload } from '../../shared/ipc';

// Only genuine base64 image data-URIs are embedded (never a remote URL / markup). exceljs supports
// jpeg/png/gif; our proofs are JPEG. Anything else is noted in text rather than embedded.
const IMG_DATA_URI = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const COLUMNS: Array<{ header: string; key: keyof Row; width: number }> = [
  { header: 'Status', key: 'status', width: 12 },
  { header: 'Tag', key: 'tag', width: 46 },
  { header: 'Event', key: 'triggerEvent', width: 18 },
  { header: 'Fired via', key: 'firedVia', width: 12 },
  { header: 'Signal', key: 'signal', width: 24 },
  { header: 'Proof', key: 'proof', width: 27 },
];
type Row = { status: string; tag: string; triggerEvent: string; firedVia: string; signal: string; proof: string };

/** Build a self-contained .xlsx workbook of the verification results with proof images embedded. */
export async function buildVerifyResultsXlsx(payload: VerifyExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Samarth Analytics';
  const ws = wb.addWorksheet('Tag verification', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };

  const rows = payload.rows ?? [];
  rows.forEach((r, i) => {
    const rowNum = i + 2; // 1-based; row 1 is the header
    const excelRow = ws.addRow({
      status: r.status ?? '',
      tag: r.tag ?? '',
      triggerEvent: r.triggerEvent ?? '',
      firedVia: r.firedVia ?? '',
      signal: r.signal ?? '',
      proof: r.screenshot ? '' : '—',
    } as Row);
    excelRow.alignment = { vertical: 'middle', wrapText: true };

    const m = r.screenshot ? IMG_DATA_URI.exec(r.screenshot) : null;
    if (m) {
      const raw = m[1] === 'jpg' ? 'jpeg' : m[1];
      if (raw === 'jpeg' || raw === 'png' || raw === 'gif') {
        const imageId = wb.addImage({ base64: m[2].replace(/\s+/g, ''), extension: raw });
        // Anchor the image into the Proof cell (0-based col 5) at this row (0-based). Sized to the cell.
        ws.addImage(imageId, { tl: { col: 5, row: rowNum - 1 }, ext: { width: 184, height: 108 } });
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
