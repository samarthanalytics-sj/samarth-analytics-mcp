// Handing a client's saved notes to a colleague as a file.
//
// Memory is per person, per machine: a colleague opening the same GTM container starts from zero and
// re-learns everything the first person already told the assistant. Real team memory needs a shared
// store, an identity model and a merge strategy. This is the step before that, and it needs none of
// them: export the notes for one client, send the file, import it.
//
// Two rules shape the design.
//
//   EXPORT IS SCOPED TO ONE CLIENT. A file for a handover must not carry another client's notes, so
//   the caller passes only the notes that apply to the container being handed over, and the envelope
//   records which container that was.
//
//   IMPORT NEVER WRITES DIRECTLY. It produces a PLAN the user reviews, and the accepted notes go in
//   through the normal add path, so redaction, dedupe, capping and eviction all still apply. An
//   import is not a privileged channel into the store.
//
// PURE. The caller does the file IO and the adds.

/** The file format. Versioned so a future shared-folder sync can read these too. */
export const MEMORY_EXPORT_VERSION = 1;

export interface MemoryExportNote {
  kind: string;
  text: string;
  /** Client scope as saved: container or property, when the note was client-specific. */
  scope?: { containerId?: string; property?: string; label?: string };
  pinned?: boolean;
}

export interface MemoryExportFile {
  format: 'samarth-memory';
  version: number;
  /** Date only, never a precise timestamp: this file gets emailed around. */
  exportedAt: string;
  /** Which client these notes describe, for the importer's confirmation. */
  client?: { containerId?: string; containerName?: string; publicId?: string };
  notes: MemoryExportNote[];
}

/** What a note must look like to be worth exporting. */
const KINDS = new Set(['fact', 'preference', 'rule', 'decision', 'glossary']);

export interface ExportInput {
  kind: string;
  text: string;
  enabled?: boolean;
  pinned?: boolean;
  scope?: { containerId?: string; property?: string; label?: string };
}

/**
 * Build the export envelope.
 *
 * Muted notes are left out: the exporter has already decided they should not apply, and shipping
 * them to a colleague silently re-enables that decision on someone else's machine.
 */
export function buildMemoryExport(
  notes: readonly ExportInput[],
  meta: { exportedAt: string; client?: MemoryExportFile['client'] },
): MemoryExportFile {
  const out: MemoryExportNote[] = [];
  for (const n of notes ?? []) {
    if (!n || n.enabled === false) continue;
    const text = String(n.text ?? '').trim();
    const kind = String(n.kind ?? '');
    if (!text || !KINDS.has(kind)) continue;
    out.push({
      kind,
      text,
      ...(n.scope && (n.scope.containerId || n.scope.property) ? { scope: { ...n.scope } } : {}),
      ...(n.pinned ? { pinned: true } : {}),
    });
  }
  return {
    format: 'samarth-memory',
    version: MEMORY_EXPORT_VERSION,
    exportedAt: meta.exportedAt,
    ...(meta.client ? { client: meta.client } : {}),
    notes: out,
  };
}

export interface ParseResult {
  notes: MemoryExportNote[];
  client?: MemoryExportFile['client'];
  exportedAt?: string;
  /** Why the file, or parts of it, could not be read. Shown to the user, never swallowed. */
  problems: string[];
}

/**
 * Read an export file.
 *
 * Tolerant about extra fields and about individual bad notes (they are reported and skipped), strict
 * about the envelope: anything that is not one of our files is refused outright rather than
 * half-imported.
 */
export function parseMemoryExport(raw: string): ParseResult {
  const problems: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(String(raw ?? ''));
  } catch {
    return { notes: [], problems: ['That file is not valid JSON, so nothing was read from it.'] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { notes: [], problems: ['That file does not contain a memory export.'] };
  }
  const f = data as Partial<MemoryExportFile>;
  if (f.format !== 'samarth-memory') {
    return { notes: [], problems: ['That file is not a memory export from this app (its format marker is missing).'] };
  }
  if (typeof f.version !== 'number' || f.version > MEMORY_EXPORT_VERSION) {
    return { notes: [], problems: [`That file was written by a newer version of the app (format ${String(f.version)}). Update, then import it.`] };
  }
  const notes: MemoryExportNote[] = [];
  const list = Array.isArray(f.notes) ? f.notes : [];
  if (!Array.isArray(f.notes)) problems.push('The file has no notes list.');
  list.forEach((n, i) => {
    const text = String((n as MemoryExportNote)?.text ?? '').trim();
    const kind = String((n as MemoryExportNote)?.kind ?? '');
    if (!text) { problems.push(`Note ${i + 1} has no text and was skipped.`); return; }
    if (!KINDS.has(kind)) { problems.push(`Note ${i + 1} has an unknown kind "${kind}" and was skipped.`); return; }
    const scope = (n as MemoryExportNote).scope;
    notes.push({
      kind,
      text,
      ...(scope && (scope.containerId || scope.property) ? { scope: { ...scope } } : {}),
      ...((n as MemoryExportNote).pinned ? { pinned: true } : {}),
    });
  });
  return { notes, ...(f.client ? { client: f.client } : {}), ...(typeof f.exportedAt === 'string' ? { exportedAt: f.exportedAt } : {}), problems };
}

export interface ImportPlanItem extends MemoryExportNote {
  /** Stable index-based id so the review UI can drop one item without reindexing. */
  id: string;
}

export interface ImportPlan {
  /** Notes not already present, offered for review. */
  add: ImportPlanItem[];
  /** Notes the account already has, so the user is not asked twice. */
  duplicates: MemoryExportNote[];
  problems: string[];
}

/** Same identity rule the store uses: kind + scope + text, case-insensitive on the text. */
const dedupeKey = (n: { kind: string; text: string; scope?: { containerId?: string; property?: string } }): string =>
  `${n.kind}|${n.scope?.containerId ?? ''}|${n.scope?.property ?? ''}|${String(n.text).trim().toLowerCase()}`;

/**
 * What an import would actually add.
 *
 * Re-scoping is deliberate: a note exported for container A is imported against whichever container
 * the importer is handing it to, so a handover works even when the two sides refer to the same client
 * by different container ids. Account-wide notes stay account-wide.
 */
export function planMemoryImport(
  parsed: ParseResult,
  existing: readonly { kind: string; text: string; scope?: { containerId?: string; property?: string } }[],
  target?: { containerId?: string; label?: string },
): ImportPlan {
  const have = new Set((existing ?? []).map(dedupeKey));
  const add: ImportPlanItem[] = [];
  const duplicates: MemoryExportNote[] = [];
  const seen = new Set<string>();

  (parsed?.notes ?? []).forEach((n, i) => {
    const clientScoped = !!(n.scope?.containerId || n.scope?.property);
    const scope = clientScoped && target?.containerId
      ? { containerId: target.containerId, ...(target.label ? { label: target.label } : {}) }
      : clientScoped
        ? { ...n.scope }
        : undefined;
    const candidate = { kind: n.kind, text: n.text, ...(scope ? { scope } : {}) };
    const key = dedupeKey(candidate);
    if (have.has(key) || seen.has(key)) { duplicates.push(n); return; }
    seen.add(key);
    add.push({ id: `imp-${i}`, ...candidate, ...(n.pinned ? { pinned: true } : {}) });
  });

  return { add, duplicates, problems: parsed?.problems ?? [] };
}

/** A filename a human can recognise a month later. */
export function memoryExportFilename(client?: MemoryExportFile['client'], exportedAt?: string): string {
  const who = String(client?.publicId || client?.containerName || 'account').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const when = String(exportedAt ?? '').slice(0, 10) || 'export';
  return `samarth-memory-${who || 'account'}-${when}.json`;
}
