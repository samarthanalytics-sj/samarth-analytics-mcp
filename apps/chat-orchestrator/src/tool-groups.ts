/**
 * PROGRESSIVE TOOL DISCLOSURE.
 *
 * The orchestrator was sending every in-scope tool on every step of the tool loop: 94 GTM schemas
 * on top of a large system prompt, about 15,000 input tokens per model call, re-sent once per tool
 * round. A single "list my tags" paid for all 94 definitions, several times over.
 *
 * What was there before was worse than expensive, it was silent: a flat ceiling (120 tools with
 * writes, 60 without) that sliced off the tail and only logged. The model never learned a tool
 * existed, so it reported it could not do the thing, and the user had no way to tell a missing
 * capability from a truncated list.
 *
 * This replaces the cap with groups. A small CORE is always sent; everything else is grouped, and
 * a group arrives when either the user's words suggest it or the model explicitly asks for it via
 * enable_tool_group. Nothing is ever silently dropped.
 *
 * TWO SAFETY PROPERTIES, both load-bearing:
 *
 *   FAIL-OPEN. groupOf() returns undefined for a name nothing classifies, and an unclassified tool
 *   is ALWAYS sent. A tool added to the MCP server tomorrow cannot vanish from the model's view
 *   because nobody updated this file.
 *
 *   FAIL-LOUD. The test walks the REAL server inventory and fails when a name falls through to
 *   undefined, so the classification cannot quietly rot into "everything is unclassified, therefore
 *   everything is sent" - which would pass every runtime check while restoring the original cost.
 *
 * Classification is by NAME SHAPE rather than a hand-listed membership map, because this server
 * names tools noun_verb with striking regularity (tags_*, ga4_create_*, clients_*). A 178-entry
 * list would be more precise and would be wrong within a month; the patterns below are checked
 * against the real inventory by the test.
 */
import type { ToolDef } from './types.js';

export const TOOL_GROUPS = [
  'core',
  'gtm-write',
  'gtm-admin',
  'server-side',
  'ga4-read',
  'ga4-write',
  'audit',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Groups the model can ask for. `core` is always present, so it is not requestable. */
export const REQUESTABLE_GROUPS: readonly Exclude<ToolGroup, 'core'>[] = TOOL_GROUPS.filter(
  (g): g is Exclude<ToolGroup, 'core'> => g !== 'core',
);

export const GROUP_SUMMARIES: Record<ToolGroup, string> = {
  core: 'Reading the setup: listing and getting accounts, containers, workspaces, tags, triggers, variables and GA4 properties.',
  'gtm-write':
    'Creating and editing GTM: tags, triggers, variables, built-in variables and folders, including deleting them.',
  'gtm-admin':
    'Container administration: workspaces, versions, publishing, environments, user permissions, and creating or combining containers.',
  'server-side':
    'Server-side GTM: clients, transformations, zones, destinations, custom templates and gtag configuration.',
  'ga4-read': 'Reading GA4: properties, data streams, key events, custom dimensions and metrics, links, and report data.',
  'ga4-write':
    'Changing GA4 Admin configuration: key events, custom dimensions and metrics, audiences, data streams, links, properties and data retention.',
  audit: 'Auditing and exporting a container.',
};

/** The always-present tool that lets the model pull in a group it cannot see. */
export const ENABLE_TOOL_GROUP = 'enable_tool_group';

/** Short label per group, for the gate description and the system-prompt sentence. */
const PROMPT_LABEL: Record<Exclude<ToolGroup, 'core'>, string> = {
  'gtm-write': 'creating and editing GTM tags, triggers and variables',
  'gtm-admin': 'workspaces, versions, publishing, environments and permissions',
  'server-side': 'server-side GTM (clients, transformations, zones, templates)',
  'ga4-read': 'reading GA4 configuration and report data',
  'ga4-write': 'changing GA4 Admin configuration',
  audit: 'auditing and exporting a container',
};

/**
 * CORE: always sent, deliberately small.
 *
 * Only the reads needed to answer "what is in here" and to resolve the ids every other tool
 * requires. Everything that CHANGES something is in a group, so a chat that is only being asked
 * questions never pays for the write surface at all.
 */
const CORE_TOOLS = new Set([
  'accounts_list',
  'accounts_get',
  'containers_list',
  'containers_get',
  'containers_lookup',
  'containers_snippet',
  'workspaces_list',
  'workspaces_get',
  'tags_list',
  'tags_get',
  'triggers_list',
  'triggers_get',
  'variables_list',
  'variables_get',
  'built_in_variables_list',
  'folders_list',
  'ga4_account_summaries_list',
  'ga4_properties_list',
  'ga4_property_get',
  'ga4_data_streams_list',
]);

/** GTM entity families whose writes are the everyday tag-building surface. */
const GTM_ENTITY = /^(tags|triggers|variables|folders|built_in_variables)_/;
/** Container administration: the operations a normal tagging question never needs. */
const GTM_ADMIN = /^(workspace|workspaces|versions|environments|user_permissions|accounts|containers)_/;
/** Server-side and advanced container objects. */
const SERVER_SIDE = /^(clients|transformations|zones|destinations|templates|gtag)_/;
/** A GA4 name that changes something. Everything else under ga4_ is a read. */
const GA4_WRITE = /^ga4_(create|update|delete|archive|acknowledge|set)_/;

/**
 * The group a tool belongs to, or undefined when nothing classifies it.
 *
 * Undefined is a deliberate value, not a failure: callers treat it as "always send". See the
 * fail-open note at the top.
 */
export function groupOf(name: string): ToolGroup | undefined {
  if (CORE_TOOLS.has(name)) return 'core';
  if (name === 'audit_container' || name === 'export_container') return 'audit';

  if (name.startsWith('ga4_')) return GA4_WRITE.test(name) ? 'ga4-write' : 'ga4-read';
  if (SERVER_SIDE.test(name)) return 'server-side';
  if (GTM_ENTITY.test(name)) return 'gtm-write';
  if (GTM_ADMIN.test(name)) return 'gtm-admin';
  return undefined;
}

/**
 * Words that pull a group in before the model has to ask for it.
 *
 * This is an optimisation, never a gate: a miss costs one extra round trip through
 * enable_tool_group, not a refusal. So the patterns are deliberately broad rather than clever.
 */
const GROUP_KEYWORDS: Record<Exclude<ToolGroup, 'core'>, RegExp> = {
  'gtm-write':
    /\b(creat|add|build|make|set up|setup|edit|updat|chang|modif|renam|remov|delet|paus|unpaus|enabl|disabl|fix|implement|configur|track)\w*\b/i,
  'gtm-admin':
    /\b(workspace|version|publish|environment|permission|user access|share|new container|combine|merge)\w*\b/i,
  'server-side': /\b(server[- ]?side|sgtm|server container|client|transformation|zone|template|gtag|first[- ]?party)\w*\b/i,
  'ga4-read': /\b(ga4|analytics|propert|measurement|stream|key event|conversion|dimension|metric|report|sessions?|users?|traffic)\w*\b/i,
  'ga4-write': /\b(ga4|analytics|key event|custom dimension|custom metric|audience|retention|data stream)\w*\b/i,
  audit: /\b(audit|review|health|check|export|score|problem|issue|broken|wrong)\w*\b/i,
};

export interface GroupSelectionInput {
  /** Every visible message this turn: the history plus the new one. */
  messages?: readonly string[];
  /** Groups already turned on, e.g. by an earlier enable_tool_group call in this turn. */
  enabled?: Iterable<ToolGroup>;
  /** Products connected via an integration chip: their tools must be reachable. */
  integrations?: readonly string[];
}

/** The groups to send for a turn. Signals are ORed, and `core` is always in the result. */
export function selectToolGroups(input: GroupSelectionInput): Set<ToolGroup> {
  const selected = new Set<ToolGroup>(['core']);
  for (const g of input.enabled ?? []) selected.add(g);

  // A connected platform is an explicit request for its surface, so its reads come in without
  // waiting for a keyword: the user already said what they wanted by turning the chip on.
  for (const p of input.integrations ?? []) {
    if (p === 'ga4') selected.add('ga4-read');
    if (p === 'gtm') selected.add('core');
  }

  const text = (input.messages ?? []).filter((m) => typeof m === 'string' && m.trim()).join('\n');
  if (text) {
    for (const group of REQUESTABLE_GROUPS) {
      if (GROUP_KEYWORDS[group].test(text)) selected.add(group);
    }
  }
  return selected;
}

/** Filter tools to the selected groups. An UNCLASSIFIED tool is always kept. */
export function filterToolsByGroup(all: readonly ToolDef[], selected: ReadonlySet<ToolGroup>): ToolDef[] {
  return all.filter((t) => {
    const g = groupOf(t.name);
    return g === undefined || selected.has(g);
  });
}

/** Which requestable groups actually have a tool in this (already scoped) inventory. */
export function availableGroups(all: readonly ToolDef[]): Exclude<ToolGroup, 'core'>[] {
  const present = new Set<ToolGroup>();
  for (const t of all) {
    const g = groupOf(t.name);
    if (g && g !== 'core') present.add(g);
  }
  return REQUESTABLE_GROUPS.filter((g) => present.has(g));
}

/** Tool counts per group, so the gate can say how much a group is worth revealing. */
export function groupCounts(all: readonly ToolDef[]): Map<ToolGroup, number> {
  const counts = new Map<ToolGroup, number>();
  for (const t of all) {
    const g = groupOf(t.name);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/**
 * The definition of enable_tool_group itself.
 *
 * Its description is the only thing standing between a hidden tool and the model telling the user
 * a capability does not exist, so it is emphatic on purpose.
 */
export function enableToolGroupDef(
  available: readonly Exclude<ToolGroup, 'core'>[],
  counts?: ReadonlyMap<ToolGroup, number>,
): ToolDef {
  const menu = available
    .map((g) => {
      const n = counts?.get(g);
      return `"${g}" (${n === undefined ? '' : `${n} tool${n === 1 ? '' : 's'}: `}${GROUP_SUMMARIES[g]})`;
    })
    .join(' ');

  return {
    name: ENABLE_TOOL_GROUP,
    description:
      'Reveal a hidden group of tools. IMPORTANT: you are only shown a SUBSET of your tools right now ' +
      '(reading the setup). Many more exist but are hidden to keep each request small. If the user asks ' +
      'for something you have no tool for (' +
      // Derived from what this chat actually has, so a GA4-only chat is never told about sGTM.
      available.map((g) => PROMPT_LABEL[g]).join(', ') +
      '), call THIS FIRST with the matching group instead of saying you cannot do it or that it must be ' +
      'done by hand in the UI. It returns the tool names in that group and they become callable on your ' +
      'next step. Groups: ' +
      menu,
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          // An empty enum is invalid JSON Schema and some providers reject the whole tool.
          ...(available.length ? { enum: [...available] } : {}),
          description: 'The group to reveal.',
        },
      },
      required: ['group'],
      additionalProperties: false,
    },
    isWrite: false,
    isDelete: false,
    isDestructive: false,
  } as ToolDef;
}

/** The system-prompt paragraph telling the model its list is partial. */
export function buildToolGroupPrompt(available: readonly Exclude<ToolGroup, 'core'>[]): string {
  if (!available.length) return '';
  const menu = available.map((g) => `${PROMPT_LABEL[g]} (group "${g}")`).join(', ');
  return (
    'YOUR TOOL LIST IS A SUBSET. To keep each request small you are shown only some of your tools ' +
    '(reading the setup). You HAVE more, hidden behind enable_tool_group: ' +
    menu +
    '. If the user asks for something you have no tool for, call enable_tool_group with the matching ' +
    'group FIRST, then use the tools it returns on your next step. NEVER tell the user a capability ' +
    'does not exist, and never say a change must be made by hand in the GTM or GA4 interface, just ' +
    'because the tool is not in the list you can currently see. Equally, do NOT claim you made a change ' +
    'you have not actually called a tool for. Wherever these instructions name a tool you cannot see, ' +
    'that tool is hidden, not missing: reveal its group first.'
  );
}

/** The result text for an enable_tool_group call: the names that just became callable. */
export function describeRevealedGroup(group: ToolGroup, revealed: readonly ToolDef[]): string {
  if (revealed.length === 0) {
    return `No tools in group "${group}" are available in this conversation. Do not claim the capability exists here; say what the user would need to do instead.`;
  }
  const names = revealed.map((t) => t.name).join(', ');
  return (
    `Group "${group}" revealed: ${revealed.length} tool(s) now callable on your next step. ${names}. ` +
    'Call the one you need now; do not call enable_tool_group again for this group.'
  );
}
