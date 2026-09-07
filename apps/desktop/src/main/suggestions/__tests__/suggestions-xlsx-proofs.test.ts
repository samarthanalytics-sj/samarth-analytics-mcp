// Structural test for the tag-SUGGESTIONS proof-embedded .xlsx export: build the workbook, read it back
// with exceljs, and assert the header, one row per suggestion, the embedded proof image, and the "no
// image" fallback. Run: tsx src/main/suggestions/__tests__/suggestions-xlsx-proofs.test.ts
import ExcelJS from 'exceljs';
import { buildSuggestionsProofsXlsx, type SuggestionProofRow } from '../suggestions-xlsx';
import type { SuggestedTagView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A valid 1×1 PNG so exceljs actually embeds an image (not just records text).
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const base = (over: Partial<SuggestedTagView>): SuggestedTagView => ({
  id: 'x', page: '/contact', label: 'l', evidence: 'e', confidence: 'high',
  enhancedMeasurementOverlap: false, platform: 'ga4_event', tagName: 'GA4 - Event - X Tag',
  measurementId: '{{GA4 Measurement ID}}', eventName: 'x_event',
  trigger: { name: 'X - Trigger', kind: 'form_submit' },
  ...over,
});

const rows: SuggestionProofRow[] = [
  {
    tag: base({
      id: 's1', tagName: 'GA4 - Event - Contact Form Tag', eventName: 'generate_lead',
      eventParameters: [{ name: 'form_id', value: '{{Form ID}}' }],
      trigger: { name: 'Contact Form - Submit', kind: 'form_submit', formIdValue: 'contact', formIdOperator: 'equals' },
    }),
    screenshot: PNG_1x1,
  },
  {
    // No screenshot → the Proof cell shows the "no image" placeholder.
    tag: base({ id: 's2', page: 'site-wide', tagName: 'GA4 - Event - Phone Click Tag', eventName: 'phone_click',
      trigger: { name: 'Phone Click', kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' } }),
  },
];

(async () => {
  const buf = await buildSuggestionsProofsXlsx(rows);
  check('produces a valid .xlsx (PK zip header)', buf.length > 2000 && buf.slice(0, 2).toString('latin1') === 'PK');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.getWorksheet('GA4 tag suggestions')!;
  check('single suggestions sheet', Boolean(ws), wb.worksheets.map((w) => w.name).join(' | '));

  const head = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  check('header has the key columns', head.includes('GTM Tag Name') && head.includes('Trigger Condition') && head.includes('Parameters') && head.includes('Proof'), head.join(' | '));
  check('header + one row per suggestion', ws.rowCount === 3, `rowCount=${ws.rowCount}`);

  // The row WITH a screenshot embeds exactly one image; the row without shows the dash placeholder.
  check('exactly one proof image embedded', ws.getImages().length === 1, `images=${ws.getImages().length}`);

  const proofColNum = head.indexOf('Proof') + 1; // 1-based column number
  const s2Proof = String(ws.getRow(3).getCell(proofColNum).value ?? '');
  // plainDashesWorkbook rewrites the em-dash placeholder to a plain hyphen at the export boundary.
  check('no-image row shows a plain-dash placeholder', s2Proof === '-' || s2Proof === '', `proof="${s2Proof}"`);

  // Content sanity: the condition + params text made it in.
  const cells: string[] = [];
  ws.eachRow((row) => (row.values as unknown[]).forEach((v) => cells.push(String(v ?? ''))));
  check('carries the form-id trigger condition', cells.some((v) => v.includes('{{Form ID}}') && v.includes('contact')));
  check('carries a parameter row', cells.some((v) => v.includes('form_id = {{Form ID}}')));
  check('carries the GTM tag name', cells.includes('GA4 - Event - Contact Form Tag'));

  console.log(`\nsuggestions-xlsx-proofs: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
})();
