// Pure drift/diff helpers for continuous GTM monitoring. No I/O — fully
// unit-testable. Two kinds of drift:
//   1. CONFIG drift  — diffSnapshots(base, target): which tags/triggers/variables
//      were added / removed / modified between two container snapshots (e.g. the
//      published LIVE version vs the draft WORKSPACE).
//   2. ISSUE drift   — diffAudits(prev, curr): which audit findings are NEW vs
//      RESOLVED since the last run, so monitoring surfaces regressions and fixes.

import type { AuditFinding, ContainerSnapshot } from './gtm-builders';

/* ───────────── Issue drift (audit-to-audit) ───────────── */

// A stable identity for a finding across runs. ONLY the volatile trailing count
// "(N tags)" / "(N triggers)" is normalised — so "Duplicate tag name X (2 tags)"
// and "(3 tags)" are the SAME issue — while names, ids, and measurement ids stay
// intact, so distinct resource-less findings (e.g. duplicate "Event 1" vs
// "Event 2", or different measurement-id sets) never collide into one key.
export function findingKey(f: AuditFinding): string {
  const sig = f.message.replace(/\((\d+)\s+(\w+)\)/g, '(# $2)');
  return `${f.category}|${f.resource?.kind ?? 'global'}|${f.resource?.id ?? ''}|${sig}`;
}

export interface AuditDrift {
  newFindings: AuditFinding[];
  resolvedFindings: AuditFinding[];
  unchangedCount: number;
}

// What changed between the previous findings and the current ones. `prev` is
// null/undefined on the very first run → everything current counts as "new".
export function diffAudits(
  prev: AuditFinding[] | null | undefined,
  curr: AuditFinding[]
): AuditDrift {
  const prevByKey = new Map((prev ?? []).map((f) => [findingKey(f), f]));
  const currByKey = new Map(curr.map((f) => [findingKey(f), f]));

  const newFindings = curr.filter((f) => !prevByKey.has(findingKey(f)));
  const resolvedFindings = (prev ?? []).filter((f) => !currByKey.has(findingKey(f)));
  const unchangedCount = curr.length - newFindings.length;
  return { newFindings, resolvedFindings, unchangedCount };
}

/* ───────────── Config drift (snapshot-to-snapshot) ───────────── */

export interface ResourceChange {
  id: string;
  name: string;
  type: string;
}
export interface ResourceDiff {
  added: ResourceChange[];
  removed: ResourceChange[];
  modified: ResourceChange[];
}
export interface SnapshotDiff {
  tags: ResourceDiff;
  triggers: ResourceDiff;
  variables: ResourceDiff;
  /** Total number of changed resources across all kinds. */
  changeCount: number;
}

type IdNamed = { name: string; type: string };

// Generic id-keyed diff. `fingerprint` returns a stable string for the fields
// that matter, so two resources with the same id are "modified" iff their
// fingerprints differ. base = the reference (e.g. live), target = the candidate
// (e.g. workspace) — added/removed are framed as "target relative to base".
function diffResources<T extends IdNamed>(
  base: Map<string, T>,
  target: Map<string, T>,
  fingerprint: (r: T) => string
): ResourceDiff {
  const added: ResourceChange[] = [];
  const removed: ResourceChange[] = [];
  const modified: ResourceChange[] = [];
  const desc = (id: string, r: T): ResourceChange => ({ id, name: r.name, type: r.type });

  for (const [id, r] of target) {
    const b = base.get(id);
    if (!b) added.push(desc(id, r));
    else if (fingerprint(b) !== fingerprint(r)) modified.push(desc(id, r));
  }
  for (const [id, r] of base) {
    if (!target.has(id)) removed.push(desc(id, r));
  }
  return { added, removed, modified };
}

const byId = <T>(items: T[], id: (t: T) => string): Map<string, T> =>
  new Map(items.map((t) => [id(t), t]));

// Recursively sort object keys so two structurally-equal resources compare equal
// regardless of the key ORDER the GTM API happened to return (the live-version
// and workspace endpoints can serialize the same parameter differently). Array
// order is preserved — only object keys are canonicalised.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonical(src[k]);
        return acc;
      }, {});
  }
  return v;
}
const stable = (v: unknown): string => JSON.stringify(canonical(v ?? null));

export function diffSnapshots(base: ContainerSnapshot, target: ContainerSnapshot): SnapshotDiff {
  const tags = diffResources(
    byId(base.tags, (t) => t.tagId),
    byId(target.tags, (t) => t.tagId),
    (t) =>
      stable([t.name, t.type, t.paused, [...t.firingTriggerId].sort(), [...(t.blockingTriggerId ?? [])].sort(), t.parameter, t.consentSettings])
  );
  const triggers = diffResources(
    byId(base.triggers, (t) => t.triggerId),
    byId(target.triggers, (t) => t.triggerId),
    (t) => stable([t.name, t.type, t.filter, t.autoEventFilter, t.customEventFilter, t.parameter])
  );
  const variables = diffResources(
    byId(base.variables, (v) => v.variableId),
    byId(target.variables, (v) => v.variableId),
    (v) => stable([v.name, v.type, v.parameter])
  );
  const changeCount =
    tags.added.length + tags.removed.length + tags.modified.length +
    triggers.added.length + triggers.removed.length + triggers.modified.length +
    variables.added.length + variables.removed.length + variables.modified.length;
  return { tags, triggers, variables, changeCount };
}
