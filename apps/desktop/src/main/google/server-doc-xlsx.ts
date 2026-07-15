// Native Excel (.xlsx) export of the SERVER container documentation - a multi-sheet workbook
// mirroring the Markdown/CSV doc: Overview, Clients, Tags (destination + firing triggers +
// referenced variables), Triggers, Variables, Transformations. Same redaction rule: secret-shaped
// values are NEVER written. Main-process only (exceljs); imported lazily by gtm:exportServerDoc.

import ExcelJS from 'exceljs';
import type { AuditReport, AuditTag, ServerContainerSnapshot } from './gtm-builders';
import { tagDestination, referencedVars, hasSecret, triggerCondition, buildDestinationRows, variableUsedBy, webLinkSummaryLines, type ServerDocMeta, type ServerDocExtras } from './server-doc';
import { configurationScore } from './server-coverage';

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

export async function buildServerDocXlsx(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport, extras?: ServerDocExtras): Promise<Buffer> {
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
  if (audit) kv('Configuration score', `${configurationScore(audit.summary)}/100 (100 - 25 per critical - 10 per high - 3 per medium - 1 per low)`);
  for (const l of extras?.coverage ? webLinkSummaryLines(extras.coverage) : []) kv('Web link', l);
  if (meta.liveVersionId) kv('Live version', `${meta.liveVersionId} (this document describes the workspace DRAFT, which may differ)`);
  kv('Note', 'Configuration-level documentation from the GTM API (no runtime data). Credential values are never included.');

  const issues = sheetWithHeader(wb, 'Issues', [
    { header: 'Severity', key: 'sev', width: 12 },
    { header: 'Where', key: 'where', width: 34 },
    { header: 'Issue', key: 'msg', width: 80 },
    { header: 'Fix', key: 'fix', width: 70 },
  ]);
  for (const f of audit?.findings ?? []) {
    issues.addRow({ sev: f.severity.toUpperCase(), where: f.resource ? `${f.resource.kind} "${f.resource.name}"` : 'container', msg: f.message, fix: f.recommendation });
  }

  const dests = sheetWithHeader(wb, 'Destinations', [
    { header: 'Destination', key: 'dest', width: 30 },
    { header: 'Tag type(s)', key: 'types', width: 24 },
    { header: 'Tags', key: 'tags', width: 8 },
    { header: 'Paused', key: 'paused', width: 8 },
  ]);
  for (const d of buildDestinationRows(s)) dests.addRow({ dest: d.destination, types: d.types, tags: d.tags, paused: d.paused || '' });

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
    { header: 'Used by', key: 'usedBy', width: 60 },
  ]);
  for (const v of s.variables ?? []) vars.addRow({ name: v.name, type: v.type, usedBy: variableUsedBy(s, v.name).join(', ') });

  const xf = sheetWithHeader(wb, 'Transformations', [
    { header: 'Transformation', key: 'name', width: 44 },
    { header: 'Type', key: 'type', width: 24 },
  ]);
  for (const x of s.transformations) xf.addRow({ name: x.name, type: x.type });

  if (extras?.versions?.length) {
    const vs = sheetWithHeader(wb, 'Versions', [
      { header: 'Version', key: 'id', width: 12 },
      { header: 'Name', key: 'name', width: 44 },
      { header: 'Tags', key: 'tags', width: 10 },
      { header: 'Triggers', key: 'triggers', width: 10 },
      { header: 'Variables', key: 'variables', width: 10 },
      { header: 'Notes', key: 'notes', width: 24 },
    ]);
    for (const v of extras.versions) {
      vs.addRow({ id: `#${v.versionId}`, name: v.name, tags: v.numTags, triggers: v.numTriggers, variables: v.numVariables, notes: [v.live ? 'LIVE' : '', v.deleted ? 'deleted' : ''].filter(Boolean).join(' / ') });
    }
  }

  plainDashesWorkbook(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** House style post-pass for EVERY xlsx export: no em/en dashes in any string cell,
 *  whatever the text's origin (engine messages, static labels, or entity names). */
export function plainDashesWorkbook(wb: ExcelJS.Workbook): void {
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === 'string' && /[\u2014\u2013]/.test(cell.value)) {
          cell.value = cell.value.replace(/[\u2014\u2013]/g, '-');
        }
      });
    });
  });
}
