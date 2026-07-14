// Styled HTML for the Workspace Comparison PDF export — mirrors the on-screen diff: the base + compared
// workspaces with their counts, a per-pair summary, and a per-entity table (added / removed / changed) with
// the field-level changes. Pure string building (no I/O, no DOM) so it is unit-testable and safe in main.

import type { WorkspaceCompareResultView, PairwiseDiffView, EntityDiffView, WsEntityKind, ConsolidatedEntityView, MergeStatus } from './ipc';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Merge-status palette (print-safe).
const MERGE: Record<MergeStatus, { fg: string; bg: string; label: string }> = {
  safe: { fg: '#166534', bg: '#dcfce7', label: '✅ Safe to merge' },
  review: { fg: '#a16207', bg: '#fef3c7', label: '⚠ Review required' },
  conflict: { fg: '#b91c1c', bg: '#fee2e2', label: '❌ Cannot merge' },
};

function statTile(label: string, value: number, color = '#111827'): string {
  return `<div style="flex:1;min-width:110px;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;text-align:center"><div style="font-size:22px;font-weight:800;color:${color}">${value}</div><div style="font-size:11px;color:#6b7280;margin-top:2px">${esc(label)}</div></div>`;
}

function consolidatedHtml(r: WorkspaceCompareResultView): string {
  const c = r.consolidated;
  const s = c.stats;
  const dash =
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px">` +
    statTile('Workspaces', s.workspaces) +
    statTile('Total items', s.totalEntities) +
    statTile('Common', s.common, '#2563eb') +
    statTile('Unique', s.unique, '#a16207') +
    statTile('Mergeable', s.mergeable, '#166534') +
    statTile('Conflicts', s.conflicts, s.conflicts ? '#b91c1c' : '#111827') +
    statTile('Missing items', s.missing) +
    `</div>`;
  const wsCols = r.workspaces.map((w) => w.name);
  // Common table: one row per common entity, a cell per workspace (its variant #), merge status + notes.
  const variantIndex = (e: ConsolidatedEntityView): Record<string, number> => {
    const seen = new Map<string, number>();
    const out: Record<string, number> = {};
    for (const w of r.workspaces) {
      const f = e.perWorkspace[w.workspaceId];
      const key = f ? JSON.stringify(Object.entries(f).sort()) : '';
      if (!seen.has(key)) seen.set(key, seen.size + 1);
      out[w.workspaceId] = seen.get(key)!;
    }
    return out;
  };
  const commonRows = c.common
    .map((e) => {
      const m = MERGE[e.mergeStatus];
      const vi = variantIndex(e);
      const cells = r.workspaces
        .map((w) => {
          const v = vi[w.workspaceId];
          const same = e.identical;
          return `<td style="padding:5px 8px;text-align:center;color:${same ? '#166534' : v === 1 ? '#374151' : '#b45309'}">${same ? '✓ same' : `v${v}`}</td>`;
        })
        .join('');
      return (
        `<tr style="border-bottom:1px solid #eef2f7;page-break-inside:avoid">` +
        `<td style="padding:5px 8px;color:#6b7280;white-space:nowrap">${e.kind}</td>` +
        `<td style="padding:5px 8px;font-weight:600">${esc(e.name)}</td>` +
        cells +
        `<td style="padding:5px 8px;white-space:nowrap"><span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:${m.bg};color:${m.fg}">${m.label}</span></td>` +
        `<td style="padding:5px 8px;font-size:11px;color:#374151">${esc(e.notes)}</td>` +
        `</tr>`
      );
    })
    .join('');
  const uncommonRows = c.uncommon
    .map(
      (e) =>
        `<tr style="border-bottom:1px solid #eef2f7;page-break-inside:avoid">` +
        `<td style="padding:5px 8px;color:#6b7280;white-space:nowrap">${e.kind}</td>` +
        `<td style="padding:5px 8px;font-weight:600">${esc(e.name)}</td>` +
        `<td style="padding:5px 8px;color:#166534;font-size:11px">${esc(e.presentIn.join(', '))}</td>` +
        `<td style="padding:5px 8px;color:#b91c1c;font-size:11px">${esc(e.missingFrom.join(', '))}</td>` +
        `<td style="padding:5px 8px;white-space:nowrap"><span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:#dbeafe;color:#1d4ed8">Copy to missing</span></td>` +
        `</tr>`,
    )
    .join('');
  const th = (cols: string[]): string =>
    `<thead><tr style="background:#f8fafc;color:#6b7280">${cols.map((x) => `<th style="text-align:left;padding:6px 8px">${esc(x)}</th>`).join('')}</tr></thead>`;
  return (
    dash +
    (c.common.length
      ? `<div style="font-size:14px;font-weight:700;margin:14px 0 4px">Common items <span style="color:#9ca3af;font-weight:400">(in all ${s.workspaces} workspaces)</span></div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:12px">${th(['Type', 'Name', ...wsCols, 'Merge status', 'Notes'])}<tbody>${commonRows}</tbody></table>`
      : '') +
    (c.uncommon.length
      ? `<div style="font-size:14px;font-weight:700;margin:18px 0 4px">Uncommon items <span style="color:#9ca3af;font-weight:400">(missing from one or more workspaces)</span></div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:12px">${th(['Type', 'Name', 'Present in', 'Missing from', 'Suggested action'])}<tbody>${uncommonRows}</tbody></table>`
      : '')
  );
}

// Print-safe status palette.
const STATUS: Record<EntityDiffView['status'], { fg: string; bg: string; label: string }> = {
  added: { fg: '#166534', bg: '#dcfce7', label: 'ADDED' },
  removed: { fg: '#b91c1c', bg: '#fee2e2', label: 'REMOVED' },
  changed: { fg: '#a16207', bg: '#fef3c7', label: 'CHANGED' },
  unchanged: { fg: '#4b5563', bg: '#f3f4f6', label: 'UNCHANGED' },
};
const KIND_LABEL: Record<WsEntityKind, string> = { tag: 'Tag', trigger: 'Trigger', variable: 'Variable', folder: 'Folder' };

const pill = (st: EntityDiffView['status']): string => {
  const s = STATUS[st];
  return `<span style="display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 7px;border-radius:999px;background:${s.bg};color:${s.fg}">${s.label}</span>`;
};

const truncate = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function changesCell(e: EntityDiffView): string {
  if (e.status === 'added') return '<span style="color:#166534">only in this workspace</span>';
  if (e.status === 'removed') return '<span style="color:#b91c1c">only in the base</span>';
  if (e.status !== 'changed' || !e.changes?.length) return '<span style="color:#9ca3af">—</span>';
  return e.changes
    .map((c) => {
      const from = c.a === undefined ? '<i style="color:#9ca3af">(none)</i>' : esc(truncate(c.a));
      const to = c.b === undefined ? '<i style="color:#9ca3af">(none)</i>' : esc(truncate(c.b));
      return `<div style="margin:1px 0"><code style="color:#2563eb">${esc(c.field)}</code>: <span style="color:#b91c1c">${from}</span> → <span style="color:#166534">${to}</span></div>`;
    })
    .join('');
}

function pairSection(p: PairwiseDiffView): string {
  const s = p.summary;
  const changed = p.entities.filter((e) => e.status !== 'unchanged');
  const summaryLine =
    s.added + s.removed + s.changed === 0
      ? `<span style="color:#166534;font-weight:600">Identical — no differences.</span>`
      : `<b>${s.changed}</b> changed · <b>${s.added}</b> added · <b>${s.removed}</b> removed · ${s.unchanged} unchanged`;
  const rows = changed
    .map(
      (e) =>
        `<tr style="border-bottom:1px solid #eef2f7;page-break-inside:avoid">` +
        `<td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${pill(e.status)}</td>` +
        `<td style="padding:6px 8px;vertical-align:top;color:#6b7280;white-space:nowrap">${KIND_LABEL[e.kind]}</td>` +
        `<td style="padding:6px 8px;vertical-align:top;font-weight:600;color:#111827">${esc(e.name)}</td>` +
        `<td style="padding:6px 8px;vertical-align:top;font-size:11px;color:#374151">${changesCell(e)}</td>` +
        `</tr>`,
    )
    .join('');
  return (
    `<div style="margin:18px 0;page-break-inside:avoid">` +
    `<div style="font-size:14px;font-weight:700;color:#111827">${esc(p.bName)} <span style="color:#9ca3af;font-weight:400">vs</span> ${esc(p.aName)} <span style="color:#9ca3af;font-weight:400">(base)</span></div>` +
    `<div style="font-size:12px;color:#374151;margin:4px 0 8px">${summaryLine}</div>` +
    (rows
      ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f8fafc;color:#6b7280">` +
        `<th style="text-align:left;padding:6px 8px">Status</th><th style="text-align:left;padding:6px 8px">Type</th><th style="text-align:left;padding:6px 8px">Name</th><th style="text-align:left;padding:6px 8px">What differs</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>`
      : '') +
    `</div>`
  );
}

/** Render the whole comparison as report-body HTML (wrapped by reportHtmlDocument on export). */
export function workspaceDiffHtml(r: WorkspaceCompareResultView): string {
  const wsRows = r.workspaces
    .map((w) => {
      const isBase = w.workspaceId === r.baseWorkspaceId;
      return (
        `<tr style="border-bottom:1px solid #eef2f7">` +
        `<td style="padding:5px 8px;font-weight:600">${esc(w.name)}${isBase ? ' <span style="font-size:10px;color:#2563eb;font-weight:700">BASE</span>' : ''}</td>` +
        `<td style="padding:5px 8px;color:#6b7280">${w.counts.tag} tags · ${w.counts.trigger} triggers · ${w.counts.variable} vars · ${w.counts.folder} folders</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<div style="font-size:12px;color:#374151;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:10px 12px;margin-bottom:14px;line-height:1.5">` +
    `<b>Summary of differences.</b> ${esc(r.headline)}` +
    `<div style="color:#9ca3af;margin-top:4px;font-size:11px">Note: GTM has no per-workspace permissions or files — user access is account/container-level and identical for every workspace. This compares configuration entities (tags, triggers, variables, folders).</div>` +
    `</div>` +
    `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px"><tbody>${wsRows}</tbody></table>` +
    consolidatedHtml(r) +
    `<div style="font-size:14px;font-weight:700;margin:20px 0 4px">Detailed differences <span style="color:#9ca3af;font-weight:400">(base vs each)</span></div>` +
    r.pairs.map(pairSection).join('')
  );
}

/** CSV of the consolidated common + uncommon items (the "spreadsheet" export — Excel opens it directly). */
export function workspaceDiffCsv(r: WorkspaceCompareResultView): string {
  const q = (s: string): string => `"${String(s).replace(/"/g, '""')}"`;
  const line = (cells: (string | number)[]): string => cells.map((x) => q(String(x))).join(',');
  const rows: string[] = [];
  rows.push(line(['Section', 'Type', 'Name', 'Present in', 'Missing from', 'Merge status', 'Differing fields', 'Suggested action', 'Notes']));
  for (const e of r.consolidated.common) {
    rows.push(line(['Common', e.kind, e.name, e.presentIn.join('; '), e.missingFrom.join('; '), e.mergeStatus, e.differingFields.join('; '), e.suggestedAction, e.notes]));
  }
  for (const e of r.consolidated.uncommon) {
    rows.push(line(['Uncommon', e.kind, e.name, e.presentIn.join('; '), e.missingFrom.join('; '), '', '', e.suggestedAction, e.notes]));
  }
  return rows.join('\r\n');
}
