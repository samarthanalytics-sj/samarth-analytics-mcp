/**
 * What is already in the selected workspace, read once per turn and put in the prompt.
 *
 * Why this exists. Asked to create a GA4 email_click tag, the chat spent its first four steps on
 * `built_in_variables_list`, `variables_list`, `triggers_list` and `tags_list` before it wrote
 * anything. That is reasonable of it: you cannot reuse a trigger you have not looked for, and
 * creating a duplicate is worse than checking. But it was paying for the lookup in the most
 * expensive currency available.
 *
 * Each of those steps is a full model round trip. Measured on this deployment: ~8,000 prompt tokens
 * and ~9 seconds each, against an account limited to 30,000 tokens per minute. Four of them is most
 * of a minute and most of the budget, spent before the actual work begins, and it is the reason
 * creation turns were hitting the rate limit at all.
 *
 * The same four lists fetched HERE cost four parallel MCP calls, about two seconds of wall clock,
 * and no model round trips whatsoever. The model starts the turn already knowing what exists.
 *
 * Read fresh at the start of every turn rather than cached. A cache would have to be invalidated by
 * every write, including writes made from the desktop app or the GTM interface itself, and a stale
 * snapshot is exactly the failure this is supposed to prevent: it would have the model "know" a
 * trigger exists that somebody deleted five minutes ago. Two seconds is cheaper than being wrong.
 */
import type { McpConnection } from './mcp-client.js';

/** Beyond this many of one kind, the summary lists a sample and says so. */
const MAX_LISTED = 60;

export interface SnapshotEntity {
  name: string;
  /** GTM's type string: gaawe, googtag, linkClick, v, jsm and so on. */
  type?: string;
}

/**
 * The GA4 base tag already in the workspace, and the id it is configured with.
 *
 * The one field worth keeping beyond names: it is the answer to "what Measurement ID does this
 * container use", the container already knows it, and asking a person for something we can read is
 * a worse product. Read from the tags list this already fetches, so it costs no extra round trip.
 */
export interface Ga4BaseTag {
  name: string;
  type: string;
  /** Absent when the tag carries a {{variable}} or a placeholder rather than a literal G- id. */
  measurementId?: string;
}

export interface WorkspaceSnapshot {
  accountId: string;
  containerId: string;
  workspaceId: string;
  tags: SnapshotEntity[];
  /** Present when the workspace already has a Google tag or a legacy GA4 Configuration. */
  ga4BaseTag?: Ga4BaseTag;
  triggers: SnapshotEntity[];
  variables: SnapshotEntity[];
  /** Built-in variable types already enabled, e.g. clickUrl, pageUrl. */
  builtIns: string[];
  /**
   * Kinds whose list did not come back, or came back truncated. Named so the prompt can refuse to
   * claim completeness for them: a partial list presented as the whole container is how a model
   * concludes something does not exist and creates a duplicate.
   */
  incomplete: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** One list tool, reduced to names and types. Never throws: a missing kind is recorded, not fatal. */
async function listKind(
  mcp: McpConnection,
  tool: string,
  args: Record<string, unknown>,
  key: string,
): Promise<{ items: SnapshotEntity[]; ok: boolean; truncated: boolean; raw: unknown[] }> {
  const { ok, text } = await mcp.callTool(tool, args);
  if (!ok) return { items: [], ok: false, truncated: false, raw: [] };
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const raw = body[key];
    const items = Array.isArray(raw)
      ? raw.flatMap((e) => {
          if (!e || typeof e !== 'object') return [];
          const o = e as Record<string, unknown>;
          // Built-in variables are identified by `type` and may carry no `name` at all, so an
          // entity keyed only by one of the two is still an entity. Requiring `name` silently
          // emptied that list, which reads as "no built-ins are enabled".
          const type = str(o.type);
          const name = str(o.name) ?? type;
          return name ? [{ name, type }] : [];
        })
      : [];
    return {
      items,
      ok: true,
      truncated: body.truncated === true,
      raw: Array.isArray(raw) ? raw : [],
    };
  } catch {
    return { items: [], ok: false, truncated: false, raw: [] };
  }
}

/** Tag types that ARE a GA4 base tag: the modern Google tag and the legacy GA4 Configuration. */
const GA4_BASE_TYPES = new Set(['googtag', 'gaawc']);
/** Where each type keeps the id it configures. */
const ID_PARAM: Record<string, string> = { googtag: 'tagId', gaawc: 'measurementId' };

/**
 * PURE: the GA4 base tag in a raw tags list, with the literal id it configures.
 *
 * A tag whose id is a {{variable}} is still returned, without an id: it IS the base tag (so a
 * second one must not be created) but it does not answer "what is the Measurement ID". Reporting a
 * "{{...}}" string as the id would put a reference inside a Constant, which resolves to nothing.
 */
export function findGa4BaseTag(raw: unknown[]): Ga4BaseTag | undefined {
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const tag = entry as { name?: unknown; type?: unknown; parameter?: unknown };
    const type = str(tag.type);
    if (!type || !GA4_BASE_TYPES.has(type)) continue;
    const params = Array.isArray(tag.parameter) ? (tag.parameter as Record<string, unknown>[]) : [];
    const value = str(params.find((p) => p.key === ID_PARAM[type])?.value as string | undefined);
    return {
      name: str(tag.name) ?? type,
      type,
      ...(value && /^G-[A-Z0-9]+$/i.test(value) ? { measurementId: value } : {}),
    };
  }
  return undefined;
}

/**
 * Reads the workspace's contents. Every list runs concurrently, because they are independent and
 * the whole point is to cost one wait rather than four.
 *
 * A failure of any single kind degrades that kind only. Losing the variable list should not stop a
 * turn that was about to create a tag; it should stop the turn from claiming the variable is absent.
 */
export async function fetchWorkspaceSnapshot(
  mcp: McpConnection,
  ws: { accountId: string; containerId: string; workspaceId: string },
): Promise<WorkspaceSnapshot> {
  const [tags, triggers, variables, builtIns] = await Promise.all([
    listKind(mcp, 'tags_list', ws, 'tags'),
    listKind(mcp, 'triggers_list', ws, 'triggers'),
    listKind(mcp, 'variables_list', ws, 'variables'),
    listKind(mcp, 'built_in_variables_list', ws, 'builtInVariables'),
  ]);

  const incomplete: string[] = [];
  for (const [label, r] of [
    ['tags', tags],
    ['triggers', triggers],
    ['variables', variables],
    ['built-in variables', builtIns],
  ] as const) {
    if (!r.ok || r.truncated) incomplete.push(label);
  }

  const ga4BaseTag = findGa4BaseTag(tags.raw);

  return {
    ...ws,
    tags: tags.items,
    ...(ga4BaseTag ? { ga4BaseTag } : {}),
    triggers: triggers.items,
    variables: variables.items,
    builtIns: builtIns.items.map((b) => b.type ?? b.name).filter(Boolean),
    incomplete,
  };
}

function renderKind(label: string, items: SnapshotEntity[], partial: boolean): string {
  if (items.length === 0) {
    return partial ? `${label}: could not be read this turn.` : `${label} (0): none.`;
  }
  const shown = items.slice(0, MAX_LISTED);
  const body = shown.map((e) => (e.type ? `${e.name} [${e.type}]` : e.name)).join(', ');
  const more =
    items.length > shown.length ? ` ...and ${items.length - shown.length} more, not listed here.` : '';
  return `${label} (${items.length}): ${body}.${more}`;
}

/**
 * The snapshot as the model reads it.
 *
 * The closing instruction is the part that saves the round trips, and it is deliberately narrow: it
 * stops the model re-listing to find out WHAT EXISTS, which this already answers, without stopping
 * it fetching an entity when it needs a field this summary does not carry, like a trigger's filter
 * conditions or a tag's parameters.
 */
export function renderWorkspaceSnapshot(s: WorkspaceSnapshot): string {
  const lines = [
    'WORKSPACE CONTENTS',
    `Read directly at the start of this turn, from workspace ${s.workspaceId} of container ${s.containerId}.`,
    renderKind('Tags', s.tags, s.incomplete.includes('tags')),
    renderKind('Triggers', s.triggers, s.incomplete.includes('triggers')),
    renderKind('Variables', s.variables, s.incomplete.includes('variables')),
    s.incomplete.includes('built-in variables')
      ? 'Built-in variables enabled: could not be read this turn.'
      : `Built-in variables enabled (${s.builtIns.length}): ${s.builtIns.length ? s.builtIns.join(', ') : 'none'}.`,
  ];

  if (s.incomplete.length) {
    lines.push(
      `INCOMPLETE: ${s.incomplete.join(', ')} could not be read in full, so this is NOT the whole ` +
        'container for those. Do not conclude something is absent from them; call the list tool ' +
        'before saying anything does not exist.',
    );
  } else {
    lines.push(
      'This is the COMPLETE contents of the workspace. You already know what exists, so do not ' +
        'call tags_list, triggers_list, variables_list or built_in_variables_list to find out. ' +
        'Reuse anything above by name instead of creating a duplicate. Fetch an individual entity ' +
        'only when you need a detail this summary does not carry, such as a trigger\'s conditions ' +
        'or a tag\'s parameters.',
    );
  }
  return lines.join('\n');
}
