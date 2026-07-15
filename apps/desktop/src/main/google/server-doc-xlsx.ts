// Native Excel (.xlsx) export of the SERVER container documentation - a multi-sheet workbook
// mirroring the Markdown/CSV doc: Overview, Clients, Tags (destination + firing triggers +
// referenced variables), Triggers, Variables, Transformations. Same redaction rule: secret-shaped
// values are NEVER written. Main-process only (exceljs); imported lazily by gtm:exportServerDoc.

import ExcelJS from 'exceljs';
import type { AuditTag, ServerContainerSnapshot } from './gtm-builders';
import { tagDestination, referencedVars, hasSecret, triggerCondition, type ServerDocMeta } from './server-doc';

const HEADER_FILL = 'FFEEF2F8';

function sheetWithHeader(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width: number }>): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

export async function buildServerDocXlsx(s: ServerContainerSnapshot, meta: ServerDocMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const firesOn = (t: AuditTag): string =>
    (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join(', ') || '(none - never fires)';

  const ov = wb.addWorksheet('Overview');
  ov.columns = [{ width: 28 }, { width: 70 }];
  const kv = (k: string, v: string): void => {
    const row = ov.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  };
  kv('Container', `${meta.containerName}${meta.publicId ? ` (${meta.publicId})` : ''}`);
  if (meta.workspaceName) kv('Workspace', meta.workspaceName);
  if (meta.generatedAt) kv('Generated', meta.generatedAt);
  kv('Tagging server URL(s)', s.taggingServerUrls.length ? s.taggingServerUrls.join(', ') : '(not set - host not wired yet)');
  kv('Clients', String(s.clients.length));
  kv('Tags', String(s.tags.length));
  kv('Triggers', String((s.triggers ?? []).length));
  kv('Variables', String((s.variables ?? []).length));
  kv('Transformations', String(s.transformations.length));
  kv('Note', 'Configuration-level documentation from the GTM API (no runtime data). Credential values are never included.');

  const clients = sheetWithHeader(wb, 'Clients', [
    { header: 'Client', key: 'name', width: 40 },
    { header: 'Type', key: 'type', width: 24 },
  ]);
  for (const c of s.clients) clients.addRow({ name: c.name, type: c.type });

  const tags = sheetWithHeader(wb, 'Tags', [
    { header: 'Tag', key: 'name', width: 44 },
    { header: 'Type', key: 'type', width: 18 },
    { header: 'Destination', key: 'dest', width: 26 },
    { header: 'Fires on', key: 'fires', width: 34 },
    { header: 'Uses variables', key: 'vars', width: 40 },
    { header: 'Notes', key: 'notes', width: 36 },
  ]);
  for (const t of s.tags) {
    tags.addRow({
      name: t.name,
      type: t.type,
      dest: tagDestination(t),
      fires: firesOn(t),
      vars: referencedVars(t).join(', '),
      notes: [t.paused ? 'PAUSED' : '', hasSecret(t) ? 'credential configured (value not shown)' : ''].filter(Boolean).join('; '),
    });
  }

  const triggers = sheetWithHeader(wb, 'Triggers', [
    { header: 'Trigger', key: 'name', width: 40 },
    { header: 'Type', key: 'type', width: 20 },
    { header: 'Condition', key: 'cond', width: 56 },
  ]);
  for (const tr of s.triggers ?? []) triggers.addRow({ name: tr.name, type: tr.type, cond: triggerCondition(tr) });

  const vars = sheetWithHeader(wb, 'Variables', [
    { header: 'Variable', key: 'name', width: 44 },
    { header: 'Type', key: 'type', width: 20 },
  ]);
  for (const v of s.variables ?? []) vars.addRow({ name: v.name, type: v.type });

  const xf = sheetWithHeader(wb, 'Transformations', [
    { header: 'Transformation', key: 'name', width: 44 },
    { header: 'Type', key: 'type', width: 24 },
  ]);
  for (const x of s.transformations) xf.addRow({ name: x.name, type: x.type });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
