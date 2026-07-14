// Native Excel (.xlsx) export of the Workspace Comparison — a multi-sheet workbook mirroring the on-screen
// report: Summary (dashboard + workspaces + per-kind), Common items (one column per workspace + merge
// status), Uncommon items (present/missing + suggested action), and a Detailed diff (base-vs-each, one row
// per field change with the FULL before/after values — no truncation, unlike the PDF). Main-process only
// (uses exceljs + returns a Buffer); imported lazily by the gtm:exportWorkspaceDiffXlsx IPC.

import ExcelJS from 'exceljs';
import type { WorkspaceCompareResultView, ConsolidatedEntityView, MergeStatus, WsEntityKind } from '../../shared/ipc';

const KIND_LABEL: Record<WsEntityKind, string> = { tag: 'Tag', trigger: 'Trigger', variable: 'Variable', builtInVariable: 'Built-in var', folder: 'Folder' };
const MERGE_LABEL: Record<MergeStatus, string> = { safe: 'Safe to merge', review: 'Review required', conflict: 'Cannot merge' };
// ARGB fills/fonts (print-safe) for the merge-status + diff-status cells.
const MERGE_FILL: Record<MergeStatus, string> = { safe: 'FFDCFCE7', review: 'FFFEF3C7', conflict: 'FFFEE2E2' };
const MERGE_FONT: Record<MergeStatus, string> = { safe: 'FF166534', review: 'FFA16207', conflict: 'FFB91C1C' };
const STATUS_FILL: Record<string, string> = { ADDED: 'FFDCFCE7', REMOVED: 'FFFEE2E2', CHANGED: 'FFFEF3C7' };
const STATUS_FONT: Record<string, string> = { ADDED: 'FF166534', REMOVED: 'FFB91C1C', CHANGED: 'FFA16207' };

const HEADER_FILL = 'FFEEF2F8';

// Per-entity variant number per workspace (1,2,3…; 0 = missing). Identical everywhere → all 1. Mirrors the
// on-screen "v1 / v2" markers so the Common sheet shows which workspaces agree.
function variantIndex(e: ConsolidatedEntityView, workspaces: WorkspaceCompareResultView['workspaces']): Record<string, number> {
  const seen = new Map<string, number>();
  const out: Record<string, number> = {};
  for (const w of workspaces) {
    const f = e.perWorkspace[w.workspaceId];
    const key = f ? JSON.stringify(Object.entries(f).sort()) : '';
    if (f && !seen.has(key)) seen.set(key, seen.size + 1);
    out[w.workspaceId] = f ? seen.get(key)! : 0;
  }
  return out;
}

/** Style row 1 of a worksheet as a bold, filled, frozen header. */
function styleHeader(ws: ExcelJS.Worksheet): void {
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function buildSummarySheet(wb: ExcelJS.Workbook, r: WorkspaceCompareResultView): void {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 22 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }];
  const title = ws.addRow(['Workspace Comparison']);
  title.font = { bold: true, size: 16 };
  ws.addRow([`Container: ${r.containerId}`]);
  ws.addRow([r.headline]);
  ws.addRow([]);

  // Dashboard stats.
  const s = r.consolidated.stats;
  const sh = ws.addRow(['Metric', 'Value']);
  sh.font = { bold: true };
  ([
    ['Workspaces', s.workspaces],
    ['Total items', s.totalEntities],
    ['Common (in all)', s.common],
    ['Unique (missing from some)', s.unique],
    ['Mergeable (identical common)', s.mergeable],
    ['Conflicts', s.conflicts],
    ['Missing item placements', s.missing],
  ] as Array<[string, number]>).forEach(([k, v]) => ws.addRow([k, v]));
  ws.addRow([]);

  // Per-kind breakdown.
  const kh = ws.addRow(['Type', 'Total', 'Common', 'Unique']);
  kh.font = { bold: true };
  (['tag', 'trigger', 'variable', 'builtInVariable', 'folder'] as WsEntityKind[]).forEach((k) => {
    const b = s.byKind[k];
    ws.addRow([KIND_LABEL[k], b.total, b.common, b.unique]);
  });
  ws.addRow([]);

  // Workspaces compared.
  const wh = ws.addRow(['Workspace', 'Role', 'Tags', 'Triggers', 'Variables', 'Built-in', 'Folders']);
  wh.font = { bold: true };
  for (const w of r.workspaces) {
    ws.addRow([w.name, w.workspaceId === r.baseWorkspaceId ? 'BASE' : 'compared', w.counts.tag, w.counts.trigger, w.counts.variable, w.counts.builtInVariable, w.counts.folder]);
  }
  ws.addRow([]);
  ws.addRow(['Note: GTM has no per-workspace permissions or files — access is account/container-level and identical for every workspace. This compares configuration entities.']);
}

function buildCommonSheet(wb: ExcelJS.Workbook, r: WorkspaceCompareResultView): void {
  const ws = wb.addWorksheet('Common items');
  const wsNames = r.workspaces.map((w) => w.name);
  const header = ['Type', 'Name', ...wsNames, 'Merge status', 'Differing fields', 'Notes'];
  ws.columns = header.map((_h, i) => ({ width: i === 1 ? 40 : i >= 2 && i < 2 + wsNames.length ? 14 : i === header.length - 1 ? 46 : 18 }));
  ws.addRow(header);
  const mergeCol = 2 + wsNames.length + 1; // 1-based column index of "Merge status"
  for (const e of r.consolidated.common) {
    const vi = variantIndex(e, r.workspaces);
    const cells = r.workspaces.map((w) => (e.identical ? '✓ same' : `v${vi[w.workspaceId]}`));
    const row = ws.addRow([KIND_LABEL[e.kind], e.name, ...cells, MERGE_LABEL[e.mergeStatus], e.differingFields.join(', '), e.notes]);
    const mc = row.getCell(mergeCol);
    mc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MERGE_FILL[e.mergeStatus] } };
    mc.font = { color: { argb: MERGE_FONT[e.mergeStatus] }, bold: true };
  }
  styleHeader(ws);
}

function buildUncommonSheet(wb: ExcelJS.Workbook, r: WorkspaceCompareResultView): void {
  const ws = wb.addWorksheet('Uncommon items');
  ws.columns = [
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Name', key: 'name', width: 40 },
    { header: 'Present in', key: 'present', width: 30 },
    { header: 'Missing from', key: 'missing', width: 30 },
    { header: 'Suggested action', key: 'action', width: 18 },
    { header: 'Notes', key: 'notes', width: 46 },
  ];
  for (const e of r.consolidated.uncommon) {
    ws.addRow({
      type: KIND_LABEL[e.kind],
      name: e.name,
      present: e.presentIn.join(', '),
      missing: e.missingFrom.join(', '),
      action: e.suggestedAction === 'copy' ? 'Copy to missing' : e.suggestedAction,
      notes: e.notes,
    });
  }
  styleHeader(ws);
}

function buildDetailedSheet(wb: ExcelJS.Workbook, r: WorkspaceCompareResultView): void {
  const ws = wb.addWorksheet('Detailed diff');
  ws.columns = [
    { header: 'Comparison', key: 'pair', width: 34 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Name', key: 'name', width: 38 },
    { header: 'Field', key: 'field', width: 26 },
    { header: 'Base value', key: 'a', width: 44 },
    { header: 'Compared value', key: 'b', width: 44 },
  ];
  const statusCol = 2;
  const paint = (row: ExcelJS.Row, status: string): void => {
    const c = row.getCell(statusCol);
    if (STATUS_FILL[status]) {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[status] } };
      c.font = { color: { argb: STATUS_FONT[status] }, bold: true };
    }
  };
  for (const p of r.pairs) {
    const pair = `${p.bName} vs ${p.aName} (base)`;
    for (const e of p.entities) {
      if (e.status === 'unchanged') continue;
      if (e.status === 'changed' && e.changes?.length) {
        for (const ch of e.changes) {
          paint(ws.addRow({ pair, status: 'CHANGED', type: KIND_LABEL[e.kind], name: e.name, field: ch.field, a: ch.a ?? '(none)', b: ch.b ?? '(none)' }), 'CHANGED');
        }
      } else if (e.status === 'added') {
        paint(ws.addRow({ pair, status: 'ADDED', type: KIND_LABEL[e.kind], name: e.name, field: '', a: '(none)', b: `only in ${p.bName}` }), 'ADDED');
      } else if (e.status === 'removed') {
        paint(ws.addRow({ pair, status: 'REMOVED', type: KIND_LABEL[e.kind], name: e.name, field: '', a: `only in ${p.aName} (base)`, b: '(none)' }), 'REMOVED');
      }
    }
  }
  styleHeader(ws);
}

// One row per dependency edge, grouped by workspace, with broken edges flagged — the "what breaks a merge"
// sheet. Missing rows are painted red so they stand out.
function buildDependenciesSheet(wb: ExcelJS.Workbook, r: WorkspaceCompareResultView): void {
  const ws = wb.addWorksheet('Dependencies');
  ws.columns = [
    { header: 'Workspace', key: 'ws', width: 22 },
    { header: 'Entity type', key: 'ek', width: 12 },
    { header: 'Entity', key: 'en', width: 34 },
    { header: 'Depends on', key: 'dk', width: 14 },
    { header: 'Dependency', key: 'dn', width: 34 },
    { header: 'Status', key: 'st', width: 12 },
  ];
  for (const w of r.dependencies) {
    for (const e of w.entities) {
      for (const d of e.dependsOn) {
        const status = d.present ? 'OK' : 'MISSING';
        const row = ws.addRow({ ws: w.name, ek: KIND_LABEL[e.kind], en: e.name, dk: d.kind === 'builtInVariable' ? 'Built-in' : d.kind === 'trigger' ? 'Trigger' : 'Variable', dn: d.name, st: status });
        if (!d.present) {
          const c = row.getCell(6);
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          c.font = { color: { argb: 'FFB91C1C' }, bold: true };
        }
      }
    }
  }
  if (r.missingDependencies.length) {
    ws.addRow([]);
    const h = ws.addRow(['Cross-workspace gaps (present somewhere, missing where the entity was copied)']);
    h.font = { bold: true };
    ws.addRow(['Entity', 'Needs', 'Present in', 'Missing in']).font = { bold: true };
    for (const m of r.missingDependencies) {
      ws.addRow([`${KIND_LABEL[m.entity.kind]}: ${m.entity.name}`, `${m.dependency.kind === 'builtInVariable' ? 'Built-in' : m.dependency.kind}: ${m.dependency.name}`, m.presentIn.join(', '), m.missingIn.join(', ')]);
    }
  }
  styleHeader(ws);
}

/** Build a self-contained .xlsx workbook of the Workspace Comparison (Summary · Common · Uncommon ·
 *  Detailed diff · Dependencies). Consumes the same view the renderer already holds, so the export matches
 *  the screen. */
export async function buildWorkspaceDiffXlsx(result: WorkspaceCompareResultView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Samarth Analytics';
  buildSummarySheet(wb, result);
  buildCommonSheet(wb, result);
  buildUncommonSheet(wb, result);
  buildDetailedSheet(wb, result);
  buildDependenciesSheet(wb, result);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
