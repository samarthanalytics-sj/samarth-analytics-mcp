// Tests for handing a client's notes to a colleague as a file. Two properties carry the design: an
// export must not leak another client's notes, and an import must never be a privileged write into
// the store (it produces a plan the user reviews, and the accepted notes go through the normal add).
// Run: tsx src/shared/__tests__/memory-transfer.test.ts
import {
  buildMemoryExport, parseMemoryExport, planMemoryImport, memoryExportFilename,
  MEMORY_EXPORT_VERSION, type ExportInput,
} from '../memory-transfer';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
// `scope` is read with `in`, not `??`: passing `scope: undefined` must mean "account-wide", which a
// nullish default would silently overwrite with the client scope.
const note = (over: Partial<ExportInput> = {}): ExportInput => ({
  kind: over.kind ?? 'rule',
  text: over.text ?? 'we use order_completed instead of purchase',
  enabled: over.enabled ?? true,
  pinned: over.pinned,
  scope: 'scope' in over ? over.scope : { containerId: 'GTM-AAA', label: 'acme.com' },
});

// ── Export ──────────────────────────────────────────────────────────────────────
{
  const f = buildMemoryExport([note()], { exportedAt: '2026-07-22', client: { containerId: 'GTM-AAA', publicId: 'GTM-AAA', containerName: 'acme.com' } });
  check('export: carries the format marker and version', f.format === 'samarth-memory' && f.version === MEMORY_EXPORT_VERSION);
  check('export: records the client, so the importer knows what it is', f.client?.publicId === 'GTM-AAA');
  check('export: the note survives with kind, text and scope', f.notes[0].kind === 'rule' && f.notes[0].scope?.containerId === 'GTM-AAA');
  check('export: the date is date-only (this file gets emailed around)', f.exportedAt === '2026-07-22' && !/T\d/.test(f.exportedAt));
}
check('export: a MUTED note is left out (the exporter already decided it should not apply)',
  buildMemoryExport([note({ enabled: false })], { exportedAt: '2026-07-22' }).notes.length === 0);
check('export: an empty or whitespace note is left out',
  buildMemoryExport([note({ text: '   ' })], { exportedAt: '2026-07-22' }).notes.length === 0);
check('export: an unknown kind is left out', buildMemoryExport([note({ kind: 'nonsense' })], { exportedAt: '2026-07-22' }).notes.length === 0);
check('export: an account-wide note carries no scope', (() => {
  const f = buildMemoryExport([note({ scope: undefined })], { exportedAt: '2026-07-22' });
  return f.notes.length === 1 && f.notes[0].scope === undefined;
})());
check('export: nothing to export is still a valid file', buildMemoryExport([], { exportedAt: '2026-07-22' }).notes.length === 0);
check('export: pinned is preserved', buildMemoryExport([note({ pinned: true })], { exportedAt: '2026-07-22' }).notes[0].pinned === true);

// ── Round trip ──────────────────────────────────────────────────────────────────
{
  const f = buildMemoryExport([note(), note({ kind: 'fact', text: 'the pricing form is behind a login' })], { exportedAt: '2026-07-22' });
  const back = parseMemoryExport(JSON.stringify(f));
  check('round trip: every note survives', back.notes.length === 2 && back.problems.length === 0);
  check('round trip: kinds and texts are intact', back.notes[1].kind === 'fact' && back.notes[1].text.includes('behind a login'));
}

// ── Parsing refuses what it should ─────────────────────────────────────────────
for (const [label, raw, expect] of [
  ['not JSON', 'this is not json', /not valid JSON/i],
  ['JSON but not ours', '{"hello":"world"}', /not a memory export/i],
  ['an array', '[1,2,3]', /does not contain a memory export/i],
  ['a newer format', '{"format":"samarth-memory","version":99,"notes":[]}', /newer version/i],
] as const) {
  const r = parseMemoryExport(raw);
  check(`parse: ${label} is refused outright`, r.notes.length === 0 && expect.test(r.problems[0] ?? ''), r.problems[0]);
}
check('parse: a bad note is skipped and REPORTED, the good ones still load', (() => {
  const r = parseMemoryExport(JSON.stringify({
    format: 'samarth-memory', version: 1, exportedAt: '2026-07-22',
    notes: [{ kind: 'rule', text: 'keep me' }, { kind: 'rule', text: '' }, { kind: 'weird', text: 'x' }],
  }));
  return r.notes.length === 1 && r.problems.length === 2;
})());
check('parse: missing notes list is reported, not silently empty', (() => {
  const r = parseMemoryExport(JSON.stringify({ format: 'samarth-memory', version: 1 }));
  return r.notes.length === 0 && r.problems.some((p) => /no notes list/i.test(p));
})());

// ── The import PLAN ─────────────────────────────────────────────────────────────
{
  const parsed = parseMemoryExport(JSON.stringify(buildMemoryExport([
    note({ text: 'a' }), note({ text: 'b' }),
  ], { exportedAt: '2026-07-22' })));
  const plan = planMemoryImport(parsed, [], { containerId: 'GTM-NEW', label: 'newclient.com' });
  check('import: everything new is offered for review', plan.add.length === 2 && plan.duplicates.length === 0);
  check('import: each item has a stable id for the review list', new Set(plan.add.map((a) => a.id)).size === 2);
  check('import: client-scoped notes are RE-SCOPED to the container being imported into',
    plan.add.every((a) => a.scope?.containerId === 'GTM-NEW'), JSON.stringify(plan.add[0].scope));
}
check('import: an account-wide note stays account-wide', (() => {
  const parsed = parseMemoryExport(JSON.stringify(buildMemoryExport([note({ scope: undefined })], { exportedAt: '2026-07-22' })));
  const plan = planMemoryImport(parsed, [], { containerId: 'GTM-NEW' });
  return plan.add[0].scope === undefined;
})());
check('import: a note the account already has is NOT offered twice', (() => {
  const parsed = parseMemoryExport(JSON.stringify(buildMemoryExport([note({ text: 'same note' })], { exportedAt: '2026-07-22' })));
  const plan = planMemoryImport(parsed, [{ kind: 'rule', text: 'Same Note', scope: { containerId: 'GTM-NEW' } }], { containerId: 'GTM-NEW' });
  return plan.add.length === 0 && plan.duplicates.length === 1;
})());
check('import: duplicates WITHIN one file collapse', (() => {
  const parsed = parseMemoryExport(JSON.stringify(buildMemoryExport([note({ text: 'dup' }), note({ text: 'dup' })], { exportedAt: '2026-07-22' })));
  const plan = planMemoryImport(parsed, [], { containerId: 'GTM-NEW' });
  return plan.add.length === 1 && plan.duplicates.length === 1;
})());
check('import: parse problems are carried into the plan, never dropped', (() => {
  const plan = planMemoryImport(parseMemoryExport('not json'), []);
  return plan.add.length === 0 && plan.problems.length === 1;
})());
check('import: no target container leaves the original scope untouched', (() => {
  const parsed = parseMemoryExport(JSON.stringify(buildMemoryExport([note()], { exportedAt: '2026-07-22' })));
  return planMemoryImport(parsed, []).add[0].scope?.containerId === 'GTM-AAA';
})());

// ── Filename ────────────────────────────────────────────────────────────────────
check('filename: names the client and the date', memoryExportFilename({ publicId: 'GTM-AAA' }, '2026-07-22') === 'samarth-memory-GTM-AAA-2026-07-22.json');
check('filename: unsafe characters are stripped', !/[/\\:*?"<>|]/.test(memoryExportFilename({ containerName: 'acme.com / EU: staging' }, '2026-07-22')));
check('filename: missing client still yields a sane name', memoryExportFilename(undefined, '2026-07-22').startsWith('samarth-memory-account-'));

console.log(`\nmemory-transfer: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
