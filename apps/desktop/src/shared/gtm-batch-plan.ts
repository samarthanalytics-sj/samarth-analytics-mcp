// Batch change planning for GTM: one approval for a whole set of tag/trigger/variable changes,
// instead of one card per item.
//
// PURE + framework-free. Two jobs:
//   1. summarizeGtmBatch(items)  - turn a flat list of planned changes into the categorized,
//      human-readable summary the approval dialog shows (counts per category, every affected item
//      by name with a one-line change description, and the totals).
//   2. resolveDeletions(...)     - match a requested delete set (by id or name) against the live
//      container, so the plan the user approves names exactly what will be removed and flags what
//      cannot be (not found, a built-in trigger, or a trigger still in use).
//
// The summary is the CONTRACT the user approves: what it lists is what executes, in the same order.
// So it is deterministic (stable input order preserved) and never invents an item that was not
// planned.
//
// House style: no em dashes anywhere in this file - every string here reaches the user.

export type GtmEntityKind = 'tag' | 'trigger' | 'variable';
export type GtmBatchAction = 'create' | 'update' | 'replace' | 'delete';

/** One planned change. `change` is the specific edit in plain words (trigger condition updated, tag
 *  config changed, variable value modified); shown under the item so the user knows what happens. */
export interface GtmBatchItem {
  action: GtmBatchAction;
  entity: GtmEntityKind;
  name: string;
  change?: string;
  /** Resolved GTM id, when known (shown for delete/update so an ambiguous name is still traceable). */
  id?: string;
  /** Set when this item CANNOT be applied, with the reason. Blocked items are counted separately and
   *  never contribute to the "will be applied" totals. */
  blocked?: string;
}

const ENTITY_PLURAL: Record<GtmEntityKind, string> = { tag: 'Tags', trigger: 'Triggers', variable: 'Variables' };
const ENTITY_SINGULAR: Record<GtmEntityKind, string> = { tag: 'Tag', trigger: 'Trigger', variable: 'Variable' };
const ACTION_VERB: Record<GtmBatchAction, string> = { create: 'created', update: 'updated', replace: 'replaced', delete: 'deleted' };
const ORDER: readonly GtmEntityKind[] = ['tag', 'trigger', 'variable'];
const ACTION_ORDER: readonly GtmBatchAction[] = ['create', 'update', 'replace', 'delete'];

export interface GtmBatchCounts {
  /** counts[entity][action] = number of applicable (non-blocked) items. */
  byEntityAction: Record<GtmEntityKind, Record<GtmBatchAction, number>>;
  byEntity: Record<GtmEntityKind, number>;
  total: number;
  blocked: number;
}

export interface GtmBatchSummary {
  counts: GtmBatchCounts;
  /** The categorized approval text: headline, then per-entity/per-action groups with each item and
   *  its change description, then any blocked items, then the totals line. */
  text: string;
  /** True when nothing applicable remains (everything was blocked, or the list was empty). */
  empty: boolean;
}

const zeroActions = (): Record<GtmBatchAction, number> => ({ create: 0, update: 0, replace: 0, delete: 0 });

/**
 * Build the categorized summary. Blocked items are listed under their own heading and excluded from
 * every count, so the totals describe exactly what WILL happen on approval.
 */
export function summarizeGtmBatch(items: readonly GtmBatchItem[]): GtmBatchSummary {
  const applicable = items.filter((i) => !i.blocked);
  const blocked = items.filter((i) => i.blocked);

  const byEntityAction: Record<GtmEntityKind, Record<GtmBatchAction, number>> = {
    tag: zeroActions(), trigger: zeroActions(), variable: zeroActions(),
  };
  const byEntity: Record<GtmEntityKind, number> = { tag: 0, trigger: 0, variable: 0 };
  for (const i of applicable) {
    byEntityAction[i.entity][i.action] += 1;
    byEntity[i.entity] += 1;
  }
  const total = applicable.length;
  const counts: GtmBatchCounts = { byEntityAction, byEntity, total, blocked: blocked.length };

  const lines: string[] = [];
  // Headline: the totals per entity, the first thing to read.
  const headParts = ORDER.filter((e) => byEntity[e] > 0).map((e) => `${byEntity[e]} ${byEntity[e] === 1 ? ENTITY_SINGULAR[e] : ENTITY_PLURAL[e]}`);
  lines.push(headParts.length ? `This batch will change ${headParts.join(', ')}.` : 'This batch has no applicable changes.');

  for (const entity of ORDER) {
    if (byEntity[entity] === 0) continue;
    lines.push('');
    lines.push(`${ENTITY_PLURAL[entity]}`);
    for (const action of ACTION_ORDER) {
      const group = applicable.filter((i) => i.entity === entity && i.action === action);
      if (!group.length) continue;
      // "8 Tags will be updated." - the exact phrasing the user asked for.
      lines.push(`  ${group.length} ${group.length === 1 ? ENTITY_SINGULAR[entity] : ENTITY_PLURAL[entity]} will be ${ACTION_VERB[action]}:`);
      for (const i of group) {
        const idPart = i.id ? ` (id ${i.id})` : '';
        const changePart = i.change ? ` - ${i.change}` : '';
        lines.push(`    - ${i.name}${idPart}${changePart}`);
      }
    }
  }

  if (blocked.length) {
    lines.push('');
    lines.push(`Not applied (${blocked.length}):`);
    for (const i of blocked) {
      lines.push(`    - ${ENTITY_SINGULAR[i.entity]} "${i.name}"${i.id ? ` (id ${i.id})` : ''}: ${i.blocked}`);
    }
  }

  lines.push('');
  lines.push(total ? `Total: ${total} change${total === 1 ? '' : 's'} will be applied${blocked.length ? `, ${blocked.length} skipped` : ''}.` : 'Nothing will be applied.');

  return { counts, text: lines.join('\n'), empty: total === 0 };
}

// ── Deletion resolution against the live container ─────────────────────────────────────────────

/** Minimal shapes the resolver needs from the container snapshot (a subset of the audit types, kept
 *  local so this module stays framework-free and unit-testable without the whole snapshot).
 *  `references` is the list of {{variable}} names this entity uses (extracted by the caller); it
 *  powers the referenced-variable warning below. */
export interface SnapTag { tagId: string; name: string; firingTriggerId?: string[]; blockingTriggerId?: string[]; references?: readonly string[] }
export interface SnapTrigger { triggerId: string; name: string; references?: readonly string[] }
export interface SnapVariable { variableId: string; name: string; references?: readonly string[] }
export interface DeletionSnapshot { tags: SnapTag[]; triggers: SnapTrigger[]; variables: SnapVariable[] }

/** One requested deletion: an id, or a name to resolve, or both. */
export interface DeleteRequest { id?: string; name?: string }
export type DeleteRequestList = readonly DeleteRequest[];

/** A built-in trigger id can never be deleted; the resolver refuses it as blocked rather than
 *  attempting a doomed API call. Mirrors isBuiltinTriggerId in gtm-builders (kept in sync by test). */
export const isBuiltinTriggerId = (id: string): boolean => /^2147479\d{3}$/.test(id);

/** "3 tags: A, B, C" style, capped so a huge fan-in stays one readable line. */
const listWithCap = (names: readonly string[], cap = 3): string =>
  `${names.slice(0, cap).join(', ')}${names.length > cap ? `, ...` : ''}`;

/**
 * Resolve a requested delete set into concrete items, matching by id first, then by exact
 * (case-insensitive) name. Produces GtmBatchItems ready for summarizeGtmBatch: found targets carry
 * their id and a warning when deleting them will break something that SURVIVES the batch; unresolved
 * or reserved ones are marked blocked with the reason.
 *
 * Referenced targets are NOT auto-blocked (deleting is the user's call), but the change note names the
 * consequence, because it must be visible before approving:
 *   - a TRIGGER still referenced by a surviving tag: GTM unlinks it from that tag;
 *   - a VARIABLE still referenced by a surviving tag / trigger / other variable: GTM does NOT refuse
 *     the delete, so the {{reference}} silently breaks. This is the dangerous case, and the reason
 *     this check exists.
 *
 * "Surviving" = not itself in the delete set: a variable used only by a tag that is ALSO being
 * deleted is not really orphaning anything, so it earns no warning.
 */
export function resolveDeletions(
  requests: { tags?: DeleteRequestList; triggers?: DeleteRequestList; variables?: DeleteRequestList },
  snap: DeletionSnapshot
): GtmBatchItem[] {
  const match = <T extends { name: string }>(list: T[], req: DeleteRequest, idOf: (t: T) => string): T | undefined => {
    if (req.id) {
      const byId = list.find((t) => idOf(t) === String(req.id));
      if (byId) return byId;
    }
    if (req.name) {
      const wanted = req.name.trim().toLowerCase();
      const named = list.filter((t) => t.name.trim().toLowerCase() === wanted);
      // An ambiguous name (two entities share it) cannot be resolved safely to one id.
      if (named.length === 1) return named[0];
    }
    return undefined;
  };
  const nameExists = (list: { name: string }[], req: DeleteRequest): boolean =>
    list.some((x) => x.name.trim().toLowerCase() === (req.name ?? '').trim().toLowerCase());

  // Pass 1: resolve every request to a matched entity (or nothing), so the FULL delete set is known
  // before any note is worded. The surviving-reference checks below need that set up front.
  const tagRes = (requests.tags ?? []).map((req) => ({ req, m: match(snap.tags, req, (x) => x.tagId) }));
  const trigRes = (requests.triggers ?? []).map((req) => ({ req, builtin: Boolean(req.id && isBuiltinTriggerId(String(req.id))), m: match(snap.triggers, req, (x) => x.triggerId) }));
  const varRes = (requests.variables ?? []).map((req) => ({ req, m: match(snap.variables, req, (x) => x.variableId) }));

  const deletedTagIds = new Set(tagRes.filter((r) => r.m).map((r) => r.m!.tagId));
  const deletedTriggerIds = new Set(trigRes.filter((r) => !r.builtin && r.m).map((r) => r.m!.triggerId));
  const deletedVarIds = new Set(varRes.filter((r) => r.m).map((r) => r.m!.variableId));

  // Every entity that will STILL EXIST after the batch, labelled for the warning message.
  const survivors: Array<{ kind: GtmEntityKind; name: string; references: readonly string[] }> = [
    ...snap.tags.filter((t) => !deletedTagIds.has(t.tagId)).map((t) => ({ kind: 'tag' as const, name: t.name, references: t.references ?? [] })),
    ...snap.triggers.filter((t) => !deletedTriggerIds.has(t.triggerId)).map((t) => ({ kind: 'trigger' as const, name: t.name, references: t.references ?? [] })),
    ...snap.variables.filter((v) => !deletedVarIds.has(v.variableId)).map((v) => ({ kind: 'variable' as const, name: v.name, references: v.references ?? [] })),
  ];
  /** Surviving entities that reference variable `varName` by {{varName}}, labelled kind + name. */
  const survivingReferrersOf = (varName: string): string[] =>
    survivors.filter((s) => s.references.includes(varName)).map((s) => `${s.kind} "${s.name}"`);

  const items: GtmBatchItem[] = [];

  for (const { req, m: t } of tagRes) {
    if (t) items.push({ action: 'delete', entity: 'tag', name: t.name, id: t.tagId, change: 'tag deleted' });
    else items.push({ action: 'delete', entity: 'tag', name: req.name ?? req.id ?? '(unspecified)', ...(req.id ? { id: String(req.id) } : {}), blocked: blockReason(req, nameExists(snap.tags, req)) });
  }
  for (const { req, builtin, m: tr } of trigRes) {
    if (builtin) {
      items.push({ action: 'delete', entity: 'trigger', name: req.name ?? String(req.id), id: String(req.id), blocked: 'built-in trigger, cannot be deleted' });
      continue;
    }
    if (tr) {
      // Only SURVIVING tags matter: a tag also being deleted will not be left with a dangling trigger.
      const referencedBy = snap.tags.filter((tg) => !deletedTagIds.has(tg.tagId) && [...(tg.firingTriggerId ?? []), ...(tg.blockingTriggerId ?? [])].includes(tr.triggerId)).map((tg) => tg.name);
      items.push({
        action: 'delete', entity: 'trigger', name: tr.name, id: tr.triggerId,
        change: referencedBy.length ? `trigger deleted (still referenced by ${referencedBy.length} surviving tag${referencedBy.length === 1 ? '' : 's'}: ${listWithCap(referencedBy)}; those tags will lose this trigger)` : 'trigger deleted',
      });
    } else {
      items.push({ action: 'delete', entity: 'trigger', name: req.name ?? req.id ?? '(unspecified)', ...(req.id ? { id: String(req.id) } : {}), blocked: blockReason(req, nameExists(snap.triggers, req)) });
    }
  }
  for (const { req, m: v } of varRes) {
    if (v) {
      const referencedBy = survivingReferrersOf(v.name);
      items.push({
        action: 'delete', entity: 'variable', name: v.name, id: v.variableId,
        change: referencedBy.length
          ? `variable deleted (still referenced by ${referencedBy.length} surviving item${referencedBy.length === 1 ? '' : 's'}: ${listWithCap(referencedBy)}; GTM does not block deleting a used variable, so those {{${v.name}}} references will break)`
          : 'variable deleted',
      });
    } else {
      items.push({ action: 'delete', entity: 'variable', name: req.name ?? req.id ?? '(unspecified)', ...(req.id ? { id: String(req.id) } : {}), blocked: blockReason(req, nameExists(snap.variables, req)) });
    }
  }
  return items;
}

/** Why a delete target could not be resolved: an ambiguous name (matched more than one) reads
 *  differently from one that matched nothing, so the user can fix the right thing. */
function blockReason(req: DeleteRequest, nameExistsMoreThanOnce: boolean): string {
  if (req.id && !req.name) return 'no entity with this id in the workspace';
  if (nameExistsMoreThanOnce) return 'the name matches more than one entity, so it is ambiguous; delete it by id instead';
  return 'not found in this workspace (already deleted, or in a different workspace)';
}
