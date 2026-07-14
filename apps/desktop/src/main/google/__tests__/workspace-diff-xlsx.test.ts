// Structural test for the Workspace Comparison .xlsx export: build the workbook, read it back with exceljs,
// and assert the sheets / headers / row counts / the full (untruncated) config values. Run:
// tsx src/main/google/__tests__/workspace-diff-xlsx.test.ts
import ExcelJS from 'exceljs';
import { buildWorkspaceDiffXlsx } from '../workspace-diff-xlsx';
import type { WorkspaceCompareResultView, WsEntityKind } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const zeroByKind = (): Record<WsEntityKind, { total: number; common: number; unique: number }> => ({
  tag: { total: 2, common: 2, unique: 0 },
  trigger: { total: 1, common: 0, unique: 1 },
  variable: { total: 0, common: 0, unique: 0 },
  folder: { total: 0, common: 0, unique: 0 },
});
const sumByKind = (): WorkspaceCompareResultView['pairs'][number]['summary']['byKind'] => ({
  tag: { added: 1, removed: 0, changed: 1, unchanged: 1 },
  trigger: { added: 0, removed: 1, changed: 0, unchanged: 0 },
  variable: { added: 0, removed: 0, changed: 0, unchanged: 0 },
  folder: { added: 0, removed: 0, changed: 0, unchanged: 0 },
});

const result: WorkspaceCompareResultView = {
  containerId: 'GTM-XXXX',
  baseWorkspaceId: 'ws1',
  workspaces: [
    { workspaceId: 'ws1', name: 'Default Workspace', counts: { tag: 2, trigger: 1, variable: 0, folder: 0 } },
    { workspaceId: 'ws2', name: 'Experiment', counts: { tag: 2, trigger: 0, variable: 0, folder: 0 } },
  ],
  headline: '“Experiment” vs “Default Workspace”: 1 changed, 1 added, 1 removed.',
  consolidated: {
    stats: { workspaces: 2, totalEntities: 3, common: 2, unique: 1, mergeable: 1, conflicts: 0, missing: 1, byKind: zeroByKind() },
    common: [
      { kind: 'tag', name: 'GA4 Config', type: 'gaawc', presentIn: ['Default Workspace', 'Experiment'], missingFrom: [], common: true, identical: true, variants: 1, differingFields: [], mergeStatus: 'safe', suggestedAction: 'none', notes: 'Identical in all 2 workspaces — safe to merge.', perWorkspace: { ws1: { type: 'gaawc' }, ws2: { type: 'gaawc' } } },
      { kind: 'tag', name: 'Phone Click', type: 'gaawe', presentIn: ['Default Workspace', 'Experiment'], missingFrom: [], common: true, identical: false, variants: 2, differingFields: ['param:eventName'], mergeStatus: 'review', suggestedAction: 'review', notes: 'Differs in param:eventName (2 versions) — review before merging.', perWorkspace: { ws1: { 'param:eventName': 'phone_click' }, ws2: { 'param:eventName': 'call_click_LONG_VALUE_that_would_be_truncated_in_the_pdf_but_not_here' } } },
    ],
    uncommon: [
      { kind: 'trigger', name: 'Newsletter Submit', type: 'customEvent', presentIn: ['Default Workspace'], missingFrom: ['Experiment'], common: false, identical: true, variants: 1, differingFields: [], mergeStatus: 'safe', suggestedAction: 'copy', notes: 'In Default Workspace; missing from Experiment.', perWorkspace: { ws1: { type: 'customEvent' }, ws2: null } },
    ],
  },
  pairs: [
    {
      aWorkspaceId: 'ws1', aName: 'Default Workspace', bWorkspaceId: 'ws2', bName: 'Experiment',
      summary: { added: 1, removed: 1, changed: 1, unchanged: 1, byKind: sumByKind() },
      entities: [
        { kind: 'tag', name: 'Phone Click', status: 'changed', changes: [{ field: 'param:eventName', a: 'phone_click', b: 'call_click_LONG_VALUE_that_would_be_truncated_in_the_pdf_but_not_here' }] },
        { kind: 'tag', name: 'Only In Experiment', status: 'added' },
        { kind: 'trigger', name: 'Newsletter Submit', status: 'removed' },
        { kind: 'tag', name: 'GA4 Config', status: 'unchanged' },
      ],
    },
  ],
};

(async () => {
  const buf = await buildWorkspaceDiffXlsx(result);
  check('produces a valid .xlsx (PK zip header)', buf.length > 2000 && buf.slice(0, 2).toString('latin1') === 'PK');

  const wb = new ExcelJS.Workbook();
  // Buffer<ArrayBufferLike> → the Buffer<ArrayBuffer> exceljs's .load() is typed for (node Buffer-generic
  // variance quirk); the bytes are identical, so a through-unknown cast is safe here.
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const names = wb.worksheets.map((w) => w.name);
  check('four sheets in order', names.join(' | ') === 'Summary | Common items | Uncommon items | Detailed diff', names.join(' | '));

  // Common sheet — a column per workspace + merge status; 2 data rows.
  const cs = wb.getWorksheet('Common items')!;
  const chead = (cs.getRow(1).values as unknown[]).slice(1).map(String);
  check('common: header has both workspace columns', chead.includes('Default Workspace') && chead.includes('Experiment'));
  check('common: header has Merge status + Differing fields', chead.includes('Merge status') && chead.includes('Differing fields'));
  check('common: one row per common entity (+header)', cs.rowCount === 3, `rowCount=${cs.rowCount}`);
  const identicalRow = (cs.getRow(2).values as unknown[]).map((v) => String(v ?? ''));
  check('common: identical entity marked "✓ same" per workspace', identicalRow.filter((v) => v === '✓ same').length === 2);

  // Uncommon sheet — present/missing + suggested action; 1 data row.
  const us = wb.getWorksheet('Uncommon items')!;
  const uhead = (us.getRow(1).values as unknown[]).slice(1).map(String);
  check('uncommon: header has Present in / Missing from / Suggested action', uhead.includes('Present in') && uhead.includes('Missing from') && uhead.includes('Suggested action'));
  check('uncommon: one row per uncommon entity (+header)', us.rowCount === 2, `rowCount=${us.rowCount}`);
  check('uncommon: suggested action is "Copy to missing"', (us.getRow(2).values as unknown[]).map(String).some((v) => v === 'Copy to missing'));

  // Detailed diff — one row per field change/add/remove (header + 1 changed + 1 added + 1 removed = 4).
  const ds = wb.getWorksheet('Detailed diff')!;
  check('detailed: header + 3 diff rows (changed/added/removed)', ds.rowCount === 4, `rowCount=${ds.rowCount}`);
  const allCells = (): string[] => { const out: string[] = []; ds.eachRow((row) => (row.values as unknown[]).forEach((v) => out.push(String(v ?? '')))); return out; };
  const cells = allCells();
  check('detailed: full (untruncated) config value present', cells.some((v) => v === 'call_click_LONG_VALUE_that_would_be_truncated_in_the_pdf_but_not_here'));
  check('detailed: shows the ADDED/REMOVED statuses', cells.includes('ADDED') && cells.includes('REMOVED') && cells.includes('CHANGED'));

  // Summary — the headline + a stat value are present somewhere on the sheet.
  const ss = wb.getWorksheet('Summary')!;
  const sCells: string[] = []; ss.eachRow((row) => (row.values as unknown[]).forEach((v) => sCells.push(String(v ?? ''))));
  check('summary: carries the headline', sCells.some((v) => v.includes('1 changed, 1 added, 1 removed')));
  check('summary: lists a workspace with its BASE role', sCells.includes('Default Workspace') && sCells.includes('BASE'));

  console.log(`\nworkspace-diff-xlsx: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
})();
